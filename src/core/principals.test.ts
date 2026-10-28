// Failure-mode list for the delegation resolver. Each case below is a way
// the rights check can go wrong. These tests were written before the code.
//
//  1. Scope strings: malformed text and misused wildcards must not parse.
//  2. Cover: a narrow grant must not satisfy a wide requirement.
//  3. Intersect: a step can only narrow, never widen.
//  4. Escalation via child: a child asks for more than its parent has.
//  5. Revoked ancestor: everything below it loses all rights.
//  6. Expired grant: an expired step removes rights below it.
//  7. Cycle in the chain, including a principal that is its own parent.
//  8. Chain depth cap: too deep fails, exactly at the cap passes.
//  9. Missing parent record.
// 10. A principal kind with the wrong parent kind.
// 11. Audit entries keep the principal kind and the whole chain, and no email.
import { describe, expect, test } from "vitest";
import {
  MAX_CHAIN_DEPTH,
  auditEntry,
  hasScope,
  intersectScopes,
  isMachineMade,
  parseScope,
  resolveChain,
  scopeCovers,
  type Principal,
} from "./principals.js";

const NOW = 1_000_000;

function table(...list: Principal[]) {
  const map = new Map(list.map((p) => [p.id, p]));
  return (id: string) => map.get(id);
}

const human: Principal = { id: "h1", kind: "human", scopes: ["*:admin"] };
const agent1: Principal = { id: "a1", kind: "agent_of_human", parentId: "h1", scopes: ["docs:write", "drive:read"] };
const agent2: Principal = { id: "a2", kind: "agent_of_agent", parentId: "a1", scopes: ["docs:admin"] };

describe("scope strings", () => {
  test.each(["", "docs", ":read", "docs:", "docs:*", "*:*", "Docs:read", "docs:read:x", "doc*:read", "docs:delete", "docs read", " docs:read"])(
    "rejects %j",
    (text) => {
      expect(() => parseScope(text)).toThrow();
    },
  );
  test.each(["docs:read", "*:admin", "drive-files:write", "tables_v2:comment"])("accepts %j", (text) => {
    expect(parseScope(text).resource.length).toBeGreaterThan(0);
  });
});

describe("scope cover", () => {
  test("a stronger action covers a weaker one on the same resource", () => {
    expect(scopeCovers("docs:write", "docs:read")).toBe(true);
    expect(scopeCovers("docs:write", "docs:comment")).toBe(true);
    expect(scopeCovers("docs:write", "docs:admin")).toBe(false);
  });
  test("a specific resource never covers another resource", () => {
    expect(scopeCovers("docs:admin", "drive:read")).toBe(false);
  });
  test("a wildcard grant covers any resource at or below its action", () => {
    expect(scopeCovers("*:read", "docs:read")).toBe(true);
    expect(scopeCovers("*:read", "docs:write")).toBe(false);
  });
  test("a specific grant never satisfies a wildcard requirement", () => {
    expect(scopeCovers("docs:admin", "*:read")).toBe(false);
    expect(hasScope(["docs:admin", "drive:admin"], "*:read")).toBe(false);
    expect(hasScope(["*:admin"], "*:read")).toBe(true);
  });
});

describe("intersection", () => {
  test("takes the weaker action on the same resource", () => {
    expect(intersectScopes(["docs:write"], ["docs:read"])).toEqual(["docs:read"]);
  });
  test("a wildcard narrows to the specific side", () => {
    expect(intersectScopes(["*:admin"], ["docs:write"])).toEqual(["docs:write"]);
  });
  test("different resources give nothing", () => {
    expect(intersectScopes(["docs:read"], ["drive:read"])).toEqual([]);
  });
  test("a wildcard against a list keeps each resource", () => {
    expect(intersectScopes(["*:read"], ["docs:write", "drive:read"]).sort()).toEqual(["docs:read", "drive:read"]);
  });
  test("has no duplicates", () => {
    expect(intersectScopes(["*:read", "docs:read"], ["docs:read"])).toEqual(["docs:read"]);
  });
});

