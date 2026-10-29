// The real Worker under `wrangler dev` with a local D1 database. One run walks the
// key story over HTTP. The in-process tests list the failure cases.
import { afterAll, beforeAll, expect, test } from "vitest";
import { startWorker } from "./e2e-server.js";

let BASE = "";
let worker: Awaited<ReturnType<typeof startWorker>>;

beforeAll(async () => {
  worker = await startWorker();
  BASE = `${worker.origin}/api/v1`;
}, 90_000);
afterAll(() => worker?.stop());
const call = async (method: string, path: string, token?: string, body?: unknown) => {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, string & string[]> };
};

test("mint, key, delegate, narrow, and revoke over HTTP", async () => {
  const ana = (await call("POST", "/test/token", undefined, { userId: "ana" })).body.token!;
  const agent = (await call("POST", "/agents", ana, { handle: "scribe", scopes: ["doc:write"] })).body;
  expect((await call("GET", "/me", agent.apiKey)).body).toMatchObject({ kind: "agent", principalId: agent.id });
  const first = (await call("POST", "/delegations", ana, { scopes: ["doc:write"] })).body;
  const second = (await call("POST", "/delegations", first.apiKey, { scopes: ["doc:read"] })).body;
  expect((await call("GET", "/me", second.apiKey)).body).toMatchObject({ kind: "agent_of_agent", scopes: ["doc:read"] });
  expect((await call("POST", "/delegations", first.apiKey, { scopes: ["doc:admin"] })).status).toBe(403);
  expect((await call("DELETE", `/principals/${first.id}`, ana)).status).toBe(200);
  expect((await call("GET", "/me", second.apiKey)).status).toBe(401);
  expect((await call("GET", "/me")).status).toBe(401);
}, 60_000);
