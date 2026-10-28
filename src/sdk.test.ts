// Failure-mode list for the SDK. These tests were written before the code. The client talks to
// a real HTTP server on this machine, so each case checks what really goes over the wire.
//  1. A base URL that would send the token in the clear (http outside localhost), carries a
//     password, a query, or a fragment, or is not a URL, is refused when the client is made.
//  2. A token that is not a bare token (a space, CR, LF, non-ASCII, too long, not a string) is
//     refused. A header cannot be split with it.
//  3. The token goes only to the base URL. A redirect is never followed, so a redirect to another
//     host never sees it.
//  4. Each path part is encoded, and `.` and `..` and an empty id are refused, so no id can climb out of its route.
//  5. An unknown action or role is refused before any request.
//  6. Each failure is an ApiError with the status. A 429 has its Retry-After. A body that is not
//     JSON is a bad response, not a crash. No error holds the token.
//  7. A request that gets no answer ends at the time limit. A closed port is a network error.
//  8. A field left out is not sent. `withToken` makes a second client and leaves the first alone.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, test } from "vitest";
import { ApiError, createClient } from "./sdk.js";

type Seen = { method: string; url: string; headers: IncomingMessage["headers"]; body: string };
const open: { close(): void }[] = [];
afterEach(() => open.splice(0).forEach((s) => s.close()));

async function server(handler: (req: IncomingMessage, res: ServerResponse, seen: Seen) => void = (_q, res) => res.writeHead(200, { "content-type": "application/json" }).end("{}")) {
  const seen: Seen[] = [];
  const http = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const entry = { method: req.method!, url: req.url!, headers: req.headers, body };
      seen.push(entry);
      handler(req, res, entry);
    });
  });
  await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
  open.push({ close: () => (http.closeAllConnections(), http.close()) });
  return { origin: `http://127.0.0.1:${(http.address() as AddressInfo).port}`, seen };
}
const json = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) =>
  res.writeHead(status, { "content-type": "application/json", ...headers }).end(JSON.stringify(body));
const TOKEN = "aid_0123456789abcdefABCDEF-_";

describe("the base URL", () => {
  test.each(["http://example.test", "ftp://example.test", "https://user:pw@example.test", "https://example.test/?x=1", "https://example.test/#a", "not a url", "", "//example.test", "http://localhost.evil.test", "http://127.0.0.1.evil.test", "http://10.0.0.1"])("%j is refused", (baseUrl) => {
    expect(() => createClient({ baseUrl, token: TOKEN })).toThrow();
  });

  test.each(["https://example.test", "https://example.test/prefix/", "http://localhost:8787", "http://127.0.0.1:1", "http://[::1]:1"])("%j is accepted", (baseUrl) => {
    expect(() => createClient({ baseUrl, token: TOKEN })).not.toThrow();
  });

  test("a path prefix is kept, and the API path follows it", async () => {
    const s = await server();
    await createClient({ baseUrl: `${s.origin}/edge/`, token: TOKEN }).me();
    expect(s.seen[0]!.url).toBe("/edge/api/v1/me");
  });
});

