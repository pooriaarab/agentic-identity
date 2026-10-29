// Failure-mode list for the Worker's open doors. These tests were written before the code.
// They call the real handler with a real store.
//  1. The test mint: it never overwrites a principal or a user, never gives `*:admin`, never
//     marks an email as verified, and a production config (a region, or an https URL) cannot turn it on.
//  2. `POST /agents` cannot make an agent with more rights than its maker.
//  3. Rate limits: a principal (counted at the root of its chain) and an IP each have a budget on
//     write and auth routes, and on the anonymous access check. Over budget is a 429 with a
//     `Retry-After`, and the request does nothing. A new window restores the budget. A bad
//     counter row or a failing store denies. A counter row holds no IP address.
import { describe, expect, test } from "vitest";
import { createMemoryStore } from "./adapters/memory.js";
import type { Store, StoreOps } from "./ports.js";
import { createApp, unsafeMintEnvError } from "./worker.js";

let t = 1_000_000_000;
const WINDOW = 60_000;
type Limits = { principal?: { limit: number; windowMs: number }; ip?: { limit: number; windowMs: number }; login?: { limit: number; windowMs: number } };
const roomy = { limit: 10_000, windowMs: WINDOW };

function setup(rateLimits: Limits = {}, store: Store = createMemoryStore()) {
  const app = createApp({ store, now: () => t, config: { unsafeTestMint: true, rateLimits: { principal: roomy, ip: roomy, login: roomy, ...rateLimits } } });
  const call = (method: string, path: string, opts: { token?: string; body?: unknown; ip?: string } = {}) =>
    app.request(`/api/v1${path}`, {
      method,
      headers: { ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}), ...(opts.ip ? { "cf-connecting-ip": opts.ip } : {}), "content-type": "application/json" },
      ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
    });
  const json = async (res: Response) => (await res.json()) as Record<string, any>;
  const mint = async (userId: string, extra: { scopes?: string[]; email?: string } = {}) => (await json(await call("POST", "/test/token", { body: { userId, ...extra } }))).token as string;
  return { store, app, call, json, mint };
}

