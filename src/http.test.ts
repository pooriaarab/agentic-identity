// Failure-mode list for requirePrincipal. These were written before the code.
//  1. A valid key gives the principal. 2. A revoked key is a 401. 3. No header is a 401 with
//     WWW-Authenticate. 4. A wrong scheme (Basic, lowercase-only junk) is a 401.
//  5. An agent principal comes back with its kind, and `kinds` that leave it out give a 403.
//  6. A scope the principal lacks is a 403. 7. An unknown kind or a bad scope option throws.
//  8. Cookie writes need a listed Origin; a bearer write and a cookie read do not. A bad Authorization header
//     is a 401 even beside a valid cookie. An expired key and a revoked parent are a 401.
//  9. An Auth that throws gives a 503, never a principal. 10. No body holds the credential.
import { describe, expect, test, vi } from "vitest";
import { createMemoryStore } from "./adapters/memory.js";
import type { PrincipalContext } from "./core/principals.js";
import { createStoreAuth, issueCredential, revokeCredential } from "./credentials.js";
import { acceptWebSocketProtocol, principalFromWebSocketRequest, requirePrincipal } from "./http.js";

async function setup() {
  const store = createMemoryStore();
  const auth = createStoreAuth(store);
  const human = { id: "p_h", kind: "human" as const, scopes: ["*:admin"] };
  const agent = { id: "p_a", kind: "agent_of_human" as const, parentId: "p_h", scopes: ["doc:read"] };
  await store.put("principals", human.id, human);
  await store.put("principals", agent.id, agent);
  const key = (principalId: string) => issueCredential(store, { principalId, kind: "api_key" });
  const req = (headers: Record<string, string> = {}) => new Request("https://app.test/x", { headers });
  return { store, auth, key, req };
}

