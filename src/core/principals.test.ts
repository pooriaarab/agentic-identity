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
// Stored data can break the declared types (a JSON store returns what was written):
// 12. revokedAt or expiresAt that is a string, NaN, Infinity, an object, a boolean: fail closed.
// 13. A kind outside the five names (a typo, "__proto__"): invalid_chain, no throw.
// 14. Scopes that are missing or not a list: invalid_chain, no throw.
// 15. A root stored with parentId null is a root, not an unknown parent.
// 16. A lookup that returns a record under another id: unknown_principal.
// The caller's options can break the declared types too:
// 17. A clock (`now`) that is NaN, infinite, a string, null, or missing: no rights. NaN made every
//     `revokedAt <= now` false, so a revoked principal kept its rights.
// 18. A depth cap (`maxDepth`) that is NaN, 0, negative, not whole, infinite, a string, or null: no rights.
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

  test.each([
    ["an ISO string", "2026-10-01T00:00:00Z"],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["a numeric string", "1"],
    ["an object", {}],
    ["a boolean", true],
  ])("fails closed when revokedAt is %s", async (_name, value) => {
    const bad = { ...agent1, revokedAt: value } as unknown as Principal;
    expect(await resolveChain("a2", table(human, bad, agent2), { now: NOW })).toEqual({ ok: false, reason: "invalid_chain", at: "a1" });
  });

  test.each([
    ["an ISO string", "2099-10-01T00:00:00Z"],
    ["NaN", Number.NaN],
    ["-Infinity", Number.NEGATIVE_INFINITY],
    ["an array", []],
  ])("fails closed when expiresAt is %s", async (_name, value) => {
    const bad = { ...human, expiresAt: value } as unknown as Principal;
    expect(await resolveChain("a1", table(bad, agent1), { now: NOW })).toEqual({ ok: false, reason: "invalid_chain", at: "h1" });
  });

  test("treats a null revokedAt or expiresAt as not set", async () => {
    const nulls = { ...agent1, revokedAt: null, expiresAt: null } as unknown as Principal;
    expect((await resolveChain("a1", table(human, nulls), { now: NOW })).ok).toBe(true);
  });

  test.each([
    ["a typo kind", { id: "p", kind: "robot", parentId: "h1", scopes: [] }],
    ["a prototype key as kind", { id: "p", kind: "__proto__", parentId: "h1", scopes: [] }],
    ["missing scopes", { id: "p", kind: "agent_of_human", parentId: "h1" }],
    ["scopes that are a string", { id: "p", kind: "agent_of_human", parentId: "h1", scopes: "docs:read" }],
    ["a nested scope list", { id: "p", kind: "agent_of_human", parentId: "h1", scopes: [["*:admin"]] }],
    ["a scope that is an object", { id: "p", kind: "agent_of_human", parentId: "h1", scopes: [{ toString: (): string => "*:admin" }] }],
    ["a scope that is a number", { id: "p", kind: "agent_of_human", parentId: "h1", scopes: [1] }],
    ["a scope that is too long", { id: "p", kind: "agent_of_human", parentId: "h1", scopes: [`${"a".repeat(80)}:read`] }],
  ] as unknown as [string, Principal][])("returns invalid_chain, and does not throw, for %s", async (_name, bad) => {
    expect(await resolveChain("p", table(human, bad), { now: NOW })).toMatchObject({ ok: false, reason: "invalid_chain", at: "p" });
  });

  test("a root stored with a null parentId is a root", async () => {
    const root = { ...human, parentId: null } as unknown as Principal;
    expect((await resolveChain("h1", table(root), { now: NOW })).ok).toBe(true);
  });

  test("a record returned under another id is unknown", async () => {
    const result = await resolveChain("a1", (id) => (id === "a1" ? { ...agent1, id: "other" } : human), { now: NOW });
    expect(result).toEqual({ ok: false, reason: "unknown_principal", at: "a1" });
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
      ["action", "at", "chain", "id", "machineMade", "outcome", "principalId", "principalKind", "resourceId", "rootId"],
    );
  });

  test("only a human is not machine made", () => {
    expect(isMachineMade("human")).toBe(false);
    for (const kind of ["agent_of_human", "agent_of_agent", "agent", "user_token"] as const) {
      expect(isMachineMade(kind)).toBe(true);
    }
  });
});

describe("bad options", () => {
  const revoked: Principal = { ...agent1, revokedAt: NOW - 1 };
  const expired: Principal = { ...agent1, expiresAt: NOW - 1 };

  test.each([[NaN], [Infinity], [-Infinity], ["1000000"], [null], [undefined], [{}], [true]])("a clock of %j gives no rights, even for a live chain", async (now) => {
    for (const records of [[human, agent1], [human, revoked], [human, expired]]) {
      const result = await resolveChain("a1", table(...records), { now: now as number });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe("invalid_options");
    }
  });

  test.each([[NaN], [0], [-1], [1.5], [Infinity], ["5"], [null], [{}]])("a depth cap of %j gives no rights", async (maxDepth) => {
    const result = await resolveChain("a2", table(human, agent1, agent2), { now: NOW, maxDepth: maxDepth as number });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("invalid_options");
  });

  test("no options object gives no rights, and a good one still works", async () => {
    expect((await resolveChain("a1", table(human, agent1), undefined as never)).ok).toBe(false);
    expect((await resolveChain("a1", table(human, agent1), { now: NOW, maxDepth: 2 })).ok).toBe(true);
    expect((await resolveChain("a1", table(human, agent1), { now: 0 })).ok).toBe(true);
  });

  test("the check does not call the lookup", async () => {
    let calls = 0;
    await resolveChain("a1", (id) => (calls++, table(human, agent1)(id)), { now: NaN });
    expect(calls).toBe(0);
  });
});
