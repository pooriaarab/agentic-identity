// Failure-mode list for the Worker API. These tests were written before the code.
// They call the real handler with a real store. Sign-in comes in a later change.
//  1. A key is shown once, stored as a hash, and a wrong key fails. A duplicate handle, and an
//     agent or a token that makes an agent, fail. 2. A grant wider than its caller, and a token
//     that delegates, fail. 3. Revoking a parent stops every child, and only the owner can.
//  4. An expired grant, a stored time of the wrong type, and the test mint without its flag give
//     no access. 5. A bad credential on the access check is a 401, never a visitor. 6. A narrow
//     agent cannot write, a revoked link fails, an invite goes to its own handle or verified
//     email only, and only an owner reads the audit log.
import { describe, expect, test } from "vitest";
import { createMemoryStore } from "./adapters/memory.js";
import type { Principal } from "./core/principals.js";
import { createStoreAuth, issueCredential, revokeCredential } from "./credentials.js";
import { runAuthContract } from "./testing.js";
import { createApp } from "./worker.js";
let t = 1_000_000_000;

async function setup(extra: { unsafeTestMint?: boolean } = {}) {
  const store = createMemoryStore();
  const app = createApp({ store, now: () => t, config: { unsafeTestMint: false, ...extra } });
  const call = (method: string, path: string, opts: { token?: string; body?: unknown } = {}) =>
    app.request(`/api/v1${path}`, {
      method,
      headers: { ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}), "content-type": "application/json" },
      ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
    });
  const mint = async (userId: string) => ((await (await call("POST", "/test/token", { body: { userId } })).json()) as { token: string }).token;
  return { store, app, call, mint };
}

describe("test mint", () => {
  test("is off unless the flag is on", async () => {
    expect((await (await setup()).call("POST", "/test/token", { body: { userId: "x" } })).status).toBe(404);
    const on = await setup({ unsafeTestMint: true });
    expect((await on.call("POST", "/test/token", { body: { userId: "x" } })).status).toBe(200);
  });
});

describe("keys and delegation", () => {
  const post = (s: Awaited<ReturnType<typeof setup>>, token: string, path: string, body: unknown) => s.call("POST", path, { token, body });
  const json = async (res: Response) => (await res.json()) as Record<string, string>;
  async function world() {
    const s = await setup({ unsafeTestMint: true });
    return { s, ana: await s.mint("ana"), bo: await s.mint("bo") };
  }

  test("an agent key is shown once, stored as a hash, and works; another key does not", async () => {
    const { s, ana } = await world();
    const agent = await json(await post(s, ana, "/agents", { handle: "scribe", scopes: ["doc:write"] }));
    const me = await json(await s.call("GET", "/me", { token: agent.apiKey! }));
    expect(me).toMatchObject({ kind: "agent", principalId: agent.id });
    expect(JSON.stringify((await s.store.query("credentials")).items)).not.toContain(agent.apiKey);
    expect((await s.call("GET", "/me", { token: `${agent.apiKey}x` })).status).toBe(401);
    expect((await post(s, ana, "/agents", { handle: "scribe", scopes: [] })).status).toBe(409);
    expect((await post(s, agent.apiKey!, "/agents", { handle: "x", scopes: [] })).status).toBe(403);
    expect((await s.call("POST", "/agents", { body: { handle: "y", scopes: [] } })).status).toBe(401);
  });

  test("a personal token acts as the user, tagged as a token, with narrower scopes", async () => {
    const { s, ana } = await world();
    const pat = await json(await post(s, ana, "/tokens", { scopes: ["doc:read"], label: "cli" }));
    const me = (await (await s.call("GET", "/me", { token: pat.token! })).json()) as { kind: string; chain: { id: string }[]; scopes: string[] };
    expect(me).toMatchObject({ kind: "user_token", scopes: ["doc:read"] });
    expect(me.chain.map((c) => c.id)[0]).toBe("ana");
    expect((await post(s, pat.token!, "/delegations", { scopes: ["doc:read"] })).status).toBe(403);
  });

  test("a grant cannot ask for more than its caller has", async () => {
    const { s, ana } = await world();
    const small = await json(await post(s, ana, "/delegations", { scopes: ["doc:read"] }));
    expect((await post(s, small.apiKey!, "/delegations", { scopes: ["doc:write"] })).status).toBe(403);
    expect((await post(s, small.apiKey!, "/delegations", { scopes: ["sheet:read"] })).status).toBe(403);
    expect((await post(s, small.apiKey!, "/delegations", { scopes: ["doc:read"] })).status).toBe(200);
  });

  test("revoking a parent stops every key below it, and only the parent's owner can", async () => {
    const { s, ana, bo } = await world();
    const first = await json(await post(s, ana, "/delegations", { scopes: ["doc:write"], label: "a" }));
    const second = await json(await post(s, first.apiKey!, "/delegations", { scopes: ["doc:read"] }));
    expect(second.id).toBeDefined();
    expect((await s.call("DELETE", `/principals/${first.id}`, { token: bo })).status).toBe(403);
    expect((await s.call("DELETE", `/principals/${first.id}`, { token: second.apiKey! })).status).toBe(403);
    expect((await s.call("DELETE", `/principals/${first.id}`, { token: ana })).status).toBe(200);
    for (const key of [first.apiKey!, second.apiKey!]) expect((await s.call("GET", "/me", { token: key })).status).toBe(401);
    expect((await s.call("GET", "/me", { token: ana })).status).toBe(200);
  });

  test.each([["revokedAt", "2026-01-01"], ["expiresAt", "2099-01-01"]])("a credential with %s of the wrong type gives no access", async (field, bad) => {
    const { s, ana } = await world();
    for (const entry of (await s.store.query("credentials")).items) await s.store.put("credentials", entry.id, { ...entry.data, [field]: bad });
    expect((await s.call("GET", "/me", { token: ana })).status).toBe(401);
  });

  test("a grant stops at its expiry", async () => {
    const { s, ana } = await world();
    const grant = await json(await post(s, ana, "/delegations", { scopes: ["doc:read"], expiresInMs: 1000 }));
    expect((await s.call("GET", "/me", { token: grant.apiKey! })).status).toBe(200);
    t += 1000;
    expect((await s.call("GET", "/me", { token: grant.apiKey! })).status).toBe(401);
  });
});

