// Failure-mode list for OpenID Connect sign-in. Each case is a way a login could be
// forged or replayed. These tests were written before the code. They call the real
// handler, with a stand-in sign-in server that signs real RS256 id tokens.
//  1. A callback with no flow cookie, another state, a replayed state, or a flow over ten minutes old.
//  2. An id token with a bad signature, another issuer, another audience, an old expiry, another
//     nonce, no subject, or an algorithm that is not RS256. 3. An IdP that refuses the code
//     (wrong PKCE verifier or secret). 4. A returnTo that leaves the site.
//  5. A session cookie without HttpOnly, Secure, or SameSite=Lax. 6. Logout must end the session.
//  7. A returnTo that a browser turns into another site: a tab or newline inside, a backslash, a
//     scheme, `//`, a control character. After parsing, it must stay on this origin.
//  8. A cookie-authenticated write with no Origin, another Origin, or `null` is refused. A
//     bearer-authenticated write and a read need no Origin.
//  9. Pending sign-in rows: expired ones are removed, a global budget caps how many start in one
//     ten-minute window, and a stored flow with a bad expiry is refused.
import { describe, expect, test } from "vitest";
import { createMemoryStore } from "./adapters/memory.js";
import { oidcProvider } from "./core/oidc.js";
import { createApp, type WorkerConfig } from "./worker.js";

const ISSUER = "https://idp.test/realms/eu";
const provider = oidcProvider({ issuer: ISSUER, clientId: "client", clientSecret: "secret" });
let t = 1_000_000_000;
const b64 = (x: object | ArrayBuffer) => Buffer.from(x instanceof ArrayBuffer ? new Uint8Array(x) : JSON.stringify(x)).toString("base64url");
const s256 = async (verifier: string) => b64(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));

async function idp() {
  const rsa = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" };
  const keys = async () => crypto.subtle.generateKey({ ...rsa, modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) }, true, ["sign", "verify"]);
  const [good, other] = [await keys(), await keys()];
  const jwk = { ...(await crypto.subtle.exportKey("jwk", good.publicKey)), kid: "k1", alg: "RS256" };
  const codes = new Map<string, { id_token: string; challenge: string }>();
  const sign = async (claims: object, key = good.privateKey, header: object = { alg: "RS256", kid: "k1" }) => {
    const body = `${b64(header)}.${b64(claims)}`;
    return `${body}.${b64(await crypto.subtle.sign(rsa, key, new TextEncoder().encode(body)))}`;
  };
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === `${ISSUER}/.well-known/openid-configuration`) {
      return Response.json({ issuer: ISSUER, authorization_endpoint: `${ISSUER}/auth`, token_endpoint: `${ISSUER}/token`, jwks_uri: `${ISSUER}/jwks` });
    }
    if (url === `${ISSUER}/jwks`) return Response.json({ keys: [jwk] });
    if (url === `${ISSUER}/token`) {
      const form = new URLSearchParams(String(init?.body));
      const found = codes.get(form.get("code") ?? "");
      const ok = found && form.get("client_secret") === "secret" && (await s256(form.get("code_verifier") ?? "")) === found.challenge;
      return ok ? Response.json({ id_token: found.id_token }) : Response.json({ error: "invalid_grant" }, { status: 400 });
    }
    return new Response("no", { status: 404 });
  }) as typeof fetch;
  /** Gives the code the IdP would return for this login, with claims you can break. */
  const approve = async (login: URLSearchParams, claims: object = {}, how: { key?: CryptoKey; header?: object } = {}) => {
    const base = { iss: ISSUER, aud: "client", sub: "u1", email: "ana@example.test", email_verified: true, nonce: login.get("nonce"), exp: t / 1000 + 300 };
    const code = crypto.randomUUID();
    codes.set(code, { id_token: await sign({ ...base, ...claims }, how.key ?? good.privateKey, how.header), challenge: login.get("code_challenge") ?? "" });
    return code;
  };
  return { fetchImpl, approve, otherKey: other.privateKey };
}