describe("requirePrincipal", () => {
  test("a valid key gives the human principal", async () => {
    const { auth, key, req } = await setup();
    const got = (await requirePrincipal(req({ authorization: `Bearer ${await key("p_h")}` }), auth)) as PrincipalContext;
    expect(got).not.toBeInstanceOf(Response);
    expect(got.principalId).toBe("p_h");
    expect(got.kind).toBe("human");
  });

  test("a valid session cookie works", async () => {
    const { auth, key, req } = await setup();
    const got = (await requirePrincipal(req({ cookie: `session=${await key("p_h")}` }), auth)) as PrincipalContext;
    expect(got.principalId).toBe("p_h");
  });

  test("a revoked key is a 401", async () => {
    const { store, auth, key, req } = await setup();
    const token = await key("p_h");
    await revokeCredential(store, token, 1);
    const res = (await requirePrincipal(req({ authorization: `Bearer ${token}` }), auth)) as Response;
    expect(res.status).toBe(401);
    expect(await res.text()).not.toContain(token);
  });

  test("a missing header is a 401 that names the scheme", async () => {
    const { auth, req } = await setup();
    const res = (await requirePrincipal(req(), auth)) as Response;
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe("Bearer");
  });

  test("a wrong scheme is a 401", async () => {
    const { auth, key, req } = await setup();
    const token = await key("p_h");
    for (const authorization of [`Basic ${token}`, `bearer ${token}`, token]) {
      const res = (await requirePrincipal(req({ authorization }), auth)) as Response;
      expect(res.status).toBe(401);
      expect(await res.text()).not.toContain(token);
    }
  });

  test("an agent principal keeps its kind, and kinds can refuse it", async () => {
    const { auth, key, req } = await setup();
    const request = req({ authorization: `Bearer ${await key("p_a")}` });
    const got = (await requirePrincipal(request, auth)) as PrincipalContext;
    expect(got.kind).toBe("agent_of_human");
    expect(got.chain.map((step) => step.id)).toEqual(["p_h", "p_a"]);
    expect(((await requirePrincipal(request, auth, { kinds: ["human"] })) as Response).status).toBe(403);
    expect(await requirePrincipal(request, auth, { kinds: ["human", "agent_of_human"] })).toMatchObject({ principalId: "p_a" });
  });

  test("a missing scope is a 403, a held scope passes", async () => {
    const { auth, key, req } = await setup();
    const request = req({ authorization: `Bearer ${await key("p_a")}` });
    expect(((await requirePrincipal(request, auth, { scope: "doc:write" })) as Response).status).toBe(403);
    expect(await requirePrincipal(request, auth, { scope: "doc:read" })).toMatchObject({ principalId: "p_a" });
  });

  test("a cookie write needs a listed origin", async () => {
    const { auth, key, req } = await setup();
    const cookie = `session=${await key("p_h")}`;
    const post = (headers: Record<string, string>) => new Request("https://app.test/x", { method: "POST", headers });
    const origins = ["https://app.test"];
    expect(((await requirePrincipal(post({ cookie }), auth, { origins })) as Response).status).toBe(403);
    expect(((await requirePrincipal(post({ cookie, origin: "https://evil.test" }), auth, { origins })) as Response).status).toBe(403);
    expect(((await requirePrincipal(post({ cookie }), auth)) as Response).status).toBe(403);
    expect(((await requirePrincipal(post({ cookie }), auth, { origins: [""] })) as Response).status).toBe(403);
    const refused = (await requirePrincipal(post({ cookie }), auth, { origins })) as Response;
    expect(await refused.text()).not.toContain(cookie.slice(8));
    expect(await requirePrincipal(post({ cookie, origin: "https://app.test" }), auth, { origins })).toMatchObject({ principalId: "p_h" });
    expect(await requirePrincipal(req({ cookie }), auth)).toMatchObject({ principalId: "p_h" });
    expect(await requirePrincipal(post({ authorization: `Bearer ${await key("p_h")}` }), auth)).toMatchObject({ principalId: "p_h" });
  });

  test("a bad Authorization header is a 401 even beside a valid cookie", async () => {
    const { auth, key, req } = await setup();
    const res = (await requirePrincipal(req({ authorization: "Basic abc", cookie: `session=${await key("p_h")}` }), auth)) as Response;
    expect(res.status).toBe(401);
  });

  test("an expired key and a revoked parent are a 401", async () => {
    const { store, auth, key, req } = await setup();
    const old = await issueCredential(store, { principalId: "p_h", kind: "api_key", expiresAt: 1 });
    expect(((await requirePrincipal(req({ authorization: `Bearer ${old}` }), auth)) as Response).status).toBe(401);
    const child = await key("p_a");
    await store.put("principals", "p_h", { id: "p_h", kind: "human", scopes: ["*:admin"], revokedAt: 1 });
    expect(((await requirePrincipal(req({ authorization: `Bearer ${child}` }), auth)) as Response).status).toBe(401);
  });

  test("an empty kinds list refuses everyone", async () => {
    const { auth, key, req } = await setup();
    expect(((await requirePrincipal(req({ authorization: `Bearer ${await key("p_h")}` }), auth, { kinds: [] })) as Response).status).toBe(403);
  });

  test("a bad option throws", async () => {
    const { auth, req } = await setup();
    await expect(requirePrincipal(req(), auth, { kinds: ["root" as never] })).rejects.toThrow(RangeError);
    await expect(requirePrincipal(req(), auth, { scope: "doc" })).rejects.toThrow(RangeError);
  });

  test("an Auth that throws is a 503", async () => {
    const res = (await requirePrincipal(new Request("https://app.test/"), {
      authenticate: async () => {
        throw new Error("down");
      },
    })) as Response;
    expect(res.status).toBe(503);
  });
});