// The store-backed Auth passes the same contract as the memory one.
describe("sharing over HTTP", () => {
  const json = async (res: Response) => (await res.json()) as Record<string, string>;
  const access = async (s: Awaited<ReturnType<typeof setup>>, id: string, action: string, headers: Record<string, string> = {}) => {
    const res = await s.app.request(`/api/v1/resources/${id}/access?action=${action}`, { headers });
    return { status: res.status, allowed: ((await res.json()) as { allowed?: boolean }).allowed };
  };
  const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
  async function world() {
    const s = await setup({ unsafeTestMint: true });
    const [ana, bo] = [await s.mint("ana"), await s.mint("bo")];
    await s.call("POST", "/resources", { token: ana, body: { id: "plan", type: "doc" } });
    return { s, ana, bo };
  }

  test("an outsider is denied, a grant opens the door, and a narrow agent stays narrow", async () => {
    const { s, ana, bo } = await world();
    expect(await access(s, "plan", "read", bearer(bo))).toEqual({ status: 200, allowed: false });
    await s.call("POST", "/resources/plan/grants", { token: ana, body: { subjectKind: "human", subjectId: "bo", role: "editor" } });
    expect((await access(s, "plan", "write", bearer(bo))).allowed).toBe(true);
    const small = await json(await s.call("POST", "/delegations", { token: bo, body: { scopes: ["doc:read"] } }));
    expect((await access(s, "plan", "write", bearer(small.apiKey!))).allowed).toBe(false);
    expect((await access(s, "plan", "read", bearer(small.apiKey!))).allowed).toBe(true);
    expect((await s.call("POST", "/resources/plan/grants", { token: bo, body: { subjectKind: "human", subjectId: "cy", role: "viewer" } })).status).toBe(403);
    for (const bad of [{ subjectId: "bo", role: "viewer" }, { subjectKind: "user_token", subjectId: "bo", role: "viewer" }, { subjectKind: "human", role: "viewer" }, { subjectKind: "human", subjectId: 5, role: "viewer" }]) {
      expect((await s.call("POST", "/resources/plan/grants", { token: ana, body: bad })).status).toBe(400);
    }
    expect((await s.call("DELETE", "/resources/plan/grants/bo", { token: ana })).status).toBe(404);
    await s.call("DELETE", "/resources/plan/grants/human/bo", { token: ana });
    expect((await access(s, "plan", "read", bearer(bo))).allowed).toBe(false);
  });

  test("a bad credential is a 401, and no credential is an anonymous visitor", async () => {
    const { s } = await world();
    expect((await access(s, "plan", "read", bearer("aid_nope"))).status).toBe(401);
    expect(await access(s, "plan", "read")).toEqual({ status: 200, allowed: false });
    expect((await access(s, "plan", "nonsense")).status).toBe(400);
  });

  test("a link token works from a header until it is revoked", async () => {
    const { s, ana } = await world();
    const link = await json(await s.call("POST", "/resources/plan/links", { token: ana, body: { role: "viewer" } }));
    expect((await access(s, "plan", "read", { "x-link-token": link.token! })).allowed).toBe(true);
    expect((await access(s, "plan", "write", { "x-link-token": link.token! })).allowed).toBe(false);
    await s.call("DELETE", `/links/${link.id}`, { token: ana });
    expect((await access(s, "plan", "read", { "x-link-token": link.token! })).allowed).toBe(false);
  });

  test("an invite reaches only the matching handle or verified email", async () => {
    const { s, ana, bo } = await world();
    const agent = await json(await s.call("POST", "/agents", { token: bo, body: { handle: "scribe", scopes: ["doc:read"] } }));
    const byHandle = await json(await s.call("POST", "/resources/plan/invites", { token: ana, body: { role: "viewer", handle: "scribe" } }));
    expect((await s.call("POST", `/invites/${byHandle.id}/accept`, { token: bo })).status).toBe(403);
    expect((await s.call("POST", `/invites/${byHandle.id}/accept`, { token: agent.apiKey! })).status).toBe(200);
    expect((await access(s, "plan", "read", bearer(agent.apiKey!))).allowed).toBe(true);
    const byEmail = await json(await s.call("POST", "/resources/plan/invites", { token: ana, body: { role: "viewer", email: "cy@example.test" } }));
    const cy = await s.mint("cy");
    await s.store.put("users", "cy", { id: "cy", email: "cy@example.test", emailVerified: true });
    expect((await s.call("POST", `/invites/${byEmail.id}/accept`, { token: bo })).status).toBe(403);
    expect((await s.call("POST", `/invites/${byEmail.id}/accept`, { token: cy })).status).toBe(200);
  });

  test("only an owner reads the audit log, and it holds the chain", async () => {
    const { s, ana, bo } = await world();
    await access(s, "plan", "read", bearer(bo));
    expect((await s.call("GET", "/resources/plan/audit", { token: bo })).status).toBe(403);
    const log = (await (await s.call("GET", "/resources/plan/audit", { token: ana })).json()) as { entries: { principalId: string; outcome: string; chain: unknown[] }[] };
    expect(log.entries.find((e) => e.principalId === "bo")).toMatchObject({ principalId: "bo", outcome: "denied", chain: [{ id: "bo", kind: "human" }] });
  });
});

