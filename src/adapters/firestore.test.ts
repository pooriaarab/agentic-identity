import { describe, expect, it } from "vitest";
import { runAuditContract, runBlobsContract, runStoreContract } from "../testing.js";
import { StoreConflictError } from "../ports.js";
import { createFirestoreBlobs, createFirestoreStore, verifySignedBlobUrl } from "./firestore.js";
import { createFakeFirestore } from "./firestore.fake.js";

// With FIRESTORE_EMULATOR_HOST set, the suite runs against the emulator. A project id names one
// dataset there, so `shared` maps to a project. Without it, a fake of the REST surface runs.
const emulator = process.env.FIRESTORE_EMULATOR_HOST;
const fakes = new Map<string, ReturnType<typeof createFakeFirestore>>();
const projectFor = (shared: string) => `t${shared.replace(/-/g, "").slice(0, 20)}`;

// The emulator job in CI sets REQUIRE_FIRESTORE_EMULATOR, so a job that lost the emulator fails
// here and does not pass on the fake.
it.runIf(process.env.REQUIRE_FIRESTORE_EMULATOR === "1")("runs against the emulator when CI asks for it", () => {
  expect(emulator).toMatch(/:\d+$/);
});

const URL_SECRET = "s".repeat(32);

function connection(options: { shared?: string; region?: string }) {
  const shared = options.shared ?? crypto.randomUUID();
  const projectId = projectFor(shared);
  // Twenty writers on one doc lock each other out in the emulator, so it gets more attempts.
  if (emulator) return { ...(options as object), projectId, fetch, baseUrl: `http://${emulator}`, token: "owner", maxAttempts: 40 };
  if (!fakes.has(shared)) fakes.set(shared, createFakeFirestore());
  return { ...(options as object), projectId, fetch: fakes.get(shared)!.fetch };
}

const make = (options: { shared?: string; region?: string } = {}) => createFirestoreStore(connection(options));
// A chunk of 100 bytes cuts the contract's 256-byte object into three chunk docs.
const makeBlobs = (options: { shared?: string; region?: string } = {}, extra: { chunkBytes?: number } = { chunkBytes: 100 }) =>
  createFirestoreBlobs({ ...connection(options), urlBase: "https://files.example/blob", urlSecret: URL_SECRET, ...extra });

runStoreContract((options) => make(options));
runAuditContract((options) => make(options));
runBlobsContract((options) => makeBlobs(options));

describe("Firestore blobs", () => {
  const chunkDocs = async (shared: string) => {
    const store = make({ shared });
    return (await store.query("blobs_chunks", { limit: 1000 })).items.length;
  };

  it("round-trips an object larger than one chunk doc, with the default chunk size", async () => {
    const blobs = makeBlobs({}, {});
    const bytes = Uint8Array.from({ length: 700_000 }, (_, i) => (i * 7) % 256);
    await blobs.put("big", bytes, { contentType: "application/octet-stream" });
    expect((await blobs.head("big"))!.size).toBe(bytes.length);
    expect((await blobs.get("big"))!.data).toEqual(bytes);
    await blobs.put("empty", new Uint8Array());
    expect((await blobs.get("empty"))!.data).toHaveLength(0);
  }, 30_000);

  it("keeps no chunk doc after a refused put, an overwrite, or a delete", async () => {
    const shared = crypto.randomUUID();
    const blobs = makeBlobs({ shared });
    await blobs.put("k", new Uint8Array(250), { ifNoneMatch: "*" });
    expect(await chunkDocs(shared)).toBe(3);
    expect(await blobs.put("k", new Uint8Array(450), { ifNoneMatch: "*" })).toBeNull();
    expect(await chunkDocs(shared)).toBe(3);
    await blobs.put("k", new Uint8Array(150));
    expect(await chunkDocs(shared)).toBe(2);
    await blobs.delete("k");
    expect(await chunkDocs(shared)).toBe(0);
  });

  it("keeps keys with slashes and long keys apart", async () => {
    const blobs = makeBlobs();
    const long = "k".repeat(2000);
    await blobs.put("a/b", Uint8Array.of(1));
    await blobs.put("a", Uint8Array.of(2));
    await blobs.put(long, Uint8Array.of(3));
    expect([(await blobs.get("a/b"))!.data[0], (await blobs.get("a"))!.data[0], (await blobs.get(long))!.data[0]]).toEqual([1, 2, 3]);
  });

  it("refuses an object over maxBytes, and bad options and secrets", async () => {
    const blobs = makeBlobs({}, { maxBytes: 10 } as never);
    await expect(blobs.put("k", new Uint8Array(11))).rejects.toThrow(RangeError);
    expect(await blobs.get("k")).toBeNull();
    expect(() => makeBlobs({}, { chunkBytes: 0 })).toThrow(RangeError);
    for (const urlSecret of [undefined, "", "short"]) {
      expect(() => createFirestoreBlobs({ ...connection({}), urlBase: "https://x.example", urlSecret: urlSecret as never })).toThrow();
    }
  });

  it("signs URLs that verifySignedBlobUrl accepts", async () => {
    const url = await makeBlobs().signedUrl("a/b", { method: "GET", expiresInSeconds: 60, responseContentType: "text/csv" });
    expect(await verifySignedBlobUrl(url, { secret: URL_SECRET })).toEqual({ key: "a/b", method: "GET", responseContentType: "text/csv" });
    expect(await verifySignedBlobUrl(url, { secret: "t".repeat(32) })).toBeNull();
  });
});

it("throws StoreConflictError after the last attempt when Firestore keeps aborting", async () => {
  const begun: unknown[] = [];
  const aborting = (async (input: RequestInfo | URL, init?: RequestInit) =>
    String(input).endsWith(":beginTransaction")
      ? (begun.push(JSON.parse(init!.body as string)), new Response(JSON.stringify({ transaction: `t${begun.length}` })))
      : String(input).endsWith(":rollback")
        ? new Response("{}")
        : new Response(JSON.stringify({ error: { code: 409, status: "ABORTED" } }), { status: 409 })) as typeof fetch;
  const store = createFirestoreStore({ projectId: "p", fetch: aborting, maxAttempts: 3 });
  await expect(store.transaction((tx) => tx.get("docs", "a"))).rejects.toBeInstanceOf(StoreConflictError);
  // Each retry names the transaction it replaces, so Firestore does not age it as a new one.
  expect(begun).toEqual([{ options: { readWrite: {} } }, { options: { readWrite: { retryTransaction: "t1" } } }, { options: { readWrite: { retryTransaction: "t2" } } }]);
});

it("retries and then gives up when beginTransaction itself is aborted", async () => {
  const aborted = (async () => new Response(JSON.stringify({ error: { code: 409, status: "ABORTED" } }), { status: 409 })) as typeof fetch;
  const store = createFirestoreStore({ projectId: "p", fetch: aborted, maxAttempts: 2 });
  await expect(store.transaction(async () => 1)).rejects.toBeInstanceOf(StoreConflictError);
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
