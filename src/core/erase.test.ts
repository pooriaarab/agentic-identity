// Failure-mode list for listGrants and deleteResource. Each case is a way data could outlive an erase.
//  1. After an erase, no grant, link, invite, or audit entry of the resource is left, whatever the
//     grant's role or kind holds. Other resources keep all theirs.
//  2. More than one page of each is removed, not only the first page.
//  3. Only an owner erases. An editor, an outsider, a narrow agent, and a missing resource are
//     refused, and nothing is removed.
//  4. A resource with children is refused. It erases once the children are gone.
//  5. A resource made again with the same id has no old grants, and an old link token fails.
//  6. More owners than one transaction takes are refused up front, and nothing is removed.
//  6b. A write that races the erase leaves nothing behind: one that lands after the erase is
//     refused, and one that lands while the erase runs is seen by the erase, which runs again.
//  7. listGrants needs an owner, pages without gaps, hides a grant that is not honored, and
//     refuses a bad limit or cursor.
// The suite runs on the memory store and on D1.
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createD1Store, D1_SCHEMA, type D1Like } from "../adapters/cloudflare.js";
import { createMemoryStore } from "../adapters/memory.js";
import type { Store, StoreOps } from "../ports.js";
import type { PrincipalContext } from "./principals.js";
import { MAX_OWNERS_ON_ERASE, createSharing } from "./sharing.js";

const root = (id: string, scopes = ["*:admin"]): PrincipalContext => ({ principalId: id, kind: "human", chain: [{ id, kind: "human" }], scopes });
const [ana, bo, cy] = [root("ana"), root("bo"), root("cy")];
const narrow: PrincipalContext = { principalId: "ana-agent", kind: "agent_of_human", chain: [{ id: "ana", kind: "human" }, { id: "ana-agent", kind: "agent_of_human" }], scopes: ["doc:write"] };
const person = (id: string) => ({ kind: "human", id }) as const;

/** Runs `hook` once, inside the first transaction, when it first deletes the resource doc "doc": after every read, before the commit. */
function afterFirstDelete(store: Store, hook: () => Promise<void>): Store {
  let fired = false;
  return {
    ...store,
    transaction: <R>(fn: (tx: StoreOps) => Promise<R>) =>
      store.transaction((tx) =>
        fn({
          ...tx,
          async delete(collection: string, id: string) {
            if (!fired && collection === "resources" && id === "doc") {
              fired = true;
              await hook();
            }
            return tx.delete(collection, id);
          },
        } as StoreOps),
      ),
  };
}

