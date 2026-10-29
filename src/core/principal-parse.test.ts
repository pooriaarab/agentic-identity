// Failure cases for parsePrincipal and subjectOf:
//  1. Input that is not an object (null, array, string, number).
//  2. Kind missing, unknown, not a string, or "__proto__": throw, never default to human.
//  3. Id missing, empty, not a string, too long.
//  4. Id with a character outside the closed set (space, colon, slash, @, newline, unicode).
//  5. Extra fields (scopes, actingFor) do not pass through.
//  6. subjectOf is stable, and refuses a bad principal.
import { describe, expect, test } from "vitest";
import { PRINCIPAL_KINDS, parsePrincipal, subjectOf } from "../index.js";

describe("parsePrincipal", () => {
  test("accepts every kind", () => {
    for (const kind of PRINCIPAL_KINDS) expect(parsePrincipal({ kind, id: "a-1.b_2" })).toEqual({ kind, id: "a-1.b_2" });
  });
  test("accepts a human and an agent, and drops extra fields", () => {
    expect(parsePrincipal({ kind: "human", id: "u1", scopes: ["*:admin"] })).toEqual({ kind: "human", id: "u1" });
    expect(parsePrincipal({ kind: "agent", id: "bot" })).toEqual({ kind: "agent", id: "bot" });
  });
  test.each([null, undefined, [], "human", 3])("rejects non-object %j", (v) => {
    expect(() => parsePrincipal(v)).toThrow(/object/);
  });
  test.each([undefined, "", "robot", "__proto__", 1, null])("rejects kind %j", (kind) => {
    expect(() => parsePrincipal({ kind, id: "u1" })).toThrow(/kind/);
  });
  test.each([undefined, "", 5, null, "a".repeat(129)])("rejects id %j", (id) => {
    expect(() => parsePrincipal({ kind: "human", id })).toThrow(/id/);
  });
  test.each(["a b", "a:b", "a/b", "a@b.c", "a\nb", "é", "-a", ".a"])("rejects id %j", (id) => {
    expect(() => parsePrincipal({ kind: "human", id })).toThrow(/id/);
  });
});

describe("subjectOf", () => {
  test("gives kind:id", () => {
    expect(subjectOf({ kind: "agent_of_human", id: "a1" })).toBe("agent_of_human:a1");
  });
  test("refuses a bad principal", () => {
    expect(() => subjectOf({ kind: "human", id: "a:b" })).toThrow(/id/);
    expect(() => subjectOf({ kind: "x", id: "a" } as never)).toThrow(/kind/);
  });
});
