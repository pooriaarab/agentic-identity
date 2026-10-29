// Failure-mode list for sharing. Each case is a way access could go wrong.
// These tests were written before the code.
//  1. Outsider, unknown resource, and bad stored data: denied, never thrown, and audited.
//  2. Each role allows its own action and the weaker ones, and no stronger one.
//  3. Scopes only narrow: an owner's agent with `doc:read` cannot write or admin.
//  4. Folders: a grant passes down, never up. The strongest role on the path wins.
//     A cycle, a missing parent, and a path deeper than the cap give no inherited access.
//  5. Only an owner shares. The last owner cannot be removed. A role must be a known role.
//  6. Invites: the matching person or agent accepts once, before expiry. Nobody else does.
//     A delegated agent cannot accept for its owner. An invite never makes an owner.
//  6b. Accept pending: one call takes every live invite for the caller's own email or handle. It
//     skips the expired, the taken, and other people's, never lowers a role, and a delegated agent gets none.
//  7. Links: role and expiry hold, a folder link reaches its children, a revoked or
//     tampered link fails, signed-in-only refuses the anonymous, and the token is never stored.
//  8. Audit: allowed and denied entries keep the chain. The anonymous visitor is labeled.
//     An entry holds no email address.
//  9. An action that is not read, comment, write, or admin is denied for every caller, the
//     anonymous visitor included, and never allowed by a missing role. A link or invite expiry
//     that is not a finite time in the future is refused when it is made, and nothing is stored.
import { beforeEach, describe, expect, test } from "vitest";
import { createMemoryStore } from "../adapters/memory.js";
import type { Store } from "../ports.js";
import type { PrincipalContext } from "./principals.js";
import { ROLES, createSharing, type Role } from "./sharing.js";

let t = 1_000_000;
let store: Store;
let sharing: ReturnType<typeof createSharing>;

const human = (id: string, scopes = ["*:admin"]): PrincipalContext => ({ principalId: id, kind: "human", chain: [{ id, kind: "human" }], scopes });
const agentOf = (owner: string, scopes: string[]): PrincipalContext => ({
  principalId: `agent-of-${owner}`,
  kind: "agent_of_human",
  chain: [{ id: owner, kind: "human" }, { id: `agent-of-${owner}`, kind: "agent_of_human" }],
  scopes,
});
const ownAgent = (id: string, scopes = ["*:admin"]): PrincipalContext => ({ principalId: id, kind: "agent", chain: [{ id, kind: "agent" }], scopes });
const [ana, bo, cy] = [human("ana"), human("bo"), human("cy")];

beforeEach(async () => {
  t = 1_000_000;
  store = createMemoryStore();
  sharing = createSharing(store, { now: () => t });
  await sharing.createResource(ana, { id: "folder", type: "doc" });
  await sharing.createResource(ana, { id: "child", type: "doc", parentId: "folder" });
  await sharing.createResource(ana, { id: "grandchild", type: "doc", parentId: "child" });
});

const allowed = async (ctx: PrincipalContext | null, action: "read" | "comment" | "write" | "admin", id: string, linkToken?: string) =>
  (await sharing.can(ctx, action, id, linkToken ? { linkToken } : {})).allowed;

describe("denial", () => {
  test("an outsider and an unknown resource are denied, not thrown, and audited", async () => {
    expect(await allowed(bo, "read", "folder")).toBe(false);
    expect(await allowed(ana, "read", "nope")).toBe(false);
    const { entries } = await sharing.listAudit(ana, "folder");
    expect(entries.map((e) => [e.principalId, e.outcome])).toEqual([["bo", "denied"]]);
  });

  test.each([
    ["an unknown role", { resourceId: "folder", subjectId: "bo", role: "god" }],
    ["a missing role", { resourceId: "folder", subjectId: "bo" }],
  ])("a stored grant with %s gives nothing", async (_name, doc) => {
    await store.put("grants", "folder:human:bo", { ...doc, subjectKind: "human" });
    expect(await allowed(bo, "read", "folder")).toBe(false);
  });
});

