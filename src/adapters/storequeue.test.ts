// The Queue contract runs here on three Stores: memory, a real D1 database served by miniflare,
// and Firestore (the emulator when FIRESTORE_EMULATOR_HOST is set, else the in-process fake).
// Failure list for the claim, written before the code:
//  1. Two runners on one Store must not both deliver a message.
//  2. A runner that crashes after the claim must not lose the message: the lease ends and
//     another runner delivers it, with a higher attempt.
//  3. A runner whose lease ended must not delete or park a message that another runner now holds.
//  4. A message that crashed its runners on every attempt must park, not loop for ever.
//  5. A doc in the collection that is not a message must not stop the other topics.
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Json, Store } from "../ports.js";
import { runQueueContract } from "../testing.js";
import { D1_SCHEMA, createD1Store, type D1Like } from "./cloudflare.js";
import { createFirestoreStore } from "./firestore.js";
import { createFakeFirestore } from "./firestore.fake.js";
import { createMemoryStore } from "./memory.js";
import { createStoreQueue } from "./storequeue.js";

let mf: Miniflare;
let db: D1Like;
beforeAll(async () => {
  mf = new Miniflare({ modules: true, script: "export default { fetch() { return new Response('ok'); } }", d1Databases: { DB: "queue-db" } });
  db = (await mf.getD1Database("DB")) as unknown as D1Like;
  await db.prepare(D1_SCHEMA).run();
});
afterAll(() => mf.dispose());

const emulator = process.env.FIRESTORE_EMULATOR_HOST;
const firestore = (): Store => {
  const projectId = `q${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
  return emulator
    ? createFirestoreStore({ projectId, fetch, baseUrl: `http://${emulator}`, token: "owner", maxAttempts: 40 })
    : createFirestoreStore({ projectId, fetch: createFakeFirestore().fetch });
};
const d1 = async (): Promise<Store> => {
  await db.prepare("DELETE FROM store_docs").run();
  return createD1Store(db, { region: "unknown" });
};

const backends: [string, () => Store | Promise<Store>][] = [
  ["memory", () => createMemoryStore()],
  ["D1", d1],
  ["Firestore", firestore],
];

for (const [name, makeStore] of backends) {
  describe(`Store queue on ${name}`, () => {
    runQueueContract(async (options) => {
      const queue = createStoreQueue(await makeStore(), options);
      return { queue, run: () => queue.run(), dead: (topic) => queue.dead(topic) };
    });

    it("delivers each message once when two runners share the Store", async () => {
      const store = await makeStore();
      const [one, two] = [createStoreQueue(store), createStoreQueue(store)];
      const got: Json[] = [];
      for (const q of [one, two]) q.consume("a", async (body) => void got.push(body));
      for (let i = 0; i < 6; i++) await one.send("a", i);
      await Promise.all([one.run(), two.run()]);
      expect([...got].sort()).toEqual([0, 1, 2, 3, 4, 5]);
    });
  });
}

describe("Store queue leases", () => {
  const setup = () => {
    let t = 0;
    const store = createMemoryStore();
    const make = () => createStoreQueue(store, { now: () => t, leaseSeconds: 30 });
    return { store, make, at: (ms: number) => void (t = ms) };
  };

  it("hands a crashed runner's message to another runner, with a higher attempt", async () => {
    const { make, at } = setup();
    const [crashing, healthy] = [make(), make()];
    const seen: number[] = [];
    crashing.consume("a", () => new Promise<void>(() => {}));
    healthy.consume("a", async (_b, meta) => void seen.push(meta.attempt));
    await crashing.send("a", 1);
    void crashing.run();
    await new Promise((r) => setTimeout(r, 20));
    await healthy.run();
    expect(seen).toEqual([]);
    at(30_000);
    await healthy.run();
    expect(seen).toEqual([2]);
  });

  it("does not let a runner past its lease delete a message another runner holds", async () => {
    const { store, make, at } = setup();
    const [slow, fast] = [make(), make()];
    let release!: () => void;
    const seen: string[] = [];
    slow.consume("a", () => new Promise<void>((r) => (release = r)));
    fast.consume("a", async () => {
      seen.push("fast");
      await new Promise((r) => setTimeout(r, 30));
    });
    await slow.send("a", 1);
    const slowRun = slow.run();
    await new Promise((r) => setTimeout(r, 20));
    at(30_000);
    const fastRun = fast.run();
    await new Promise((r) => setTimeout(r, 10));
    release();
    await slowRun;
    expect((await store.query("queue_messages")).items).toHaveLength(1);
    await fastRun;
    expect(seen).toEqual(["fast"]);
    expect((await store.query("queue_messages")).items).toHaveLength(0);
  });

  it("parks a message whose runners crashed on every attempt", async () => {
    const { store, make, at } = setup();
    await make().send("a", "poison");
    const [{ id }] = (await store.query("queue_messages")).items as unknown as [{ id: string }];
    for (let i = 0; i < 3; i++) {
      const crashing = make();
      crashing.consume("a", () => new Promise<void>(() => {}));
      void crashing.run();
      await new Promise((r) => setTimeout(r, 20));
      at((i + 1) * 30_000);
    }
    // Three claims used all attempts, so the fourth claim parks the message and delivers nothing.
    const healthy = make();
    const seen: Json[] = [];
    healthy.consume("a", async (b) => void seen.push(b));
    await healthy.run();
    expect(seen).toEqual([]);
    expect(await healthy.dead("a")).toEqual(["poison"]);
    expect((await store.get("queue_messages", id))!.state).toBe("dead");
  });

  it("skips a doc that is not a message and still serves the other topics", async () => {
    const { store, make } = setup();
    const q = make();
    const seen: Json[] = [];
    q.consume("a", async (b) => void seen.push(b));
    q.consume("b", async (b) => void seen.push(b));
    await store.put("queue_messages", "junk", { topic: "a", state: "pending", due: "soon" });
    await q.send("b", "ok");
    await q.run();
    expect(seen).toEqual(["ok"]);
  });
});