describe("the test mint", () => {
  test("is off unless its flag is on", async () => {
    const app = createApp({ store: createMemoryStore(), now: () => t, config: { unsafeTestMint: false } });
    expect((await app.request("/api/v1/test/token", { method: "POST", body: JSON.stringify({ userId: "x" }) })).status).toBe(404);
  });

  test("never overwrites a principal or a user that exists", async () => {
    const s = setup();
    const ana = await s.mint("ana", { scopes: ["doc:admin"] });
    const agent = await s.json(await s.call("POST", "/agents", { token: ana, body: { handle: "scribe", scopes: ["doc:read"] } }));
    await s.store.put("users", "u_real", { id: "u_real", email: "real@example.test", emailVerified: true });
    const before = JSON.stringify([await s.store.get("principals", "ana"), await s.store.get("principals", agent.id)]);
    for (const userId of ["ana", agent.id, "u_real"]) {
      const res = await s.call("POST", "/test/token", { body: { userId, email: "victim@example.test", scopes: ["doc:admin"] } });
      expect(res.status).toBe(409);
      expect(JSON.stringify(await res.json())).not.toContain("aid_");
    }
    expect(JSON.stringify([await s.store.get("principals", "ana"), await s.store.get("principals", agent.id)])).toBe(before);
    expect(await s.store.get("users", "u_real")).toMatchObject({ email: "real@example.test", emailVerified: true });
    expect((await s.call("GET", "/me", { token: agent.apiKey })).status).toBe(200);
  });

  test("never gives *:admin, and the default is narrow", async () => {
    const s = setup();
    for (const scopes of [["*:admin"], ["doc:read", "*:admin"], ["nonsense"], "doc:read", []]) {
      const res = await s.call("POST", "/test/token", { body: { userId: "x", scopes } });
      expect(res.status === 400 || res.status === 403).toBe(true);
    }
    expect(await s.store.get("principals", "x")).toBeNull();
    expect((await s.json(await s.call("GET", "/me", { token: await s.mint("ana") }))).scopes).toEqual(["doc:admin"]);
    expect((await s.json(await s.call("GET", "/me", { token: await s.mint("bo", { scopes: ["*:write"] }) }))).scopes).toEqual(["*:write"]);
  });

  test.each([
    ["a nested list", [["*:admin"]]],
    ["a nested list next to a good scope", ["doc:read", ["*:admin"]]],
    ["a deeply nested list", [[["*:admin"]]]],
    ["an object", [{ toString: (): string => "*:admin" }]],
    ["an object with the scope as a key", [{ "*:admin": true }]],
    ["a number", [1]],
    ["null", [null]],
    ["a boolean", [true]],
    ["upper case", ["*:ADMIN"]],
    ["mixed case", ["*:Admin"]],
    ["a leading space", [" *:admin"]],
    ["a trailing space", ["*:admin "]],
    ["a tab", ["*:admin\t"]],
    ["a newline", ["*:admin\n"]],
    ["a zero-width character", ["*:\u200badmin"]],
    ["a full-width star", ["\uff0a:admin"]],
    ["too many scopes", Array.from({ length: 33 }, () => "doc:read")],
    ["a scope that is too long", [`${"a".repeat(80)}:read`]],
  ])("refuses %s as scopes before it stores or normalizes anything", async (_name, scopes) => {
    const s = setup();
    const res = await s.call("POST", "/test/token", { body: { userId: "x", scopes } });
    expect(res.status).toBe(400);
    expect(await s.store.get("principals", "x")).toBeNull();
  });

  test.each([
    ["a nested list", [["doc:read"]]],
    ["an object", [{ toString: (): string => "doc:read" }]],
    ["upper case", ["DOC:read"]],
  ])("refuses %s as scopes on /agents, /tokens, and /delegations", async (_name, scopes) => {
    const s = setup();
    const ana = await s.mint("ana");
    for (const [path, extra] of [["/agents", { handle: "scribe" }], ["/tokens", {}], ["/delegations", {}]] as const) {
      expect((await s.call("POST", path, { token: ana, body: { ...extra, scopes } })).status).toBe(400);
    }
  });

  test("never marks an email as verified, so it cannot accept an email invite", async () => {
    const s = setup();
    const [ana, cy] = [await s.mint("ana"), await s.mint("cy", { email: "CY@example.test" })];
    expect(await s.store.get("users", "cy")).toMatchObject({ email: "cy@example.test", emailVerified: false });
    await s.call("POST", "/resources", { token: ana, body: { id: "plan", type: "doc" } });
    const invite = await s.json(await s.call("POST", "/resources/plan/invites", { token: ana, body: { role: "viewer", email: "cy@example.test" } }));
    expect((await s.call("POST", `/invites/${invite.id}/accept`, { token: cy })).status).toBe(403);
  });

  test("marks an email as verified only when the body asks, so a test can accept an email invite", async () => {
    const s = setup();
    const ana = await s.mint("ana");
    const res = await s.call("POST", "/test/token", { body: { userId: "dee", email: "Dee@example.test", emailVerified: true } });
    const dee = (await s.json(res)).token as string;
    expect(await s.store.get("users", "dee")).toMatchObject({ email: "dee@example.test", emailVerified: true });
    expect((await s.call("POST", "/test/token", { body: { userId: "eve", email: "e@example.test", emailVerified: "yes" } })).status).toBe(400);
    expect((await s.call("POST", "/test/token", { body: { userId: "fay", emailVerified: true } })).status).toBe(400);
    await s.call("POST", "/resources", { token: ana, body: { id: "plan", type: "doc" } });
    const invite = await s.json(await s.call("POST", "/resources/plan/invites", { token: ana, body: { role: "viewer", email: "dee@example.test" } }));
    expect((await s.call("POST", `/invites/${invite.id}/accept`, { token: dee })).status).toBe(200);
  });

  test("a production config cannot turn it on", () => {
    const on = { IDENTITY_UNSAFE_TEST_MINT: "1" };
    expect(unsafeMintEnvError({ ...on, REGION: "eu" })).toMatch(/UNSAFE/);
    expect(unsafeMintEnvError({ ...on, REGION: "us" })).toMatch(/UNSAFE/);
    expect(unsafeMintEnvError({ ...on, REGION: "unknown", PUBLIC_URL: "https://id.example.test" })).toMatch(/UNSAFE/);
    expect(unsafeMintEnvError({ ...on, REGION: "unknown" })).toBeNull();
    expect(unsafeMintEnvError({ ...on, REGION: "unknown", PUBLIC_URL: "http://localhost:8787" })).toBeNull();
    expect(unsafeMintEnvError({ REGION: "eu", PUBLIC_URL: "https://id.example.test" })).toBeNull();
    expect(unsafeMintEnvError({ IDENTITY_UNSAFE_TEST_MINT: "true", REGION: "eu" })).toBeNull();
  });
});

describe("an agent with its own identity", () => {
  test("cannot have more rights than its maker", async () => {
    const s = setup();
    const small = await s.mint("small", { scopes: ["doc:read"] });
    const make = (token: string, scopes: string[], handle: string) => s.call("POST", "/agents", { token, body: { handle, scopes } });
    for (const [i, scopes] of [["doc:admin"], ["doc:write"], ["*:read"], ["sheet:read"], ["doc:read", "doc:admin"]].entries()) expect((await make(small, scopes!, `a${i}`)).status).toBe(403);
    expect((await make(small, ["doc:read"], "fine")).status).toBe(200);
    const big = await s.mint("big", { scopes: ["doc:admin"] });
    expect((await make(big, ["doc:write"], "b1")).status).toBe(200);
    expect((await make(big, ["sheet:read"], "b2")).status).toBe(403);
    const none = await s.mint("none", { scopes: ["doc:read"] });
    expect((await make(none, [], "empty")).status).toBe(200);
    expect(await s.store.get("handles", "a0")).toBeNull();
  });
});