describe("the token", () => {
  test.each(["", " abc", "abc ", "a b", "abc\r\nX-Evil: 1", "abc\n", "ключ", "x".repeat(513), 5, null, {}])("%j is refused", (token) => {
    expect(() => createClient({ baseUrl: "https://example.test", token: token as string })).toThrow();
  });

  test("is sent as a bearer header, with no cookie, and only to the base URL", async () => {
    const s = await server();
    await createClient({ baseUrl: s.origin, token: TOKEN }).me();
    expect(s.seen[0]!.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(s.seen[0]!.headers.cookie).toBeUndefined();
    expect(s.seen[0]!.headers.accept).toBe("application/json");
  });

  test("a client with no token sends no authorization header", async () => {
    const s = await server();
    await createClient({ baseUrl: s.origin }).access("plan", "read");
    expect(s.seen[0]!.headers.authorization).toBeUndefined();
  });

  test.each([301, 302, 307, 308])("a %i redirect is not followed, so another host never sees the token", async (status) => {
    const other = await server();
    const first = await server((_q, res) => res.writeHead(status, { location: `${other.origin}/steal` }).end());
    const error = await createClient({ baseUrl: first.origin, token: TOKEN }).me().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(other.seen).toHaveLength(0);
    expect(JSON.stringify(error) + String(error) + (error as Error).stack).not.toContain(TOKEN);
  });
});

describe("ids and inputs", () => {
  test.each([["a/b", "a%2Fb"], ["a b", "a%20b"], ["é?x=1#y", "%C3%A9%3Fx%3D1%23y"], ["%2e%2e", "%252e%252e"], ["a/../b", "a%2F..%2Fb"]])("the id %j is encoded", async (id, encoded) => {
    const s = await server();
    const client = createClient({ baseUrl: s.origin, token: TOKEN });
    await client.revokePrincipal(id);
    await client.revokeLink(id);
    await client.grant(id, id, "viewer");
    expect(s.seen.map((r) => r.url)).toEqual([`/api/v1/principals/${encoded}`, `/api/v1/links/${encoded}`, `/api/v1/resources/${encoded}/grants`]);
  });

  test.each([".", "..", "", "x".repeat(257), 5, null, undefined])("the id %j is refused before any request", async (id) => {
    const s = await server();
    const client = createClient({ baseUrl: s.origin, token: TOKEN });
    expect(() => client.revokePrincipal(id as string)).toThrow();
    expect(() => client.revokeGrant("plan", id as string)).toThrow();
    expect(s.seen).toHaveLength(0);
  });

  test("an unknown action or role is refused before any request", async () => {
    const s = await server();
    const client = createClient({ baseUrl: s.origin, token: TOKEN });
    for (const action of ["delete", "", "READ", "constructor"]) expect(() => client.access("plan", action as "read")).toThrow(RangeError);
    for (const role of ["king", "", "OWNER", "constructor"]) {
      expect(() => client.grant("plan", "bo", role as "viewer")).toThrow(RangeError);
      expect(() => client.createLink("plan", { role: role as "viewer" })).toThrow(RangeError);
      expect(() => client.createInvite("plan", { role: role as "viewer", handle: "scribe" })).toThrow(RangeError);
    }
    expect(s.seen).toHaveLength(0);
  });

  test("a field left out is not sent, and the action and link token go where the server reads them", async () => {
    const s = await server();
    const client = createClient({ baseUrl: s.origin, token: TOKEN });
    await client.createInvite("plan", { role: "viewer", email: "cy@example.test" });
    await client.access("plan", "write", { linkToken: "tok_abc" });
    await client.createLink("plan", { role: "viewer", signedInOnly: undefined, expiresInMs: undefined });
    expect(JSON.parse(s.seen[0]!.body)).toEqual({ role: "viewer", email: "cy@example.test" });
    expect(s.seen[1]).toMatchObject({ method: "GET", url: "/api/v1/resources/plan/access?action=write" });
    expect(s.seen[1]!.headers["x-link-token"]).toBe("tok_abc");
    expect(JSON.parse(s.seen[2]!.body)).toEqual({ role: "viewer" });
  });

  test("withToken makes a second client and leaves the first alone", async () => {
    const s = await server();
    const first = createClient({ baseUrl: s.origin, token: TOKEN });
    const second = first.withToken("aid_other");
    await second.me();
    await first.me();
    expect(s.seen.map((r) => r.headers.authorization)).toEqual(["Bearer aid_other", `Bearer ${TOKEN}`]);
  });
});

describe("errors", () => {
  test.each([[401, "unauthorized"], [403, "forbidden"], [404, "not found"], [409, "handle taken"], [400, "bad request"]])("a %i is an ApiError with its status and message", async (status, message) => {
    const s = await server((_q, res) => json(res, status, { error: message }));
    const error = (await createClient({ baseUrl: s.origin, token: TOKEN }).me().catch((e: unknown) => e)) as ApiError;
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status, message, reason: "http" });
    expect(String(error) + JSON.stringify(error)).not.toContain(TOKEN);
  });

  test("a 429 carries its Retry-After, and a bad Retry-After is left out", async () => {
    for (const [header, expected] of [["7", 7], ["soon", undefined], ["-1", undefined], ["1e9", undefined]] as const) {
      const s = await server((_q, res) => json(res, 429, { error: "too many requests" }, { "retry-after": header }));
      const error = (await createClient({ baseUrl: s.origin, token: TOKEN }).me().catch((e: unknown) => e)) as ApiError;
      expect(error.status).toBe(429);
      expect(error.retryAfterSeconds).toBe(expected);
    }
  });

  test("a body that is not JSON is a bad response, on an error and on a success", async () => {
    for (const status of [200, 502]) {
      const s = await server((_q, res) => res.writeHead(status, { "content-type": "text/html" }).end("<html>oops</html>"));
      const error = (await createClient({ baseUrl: s.origin, token: TOKEN }).me().catch((e: unknown) => e)) as ApiError;
      expect(error).toBeInstanceOf(ApiError);
      expect(error.status).toBe(status);
      expect(error.reason).toBe("bad_response");
      expect(error.message).not.toContain("oops");
    }
  });

  test("an error message from the server is cut at 200 characters, and holds no token the client sent", async () => {
    const s = await server((req, res) => json(res, 400, { error: `${req.headers.authorization} ${"x".repeat(500)}` }));
    const error = (await createClient({ baseUrl: s.origin, token: TOKEN }).me().catch((e: unknown) => e)) as ApiError;
    expect(error.message.length).toBeLessThanOrEqual(200);
    expect(error.message).not.toContain(TOKEN);
  });

  test("a request with no answer ends at the time limit", async () => {
    const s = await server(() => undefined);
    const started = Date.now();
    const error = (await createClient({ baseUrl: s.origin, token: TOKEN, timeoutMs: 150 }).me().catch((e: unknown) => e)) as ApiError;
    expect(error).toMatchObject({ status: 0, reason: "timeout" });
    expect(Date.now() - started).toBeLessThan(3000);
  });

  test("a closed port is a network error with no token in it", async () => {
    const s = await server();
    const { origin } = s;
    open.splice(0).forEach((x) => x.close());
    const error = (await createClient({ baseUrl: origin, token: TOKEN }).me().catch((e: unknown) => e)) as ApiError;
    expect(error).toMatchObject({ status: 0, reason: "network" });
    expect(String(error) + JSON.stringify(error)).not.toContain(TOKEN);
  });

  test("a time limit that is not a positive whole number is refused", () => {
    for (const timeoutMs of [0, -1, 1.5, NaN, Infinity, "5"]) expect(() => createClient({ baseUrl: "https://example.test", timeoutMs: timeoutMs as number })).toThrow();
  });
});