describe("roles", () => {
  const strongest: Record<Role, string> = { viewer: "read", commenter: "comment", editor: "write", owner: "admin" };
  const actions = ["read", "comment", "write", "admin"] as const;
  test.each(ROLES)("%s allows its action and the weaker ones only", async (role) => {
    await sharing.grant(ana, "folder", { kind: "human", id: "bo" }, role);
    for (const [i, action] of actions.entries()) expect(await allowed(bo, action, "folder")).toBe(i <= actions.indexOf(strongest[role] as never));
  });

  test("a role must be a known role", async () => {
    await expect(sharing.grant(ana, "folder", { kind: "human", id: "bo" }, "god" as Role)).rejects.toThrow();
  });
});

describe("scopes narrow", () => {
  test("an agent of an owner gets only what its scopes allow", async () => {
    const agent = agentOf("ana", ["doc:read"]);
    expect(await allowed(agent, "read", "folder")).toBe(true);
    expect(await allowed(agent, "write", "folder")).toBe(false);
    expect(await allowed(agentOf("ana", ["sheet:admin"]), "read", "folder")).toBe(false);
    expect(await allowed(agentOf("ana", ["*:read"]), "read", "folder")).toBe(true);
  });
});

describe("folders", () => {
  test("a grant passes down and never up", async () => {
    await sharing.grant(ana, "folder", { kind: "human", id: "bo" }, "viewer");
    expect(await allowed(bo, "read", "grandchild")).toBe(true);
    await sharing.grant(ana, "grandchild", { kind: "human", id: "cy" }, "viewer");
    expect(await allowed(cy, "read", "folder")).toBe(false);
    expect(await allowed(cy, "read", "child")).toBe(false);
  });

  test("the strongest role on the path wins, and a lower child grant does not demote", async () => {
    await sharing.grant(ana, "folder", { kind: "human", id: "bo" }, "viewer");
    await sharing.grant(ana, "child", { kind: "human", id: "bo" }, "editor");
    expect(await allowed(bo, "write", "grandchild")).toBe(true);
    expect(await allowed(bo, "write", "folder")).toBe(false);
    await sharing.grant(ana, "folder", { kind: "human", id: "cy" }, "editor");
    await sharing.grant(ana, "child", { kind: "human", id: "cy" }, "viewer");
    expect(await allowed(cy, "write", "child")).toBe(true);
  });

  test("a cycle, a missing parent, and a path over the cap give no inherited access", async () => {
    await store.put("resources", "x", { id: "x", type: "doc", parentId: "y" });
    await store.put("resources", "y", { id: "y", type: "doc", parentId: "x" });
    await store.put("grants", "y:human:bo", { resourceId: "y", subjectKind: "human", subjectId: "bo", role: "owner" });
    expect(await allowed(bo, "read", "x")).toBe(false);
    await store.put("resources", "orphan", { id: "orphan", type: "doc", parentId: "gone" });
    await store.put("grants", "gone:human:bo", { resourceId: "gone", subjectKind: "human", subjectId: "bo", role: "owner" });
    expect(await allowed(bo, "read", "orphan")).toBe(false);
    await sharing.grant(ana, "folder", { kind: "human", id: "bo" }, "viewer");
    let parent = "folder";
    for (let i = 0; i < 20; i++) {
      await store.put("resources", `d${i}`, { id: `d${i}`, type: "doc", parentId: parent });
      parent = `d${i}`;
    }
    expect(await allowed(bo, "read", "d1")).toBe(true);
    expect(await allowed(bo, "read", "d19")).toBe(false);
  });

  test("a new resource needs write on its parent and an existing parent", async () => {
    await expect(sharing.createResource(bo, { type: "doc", parentId: "folder" })).rejects.toThrow();
    await expect(sharing.createResource(ana, { type: "doc", parentId: "nope" })).rejects.toThrow();
    await expect(sharing.createResource(ana, { type: "Bad Type" })).rejects.toThrow();
    await sharing.grant(ana, "folder", { kind: "human", id: "bo" }, "editor");
    const made = await sharing.createResource(bo, { type: "doc", parentId: "folder" });
    expect(await allowed(bo, "admin", made.id)).toBe(true);
  });
});