describe("audit paging", () => {
  type Page = { entries: { id: string; at: number }[]; nextCursor?: string };
  async function logged() {
    const s = await setup({ unsafeTestMint: true });
    const ana = await s.mint("ana");
    const bo = await s.mint("bo");
    await s.call("POST", "/resources", { token: ana, body: { id: "plan", type: "doc" } });
    const start = t;
    for (let i = 0; i < 7; i++) {
      t = start + i;
      await s.call("GET", "/resources/plan/access?action=read", { token: bo });
    }
    t = start + 100;
    const read = async (query: string) => s.call("GET", `/resources/plan/audit${query}`, { token: ana });
    return { s, ana, bo, read, start };
  }

  test("lists the newest entry first, and pages never repeat or skip an entry", async () => {
    const { read } = await logged();
    const all = (await (await read("")).json()) as Page;
    expect(all.entries).toHaveLength(7);
    expect(all.nextCursor).toBeUndefined();
    expect(all.entries.map((e) => e.at)).toEqual([...all.entries.map((e) => e.at)].sort((a, b) => b - a));
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = (await (await read(`?limit=3${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`)).json()) as Page;
      expect(page.entries.length).toBeLessThanOrEqual(3);
      seen.push(...page.entries.map((e) => e.id));
      cursor = page.nextCursor;
      pages++;
    } while (cursor);
    expect(pages).toBe(3);
    expect(seen).toEqual(all.entries.map((e) => e.id));
  });

  test.each(["limit=0", "limit=-1", "limit=1.5", "limit=abc", "limit=201", "limit=", "cursor=not-a-cursor"])("%s is a 400", async (query) => {
    const { read } = await logged();
    expect((await read(`?${query}`)).status).toBe(400);
  });

  test("a page by a non-owner is still refused", async () => {
    const { s, bo } = await logged();
    expect((await s.call("GET", "/resources/plan/audit?limit=1", { token: bo })).status).toBe(403);
  });
});

runAuthContract((options) => {
  const store = createMemoryStore();
  const now = options.now ?? (() => t);
  return {
    auth: createStoreAuth(store, { now }),
    async issue(context, opts) {
      const { chain, scopes } = context;
      for (const [i, step] of chain.entries()) {
        const principal: Principal = { id: step.id, kind: step.kind, scopes: i === 0 && chain.length > 1 ? ["*:admin"] : scopes, ...(i > 0 ? { parentId: chain[i - 1]!.id } : {}) };
        await store.put("principals", step.id, principal as never);
      }
      return issueCredential(store, { principalId: context.principalId, kind: "api_key", ...(opts?.expiresAt === undefined ? {} : { expiresAt: opts.expiresAt }) });
    },
    revoke: (credential) => revokeCredential(store, credential, now()),
  };
});