async function setup(extra: Partial<WorkerConfig> = {}) {
  const store = createMemoryStore();
  const server = await idp();
  const app = createApp({ store, now: () => t, fetch: server.fetchImpl, config: { signIn: { provider, publicUrl: "https://app.test" }, unsafeTestMint: false, ...extra } });
  const call = (method: string, path: string, opts: { token?: string; cookie?: string; origin?: string; body?: unknown } = {}) =>
    app.request(`/api/v1${path}`, {
      method,
      headers: { ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}), ...(opts.cookie ? { cookie: opts.cookie } : {}), ...(opts.origin ? { origin: opts.origin } : {}), "content-type": "application/json" },
      ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
    });
  const login = async (returnTo?: string) => {
    const res = await call("GET", `/auth/login${returnTo ? `?returnTo=${encodeURIComponent(returnTo)}` : ""}`);
    const params = new URL(res.headers.get("location")!).searchParams;
    return { params, state: params.get("state")!, flow: res.headers.get("set-cookie")!.split(";")[0]!, res };
  };
  const callback = (state: string, code: string, cookie?: string) => call("GET", `/auth/callback?state=${state}&code=${code}`, cookie ? { cookie } : {});
  return { store, server, call, login, callback };
}

describe("sign-in", () => {
  test("a good login sets a session cookie with its flags, and the cookie works", async () => {
    const s = await setup();
    const { params, state, flow, res } = await s.login("/docs");
    expect(res.status).toBe(302);
    expect(res.headers.get("set-cookie")).toMatch(/HttpOnly/);
    expect(params.get("code_challenge_method")).toBe("S256");
    expect(params.get("redirect_uri")).toBe("https://app.test/api/v1/auth/callback");
    const done = await s.callback(state, await s.server.approve(params), flow);
    expect(done.status).toBe(302);
    expect(done.headers.get("location")).toBe("/docs");
    const cookie = done.headers.get("set-cookie")!;
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/Secure/);
    expect(cookie).toMatch(/SameSite=Lax/);
    const me = (await (await s.call("GET", "/me", { cookie: cookie.split(";")[0]! })).json()) as { kind: string };
    expect(me.kind).toBe("human");
  });

  test.each([["//evil.test"], ["https://evil.test/x"], ["/\\evil.test"]])("a returnTo of %s goes to /", async (to) => {
    const s = await setup();
    const { params, state, flow } = await s.login(to);
    expect((await s.callback(state, await s.server.approve(params), flow)).headers.get("location")).toBe("/");
  });

  test.each([["/\t/evil.test"], ["/\n/evil.test"], ["/\r/evil.test"], ["\t//evil.test"], [" //evil.test"], ["///evil.test"], ["/\\\\evil.test"], ["javascript:alert(1)"], ["http:evil.test"], ["/\u0000/x"], ["/\u0085//evil.test"], [""]])("a returnTo of %j goes to /", async (to) => {
    const s = await setup();
    const { params, state, flow } = await s.login(to);
    const location = (await s.callback(state, await s.server.approve(params), flow)).headers.get("location")!;
    expect(location).toBe("/");
    expect(new URL(location, "https://app.test").origin).toBe("https://app.test");
  });

  test.each([
    ["/.//evil.test"],
    ["/./\\evil.test"],
    ["/..//evil.test"],
    ["/a/..//evil.test"],
    ["/a/../..//evil.test"],
    ["/%2e//evil.test"],
    ["/%2E//evil.test"],
    ["/%2e%2e//evil.test"],
    ["/%2E%2E//evil.test"],
    ["/.%2e//evil.test"],
    ["/\\evil.test"],
    ["/\t/evil.test"],
    ["/.\t//evil.test"],
    ["/\n/evil.test"],
    ["/./\t/evil.test"],
    ["/a/..\\evil.test"],
    ["/.\\\\evil.test"],
    ["http://["],
    ["//["],
  ])("dot segments and other ways to reach //: a returnTo of %j goes to /", async (to) => {
    const s = await setup();
    const { params, state, flow } = await s.login(to);
    const location = (await s.callback(state, await s.server.approve(params), flow)).headers.get("location")!;
    expect(location).toBe("/");
  });

  test.each([["/%2F%2Fevil.test"], ["/%2f%2fevil.test"], ["/%5C%5Cevil.test"], ["/a%2F..%2F%2Fevil.test"], ["/%252e//evil.test"], ["/.//evil.test"], ["/%2e%2e%2f%2fevil.test"]])(
    "an encoded returnTo of %s never leaves this origin",
    async (to) => {
      const s = await setup();
      const { params, state, flow } = await s.login(to);
      const location = (await s.callback(state, await s.server.approve(params), flow)).headers.get("location")!;
      expect(location.startsWith("/")).toBe(true);
      expect(location).not.toMatch(/^\/[\\/]/);
      expect(new URL(location, "https://app.test").origin).toBe("https://app.test");
    },
  );

  test.each([["/docs?x=1#top"], ["/a/b%20c"], ["/"]])("a returnTo of %s is kept", async (to) => {
    const s = await setup();
    const { params, state, flow } = await s.login(to);
    expect((await s.callback(state, await s.server.approve(params), flow)).headers.get("location")).toBe(to);
  });

  test("logout ends the session", async () => {
    const s = await setup();
    const { params, state, flow } = await s.login();
    const cookie = (await s.callback(state, await s.server.approve(params), flow)).headers.get("set-cookie")!.split(";")[0]!;
    expect((await s.call("POST", "/auth/logout", { cookie, origin: "https://app.test" })).status).toBe(200);
    expect((await s.call("GET", "/me", { cookie })).status).toBe(401);
  });

  test("the same subject gets the same user on the next login", async () => {
    const s = await setup();
    const ids: string[] = [];
    for (let i = 0; i < 2; i++) {
      const { params, state, flow } = await s.login();
      const cookie = (await s.callback(state, await s.server.approve(params), flow)).headers.get("set-cookie")!.split(";")[0]!;
      ids.push(((await (await s.call("GET", "/me", { cookie })).json()) as { principalId: string }).principalId);
    }
    expect(ids[0]).toBe(ids[1]);
  });

  const bad: [string, (s: Awaited<ReturnType<typeof setup>>, params: URLSearchParams) => Promise<string>][] = [
    ["another issuer", (s, p) => s.server.approve(p, { iss: "https://evil.test" })],
    ["another audience", (s, p) => s.server.approve(p, { aud: "other" })],
    ["an expired token", (s, p) => s.server.approve(p, { exp: t / 1000 - 1 })],
    ["another nonce", (s, p) => s.server.approve(p, { nonce: "nope" })],
    ["no subject", (s, p) => s.server.approve(p, { sub: undefined })],
    ["a bad signature", (s, p) => s.server.approve(p, {}, { key: s.server.otherKey })],
    ["an algorithm that is not RS256", (s, p) => s.server.approve(p, {}, { header: { alg: "none", kid: "k1" } })],
    ["a code the IdP refuses", async () => "unknown-code"],
  ];
  test.each(bad)("refuses %s and sets no session", async (_name, makeCode) => {
    const s = await setup();
    const { params, state, flow } = await s.login();
    const res = await s.callback(state, await makeCode(s, params), flow);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.headers.get("set-cookie") ?? "").not.toMatch(/session=/);
  });

  test("refuses a flow that is older than ten minutes", async () => {
    const s = await setup();
    const { params, state, flow } = await s.login();
    const code = await s.server.approve(params);
    t += 600_000;
    expect((await s.callback(state, code, flow)).status).toBe(400);
    t -= 600_000;
  });

  test("refuses a callback with no flow cookie, another state, or a replayed state", async () => {
    const s = await setup();
    const { params, state, flow } = await s.login();
    const code = await s.server.approve(params);
    expect((await s.callback(state, code)).status).toBe(400);
    expect((await s.callback("other", code, flow)).status).toBe(400);
    expect((await s.callback(state, code, flow)).status).toBe(302);
    expect((await s.callback(state, code, flow)).status).toBe(400);
  });
});


