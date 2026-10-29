import { expect, it } from "vitest";
import { runStoreContract } from "../testing.js";
import { StoreConflictError } from "../ports.js";
import { createFirestoreStore } from "./firestore.js";
import { createFakeFirestore } from "./firestore.fake.js";

// With FIRESTORE_EMULATOR_HOST set, the suite runs against the emulator. A project id names one
// dataset there, so `shared` maps to a project. Without it, a fake of the REST surface runs.
const emulator = process.env.FIRESTORE_EMULATOR_HOST;
const fakes = new Map<string, ReturnType<typeof createFakeFirestore>>();
const projectFor = (shared: string) => `t${shared.replace(/-/g, "").slice(0, 20)}`;

function make(options: { shared?: string; region?: string } = {}) {
  const shared = options.shared ?? crypto.randomUUID();
  const projectId = projectFor(shared);
  if (emulator) return createFirestoreStore({ ...(options as object), projectId, fetch, baseUrl: `http://${emulator}`, token: "owner" });
  if (!fakes.has(shared)) fakes.set(shared, createFakeFirestore());
  return createFirestoreStore({ ...(options as object), projectId, fetch: fakes.get(shared)!.fetch });
}

runStoreContract((options) => make(options));

it("throws StoreConflictError after the last attempt when Firestore keeps aborting", async () => {
  const aborting = (async (input: RequestInfo | URL) =>
    String(input).endsWith(":beginTransaction")
      ? new Response(JSON.stringify({ transaction: "dA==" }))
      : String(input).endsWith(":rollback")
        ? new Response("{}")
        : new Response(JSON.stringify({ error: { code: 409, status: "ABORTED" } }), { status: 409 })) as typeof fetch;
  const store = createFirestoreStore({ projectId: "p", fetch: aborting, maxAttempts: 3 });
  await expect(store.transaction((tx) => tx.get("docs", "a"))).rejects.toBeInstanceOf(StoreConflictError);
});

it("never puts a token or a doc in an error", async () => {
  const denied = (async () => new Response(JSON.stringify({ error: { code: 403, status: "PERMISSION_DENIED", message: "secret-doc-text" } }), { status: 403 })) as typeof fetch;
  const store = createFirestoreStore({ projectId: "p", fetch: denied, token: "secret-token" });
  const error = await store.put("docs", "a", { text: "secret-doc-text" }).catch((e: Error) => e);
  expect((error as Error).message).not.toMatch(/secret/);
});

it("rejects a doc Firestore cannot hold, before any request", async () => {
  const never = (async () => {
    throw new Error("no request expected");
  }) as typeof fetch;
  const store = createFirestoreStore({ projectId: "p", fetch: never });
  for (const doc of [{ a: [[1]] }, { a: Number.NaN }, { "": 1 }, { __x__: 1 }, { d: new Date() }]) {
    await expect(store.put("docs", "a", doc as never)).rejects.toThrow();
  }
});