describe("resolveChain", () => {
  test("a root human keeps its own scopes", async () => {
    const result = await resolveChain("h1", table(human), { now: NOW });
    expect(result).toMatchObject({ ok: true, scopes: ["*:admin"] });
  });

  test("rights narrow down a three-step chain", async () => {
    const result = await resolveChain("a2", table(human, agent1, agent2), { now: NOW });
    expect(result.ok && result.scopes).toEqual(["docs:write"]);
  });

  test("escalation via child is cut to the parent's rights", async () => {
    const greedy: Principal = { id: "a3", kind: "agent_of_human", parentId: "h2", scopes: ["*:admin"] };
    const small: Principal = { id: "h2", kind: "human", scopes: ["docs:read"] };
    const result = await resolveChain("a3", table(small, greedy), { now: NOW });
    expect(result.ok && result.scopes).toEqual(["docs:read"]);
  });

  test("a revoked parent removes all rights below it", async () => {
    const revoked = { ...agent1, revokedAt: NOW - 1 };
    const result = await resolveChain("a2", table(human, revoked, agent2), { now: NOW });
    expect(result).toEqual({ ok: false, reason: "revoked", at: "a1" });
  });

  test("a revoked root removes all rights below it", async () => {
    const revoked = { ...human, revokedAt: NOW - 5 };
    const result = await resolveChain("a2", table(revoked, agent1, agent2), { now: NOW });
    expect(result).toEqual({ ok: false, reason: "revoked", at: "h1" });
  });

  test("revocation applies at its own time, not before", async () => {
    const later = { ...agent1, revokedAt: NOW + 1 };
    expect((await resolveChain("a1", table(human, later), { now: NOW })).ok).toBe(true);
    const exact = { ...agent1, revokedAt: NOW };
    expect((await resolveChain("a1", table(human, exact), { now: NOW })).ok).toBe(false);
  });

  test("an expired grant removes rights below it", async () => {
    const expired = { ...agent1, expiresAt: NOW };
    const result = await resolveChain("a2", table(human, expired, agent2), { now: NOW });
    expect(result).toEqual({ ok: false, reason: "expired", at: "a1" });
    const live = { ...agent1, expiresAt: NOW + 1 };
    expect((await resolveChain("a2", table(human, live, agent2), { now: NOW })).ok).toBe(true);
  });

  test("a cycle fails", async () => {
    const x: Principal = { id: "x", kind: "agent_of_agent", parentId: "y", scopes: ["docs:read"] };
    const y: Principal = { id: "y", kind: "agent_of_agent", parentId: "x", scopes: ["docs:read"] };
    expect(await resolveChain("x", table(x, y), { now: NOW })).toMatchObject({ ok: false, reason: "cycle" });
  });

  test("a principal that is its own parent fails", async () => {
    const self: Principal = { id: "s", kind: "agent_of_agent", parentId: "s", scopes: ["docs:read"] };
    expect(await resolveChain("s", table(self), { now: NOW })).toMatchObject({ ok: false, reason: "cycle" });
  });

  function deepChain(length: number) {
    const list: Principal[] = [{ id: "n0", kind: "human", scopes: ["*:admin"] }];
    list.push({ id: "n1", kind: "agent_of_human", parentId: "n0", scopes: ["docs:write"] });
    for (let i = 2; i < length; i++) {
      list.push({ id: `n${i}`, kind: "agent_of_agent", parentId: `n${i - 1}`, scopes: ["docs:write"] });
    }
    return list;
  }

  test("a chain at the depth cap passes and one step more fails", async () => {
    const ok = deepChain(MAX_CHAIN_DEPTH);
    expect((await resolveChain(`n${MAX_CHAIN_DEPTH - 1}`, table(...ok), { now: NOW })).ok).toBe(true);
    const tooDeep = deepChain(MAX_CHAIN_DEPTH + 1);
    expect(await resolveChain(`n${MAX_CHAIN_DEPTH}`, table(...tooDeep), { now: NOW })).toMatchObject({
      ok: false,
      reason: "depth_exceeded",
    });
  });

  test("a custom cap applies", async () => {
    const chain = deepChain(3);
    expect(await resolveChain("n2", table(...chain), { now: NOW, maxDepth: 2 })).toMatchObject({
      ok: false,
      reason: "depth_exceeded",
    });
  });

  test("a missing parent or leaf fails", async () => {
    expect(await resolveChain("a1", table(agent1), { now: NOW })).toEqual({ ok: false, reason: "unknown_principal", at: "h1" });
    expect(await resolveChain("nope", table(human), { now: NOW })).toEqual({ ok: false, reason: "unknown_principal", at: "nope" });
  });

  test.each([
    ["a human with a parent", { id: "p", kind: "human", parentId: "h1", scopes: [] }],
    ["an own-identity agent with a parent", { id: "p", kind: "agent", parentId: "h1", scopes: [] }],
    ["an agent_of_human with no parent", { id: "p", kind: "agent_of_human", scopes: [] }],
    ["an agent_of_human under an agent", { id: "p", kind: "agent_of_human", parentId: "a1", scopes: [] }],
    ["a user_token under an agent", { id: "p", kind: "user_token", parentId: "a1", scopes: [] }],
    ["an agent_of_agent under a human", { id: "p", kind: "agent_of_agent", parentId: "h1", scopes: [] }],
    ["a malformed stored scope", { id: "p", kind: "agent_of_human", parentId: "h1", scopes: ["docs:delete"] }],
  ] as [string, Principal][])("rejects %s", async (_name, bad) => {
    const result = await resolveChain("p", table(human, agent1, bad), { now: NOW });
    expect(result).toMatchObject({ ok: false, reason: "invalid_chain", at: "p" });
  });

  test("does not change the stored principals", async () => {
    const before = JSON.stringify([human, agent1, agent2]);
    await resolveChain("a2", table(human, agent1, agent2), { now: NOW });
    expect(JSON.stringify([human, agent1, agent2])).toBe(before);
  });
});

describe("audit", () => {
  test("keeps the principal kind and the whole chain, and nothing personal", async () => {
    const result = await resolveChain("a2", table(human, agent1, agent2), { now: NOW });
    if (!result.ok) throw new Error("chain should resolve");
    const entry = auditEntry(result, { id: "e1", at: NOW, action: "docs:write", resourceId: "doc9", outcome: "allowed" });
    expect(entry.principalKind).toBe("agent_of_agent");
    expect(entry.principalId).toBe("a2");
    expect(entry.chain).toEqual([
      { id: "h1", kind: "human" },
      { id: "a1", kind: "agent_of_human" },
      { id: "a2", kind: "agent_of_agent" },
    ]);
    expect(entry.machineMade).toBe(true);
    expect(Object.keys(entry).sort()).toEqual(
      ["action", "at", "chain", "id", "machineMade", "outcome", "principalId", "principalKind", "resourceId"],
    );
  });

  test("only a human is not machine made", () => {
    expect(isMachineMade("human")).toBe(false);
    for (const kind of ["agent_of_human", "agent_of_agent", "agent", "user_token"] as const) {
      expect(isMachineMade(kind)).toBe(true);
    }
  });
});