describe("who can share", () => {
  test("only an owner grants, and the last owner stays", async () => {
    await sharing.grant(ana, "folder", { kind: "human", id: "bo" }, "editor");
    await expect(sharing.grant(bo, "folder", { kind: "human", id: "cy" }, "viewer")).rejects.toThrow();
    await expect(sharing.revokeGrant(ana, "folder", { kind: "human", id: "ana" })).rejects.toThrow();
    await sharing.grant(ana, "folder", { kind: "human", id: "bo" }, "owner");
    await sharing.revokeGrant(bo, "folder", { kind: "human", id: "ana" });
    expect(await allowed(ana, "read", "folder")).toBe(false);
  });

  test("a revoked grant stops access", async () => {
    await sharing.grant(ana, "folder", { kind: "human", id: "bo" }, "viewer");
    await sharing.revokeGrant(ana, "folder", { kind: "human", id: "bo" });
    expect(await allowed(bo, "read", "folder")).toBe(false);
  });

  test("an agent of an owner needs the admin scope to share", async () => {
    await expect(sharing.grant(agentOf("ana", ["doc:write"]), "folder", { kind: "human", id: "bo" }, "viewer")).rejects.toThrow();
    await sharing.grant(agentOf("ana", ["doc:admin"]), "folder", { kind: "human", id: "bo" }, "viewer");
  });
});

describe("invites", () => {
  test("the matching person accepts once, and the grant follows", async () => {
    const invite = await sharing.createInvite(ana, "folder", { role: "editor", email: "Bo@Example.test" });
    await expect(sharing.acceptInvite(cy, invite.id, { email: "cy@example.test" })).rejects.toThrow();
    await sharing.acceptInvite(bo, invite.id, { email: "bo@EXAMPLE.test" });
    expect(await allowed(bo, "write", "child")).toBe(true);
    await expect(sharing.acceptInvite(bo, invite.id, { email: "bo@example.test" })).rejects.toThrow();
  });

  test("an agent accepts a handle invite, and nobody else does", async () => {
    const invite = await sharing.createInvite(ana, "folder", { role: "viewer", handle: "scribe" });
    await expect(sharing.acceptInvite(bo, invite.id, { handle: "scribe" })).rejects.toThrow();
    await expect(sharing.acceptInvite(ownAgent("a9"), invite.id, { handle: "other" })).rejects.toThrow();
    await sharing.acceptInvite(ownAgent("a9"), invite.id, { handle: "scribe" });
    expect(await allowed(ownAgent("a9"), "read", "folder")).toBe(true);
  });

  test("an agent cannot take an email invite, and a delegated agent cannot accept for its owner", async () => {
    const invite = await sharing.createInvite(ana, "folder", { role: "viewer", email: "bo@example.test" });
    await expect(sharing.acceptInvite(ownAgent("a9"), invite.id, { email: "bo@example.test" })).rejects.toThrow();
    await expect(sharing.acceptInvite(agentOf("bo", ["*:admin"]), invite.id, { email: "bo@example.test" })).rejects.toThrow();
  });

  test("an invite expires at its time, is never an owner invite, and needs an owner to make", async () => {
    const invite = await sharing.createInvite(ana, "folder", { role: "viewer", email: "bo@example.test", expiresInMs: 1000 });
    t += 1000;
    await expect(sharing.acceptInvite(bo, invite.id, { email: "bo@example.test" })).rejects.toThrow();
    await expect(sharing.createInvite(ana, "folder", { role: "owner", email: "bo@example.test" })).rejects.toThrow();
    await expect(sharing.createInvite(bo, "folder", { role: "viewer", email: "cy@example.test" })).rejects.toThrow();
    await expect(sharing.createInvite(ana, "folder", { role: "viewer" })).rejects.toThrow();
    await expect(sharing.createInvite(ana, "folder", { role: "viewer", email: "x@example.test", handle: "y" })).rejects.toThrow();
  });

  test("an accepted invite does not lower a stronger role", async () => {
    await sharing.grant(ana, "folder", { kind: "human", id: "bo" }, "editor");
    const invite = await sharing.createInvite(ana, "folder", { role: "viewer", email: "bo@example.test" });
    await sharing.acceptInvite(bo, invite.id, { email: "bo@example.test" });
    expect(await allowed(bo, "write", "folder")).toBe(true);
  });
});

