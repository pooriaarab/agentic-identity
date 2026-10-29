// Failure cases for revokeInvite:
//  1. A viewer, an editor, a stranger, and an unknown invite id cannot revoke. Only an owner can.
//     The owner of another resource cannot revoke this resource's invite.
//  2. A revoked invite cannot be accepted, for a handle and for an email.
//  3. An invite that was accepted cannot be revoked: the grant stays, so the call says so.
//  4. A second revoke changes nothing and writes no second audit entry.
//  5. A revoke writes one audit entry that holds no email, and the list shows `revokedAt`.
//  6. An invite that an erase removed in between is not put back.
import { expect, test } from "vitest";
import { createMemoryStore } from "../adapters/memory.js";
import type { PrincipalContext } from "./principals.js";
import { createSharing } from "./sharing.js";

const root = (id: string): PrincipalContext => ({ principalId: id, kind: "human", chain: [{ id, kind: "human" }], scopes: ["*:admin"] });
const [ana, bo, eve] = [root("ana"), root("bo"), root("eve")];
const agent: PrincipalContext = { principalId: "bot1", kind: "agent", chain: [{ id: "bot1", kind: "agent" }], scopes: ["doc:read"] };

async function setup() {
  const store = createMemoryStore();
  const sharing = createSharing(store, { now: () => 5_000 });
  await sharing.createResource(ana, { id: "doc", type: "doc" });
  await sharing.createResource(eve, { id: "evedoc", type: "doc" });
  return { store, sharing };
}

test("only an owner of the resource revokes", async () => {
  const { sharing } = await setup();
  await sharing.grant(ana, "doc", { kind: "human", id: "bo" }, "editor");
  const { id } = await sharing.createInvite(ana, "doc", { role: "viewer", handle: "bot1" });
  for (const who of [bo, root("vic"), eve]) await expect(sharing.revokeInvite(who, id)).rejects.toThrow("forbidden");
  await expect(sharing.revokeInvite(ana, "missing")).rejects.toThrow("forbidden");
  await expect(sharing.acceptInvite(agent, id, { handle: "bot1" })).resolves.toBeUndefined();
});

test("a revoked invite cannot be accepted", async () => {
  const { sharing } = await setup();
  const byHandle = await sharing.createInvite(ana, "doc", { role: "viewer", handle: "bot1" });
  const byEmail = await sharing.createInvite(ana, "doc", { role: "viewer", email: "cy@example.test" });
  await sharing.revokeInvite(ana, byHandle.id);
  await sharing.revokeInvite(ana, byEmail.id);
  await expect(sharing.acceptInvite(agent, byHandle.id, { handle: "bot1" })).rejects.toThrow("forbidden");
  await expect(sharing.acceptInvite(root("cy"), byEmail.id, { email: "cy@example.test" })).rejects.toThrow("forbidden");
  expect((await sharing.can(agent, "read", "doc")).allowed).toBe(false);
});

test("an accepted invite is not revoked, and a second revoke does nothing", async () => {
  const { sharing } = await setup();
  const accepted = await sharing.createInvite(ana, "doc", { role: "viewer", handle: "bot1" });
  await sharing.acceptInvite(agent, accepted.id, { handle: "bot1" });
  await expect(sharing.revokeInvite(ana, accepted.id)).rejects.toThrow("already accepted");
  const open = await sharing.createInvite(ana, "doc", { role: "viewer", handle: "bot2" });
  await sharing.revokeInvite(ana, open.id);
  await sharing.revokeInvite(ana, open.id);
  const { entries } = await sharing.listAudit(ana, "doc");
  expect(entries.filter((e) => e.action === ("invite.revoke" as never))).toHaveLength(1);
});

test("the audit entry and the list hold no email, and the list shows the revoke", async () => {
  const { sharing } = await setup();
  const { id } = await sharing.createInvite(ana, "doc", { role: "viewer", email: "Secret@example.com" });
  await sharing.revokeInvite(ana, id);
  expect(JSON.stringify((await sharing.listAudit(ana, "doc")).entries).toLowerCase()).not.toContain("secret");
  const { invites } = await sharing.listInvites(ana, "doc");
  expect(invites).toMatchObject([{ id, for: "email", revokedAt: 5_000 }]);
  expect(JSON.stringify(invites).toLowerCase()).not.toContain("secret");
});

test("an invite that an erase removed is not put back", async () => {
  const { store, sharing } = await setup();
  const { id } = await sharing.createInvite(ana, "doc", { role: "viewer", handle: "bot1" });
  await store.delete("invites", id);
  await expect(sharing.revokeInvite(ana, id)).rejects.toThrow("forbidden");
  expect(await store.get("invites", id)).toBeNull();
});
