// Failure cases for the lifecycle commands. Each is a way a command could give a power the actor lacks.
//  1. principals revoke: an unknown id is "not found". A stranger, a viewer on the agent's resource, a token
//     of the owner, and the agent itself cannot revoke it. The owner can, and the agent and its child stop working.
//  2. keys rotate: a stranger cannot. A person, a token, and a revoked agent are "bad principal".
//     The old key stops, exactly one new key works, and the audit entry holds no key.
//  3. resources delete: a non-owner cannot, and nothing is removed. A resource with children is refused.
//  4. account export: an agent, a delegated agent, and a token cannot. It never overwrites a file. It writes
//     one private zip with a manifest, and the command result holds no email.
//  5. account erase: it needs --yes, and only the person. Another person's data stays.
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { createMemoryStore } from "./adapters/memory.js";
import { COMMANDS, UsageError, openApp, type Args } from "./commands.js";
import { createStoreAuth, issueCredential } from "./credentials.js";

const find = (...path: string[]) => COMMANDS.find((c) => c.path.join(" ") === path.join(" "))!;
async function setup() {
  const store = createMemoryStore();
  const as = async (id?: string) => openApp(store, { ...(id === undefined ? {} : { as: id }), now: () => 1_000 });
  const run = async (id: string | undefined, command: string[], args: Args) => find(...command).run(await as(id), args);
  await as();
  await store.put("principals", "eve", { id: "eve", kind: "human", scopes: ["*:admin"] });
  const agent = (await run(undefined, ["agents", "create"], { handle: "helper", scopes: ["doc:admin"] })) as { id: string };
  const key = await issueCredential(store, { principalId: agent.id, kind: "api_key", label: "helper" });
  const alive = async (token: string) => (await createStoreAuth(store, { now: () => 2_000 }).authenticate(new Request("https://x.test", { headers: { authorization: `Bearer ${token}` } }))) !== null;
  return { store, run, agent: agent.id, key, alive };
}
const auditActions = async (store: ReturnType<typeof createMemoryStore>) => (await store.query("audit")).items.map((i) => i.data.action);

test("principals revoke stops the principal and its children, for its owner only", async () => {
  const { store, run, agent, key, alive } = await setup();
  await store.put("principals", "child", { id: "child", kind: "agent_of_agent", parentId: agent, scopes: ["doc:read"] });
  await store.put("principals", "tok", { id: "tok", kind: "user_token", parentId: "local", scopes: ["doc:read"] });
  const childKey = await issueCredential(store, { principalId: "child", kind: "api_key" });
  await expect(run(undefined, ["principals", "revoke"], { principal: "nope" })).rejects.toThrow("not found");
  for (const who of ["eve", "tok", agent]) await expect(run(who, ["principals", "revoke"], { principal: agent })).rejects.toThrow(/forbidden/);
  expect(await alive(key)).toBe(true);
  await expect(run(undefined, ["principals", "revoke"], { principal: agent })).resolves.toEqual({ revoked: agent });
  expect(await alive(key)).toBe(false);
  expect(await alive(childKey)).toBe(false);
  expect(await auditActions(store)).toContain("key.revoke");
});

test("keys rotate gives one new key, stops the old one, and refuses what is not an agent", async () => {
  const { store, run, agent, key, alive } = await setup();
  await store.put("principals", "tok", { id: "tok", kind: "user_token", parentId: "local", scopes: ["doc:read"] });
  await store.put("principals", "dead", { id: "dead", kind: "agent", scopes: [], ownerId: "local", revokedAt: 10 });
  await expect(run("eve", ["keys", "rotate"], { principal: agent })).rejects.toThrow("forbidden");
  await expect(run(undefined, ["keys", "rotate"], { principal: "local" })).rejects.toThrow("forbidden");
  for (const id of ["tok", "dead"]) await expect(run(undefined, ["keys", "rotate"], { principal: id }), id).rejects.toThrow("bad principal");
  expect(await alive(key)).toBe(true);
  const rotated = (await run(undefined, ["keys", "rotate"], { principal: agent })) as { id: string; apiKey: string };
  expect(rotated.id).toBe(agent);
  expect(await alive(key)).toBe(false);
  expect(await alive(rotated.apiKey)).toBe(true);
  expect(JSON.stringify((await store.query("audit")).items)).not.toContain(rotated.apiKey);
  expect(await auditActions(store)).toContain("key.rotate");
});

