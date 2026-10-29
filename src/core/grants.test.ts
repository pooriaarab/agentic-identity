// Failure-mode list for grant kinds. Each case is a way a role could reach the wrong subject.
//  1. A person and an agent with one id share a role: the grant to one must not open the other.
//  2. Both can hold their own role on one resource, and a revoke removes only the kind it names.
//  3. A missing, unknown, or inherited kind is refused. Nothing is stored. No kind is a default.
//  4. A root that is not a person or an own-identity agent holds no role.
//  5. The last-owner guard counts subjects, not ids: an owner of the other kind is another owner.
//  6. A grant stored before kinds is not honored, and it does not count as an owner.
//  7. The migration gives each stored grant the kind of the principal with its id, keeps the
//     stronger role when the new grant exists, leaves what it cannot place, and is safe to repeat.
//  8. An erase of a person removes grants of the person and their agents, with a kind or without,
//     and leaves a grant of the other kind that has the same id.
import { describe, expect, test } from "vitest";
import { createMemoryStore } from "../adapters/memory.js";
import { deletePerson } from "../gdpr.js";
import type { PrincipalContext } from "./principals.js";
import { createSharing, migrateGrants, type Subject } from "./sharing.js";

const root = (id: string, kind: "human" | "agent"): PrincipalContext => ({ principalId: id, kind, chain: [{ id, kind }], scopes: ["*:admin"] });
const [ana, same, sameAgent] = [root("ana", "human"), root("pat", "human"), root("pat", "agent")];
const [human, agent] = [(id: string): Subject => ({ kind: "human", id }), (id: string): Subject => ({ kind: "agent", id })];

async function setup() {
  const store = createMemoryStore();
  const sharing = createSharing(store);
  await sharing.createResource(ana, { id: "doc", type: "doc" });
  const can = async (ctx: PrincipalContext, action: "read" | "write") => (await sharing.can(ctx, action, "doc")).allowed;
  return { store, sharing, can };
}

describe("grants keyed on kind and id", () => {
  test("a grant to a person does not open the agent with the same id, and the other way round", async () => {
    const { sharing, can } = await setup();
    await sharing.grant(ana, "doc", human("pat"), "editor");
    expect(await can(same, "write")).toBe(true);
    expect(await can(sameAgent, "read")).toBe(false);
    await sharing.revokeGrant(ana, "doc", human("pat"));
    await sharing.grant(ana, "doc", agent("pat"), "viewer");
    expect(await can(sameAgent, "read")).toBe(true);
    expect(await can(same, "read")).toBe(false);
  });

  test("each kind holds its own role, and a revoke removes only the named kind", async () => {
    const { sharing, can } = await setup();
    await sharing.grant(ana, "doc", human("pat"), "editor");
    await sharing.grant(ana, "doc", agent("pat"), "viewer");
    expect(await can(same, "write")).toBe(true);
    expect(await can(sameAgent, "write")).toBe(false);
    await sharing.revokeGrant(ana, "doc", human("pat"));
    expect(await can(same, "read")).toBe(false);
    expect(await can(sameAgent, "read")).toBe(true);
  });

  test.each([[undefined], [null], [{ id: "pat" }], [{ kind: "user_token", id: "pat" }], [{ kind: "constructor", id: "pat" }], [{ kind: "agent_of_human", id: "pat" }], [{ kind: "human", id: "a:b" }], [{ kind: "human" }], ["pat"]])(
    "the subject %j is refused and nothing is stored",
    async (subject) => {
      const { store, sharing } = await setup();
      await expect(sharing.grant(ana, "doc", subject as Subject, "viewer")).rejects.toThrow();
      await expect(sharing.revokeGrant(ana, "doc", subject as Subject)).rejects.toThrow();
      expect((await store.query("grants")).items).toHaveLength(1);
    },
  );

  test("a root that is not a person or an own-identity agent holds no role", async () => {
    const { sharing } = await setup();
    const odd: PrincipalContext = { principalId: "t", kind: "user_token", chain: [{ id: "t", kind: "user_token" }], scopes: ["*:admin"] };
    expect((await sharing.can(odd, "read", "doc")).allowed).toBe(false);
    await expect(sharing.createResource(odd, { type: "doc" })).rejects.toThrow("forbidden");
  });

  test("an owner of the other kind with the same id is another owner", async () => {
    const { sharing, store } = await setup();
    await expect(sharing.revokeGrant(ana, "doc", human("ana"))).rejects.toThrow("last owner");
    await sharing.grant(ana, "doc", agent("ana"), "owner");
    await sharing.revokeGrant(ana, "doc", human("ana"));
    expect((await store.query("grants", { where: { role: "owner" } })).items.map((g) => g.data.subjectKind)).toEqual(["agent"]);
  });

  test("a grant stored before kinds is not honored and is not an owner", async () => {
    const { sharing, store, can } = await setup();
    await store.put("grants", "doc:pat", { resourceId: "doc", subjectId: "pat", role: "owner" });
    expect(await can(same, "read")).toBe(false);
    expect(await can(sameAgent, "read")).toBe(false);
    await expect(sharing.revokeGrant(ana, "doc", human("ana"))).rejects.toThrow("last owner");
  });
});

