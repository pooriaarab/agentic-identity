// Failure-mode list for requirePrincipal. These were written before the code.
//  1. A valid key gives the principal. 2. A revoked key is a 401. 3. No header is a 401 with
//     WWW-Authenticate. 4. A wrong scheme (Basic, lowercase-only junk) is a 401.
//  5. An agent principal comes back with its kind, and `kinds` that leave it out give a 403.
//  6. A scope the principal lacks is a 403. 7. An unknown kind or a bad scope option throws.
//  8. Cookie writes need a listed Origin; a bearer write and a cookie read do not. A bad Authorization header
//     is a 401 even beside a valid cookie. An expired key and a revoked parent are a 401.
//  9. An Auth that throws gives a 503, never a principal. 9. No body holds the credential.
import { describe, expect, test } from "vitest";
import { createMemoryStore } from "./adapters/memory.js";
import type { PrincipalContext } from "./core/principals.js";
import { createStoreAuth, issueCredential, revokeCredential } from "./credentials.js";
import { requirePrincipal } from "./http.js";

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
      expect(((await requirePrincipal(req({ authorization }), auth)) as Response).status).toBe(401);
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