test("resources delete needs an owner and refuses a resource with children", async () => {
  const { store, run, agent } = await setup();
  await run(undefined, ["resources", "create"], { type: "folder", id: "dir" });
  await run(undefined, ["resources", "create"], { type: "doc", id: "leaf", parent: "dir" });
  await expect(run("eve", ["resources", "delete"], { resource: "leaf" })).rejects.toThrow("forbidden");
  await expect(run(agent, ["resources", "delete"], { resource: "leaf" })).rejects.toThrow("forbidden");
  await expect(run(undefined, ["resources", "delete"], { resource: "dir" })).rejects.toThrow("children");
  expect(await store.get("resources", "leaf")).not.toBeNull();
  await expect(run(undefined, ["resources", "delete"], { resource: "leaf" })).resolves.toEqual({ deleted: true });
  await expect(run(undefined, ["resources", "delete"], { resource: "dir" })).resolves.toEqual({ deleted: true });
  expect(await store.get("resources", "dir")).toBeNull();
});

test("account export is for the person, never overwrites, and holds the record of itself", async () => {
  const { store, run, agent } = await setup();
  await store.put("users", "local", { id: "local", email: "secret@example.test", emailVerified: true });
  await store.put("principals", "d1", { id: "d1", kind: "agent_of_human", parentId: "local", scopes: ["doc:read"] });
  await store.put("principals", "t1", { id: "t1", kind: "user_token", parentId: "local", scopes: ["doc:read"] });
  const out = join(mkdtempSync(join(tmpdir(), "ai-acct-")), "me.zip");
  for (const who of [agent, "d1", "t1"]) await expect(run(who, ["account", "export"], { out }), who).rejects.toThrow("only the person");
  await expect(run(undefined, ["account", "export"], {})).rejects.toThrow(UsageError);
  const done = (await run(undefined, ["account", "export"], { out })) as { file: string; bytes: number; manifest: { apps: { id: string; files: { path: string }[] }[] } };
  expect(JSON.stringify(done)).not.toContain("secret@");
  expect(done.manifest.apps).toMatchObject([{ id: "identity", files: [{ path: "identity.json" }] }]);
  expect(statSync(out).mode & 0o777).toBe(0o600);
  expect(statSync(out).size).toBe(done.bytes);
  expect(readFileSync(out).subarray(0, 2).toString()).toBe("PK");
  expect(readFileSync(out).includes("person.export")).toBe(true);
  const before = readFileSync(out);
  await expect(run(undefined, ["account", "export"], { out })).rejects.toThrow("the file exists");
  expect(readFileSync(out).equals(before)).toBe(true);
  await expect(run(undefined, ["account", "export"], { out: join(out, "no", "dir.zip") })).rejects.toThrow("could not write");
});

test("account erase needs --yes and the person, and leaves another person's data", async () => {
  const { store, run, agent } = await setup();
  await run(undefined, ["resources", "create"], { type: "doc", id: "mine" });
  await run("eve", ["resources", "create"], { type: "doc", id: "hers" });
  await expect(run(agent, ["account", "erase"], { yes: true })).rejects.toThrow("only the person");
  await expect(run(undefined, ["account", "erase"], {})).rejects.toThrow(UsageError);
  await expect(run(undefined, ["account", "erase"], { yes: false })).rejects.toThrow("--yes");
  expect(await store.get("principals", "local")).not.toBeNull();
  const done = (await run(undefined, ["account", "erase"], { yes: true })) as { erased: boolean; results: unknown[] };
  expect(done).toMatchObject({ erased: true, results: [{ appId: "identity", ok: true, audited: true }] });
  for (const [collection, id] of [["principals", "local"], ["principals", agent], ["resources", "mine"]] as const) expect(await store.get(collection, id), `${collection}/${id}`).toBeNull();
  expect(await store.get("resources", "hers")).not.toBeNull();
  expect(await store.get("principals", "eve")).not.toBeNull();
  // No entry of the erase names the person.
  expect(JSON.stringify((await store.query("audit")).items)).not.toContain('"local"');
});
