// The SDK against the real Worker under `wrangler dev` with a local D1 database. One run walks
// every route the SDK has: keys, delegation, sharing, invites, links, audit, export, and delete.
import { afterAll, beforeAll, expect, test } from "vitest";
import { startWorker } from "./e2e-server.js";
import { ApiError, createClient } from "./sdk.js";

let worker: Awaited<ReturnType<typeof startWorker>>;
beforeAll(async () => {
  worker = await startWorker();
}, 90_000);
afterAll(() => worker?.stop());

const mint = async (userId: string) =>
  ((await (await fetch(`${worker.origin}/api/v1/test/token`, { method: "POST", body: JSON.stringify({ userId }) })).json()) as { token: string }).token;

test("a person, an agent, and a visitor use the whole API through the SDK", async () => {
  const ana = createClient({ baseUrl: worker.origin, token: await mint("ana") });
  expect(await ana.me()).toMatchObject({ principalId: "ana", kind: "human", chain: [{ id: "ana", kind: "human" }] });

  // Keys and delegation. A grant cannot ask for more than its caller has.
  const scribe = await ana.createAgent({ handle: "scribe", scopes: ["doc:read"] });
  const agent = ana.withToken(scribe.apiKey);
  expect(await agent.me()).toMatchObject({ kind: "agent", principalId: scribe.id, scopes: ["doc:read"] });
  const grant = await ana.delegate({ scopes: ["doc:write"], label: "helper", expiresInMs: 600_000 });
  const helper = ana.withToken(grant.apiKey);
  expect(await helper.me()).toMatchObject({ kind: "agent_of_human", scopes: ["doc:write"] });
  const denied = await helper.delegate({ scopes: ["doc:admin"] }).catch((e: unknown) => e);
  expect(denied).toBeInstanceOf(ApiError);
  expect(denied).toMatchObject({ status: 403, reason: "http" });
  const pat = await ana.createToken({ scopes: ["doc:read"], label: "cli" });
  expect(await ana.withToken(pat.token).me()).toMatchObject({ kind: "user_token", scopes: ["doc:read"] });

  // Sharing: a resource, a grant, an invite to a handle, and a link.
  await ana.createResource({ id: "plan", type: "doc" });
  expect(await ana.access("plan", "admin")).toEqual({ allowed: true, role: "owner" });
  expect((await helper.access("plan", "write")).allowed).toBe(true);
  expect((await helper.access("plan", "admin")).allowed).toBe(false);
  expect((await agent.access("plan", "read")).allowed).toBe(false);
  const invite = await ana.createInvite("plan", { role: "viewer", handle: "scribe" });
  await agent.acceptInvite(invite.id);
  expect((await agent.access("plan", "read")).allowed).toBe(true);
  const link = await ana.createLink("plan", { role: "viewer", expiresInMs: 600_000 });
  const visitor = createClient({ baseUrl: worker.origin });
  expect((await visitor.access("plan", "read")).allowed).toBe(false);
  expect((await visitor.access("plan", "read", { linkToken: link.token })).allowed).toBe(true);
  await ana.revokeLink(link.id);
  expect((await visitor.access("plan", "read", { linkToken: link.token })).allowed).toBe(false);
  await ana.createResource({ id: "memo", type: "doc" });
  await ana.grant("memo", { kind: "agent", id: scribe.id }, "editor");
  expect((await agent.access("memo", "write")).allowed).toBe(false);
  await ana.revokeGrant("memo", { kind: "agent", id: scribe.id });

  // The audit log holds the chain, and only an owner reads it.
  const log = await ana.audit("plan");
  expect(log.entries.length).toBeGreaterThan(3);
  expect(log.entries.some((e) => e.principalKind === "agent_of_human" && e.machineMade)).toBe(true);
  const first = await ana.audit("plan", { limit: 2 });
  expect(first.entries).toHaveLength(2);
  expect(first.nextCursor).toBeDefined();
  const second = await ana.audit("plan", { limit: 2, cursor: first.nextCursor! });
  expect(second.entries.map((e) => e.id)).not.toContain(first.entries[0]!.id);
  expect(await agent.audit("plan").catch((e: unknown) => (e as ApiError).status)).toBe(403);

  // Revoking a principal stops its key. A bad key is a 401.
  await ana.revokePrincipal(grant.id);
  expect(await helper.me().catch((e: unknown) => (e as ApiError).status)).toBe(401);
  expect(await createClient({ baseUrl: worker.origin, token: "aid_nope" }).me().catch((e: unknown) => (e as ApiError).status)).toBe(401);

  // Export and delete need the person, and a delete ends the session.
  expect(await agent.exportMe().catch((e: unknown) => (e as ApiError).status)).toBe(403);
  const exported = (await ana.exportMe()) as { user: unknown; principals: unknown[] };
  expect(exported.principals.length).toBeGreaterThan(1);
  expect(await ana.deleteMe()).toEqual({ deleted: true });
  expect(await ana.me().catch((e: unknown) => (e as ApiError).status)).toBe(401);
}, 120_000);