/** Two stores on one backing dataset, as two isolates have. A store runs its own transactions one at a time. */
function suite(name: string, size: number, make: () => Promise<[Store, Store]>) {
  describe(name, { timeout: 120_000 }, () => {
    const setup = async () => {
      const [store, other] = await make();
      const sharing = createSharing(store);
      await sharing.createResource(ana, { id: "doc", type: "doc" });
      await sharing.createResource(ana, { id: "keep", type: "doc" });
      return { store, sharing, rival: createSharing(other) };
    };
    const left = async (store: Store, resourceId: string) => {
      const found: Record<string, number> = {};
      for (const collection of ["resources", "grants", "links", "invites", "audit"]) {
        const where: Record<string, string> = collection === "resources" ? { id: resourceId } : { resourceId };
        let n = 0;
        for (let cursor: string | undefined; ; ) {
          const page = await store.query(collection, { where, limit: 100, ...(cursor === undefined ? {} : { cursor }) });
          n += page.items.length;
          if ((cursor = page.nextCursor) === undefined) break;
        }
        found[collection] = n;
      }
      return found;
    };
    const fill = async (sharing: ReturnType<typeof createSharing>, resourceId: string) => {
      await sharing.grant(ana, resourceId, person("bo"), "editor");
      await sharing.createInvite(ana, resourceId, { role: "viewer", handle: "scribe" });
      const link = await sharing.createLink(ana, resourceId, { role: "viewer" });
      await sharing.can(bo, "read", resourceId);
      return link;
    };

    test("removes the resource, grants of every shape, links, invites, and audit, and leaves other resources alone", async () => {
      const { store, sharing } = await setup();
      await fill(sharing, "doc");
      await fill(sharing, "keep");
      await store.put("grants", "doc:legacy", { resourceId: "doc", subjectId: "old", role: "owner" });
      await store.put("grants", "doc:odd", { resourceId: "doc", subjectId: "odd", role: "god" });
      await store.put("grants", "doc:norole", { resourceId: "doc", subjectId: "none" });
      const before = await left(store, "keep");
      await sharing.deleteResource(ana, "doc");
      expect(await left(store, "doc")).toEqual({ resources: 0, grants: 0, links: 0, invites: 0, audit: 0 });
      expect(await left(store, "keep")).toEqual(before);
    });

    test("removes more than one page of grants, links, invites, and audit", async () => {
      const { store, sharing } = await setup();
      await Promise.all(
        Array.from({ length: size }, (_, i) =>
          Promise.all([
            store.put("grants", `doc:human:u${i}`, { resourceId: "doc", subjectKind: "human", subjectId: `u${i}`, role: "viewer" }),
            store.put("links", `l${i}`, { id: `l${i}`, resourceId: "doc", role: "viewer", tokenHash: `h${i}` }),
            store.put("invites", `i${i}`, { id: `i${i}`, resourceId: "doc", role: "viewer", handle: "x" }),
            store.put("audit", `a${i}`, { id: `a${i}`, resourceId: "doc", at: i }),
          ]),
        ),
      );
      await sharing.deleteResource(ana, "doc");
      expect(await left(store, "doc")).toEqual({ resources: 0, grants: 0, links: 0, invites: 0, audit: 0 });
    });

    test.each([["an editor", bo], ["an outsider", cy], ["a narrow agent", narrow]])("%s cannot erase, and nothing is removed", async (_who, ctx) => {
      const { store, sharing } = await setup();
      await sharing.grant(ana, "doc", person("bo"), "editor");
      const before = await left(store, "doc");
      await expect(sharing.deleteResource(ctx, "doc")).rejects.toThrow("forbidden");
      expect(await left(store, "doc")).toEqual(before);
    });

    test("a missing resource is refused", async () => {
      const { sharing } = await setup();
      await expect(sharing.deleteResource(ana, "nope")).rejects.toThrow("forbidden");
    });

    test("a resource with children is refused until the children are gone", async () => {
      const { store, sharing } = await setup();
      await sharing.createResource(ana, { id: "kid", type: "doc", parentId: "doc" });
      await expect(sharing.deleteResource(ana, "doc")).rejects.toThrow("children");
      expect((await left(store, "doc")).resources).toBe(1);
      await sharing.deleteResource(ana, "kid");
      await sharing.deleteResource(ana, "doc");
      expect((await left(store, "doc")).resources).toBe(0);
    });

    test("a resource made again has no old grants, and an old link token fails", async () => {
      const { sharing } = await setup();
      const link = await fill(sharing, "doc");
      await sharing.deleteResource(ana, "doc");
      expect((await sharing.can(bo, "read", "doc")).allowed).toBe(false);
      await sharing.createResource(cy, { id: "doc", type: "doc" });
      expect((await sharing.can(bo, "read", "doc")).allowed).toBe(false);
      expect((await sharing.can(null, "read", "doc", { linkToken: link.token })).allowed).toBe(false);
      expect((await sharing.listGrants(cy, "doc")).grants).toEqual([{ resourceId: "doc", subjectKind: "human", subjectId: "cy", role: "owner" }]);
    });

    test("more owners than one transaction takes are refused, and nothing is removed", async () => {
      const { store, sharing } = await setup();
      await Promise.all(Array.from({ length: MAX_OWNERS_ON_ERASE }, (_, i) => store.put("grants", `doc:human:o${i}`, { resourceId: "doc", subjectKind: "human", subjectId: `o${i}`, role: "owner" })));
      await sharing.grant(ana, "doc", person("bo"), "editor");
      const before = await left(store, "doc");
      await expect(sharing.deleteResource(ana, "doc")).rejects.toThrow("too many owners");
      expect(await left(store, "doc")).toEqual(before);
    });

    test.each([
      ["grant", (s: ReturnType<typeof createSharing>) => s.grant(ana, "doc", person("mallory"), "owner")],
      ["createLink", (s: ReturnType<typeof createSharing>) => s.createLink(ana, "doc", { role: "viewer" })],
      ["createInvite", (s: ReturnType<typeof createSharing>) => s.createInvite(ana, "doc", { role: "viewer", handle: "scribe" })],
      ["createResource", (s: ReturnType<typeof createSharing>) => s.createResource(ana, { id: "late", type: "doc", parentId: "doc" })],
    ])("%s that lands after the erase is refused and leaves nothing", async (_name, write) => {
      const { store, sharing } = await setup();
      const gate = { erased: false };
      const late = createSharing({ ...store, transaction: (fn) => (gate.erased ? store.transaction(fn) : store.delete("resources", "doc").then(() => ((gate.erased = true), store.transaction(fn)))) } as Store);
      await expect(write(late)).rejects.toThrow("forbidden");
      const owners = (await store.query("grants", { where: { role: "owner" } })).items.filter((g) => g.data.subjectId === "mallory");
      expect(owners).toEqual([]);
      expect((await left(store, "doc")).links + (await left(store, "doc")).invites).toBe(0);
      expect((await store.get("resources", "late"))).toBeNull();
    });

    test.each([
      ["grant", (s: ReturnType<typeof createSharing>) => s.grant(ana, "doc", person("mallory"), "viewer")],
      ["owner grant", (s: ReturnType<typeof createSharing>) => s.grant(ana, "doc", person("mallory"), "owner")],
      ["createLink", (s: ReturnType<typeof createSharing>) => s.createLink(ana, "doc", { role: "viewer" })],
      ["createInvite", (s: ReturnType<typeof createSharing>) => s.createInvite(ana, "doc", { role: "viewer", handle: "scribe" })],
    ])("%s that lands while the erase runs is erased too", async (_name, write) => {
      const { store, rival } = await setup();
      const erasing = createSharing(afterFirstDelete(store, async () => void (await write(rival).catch(() => undefined))));
      await erasing.deleteResource(ana, "doc");
      expect(await left(store, "doc")).toEqual({ resources: 0, grants: 0, links: 0, invites: 0, audit: 0 });
    });

    test("an invite accepted while the erase runs is erased too", async () => {
      const { store, rival } = await setup();
      const scribe: PrincipalContext = { principalId: "scribe-id", kind: "agent", chain: [{ id: "scribe-id", kind: "agent" }], scopes: ["*:admin"] };
      const erasing = createSharing(afterFirstDelete(store, async () => {
        const invite = await rival.createInvite(ana, "doc", { role: "viewer", handle: "scribe" });
        await rival.acceptInvite(scribe, invite.id, { handle: "scribe" });
      }));
      await erasing.deleteResource(ana, "doc");
      expect(await left(store, "doc")).toEqual({ resources: 0, grants: 0, links: 0, invites: 0, audit: 0 });
    });

    test("a link revoked after the erase does not come back", async () => {
      const { store, sharing } = await setup();
      const link = await sharing.createLink(ana, "doc", { role: "viewer" });
      let erased = false;
      const late = createSharing({
        ...store,
        transaction: async (fn) => {
          if (!erased) ((erased = true), await sharing.deleteResource(ana, "doc"));
          return store.transaction(fn);
        },
      } as Store);
      await expect(late.revokeLink(ana, link.id)).rejects.toThrow("forbidden");
      expect(await store.get("links", link.id)).toBeNull();
    });

    test("a child that lands while the erase runs stops the erase", async () => {
      const { store, rival } = await setup();
      const erasing = createSharing(afterFirstDelete(store, async () => void (await rival.createResource(ana, { id: "late", type: "doc", parentId: "doc" }))));
      await expect(erasing.deleteResource(ana, "doc")).rejects.toThrow("children");
      expect((await left(store, "doc")).resources).toBe(1);
    });

    test("listGrants needs an owner", async () => {
      const { sharing } = await setup();
      await sharing.grant(ana, "doc", person("bo"), "editor");
      await expect(sharing.listGrants(bo, "doc")).rejects.toThrow("forbidden");
      await expect(sharing.listGrants(cy, "doc")).rejects.toThrow("forbidden");
      expect((await sharing.listGrants(ana, "doc")).grants.map((g) => [g.subjectKind, g.subjectId, g.role])).toEqual([["human", "ana", "owner"], ["human", "bo", "editor"]]);
    });

    test("listGrants pages without gaps and hides a grant that is not honored", async () => {
      const { store, sharing } = await setup();
      for (const id of ["b1", "b2", "b3"]) await sharing.grant(ana, "doc", person(id), "viewer");
      await store.put("grants", "doc:legacy", { resourceId: "doc", subjectId: "old", role: "owner" });
      await store.put("grants", "doc:human:odd", { resourceId: "doc", subjectKind: "human", subjectId: "odd", role: "god" });
      const seen: string[] = [];
      let cursor: string | undefined;
      for (let pages = 0; pages < 10; pages++) {
        const page = await sharing.listGrants(ana, "doc", { limit: 2, ...(cursor === undefined ? {} : { cursor }) });
        seen.push(...page.grants.map((g) => g.subjectId));
        if ((cursor = page.nextCursor) === undefined) break;
      }
      expect(seen.sort()).toEqual(["ana", "b1", "b2", "b3"]);
    });

    test("listGrants refuses a cursor that is not text", async () => {
      const { sharing } = await setup();
      await expect(sharing.listGrants(ana, "doc", { cursor: 5 as unknown as string })).rejects.toThrow("invalid cursor");
    });

    test.each([[0], [201], [1.5], [Number.NaN], ["5"]])("listGrants refuses the limit %j", async (limit) => {
      const { sharing } = await setup();
      await expect(sharing.listGrants(ana, "doc", { limit: limit as number })).rejects.toThrow(RangeError);
    });
  });
}

suite("memory", 250, async () => {
  const shared = crypto.randomUUID();
  return [createMemoryStore({ shared }), createMemoryStore({ shared })];
});

let mf: Miniflare;
let db: D1Like;
beforeAll(async () => {
  mf = new Miniflare({ modules: true, script: "export default { fetch() { return new Response('ok'); } }", d1Databases: { DB: "erase-db" } });
  db = (await mf.getD1Database("DB")) as unknown as D1Like;
  await db.prepare(D1_SCHEMA).run();
});
afterAll(() => mf.dispose());

// D1 is slow to fill, so it gets fewer docs. They still make the sweep and the last transaction share the work.
suite("d1", 101, async () => {
  await db.prepare("DELETE FROM store_docs").run();
  return [createD1Store(db, { region: "unknown" }), createD1Store(db, { region: "unknown" })];
});