describe("accept pending invites", () => {
  test("takes every live invite for the verified email, and only those", async () => {
    await sharing.createInvite(ana, "folder", { role: "editor", email: "Bo@Example.test" });
    await sharing.createInvite(ana, "child", { role: "viewer", email: "bo@example.test" });
    await sharing.createInvite(ana, "grandchild", { role: "viewer", email: "cy@example.test" });
    await sharing.createInvite(ana, "grandchild", { role: "editor", email: "bo@example.test", expiresInMs: 1000 });
    t += 1000;
    expect((await sharing.acceptPendingInvites(bo, { email: "BO@example.test" })).accepted).toBe(2);
    expect(await allowed(bo, "write", "folder")).toBe(true);
    expect(await allowed(cy, "read", "grandchild")).toBe(false);
    expect((await sharing.acceptPendingInvites(bo, { email: "bo@example.test" })).accepted).toBe(0);
  });

  test("a revoked invite is skipped, and the live one still counts", async () => {
    const revoked = await sharing.createInvite(ana, "folder", { role: "editor", email: "bo@example.test" });
    await sharing.createInvite(ana, "child", { role: "viewer", email: "bo@example.test" });
    await sharing.revokeInvite(ana, revoked.id);
    expect((await sharing.acceptPendingInvites(bo, { email: "bo@example.test" })).accepted).toBe(1);
    expect(await allowed(bo, "read", "folder")).toBe(false);
    expect(await allowed(bo, "read", "child")).toBe(true);
  });

  test("an unverified person, a delegated agent, and an agent with an email get nothing", async () => {
    await sharing.createInvite(ana, "folder", { role: "viewer", email: "bo@example.test" });
    expect((await sharing.acceptPendingInvites(bo, {})).accepted).toBe(0);
    expect((await sharing.acceptPendingInvites(agentOf("bo", ["*:admin"]), { email: "bo@example.test" })).accepted).toBe(0);
    expect((await sharing.acceptPendingInvites(ownAgent("a9"), { email: "bo@example.test" })).accepted).toBe(0);
    expect(await allowed(bo, "read", "folder")).toBe(false);
  });

  test("pages by cursor, so a live invite behind many taken ones is still reached", async () => {
    for (let i = 0; i < 60; i++) {
      const taken = await sharing.createInvite(ana, "folder", { role: "viewer", email: "bo@example.test" });
      await sharing.acceptInvite(bo, taken.id, { email: "bo@example.test" });
    }
    await sharing.createInvite(ana, "child", { role: "editor", email: "bo@example.test" });
    let accepted = 0;
    let pages = 0;
    for (let cursor: string | undefined; ; ) {
      const page = await sharing.acceptPendingInvites(bo, { email: "bo@example.test" }, cursor === undefined ? {} : { cursor });
      accepted += page.accepted;
      pages += 1;
      if ((cursor = page.nextCursor) === undefined) break;
    }
    expect(pages).toBe(2);
    expect(accepted).toBe(1);
    expect(await allowed(bo, "write", "child")).toBe(true);
    await expect(sharing.acceptPendingInvites(bo, { email: "bo@example.test" }, { cursor: 5 as unknown as string })).rejects.toThrow();
  });

  test("a store failure is thrown, not counted as nothing to accept", async () => {
    await sharing.createInvite(ana, "folder", { role: "viewer", email: "bo@example.test" });
    const broken = createSharing({ ...store, transaction: async () => { throw new Error("disk full"); } } as Store, { now: () => t });
    await expect(broken.acceptPendingInvites(bo, { email: "bo@example.test" })).rejects.toThrow("disk full");
  });

  test("an agent takes the invites for its handle, and a stronger role stays", async () => {
    await sharing.createInvite(ana, "folder", { role: "viewer", handle: "scribe" });
    expect((await sharing.acceptPendingInvites(ownAgent("a9"), { handle: "scribe" })).accepted).toBe(1);
    expect(await allowed(ownAgent("a9"), "read", "folder")).toBe(true);
    await sharing.grant(ana, "child", { kind: "human", id: "bo" }, "editor");
    await sharing.createInvite(ana, "child", { role: "viewer", email: "bo@example.test" });
    expect((await sharing.acceptPendingInvites(bo, { email: "bo@example.test" })).accepted).toBe(1);
    expect(await allowed(bo, "write", "child")).toBe(true);
  });
});