// Failure-mode list for principalFromWebSocketRequest and acceptWebSocketProtocol. Written before the code.
//  1. A good token in `<protocol>.bearer.<token>` gives the principal (base64url and plain). 2. No token is a 401.
//  3. A bad, revoked, or expired token is a 401. 4. Bad base64, bad UTF-8, a bad character, or a token
//     over 512 characters is a 401. 5. Two token entries are a 401. 6. A token without the bare protocol is a 401.
//  7. A request that is not an upgrade ignores the subprotocol. 8. An Authorization header wins, and the
//     subprotocol is ignored. 9. The cookie works only from a listed origin. 10. The 401 body never holds the token.
//  11. A token entry from another protocol is not read. 12. Kinds and scope still give a 403. 13. A bad option throws.
//  14. The echo names only the bare protocol, only on a 101, only when it was offered, and survives read-only headers.
describe("principalFromWebSocketRequest", () => {
  const b64 = (s: string) => Buffer.from(s).toString("base64url");
  const socket = (offer: string | null, headers: Record<string, string> = {}) =>
    new Request("https://app.test/ws", { headers: { upgrade: "websocket", ...(offer === null ? {} : { "sec-websocket-protocol": offer }), ...headers } });
  const opts = { protocol: "agentic-docs" };

  test("a base64url token gives the principal", async () => {
    const { auth, key } = await setup();
    const token = await key("p_h");
    const got = (await principalFromWebSocketRequest(socket(`agentic-docs, agentic-docs.bearer.${b64(token)}`), auth, opts)) as PrincipalContext;
    expect(got.principalId).toBe("p_h");
  });

  test("a plain token gives the principal", async () => {
    const { auth, key } = await setup();
    const token = await key("p_a");
    const got = (await principalFromWebSocketRequest(socket(`agentic-docs,agentic-docs.bearer.${token}`), auth, { ...opts, encoding: "plain" })) as PrincipalContext;
    expect(got.kind).toBe("agent_of_human");
  });

  test("no token, a bare protocol alone, and a token without the bare protocol are a 401", async () => {
    const { auth, key } = await setup();
    const token = await key("p_h");
    for (const offer of [null, "agentic-docs", `agentic-docs.bearer.${b64(token)}`, `other.bearer.${b64(token)}, other`]) {
      const res = (await principalFromWebSocketRequest(socket(offer), auth, opts)) as Response;
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toBe("Bearer");
    }
  });

  test("a bad, revoked, or malformed token is a 401 and the body never holds it", async () => {
    const { store, auth, key } = await setup();
    const revoked = await key("p_h");
    await revokeCredential(store, revoked, 1);
    const good = await key("p_h");
    const offers = [
      `agentic-docs, agentic-docs.bearer.${b64(revoked)}`,
      `agentic-docs, agentic-docs.bearer.${b64("not-a-key")}`,
      "agentic-docs, agentic-docs.bearer.!!!",
      "agentic-docs, agentic-docs.bearer.",
      `agentic-docs, agentic-docs.bearer.${Buffer.from([0xff, 0xfe]).toString("base64url")}`,
      `agentic-docs, agentic-docs.bearer.${b64("a".repeat(513))}`,
      `agentic-docs, agentic-docs.bearer.${b64(good)}, agentic-docs.bearer.${b64(good)}`,
    ];
    for (const offer of offers) {
      const res = (await principalFromWebSocketRequest(socket(offer), auth, opts)) as Response;
      expect(res.status).toBe(401);
      expect(await res.text()).not.toContain(revoked);
    }
  });

  test("a request that is not an upgrade ignores the subprotocol", async () => {
    const { auth, key } = await setup();
    const token = await key("p_h");
    const plain = new Request("https://app.test/x", { headers: { "sec-websocket-protocol": `agentic-docs, agentic-docs.bearer.${b64(token)}` } });
    expect(((await principalFromWebSocketRequest(plain, auth, opts)) as Response).status).toBe(401);
  });

  test("an Authorization header wins and the subprotocol is ignored", async () => {
    const { auth, key } = await setup();
    const token = await key("p_h");
    const ok = (await principalFromWebSocketRequest(socket("agentic-docs, agentic-docs.bearer.zzz", { authorization: `Bearer ${token}` }), auth, opts)) as PrincipalContext;
    expect(ok.principalId).toBe("p_h");
    const bad = (await principalFromWebSocketRequest(socket(`agentic-docs, agentic-docs.bearer.${b64(token)}`, { authorization: "Basic abc" }), auth, opts)) as Response;
    expect(bad.status).toBe(401);
  });

  test("the cookie signs a socket in only from a listed origin", async () => {
    const { auth, key } = await setup();
    const cookie = `session=${await key("p_h")}`;
    const withOrigin = { ...opts, origins: ["https://app.example.org"] };
    expect(((await principalFromWebSocketRequest(socket(null, { cookie }), auth, withOrigin)) as Response).status).toBe(403);
    expect(((await principalFromWebSocketRequest(socket(null, { cookie, origin: "https://evil.test" }), auth, withOrigin)) as Response).status).toBe(403);
    const got = (await principalFromWebSocketRequest(socket(null, { cookie, origin: "https://app.example.org" }), auth, withOrigin)) as PrincipalContext;
    expect(got.principalId).toBe("p_h");
  });

  test("a valid token beside a cookie uses the token, not the cookie", async () => {
    const { auth, key } = await setup();
    const token = await key("p_a");
    const got = (await principalFromWebSocketRequest(socket(`agentic-docs, agentic-docs.bearer.${b64(token)}`, { cookie: `session=${await key("p_h")}` }), auth, opts)) as PrincipalContext;
    expect(got.principalId).toBe("p_a");
  });

  test("kinds and scope still give a 403, and bad options throw", async () => {
    const { auth, key } = await setup();
    const offer = `agentic-docs, agentic-docs.bearer.${b64(await key("p_a"))}`;
    expect(((await principalFromWebSocketRequest(socket(offer), auth, { ...opts, kinds: ["human"] })) as Response).status).toBe(403);
    expect(((await principalFromWebSocketRequest(socket(offer), auth, { ...opts, scope: "doc:write" })) as Response).status).toBe(403);
    await expect(principalFromWebSocketRequest(socket(offer), auth, { protocol: "a b" })).rejects.toThrow(RangeError);
    await expect(principalFromWebSocketRequest(socket(offer), auth, { protocol: "" })).rejects.toThrow(RangeError);
    await expect(principalFromWebSocketRequest(socket(offer), auth, { ...opts, encoding: "hex" as never })).rejects.toThrow(RangeError);
  });
});

