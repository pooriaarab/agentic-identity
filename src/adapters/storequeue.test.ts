// The Queue contract runs here on three Stores: memory, a real D1 database served by miniflare,
// and Firestore (the emulator when FIRESTORE_EMULATOR_HOST is set, else the in-process fake).
// Failure list for the claim, written before the code:
//  1. Two runners on one Store must not both deliver a message.
//  2. A runner that crashes after the claim must not lose the message: the lease ends and
//     another runner delivers it, with a higher attempt.
//  3. A runner whose lease ended must not delete or park a message that another runner now holds.
//  4. A message that crashed its runners on every attempt must park, not loop for ever.
//  5. A doc in the collection that is not a message must not stop its own topic or the others,
//     whether it sorts first or last, and must not show in `dead()`.
//  6. One instance that runs twice at once must not let the first run settle the second's claim.
//  7. A failed settle, or a claim that loses its race for good, must not stop the rest of the run.
//  8. A clock that returns NaN must not store a message that nothing can deliver.
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { StoreConflictError, type Json, type Store } from "../ports.js";
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
/** A dataset gives out Store instances that share its data, as two isolates do. */
type Dataset = { open(): Store };
const firestore = (): Dataset => {
  const projectId = `q${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
  const fake = createFakeFirestore();
  return {
    open: () =>
      emulator
        ? createFirestoreStore({ projectId, fetch, baseUrl: `http://${emulator}`, token: "owner", maxAttempts: 40 })
        : createFirestoreStore({ projectId, fetch: fake.fetch }),
  };
};
const d1 = async (): Promise<Dataset> => {
  await db.prepare("DELETE FROM store_docs").run();
  return { open: () => createD1Store(db, { region: "unknown" }) };
};
const memory = (): Dataset => {
  const shared = crypto.randomUUID();
  return { open: () => createMemoryStore({ shared }) };
};

const backends: [string, () => Dataset | Promise<Dataset>][] = [
  ["memory", memory],
  ["D1", d1],
  ["Firestore", firestore],
];

for (const [name, makeDataset] of backends) {
  describe(`Store queue on ${name}`, () => {
    runQueueContract(async (options) => {
      const queue = createStoreQueue((await makeDataset()).open(), options);
      return { queue, run: () => queue.run(), dead: (topic) => queue.dead(topic) };
    });

    it("delivers each message once when two runners share the Store", async () => {
      const data = await makeDataset();
      const [one, two] = [createStoreQueue(data.open()), createStoreQueue(data.open())];
      const got: Json[] = [];
      for (const q of [one, two]) q.consume("a", async (body) => void got.push(body));
      for (let i = 0; i < 6; i++) await one.send("a", i);
      await Promise.all([one.run(), two.run()]);
      expect([...got].sort()).toEqual([0, 1, 2, 3, 4, 5]);
    });

    it("parks a doc that is not a message, even when it is first, and serves the rest of its topic", async () => {
      const store = (await makeDataset()).open();
      const q = createStoreQueue(store);
      const seen: Json[] = [];
      q.consume("a", async (b) => void seen.push(b));
      q.consume("b", async (b) => void seen.push(b));
      await store.put("queue_messages", "junk1", { topic: "a", state: "pending", due: "soon" });
      await store.put("queue_messages", "junk2", { topic: "a", state: "pending", due: -1, attempt: "x" });
      await store.put("queue_messages", "junk3", { topic: "a", state: "pending", due: -2, attempt: -100, body: 1 });
      await store.put("queue_messages", "junk5", { topic: "a", state: "pending", due: 5 });
      await store.put("queue_messages", "junk6", { topic: "a", state: "pending", due: true, attempt: 0, body: 1 });
      await store.put("queue_messages", "junk4", { topic: "a", state: "dead", key: "k" });
      await q.send("a", "late");
      await q.send("b", "ok");
      await q.run();
      expect(seen).toEqual(["late", "ok"]);
      expect(await q.dead("a")).toEqual([]);
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

  it("does not let one run settle the claim of another run on the same instance", async () => {
    const { store, make, at } = setup();
    const q = make();
    const releases: (() => void)[] = [];
    q.consume("a", () => new Promise<void>((r) => releases.push(r)));
    await q.send("a", 1);
    const first = q.run();
    await new Promise((r) => setTimeout(r, 20));
    at(30_000);
    const second = q.run();
    await new Promise((r) => setTimeout(r, 20));
    expect(releases).toHaveLength(2);
    releases[0]!();
    await first;
    expect((await store.query("queue_messages")).items).toHaveLength(1);
    releases[1]!();
    await second;
    expect((await store.query("queue_messages")).items).toHaveLength(0);
  });

  it("goes on with the other topics when a claim gives up on a race", async () => {
    const base = createMemoryStore();
    let lose = true;
    const store: Store = {
      ...base,
      region: base.region,
      transaction: (fn) => {
        if (!lose) return base.transaction(fn);
        lose = false;
        return Promise.reject(new StoreConflictError());
      },
    };
    const q = createStoreQueue(store);
    const seen: Json[] = [];
    q.consume("a", async (b) => void seen.push(b));
    q.consume("b", async (b) => void seen.push(b));
    await q.send("a", 1);
    await q.send("b", 2);
    await q.run();
    expect(seen).toEqual([2]);
    await q.run();
    expect(seen).toEqual([2, 1]);
  });

  it("refuses to send with a clock that is not a finite number", async () => {
    const q = createStoreQueue(createMemoryStore(), { now: () => NaN });
    await expect(q.send("a", 1)).rejects.toThrow();
  });

  it("goes on with the other topics when a settle fails", async () => {
    let fail = false;
    const base = createMemoryStore();
    const store: Store = {
      ...base,
      region: base.region,
      transaction: (fn) => {
        if (!fail) return base.transaction(fn);
        fail = false;
        return Promise.reject(new Error("conflict"));
      },
    };
    const q = createStoreQueue(store);
    const seen: Json[] = [];
    q.consume("a", async (b) => {
      seen.push(b);
      fail = true;
    });
    q.consume("b", async (b) => void seen.push(b));
    await q.send("a", 1);
    await q.send("b", 2);
    await q.run();
    expect(seen).toEqual([1, 2]);
    // The failed settle left message 1 claimed, so it returns once its lease ends.
    expect((await base.query("queue_messages")).items).toHaveLength(1);
  });
});
