// Failure-mode list for the last-owner guard. Each case is a way a resource could end with no owner.
//  1. One owner demotes themself with grant: refused (grant had no guard before).
//  2. Two owners remove each other with revokeGrant at once: one wins, one is refused.
//  3. Two owners demote each other with grant at once: one wins, one is refused.
//  4. One owner removes the other while the other demotes the first: one wins, one is refused.
//  5. A demotion that leaves an owner still works, and so does a grant that keeps the role owner.
// Two Sharing instances sit on two stores with one backing dataset, as two isolates do. A barrier
// holds both transactions after their reads, so each one sees two owners before either one writes.
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createD1Store, D1_SCHEMA, type D1Like } from "../adapters/cloudflare.js";
import { createMemoryStore } from "../adapters/memory.js";
import type { Store, StoreOps } from "../ports.js";
import type { PrincipalContext } from "./principals.js";
import { createSharing } from "./sharing.js";

const human = (id: string): PrincipalContext => ({ principalId: id, kind: "human", chain: [{ id, kind: "human" }], scopes: ["*:admin"] });
const [ana, bo] = [human("ana"), human("bo")];

function barrier(stores: Store[]): Store[] {
  let arrived = 0;
  let open!: () => void;
  const gate = new Promise<void>((resolve) => (open = resolve));
  return stores.map((store) => ({
    ...store,
    transaction: <R>(fn: (tx: StoreOps) => Promise<R>) =>
      store.transaction((tx) =>
        fn({
          ...tx,
          async query(...args: Parameters<StoreOps["query"]>) {
            const page = await tx.query(...args);
            if (++arrived >= stores.length) open();
            await gate;
            return page;
          },
        } as StoreOps),
      ),
  }));
}

function suite(name: string, make: () => Promise<[Store, Store]>) {
  describe(name, () => {
    const setup = async () => {
      const [s1, s2] = await make();
      const [a, b] = barrier([s1, s2]).map((s) => createSharing(s));
      const plain = createSharing(s1);
      await plain.createResource(ana, { id: "doc", type: "doc" });
      await plain.grant(ana, "doc", { kind: "human", id: "bo" }, "owner");
      return { a: a!, b: b!, plain, store: s1 };
    };
    const owners = async (store: Store) => (await store.query("grants", { where: { resourceId: "doc", role: "owner" } })).items.length;
    const settled = (results: PromiseSettledResult<unknown>[]) => results.map((r) => r.status).sort();

    test("two owners remove each other at once: one wins", async () => {
      const { a, b, store } = await setup();
      const results = await Promise.allSettled([a.revokeGrant(ana, "doc", { kind: "human", id: "bo" }), b.revokeGrant(bo, "doc", { kind: "human", id: "ana" })]);
      expect(settled(results)).toEqual(["fulfilled", "rejected"]);
      expect(await owners(store)).toBe(1);
    });

    test("two owners demote each other at once: one wins", async () => {
      const { a, b, store } = await setup();
      const results = await Promise.allSettled([a.grant(ana, "doc", { kind: "human", id: "bo" }, "editor"), b.grant(bo, "doc", { kind: "human", id: "ana" }, "editor")]);
      expect(settled(results)).toEqual(["fulfilled", "rejected"]);
      expect(await owners(store)).toBe(1);
    });

    test("a removal and a demotion at once: one wins", async () => {
      const { a, b, store } = await setup();
      const results = await Promise.allSettled([a.revokeGrant(ana, "doc", { kind: "human", id: "bo" }), b.grant(bo, "doc", { kind: "human", id: "ana" }, "viewer")]);
      expect(settled(results)).toEqual(["fulfilled", "rejected"]);
      expect(await owners(store)).toBe(1);
    });

    test("the last owner cannot demote themself, and other changes still work", async () => {
      const { plain, store } = await setup();
      await plain.grant(ana, "doc", { kind: "human", id: "bo" }, "editor");
      await expect(plain.grant(ana, "doc", { kind: "human", id: "ana" }, "editor")).rejects.toThrow("last owner");
      await plain.grant(ana, "doc", { kind: "human", id: "ana" }, "owner");
      await plain.grant(ana, "doc", { kind: "human", id: "bo" }, "owner");
      await plain.grant(ana, "doc", { kind: "human", id: "bo" }, "viewer");
      expect(await owners(store)).toBe(1);
    });
  });
}

suite("memory", async () => {
  const shared = `owners-${Math.random()}`;
  return [createMemoryStore({ shared }), createMemoryStore({ shared })];
});

let mf: Miniflare;
let db: D1Like;
beforeAll(async () => {
  mf = new Miniflare({ modules: true, script: "export default { fetch() { return new Response('ok'); } }", d1Databases: { DB: "owners-db" } });
  db = (await mf.getD1Database("DB")) as unknown as D1Like;
  await db.prepare(D1_SCHEMA).run();
});
afterAll(() => mf.dispose());

suite("d1", async () => {
  await db.prepare("DELETE FROM store_docs").run();
  return [createD1Store(db, { region: "unknown" }), createD1Store(db, { region: "unknown" })];
});
