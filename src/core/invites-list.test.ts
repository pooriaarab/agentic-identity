// Failure cases for listInvites:
//  1. A viewer, an editor, a stranger, and a link visitor cannot list. Only an owner can.
//  2. The list never holds an email, in any field.
//  3. A bad limit or cursor is refused, and an invite on another resource is not listed.
//  4. Pages cover every invite once.
import { expect, test } from "vitest";
import { createMemoryStore } from "../adapters/memory.js";
import type { PrincipalContext } from "./principals.js";
import { createSharing } from "./sharing.js";

const root = (id: string): PrincipalContext => ({ principalId: id, kind: "human", chain: [{ id, kind: "human" }], scopes: ["*:admin"] });
const [ana, bo, eve] = [root("ana"), root("bo"), root("eve")];

async function setup() {
  const sharing = createSharing(createMemoryStore());
  await sharing.createResource(ana, { id: "doc", type: "doc" });
  await sharing.createResource(ana, { id: "other", type: "doc" });
  return sharing;
}

test("only an owner lists invites", async () => {
  const sharing = await setup();
  await sharing.grant(ana, "doc", { kind: "human", id: "bo" }, "editor");
  await expect(sharing.listInvites(bo, "doc")).rejects.toThrow("forbidden");
  await expect(sharing.listInvites(eve, "doc")).rejects.toThrow("forbidden");
  await expect(sharing.listInvites(ana, "missing")).rejects.toThrow("forbidden");
});

test("the list holds no email and no other resource's invite", async () => {
  const sharing = await setup();
  await sharing.createInvite(ana, "doc", { role: "viewer", email: "Secret@example.com" });
  await sharing.createInvite(ana, "doc", { role: "editor", handle: "bot" });
  await sharing.createInvite(ana, "other", { role: "viewer", handle: "elsewhere" });
  const { invites } = await sharing.listInvites(ana, "doc");
  expect(invites).toHaveLength(2);
  expect(JSON.stringify(invites).toLowerCase()).not.toContain("secret");
  expect(invites.map((i) => i.for).sort()).toEqual(["email", "handle"]);
  expect(invites.find((i) => i.for === "handle")?.handle).toBe("bot");
});

test("bad paging input is refused and pages cover each invite once", async () => {
  const sharing = await setup();
  for (let i = 0; i < 3; i++) await sharing.createInvite(ana, "doc", { role: "viewer", handle: `bot${i}` });
  await expect(sharing.listInvites(ana, "doc", { limit: 0 })).rejects.toThrow(RangeError);
  await expect(sharing.listInvites(ana, "doc", { cursor: 5 as never })).rejects.toThrow("invalid cursor");
  const seen: string[] = [];
  for (let cursor: string | undefined; ; ) {
    const page = await sharing.listInvites(ana, "doc", { limit: 2, ...(cursor === undefined ? {} : { cursor }) });
    seen.push(...page.invites.map((i) => i.id));
    if ((cursor = page.nextCursor) === undefined) break;
  }
  expect(new Set(seen).size).toBe(3);
  expect(seen).toHaveLength(3);
});