describe("acceptWebSocketProtocol", () => {
  const offered = new Request("https://app.test/ws", { headers: { upgrade: "websocket", "sec-websocket-protocol": "agentic-docs, agentic-docs.bearer.dG9r" } });
  const upgraded = (headers: HeadersInit = {}) => {
    const res = new Response(null, { status: 200, headers });
    Object.defineProperty(res, "status", { value: 101 });
    return res;
  };

  test("a 101 answer names only the bare protocol", () => {
    const res = acceptWebSocketProtocol(offered, upgraded(), "agentic-docs");
    expect(res.headers.get("sec-websocket-protocol")).toBe("agentic-docs");
  });

  test("a non-101 answer and an unoffered protocol come back as they are", () => {
    const denied = new Response("no", { status: 401 });
    expect(acceptWebSocketProtocol(offered, denied, "agentic-docs")).toBe(denied);
    const res = upgraded();
    expect(acceptWebSocketProtocol(offered, res, "other").headers.has("sec-websocket-protocol")).toBe(false);
  });

  test("a read-only answer is rebuilt around its socket", () => {
    const socketObject = {};
    const frozen = Object.assign(upgraded({ "x-room": "1" }), { webSocket: socketObject });
    Object.defineProperty(frozen, "headers", { value: { get: () => null, set: () => { throw new TypeError("immutable"); }, [Symbol.iterator]: () => [["x-room", "1"]][Symbol.iterator]() } });
    class Fake { constructor(public body: null, public init: { status: number; headers: Headers; webSocket: unknown }) {} }
    vi.stubGlobal("Response", Fake);
    try {
      const out = acceptWebSocketProtocol(offered, frozen, "agentic-docs") as unknown as Fake;
      expect(out.init.status).toBe(101);
      expect(out.init.webSocket).toBe(socketObject);
      expect(out.init.headers.get("sec-websocket-protocol")).toBe("agentic-docs");
      expect(out.init.headers.get("x-room")).toBe("1");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