describe("a cookie-authenticated write", () => {
  const signedIn = async () => {
    const s = await setup();
    const { params, state, flow } = await s.login();
    const cookie = (await s.callback(state, await s.server.approve(params), flow)).headers.get("set-cookie")!.split(";")[0]!;
    return { s, cookie };
  };

  test.each([[undefined], ["https://evil.test"], ["https://app.test.evil.test"], ["http://app.test"], ["https://app.test:8443"], ["null"], [""]])("is refused with Origin %j, and does nothing", async (origin) => {
    const { s, cookie } = await signedIn();
    const body = { scopes: ["doc:read"] };
    expect((await s.call("POST", "/tokens", { cookie, ...(origin ? { origin } : {}), body })).status).toBe(403);
    expect((await s.call("POST", "/agents", { cookie, ...(origin ? { origin } : {}), body: { handle: "scribe", scopes: [] } })).status).toBe(403);
    expect((await s.call("DELETE", "/me", { cookie, ...(origin ? { origin } : {}) })).status).toBe(403);
    expect((await s.store.query("principals")).items).toHaveLength(1);
    expect((await s.call("GET", "/me", { cookie })).status).toBe(200);
  });

  test("works from the Worker's own origin, and a read needs no Origin", async () => {
    const { s, cookie } = await signedIn();
    expect((await s.call("POST", "/tokens", { cookie, origin: "https://app.test", body: { scopes: ["doc:read"] } })).status).toBe(200);
    expect((await s.call("GET", "/me/export", { cookie })).status).toBe(200);
  });

  test("a bearer write needs no Origin, because a page cannot add that header", async () => {
    const { s, cookie } = await signedIn();
    const token = ((await (await s.call("POST", "/tokens", { cookie, origin: "https://app.test", body: { scopes: ["doc:read"] } })).json()) as { token: string }).token;
    expect((await s.call("POST", "/auth/logout", { token })).status).toBe(200);
  });

  test("is refused when no public URL is set, because there is no origin to match", async () => {
    const store = createMemoryStore();
    const app = createApp({ store, now: () => t, config: { unsafeTestMint: true } });
    const mint = (await (await app.request("/api/v1/test/token", { method: "POST", body: JSON.stringify({ userId: "ana" }) })).json()) as { token: string };
    const cookie = `session=${mint.token}`;
    const write = (origin?: string) => app.request("/api/v1/tokens", { method: "POST", headers: { cookie, ...(origin ? { origin } : {}) }, body: JSON.stringify({ scopes: ["doc:read"] }) });
    expect((await write("https://app.test")).status).toBe(403);
    expect((await write()).status).toBe(403);
  });
});

