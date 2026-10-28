// Failure-mode list for data export and hard delete. These tests were written
// before the code. They call the real handler with a real store.
//  1. Only a person who signed in directly may export or delete. An agent key, a grant,
//     and a personal token act for the person, so each one gets a 403.
//  2. The export holds the person's own data, and nothing about another person.
//     It holds no key, no key hash, and no hash of a link token.
//  3. After a delete, no id, handle, email, or key of the person remains in any collection,
//     and every key of the person and of their agents stops.
//  4. A delete leaves other people's data alone: a resource they co-own, and a resource they own
//     inside the person's folder. A resource that only the person owns goes, with its links,
//     invites, and audit. An invite the person sent, or that names their email, goes too.
//  5. Asking twice is not an error that leaks: the second delete is a 401.
import { describe, expect, test } from "vitest";
import { createMemoryStore } from "./adapters/memory.js";
import { createApp } from "./worker.js";

const COLLECTIONS = ["principals", "users", "credentials", "handles", "resources", "grants", "invites", "links", "audit"];

async function world() {
  const store = createMemoryStore();
  const app = createApp({ store, now: () => 1_000_000, config: { allowTestTokenMint: true } });
  const call = async (method: string, path: string, token?: string, body?: unknown) => {
    const res = await app.request(`/api/v1${path}`, {
      method,
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, any> };
  };
  const mint = async (userId: string, email: string) => (await call("POST", "/test/token", undefined, { userId, email })).body.token as string;
  const [ana, bo] = [await mint("ana", "ana@example.test"), await mint("bo", "bo@example.test")];
  const agent = (await call("POST", "/agents", ana, { handle: "scribe", scopes: ["*:admin"] })).body;
  const grant = (await call("POST", "/delegations", ana, { scopes: ["doc:read"] })).body;
  const pat = (await call("POST", "/tokens", ana, { scopes: ["doc:read"] })).body;
  await call("POST", "/resources", ana, { id: "mine", type: "doc" });
  await call("POST", "/resources", ana, { id: "mine-child", type: "doc", parentId: "mine" });
  await call("POST", "/resources", ana, { id: "shared", type: "doc" });
  await call("POST", "/resources/shared/grants", ana, { subjectId: "bo", role: "owner" });
  await call("POST", "/resources", bo, { id: "boss", type: "doc" });
  await call("POST", "/resources/boss/grants", bo, { subjectId: "ana", role: "viewer" });
  await call("POST", "/resources/mine/grants", ana, { subjectId: "bo", role: "editor" });
  await call("POST", "/resources", bo, { id: "bo-note", type: "doc", parentId: "mine" });
  await call("POST", "/resources/shared/invites", ana, { role: "viewer", email: "dee@example.test" });
  await call("POST", "/resources/boss/invites", bo, { role: "viewer", email: "ana@example.test" });
  await call("POST", "/resources/mine/links", ana, { role: "viewer" });
  await call("POST", "/resources/mine/invites", ana, { role: "viewer", email: "cy@example.test" });
  await call("GET", "/resources/boss/access?action=read", agent.apiKey);
  const dump = async () => {
    const rows: string[] = [];
    for (const name of COLLECTIONS) for (const e of (await store.query(name, { limit: 1000 })).items) rows.push(`${name}/${e.id} ${JSON.stringify(e.data)}`);
    return rows.join("\n");
  };
  return { call, ana, bo, agent, grant, pat, dump };
}

describe("export and delete", () => {
  test.each(["agent", "grant", "pat"] as const)("a %s cannot export or delete the person", async (kind) => {
    const w = await world();
    const key = kind === "agent" ? w.agent.apiKey : kind === "grant" ? w.grant.apiKey : w.pat.token;
    expect((await w.call("GET", "/me/export", key)).status).toBe(403);
    expect((await w.call("DELETE", "/me", key)).status).toBe(403);
    expect((await w.call("GET", "/me", w.ana)).status).toBe(200);
  });

  test("the export holds the person's data and nothing about another person or any secret", async () => {
    const w = await world();
    const out = (await w.call("GET", "/me/export", w.ana)).body;
    const text = JSON.stringify(out);
    expect(out.user.email).toBe("ana@example.test");
    expect(out.principals.map((p: { id: string }) => p.id).sort()).toEqual(["ana", w.agent.id, w.grant.id, w.pat.id].sort());
    expect(out.resources.map((r: { id: string }) => r.id).sort()).toEqual(["boss", "mine", "mine-child", "shared"]);
    expect(out.audit.length).toBeGreaterThan(0);
    for (const secret of [w.agent.apiKey, w.grant.apiKey, w.pat.token, w.ana, w.bo]) expect(text).not.toContain(secret);
    expect(text).not.toContain("tokenHash");
    expect(text).not.toContain("bo@example.test");
    expect(text).not.toContain("cy@example.test");
    expect(text).not.toContain("dee@example.test");
  });

  test("a delete removes the person, their agents, and what only they own, and spares the rest", async () => {
    const w = await world();
    expect((await w.call("DELETE", "/me", w.ana)).status).toBe(200);
    const left = await w.dump();
    for (const gone of ["ana", "scribe", "resources/mine ", "resources/mine-child ", "grants/mine:", "ana@example.test", "cy@example.test", "dee@example.test", w.agent.id, w.grant.id, w.pat.id]) expect(left).not.toContain(gone);
    for (const key of [w.ana, w.agent.apiKey, w.grant.apiKey, w.pat.token]) expect((await w.call("GET", "/me", key)).status).toBe(401);
    expect(left).toContain("bo@example.test");
    expect((await w.call("GET", "/resources/shared/access?action=admin", w.bo)).body.allowed).toBe(true);
    expect((await w.call("GET", "/resources/boss/access?action=admin", w.bo)).body.allowed).toBe(true);
    expect((await w.call("GET", "/resources/bo-note/access?action=admin", w.bo)).body.allowed).toBe(true);
    expect((await w.call("DELETE", "/me", w.ana)).status).toBe(401);
  });
});