describe("links", () => {
  test("the role holds for an anonymous visitor, and a folder link reaches its children", async () => {
    const link = await sharing.createLink(ana, "folder", { role: "viewer" });
    expect(await allowed(null, "read", "grandchild", link.token)).toBe(true);
    expect(await allowed(null, "comment", "grandchild", link.token)).toBe(false);
    expect(await allowed(null, "read", "grandchild")).toBe(false);
    const own = await sharing.createLink(ana, "grandchild", { role: "editor" });
    expect(await allowed(null, "read", "folder", own.token)).toBe(false);
    expect(await allowed(null, "write", "child", own.token)).toBe(false);
  });

  test("an expired, revoked, or changed link fails, and an expiry applies at its exact time", async () => {
    const link = await sharing.createLink(ana, "folder", { role: "viewer", expiresAt: t + 1000 });
    t += 999;
    expect(await allowed(null, "read", "folder", link.token)).toBe(true);
    t += 1;
    expect(await allowed(null, "read", "folder", link.token)).toBe(false);
    const live = await sharing.createLink(ana, "folder", { role: "viewer" });
    expect(await allowed(null, "read", "folder", `${live.token}x`)).toBe(false);
    expect(await allowed(null, "read", "folder", "")).toBe(false);
    await sharing.revokeLink(ana, live.id);
    expect(await allowed(null, "read", "folder", live.token)).toBe(false);
  });

  test("signed-in-only refuses the anonymous and accepts anyone signed in", async () => {
    const link = await sharing.createLink(ana, "folder", { role: "viewer", signedInOnly: true });
    expect(await allowed(null, "read", "folder", link.token)).toBe(false);
    expect(await allowed(cy, "read", "folder", link.token)).toBe(true);
  });

  test("a link never makes an owner, never beats scopes, and is never stored", async () => {
    await expect(sharing.createLink(ana, "folder", { role: "owner" as Role })).rejects.toThrow();
    await expect(sharing.createLink(bo, "folder", { role: "viewer" })).rejects.toThrow();
    const link = await sharing.createLink(ana, "folder", { role: "editor" });
    expect(await allowed(agentOf("cy", ["doc:read"]), "write", "folder", link.token)).toBe(false);
    const stored = JSON.stringify((await store.query("links")).items);
    expect(stored).not.toContain(link.token);
  });

  test.each([["a string", "9999999999999"], ["an object", {}], ["an array", []]])("a stored link with %s as expiry gives nothing", async (_name, bad) => {
    const link = await sharing.createLink(ana, "folder", { role: "viewer" });
    const [entry] = (await store.query("links")).items;
    await store.put("links", entry!.id, { ...entry!.data, expiresAt: bad as never });
    expect(await allowed(null, "read", "folder", link.token)).toBe(false);
  });
});