describe("pending sign-in rows", () => {
  const rows = async (s: Awaited<ReturnType<typeof setup>>) => (await s.store.query("auth_flows", { limit: 500 })).items.length;

  test("expired rows are removed when a new sign-in starts", async () => {
    const s = await setup();
    for (let i = 0; i < 4; i++) await s.login();
    expect(await rows(s)).toBe(4);
    t += 600_001;
    await s.login();
    expect(await rows(s)).toBe(1);
    t -= 600_001;
  });

  test("a global budget caps how many start in one window, and a refused start writes no row", async () => {
    const s = await setup({ rateLimits: { loginAll: { limit: 3, windowMs: 600_000 } } });
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) codes.push((await s.call("GET", "/auth/login")).status);
    expect(codes).toEqual([302, 302, 302, 429, 429]);
    expect(await rows(s)).toBe(3);
  });

  test.each([["a string", "9999999999999"], ["null", null], ["NaN", Number.NaN], ["an object", {}]])("a stored flow with %s as expiry is refused", async (_name, bad) => {
    const s = await setup();
    const { params, state, flow } = await s.login();
    const code = await s.server.approve(params);
    const row = await s.store.get("auth_flows", state);
    await s.store.put("auth_flows", state, { ...row!, expiresAt: bad as never });
    expect((await s.callback(state, code, flow)).status).toBe(400);
  });
});
