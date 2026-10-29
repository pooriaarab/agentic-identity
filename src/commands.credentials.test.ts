// Failure cases for `tokens create` and `delegations create`. Each is a way a command could give
// rights or a secret that the actor should not.
//  1. An agent, a delegated agent, and a token cannot make a token. Only a person can.
//  2. A token cannot delegate. An agent and a delegated agent can, and the kind follows the actor.
//  3. A delegation cannot hold a scope outside the actor's own, so a step only narrows.
//  4. A bad scope list (missing, empty, too long, not in the scope format) is a usage error and writes nothing.
//  5. A bad expiry (zero, negative, fraction, string) is a usage error and writes nothing.
//  6. The secret works once: the store holds only its hash, and the principal expires with the credential.
//  7. A token that has more scopes than its person still acts with the person's scopes only.
//  8. A revoked or expired actor cannot make either.
import { describe, expect, test } from "vitest";
import { createMemoryStore } from "./adapters/memory.js";
import { COMMANDS, openApp, type Args } from "./commands.js";
import { sha256Hex } from "./credentials.js";

const find = (...path: string[]) => COMMANDS.find((c) => c.path.join(" ") === path.join(" "))!;
async function setup() {
  const store = createMemoryStore();
  let clock = 1_000;
  const run = async (id: string | undefined, command: string[], args: Args) => find(...command).run(await openApp(store, { ...(id === undefined ? {} : { as: id }), now: () => clock }), args);
  await openApp(store);
  const count = async () => ((await store.query("principals", {})).items.length) + (await store.query("credentials", {})).items.length;
  return { store, run, count, tick: (ms: number) => (clock += ms) };
}
type Made = { id: string; token?: string; apiKey?: string };

describe("tokens create", () => {
  test("only a person makes a token, and the secret is stored as a hash", async () => {
    const { store, run } = await setup();
    const made = (await run(undefined, ["tokens", "create"], { scopes: ["doc:read"], label: "ci" })) as Made;
    expect(made.token).toMatch(/^aid_/);
    expect(await store.get("principals", made.id)).toMatchObject({ kind: "user_token", parentId: "local", scopes: ["doc:read"] });
    expect(await store.get("credentials", await sha256Hex(made.token!))).toMatchObject({ principalId: made.id, kind: "pat", label: "ci" });
    expect(JSON.stringify((await store.query("credentials", {})).items)).not.toContain(made.token!);
    // 1.
    const agent = (await run(undefined, ["agents", "create"], { handle: "bot", scopes: ["doc:read"] })) as Made;
    await store.put("principals", "d1", { id: "d1", kind: "agent_of_human", parentId: "local", scopes: ["doc:read"] });
    for (const who of [agent.id, "d1", made.id]) await expect(run(who, ["tokens", "create"], { scopes: ["doc:read"] })).rejects.toThrow("only a person");
  });

  test("a bad scope list or expiry is a usage error and writes nothing", async () => {
    const { run, count } = await setup();
    const before = await count();
    const bad: Args[] = [{}, { scopes: [] }, { scopes: ["nope"] }, { scopes: Array.from({ length: 33 }, () => "doc:read") }, { scopes: "doc:read" }, { scopes: ["doc:read"], "expires-in-ms": 0 }, { scopes: ["doc:read"], "expires-in-ms": -5 }, { scopes: ["doc:read"], "expires-in-ms": 1.5 }, { scopes: ["doc:read"], "expires-in-ms": "9" }];
    for (const args of bad) await expect(run(undefined, ["tokens", "create"], args), JSON.stringify(args)).rejects.toThrow();
    expect(await count()).toBe(before);
  });

  test("the token and its principal expire together, and a token acts with the person's scopes only", async () => {
    const { store, run, tick } = await setup();
    await store.put("principals", "ann", { id: "ann", kind: "human", scopes: ["doc:read"] });
    const wide = (await run("ann", ["tokens", "create"], { scopes: ["doc:admin"], "expires-in-ms": 100 })) as Made;
    expect(await store.get("credentials", await sha256Hex(wide.token!))).toMatchObject({ expiresAt: 1_100 });
    const who = (await run(wide.id, ["whoami"], {})) as { scopes: string[] };
    expect(who.scopes).not.toContain("doc:admin");
    tick(200);
    await expect(run(wide.id, ["whoami"], {})).rejects.toThrow("cannot act");
  });
});

describe("delegations create", () => {
  test("a person or an agent delegates inside their own scopes, and a token does not", async () => {
    const { store, run } = await setup();
    const fromPerson = (await run(undefined, ["delegations", "create"], { scopes: ["doc:write"] })) as Made;
    expect(fromPerson.apiKey).toMatch(/^aid_/);
    expect(await store.get("principals", fromPerson.id)).toMatchObject({ kind: "agent_of_human", parentId: "local" });
    expect(await store.get("credentials", await sha256Hex(fromPerson.apiKey!))).toMatchObject({ principalId: fromPerson.id, kind: "api_key" });
    // 2. A delegated agent delegates again. A step only narrows.
    const below = (await run(fromPerson.id, ["delegations", "create"], { scopes: ["doc:read"] })) as Made;
    expect(await store.get("principals", below.id)).toMatchObject({ kind: "agent_of_agent", parentId: fromPerson.id });
    // 3.
    await expect(run(fromPerson.id, ["delegations", "create"], { scopes: ["doc:admin"] })).rejects.toThrow("exceed your own");
    await expect(run(below.id, ["delegations", "create"], { scopes: ["doc:write"] })).rejects.toThrow("exceed your own");
    const agent = (await run(undefined, ["agents", "create"], { handle: "bot", scopes: ["doc:write"] })) as Made;
    expect(await run(agent.id, ["delegations", "create"], { scopes: ["doc:read"] })).toMatchObject({ apiKey: expect.stringMatching(/^aid_/) });
    const token = (await run(undefined, ["tokens", "create"], { scopes: ["doc:write"] })) as Made;
    await expect(run(token.id, ["delegations", "create"], { scopes: ["doc:read"] })).rejects.toThrow("a token cannot delegate");
  });

  test("a bad request writes nothing, and a revoked actor is refused", async () => {
    const { run, count } = await setup();
    const made = (await run(undefined, ["delegations", "create"], { scopes: ["doc:read"] })) as Made;
    const before = await count();
    for (const args of [{}, { scopes: [] }, { scopes: ["x"] }, { scopes: ["doc:read"], "expires-in-ms": 0 }, { scopes: ["doc:read"], "expires-in-ms": 2.5 }] as Args[]) await expect(run(undefined, ["delegations", "create"], args)).rejects.toThrow();
    expect(await count()).toBe(before);
    await run(undefined, ["principals", "revoke"], { principal: made.id });
    // 8.
    await expect(run(made.id, ["delegations", "create"], { scopes: ["doc:read"] })).rejects.toThrow("cannot act");
  });
});