describe("audit", () => {
  test("entries keep the chain and the machine label, and the anonymous visitor is labeled", async () => {
    const agent = agentOf("ana", ["doc:admin"]);
    await sharing.can(agent, "write", "folder");
    await sharing.can(bo, "write", "folder");
    const link = await sharing.createLink(ana, "folder", { role: "viewer" });
    await sharing.can(null, "read", "folder", { linkToken: link.token });
    const { entries } = await sharing.listAudit(ana, "folder");
    const by = (id: string) => entries.find((e) => e.principalId === id)!;
    expect(by("agent-of-ana")).toMatchObject({ outcome: "allowed", machineMade: true, chain: agent.chain });
    expect(by("bo")).toMatchObject({ outcome: "denied", machineMade: false });
    expect(by("anonymous")).toMatchObject({ principalKind: "anonymous", chain: [], outcome: "allowed" });
  });

  test("an entry holds no email address, and only an owner reads the log", async () => {
    await sharing.createInvite(ana, "folder", { role: "viewer", email: "bo@example.test" });
    expect(JSON.stringify((await store.query("audit")).items)).not.toContain("@");
    await expect(sharing.listAudit(bo, "folder")).rejects.toThrow();
  });
});

describe("an unknown action", () => {
  test.each(["delete", "constructor", "__proto__", "toString", "", "READ", undefined, null, 1, {}])("%s is denied for every caller", async (action) => {
    const link = await sharing.createLink(ana, "folder", { role: "viewer" });
    const callers = [null, ana, bo, agentOf("ana", ["*:admin"]), ownAgent("scribe")];
    for (const ctx of callers) {
      expect((await sharing.can(ctx, action as never, "folder")).allowed).toBe(false);
      expect((await sharing.can(ctx, action as never, "folder", { linkToken: link.token })).allowed).toBe(false);
    }
  });

  test("a known action still works for the same callers", async () => {
    expect(await allowed(null, "read", "folder")).toBe(false);
    expect(await allowed(ana, "admin", "folder")).toBe(true);
  });
});

describe("an expiry that is not a finite time in the future", () => {
  const stored = async (collection: string) => (await store.query(collection)).items.length;
  const bad = [NaN, Infinity, -Infinity, -1, 0, null, "9999999999999", "tomorrow", {}, [], true];

  test.each(bad.map((v) => [String(JSON.stringify(v) ?? v), v]))("a link with expiresAt %s is refused and not stored", async (_name, value) => {
    await expect(sharing.createLink(ana, "folder", { role: "viewer", expiresAt: value as never })).rejects.toThrow();
    expect(await stored("links")).toBe(0);
  });

  test("a link that expires now or in the past is refused, and one in the future works", async () => {
    for (const expiresAt of [t - 1, t]) await expect(sharing.createLink(ana, "folder", { role: "viewer", expiresAt })).rejects.toThrow();
    expect(await stored("links")).toBe(0);
    const link = await sharing.createLink(ana, "folder", { role: "viewer", expiresAt: t + 1 });
    expect(await allowed(null, "read", "folder", link.token)).toBe(true);
  });

  test.each([...bad, 1.5, 2 ** 53].map((v) => [String(JSON.stringify(v) ?? v), v]))("an invite with expiresInMs %s is refused and not stored", async (_name, value) => {
    await expect(sharing.createInvite(ana, "folder", { role: "viewer", handle: "scribe", expiresInMs: value as never })).rejects.toThrow();
    expect(await stored("invites")).toBe(0);
  });

  test("an invite with a whole positive time works", async () => {
    await sharing.createInvite(ana, "folder", { role: "viewer", handle: "scribe", expiresInMs: 1 });
    expect(await stored("invites")).toBe(1);
  });
});