describe("rate limits", () => {
  test("a principal has a budget, and the root of its chain pays for its agents", async () => {
    const s = setup({ principal: { limit: 3, windowMs: WINDOW } });
    const [ana, bo] = [await s.mint("ana"), await s.mint("bo")];
    const helper = await s.json(await s.call("POST", "/delegations", { token: ana, body: { scopes: ["doc:read"] } }));
    const token = () => s.call("POST", "/tokens", { token: ana, body: { scopes: ["doc:read"] } });
    expect((await token()).status).toBe(200);
    expect((await token()).status).toBe(200);
    const over = await token();
    expect(over.status).toBe(429);
    expect(Number(over.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await s.call("POST", "/delegations", { token: helper.apiKey, body: { scopes: ["doc:read"] } })).status).toBe(429);
    expect((await s.call("POST", "/tokens", { token: bo, body: { scopes: ["doc:read"] } })).status).toBe(200);
    for (let i = 0; i < 10; i++) expect((await s.call("GET", "/me", { token: ana })).status).toBe(200);
    expect((await s.store.query("principals", { where: { kind: "user_token" } })).items).toHaveLength(3);
    t += WINDOW;
    expect((await token()).status).toBe(200);
  });

  test("an IP has a budget on writes and on the anonymous access check, and a refused call writes nothing", async () => {
    const s = setup({ ip: { limit: 5, windowMs: WINDOW } });
    const ana = await s.mint("ana", { ip: "198.51.100.1" } as never);
    await s.call("POST", "/resources", { token: ana, ip: "198.51.100.1", body: { id: "plan", type: "doc" } });
    const access = (ip: string) => s.call("GET", "/resources/plan/access?action=read", { ip });
    const seen: number[] = [];
    for (let i = 0; i < 8; i++) seen.push((await access("203.0.113.9")).status);
    expect(seen.filter((x) => x === 200).length).toBeLessThanOrEqual(5);
    expect(seen.at(-1)).toBe(429);
    expect((await s.store.query("audit", { where: { resourceId: "plan" }, limit: 500 })).items.length).toBe(seen.filter((x) => x === 200).length);
    expect((await access("203.0.113.10")).status).toBe(200);
    expect((await s.call("POST", "/tokens", { token: ana, ip: "203.0.113.9", body: { scopes: ["doc:read"] } })).status).toBe(429);
    t += WINDOW;
    expect((await access("203.0.113.9")).status).toBe(200);
  });

  test("sign-in start has its own tighter budget", async () => {
    const s = setup({ login: { limit: 2, windowMs: WINDOW } });
    const codes: number[] = [];
    for (let i = 0; i < 4; i++) codes.push((await s.call("GET", "/auth/login", { ip: "203.0.113.20" })).status);
    expect(codes).toEqual([404, 404, 429, 429]);
    expect((await s.call("GET", "/auth/login", { ip: "203.0.113.21" })).status).toBe(404);
  });

  test("a counter row holds no IP address", async () => {
    const s = setup();
    await s.call("GET", "/resources/plan/access?action=read", { ip: "203.0.113.77" });
    const rows = (await s.store.query("rate_limits")).items;
    expect(rows.length).toBeGreaterThan(0);
    expect(JSON.stringify(rows)).not.toContain("203.0.113.77");
  });

  test("a bad counter row denies, and a failing store denies", async () => {
    const s = setup({ ip: { limit: 5, windowMs: WINDOW } });
    await s.call("GET", "/resources/plan/access?action=read", { ip: "203.0.113.30" });
    for (const row of (await s.store.query("rate_limits")).items) await s.store.put("rate_limits", row.id, { windowStart: "x", count: "y" });
    expect((await s.call("GET", "/resources/plan/access?action=read", { ip: "203.0.113.30" })).status).toBe(429);
    expect((await s.call("GET", "/resources/plan/access?action=read", { ip: "203.0.113.31" })).status).toBe(200);

    const raw = createMemoryStore();
    let broken = false;
    const wrap = (ops: StoreOps): StoreOps => ({ ...ops, get: (c, i) => ops.get(c, i), delete: (c, i) => ops.delete(c, i), query: (c, q) => ops.query(c, q), put: (c, i, d) => (broken && c === "rate_limits" ? Promise.reject(new Error("down")) : ops.put(c, i, d)) });
    const failing = setup({}, { ...wrap(raw), region: raw.region, transaction: (fn) => raw.transaction((tx) => fn(wrap(tx))) });
    broken = true;
    expect((await failing.call("GET", "/resources/plan/access?action=read")).status).toBe(503);
  });
});