describe("migrateGrants", () => {
  const principals = (store: ReturnType<typeof createMemoryStore>) =>
    Promise.all([
      store.put("principals", "pat", { id: "pat", kind: "human", scopes: [] }),
      store.put("principals", "bot", { id: "bot", kind: "agent", scopes: [] }),
      store.put("principals", "sub", { id: "sub", kind: "agent_of_human", scopes: [] }),
    ]);

  test("gives each grant the kind of its principal and keeps the stronger role", async () => {
    const { store, can } = await setup();
    await principals(store);
    await store.put("grants", "doc:pat", { resourceId: "doc", subjectId: "pat", role: "editor" });
    await store.put("grants", "doc:bot", { resourceId: "doc", subjectId: "bot", role: "viewer" });
    await store.put("grants", "doc:human:pat", { resourceId: "doc", subjectKind: "human", subjectId: "pat", role: "viewer" });
    await store.put("grants", "doc:orphan", { resourceId: "doc", subjectId: "ghost", role: "owner" });
    await store.put("grants", "doc:sub", { resourceId: "doc", subjectId: "sub", role: "owner" });
    await store.put("grants", "doc:odd", { resourceId: "doc", subjectId: "pat", role: "god" });
    const result = await migrateGrants(store);
    expect(result.migrated).toBe(2);
    expect(result.unresolved.sort()).toEqual(["doc:odd", "doc:orphan", "doc:sub"]);
    expect(await store.get("grants", "doc:human:pat")).toEqual({ resourceId: "doc", subjectKind: "human", subjectId: "pat", role: "editor" });
    expect(await store.get("grants", "doc:agent:bot")).toEqual({ resourceId: "doc", subjectKind: "agent", subjectId: "bot", role: "viewer" });
    expect(await store.get("grants", "doc:pat")).toBeNull();
    expect(await can(same, "write")).toBe(true);
    expect(await can(root("bot", "agent"), "read")).toBe(true);
    expect(await can(sameAgent, "read")).toBe(false);
  });

  test("a second run changes nothing more", async () => {
    const { store } = await setup();
    await principals(store);
    await store.put("grants", "doc:pat", { resourceId: "doc", subjectId: "pat", role: "editor" });
    expect((await migrateGrants(store)).migrated).toBe(1);
    expect(await migrateGrants(store)).toEqual({ migrated: 0, unresolved: [] });
  });
});

describe("erase", () => {
  test("removes grants with a kind or without, and leaves the other kind with the same id", async () => {
    const { store, sharing } = await setup();
    await store.put("principals", "pat", { id: "pat", kind: "human", scopes: [] });
    await sharing.grant(ana, "doc", human("pat"), "editor");
    await sharing.grant(ana, "doc", agent("pat"), "viewer");
    await store.put("grants", "doc:pat", { resourceId: "doc", subjectId: "pat", role: "viewer" });
    await deletePerson(store, "pat");
    expect((await store.query("grants")).items.map((g) => g.id).sort()).toEqual(["doc:agent:pat", "doc:human:ana"]);
  });
});
