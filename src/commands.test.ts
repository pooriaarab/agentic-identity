// Failure cases for the rights checks in the command table. Each is a way a command could give
// rights that the actor does not hold.
//  1. An agent (own identity) cannot make an agent. Only a person can.
//  2. A person with narrow scopes cannot give an agent a scope wider than their own.
//  3. An agent made by delegation, or a token, cannot make an agent.
//  4. An unknown, revoked, or expired actor is refused by every command, including a list.
//  5. A handle is not made twice, and a bad handle or scope is a usage error.
//  6. An agent with a viewer role cannot list grants, and a person with no role cannot either.
import { describe, expect, test } from "vitest";
import { createMemoryStore } from "./adapters/memory.js";
import { COMMANDS, UsageError, openApp, type Args } from "./commands.js";

const find = (...path: string[]) => COMMANDS.find((c) => c.path.join(" ") === path.join(" "))!;
async function setup() {
  const store = createMemoryStore();
  let clock = 1_000;
  const as = async (id?: string) => openApp(store, { ...(id === undefined ? {} : { as: id }), now: () => clock });
  const run = async (id: string | undefined, command: string[], args: Args) => find(...command).run(await as(id), args);
  await as();
  return { store, as, run, tick: (ms: number) => (clock += ms) };
}

describe("agents create", () => {
  test("only a person makes an agent, and only with scopes inside their own", async () => {
    const { store, run } = await setup();
    const made = (await run(undefined, ["agents", "create"], { handle: "helper", scopes: ["doc:write"] })) as { id: string };
    // 1. An agent cannot make another agent.
    await expect(run(made.id, ["agents", "create"], { handle: "child", scopes: ["doc:read"] })).rejects.toThrow("only a person");
    // 3. A delegated agent and a token cannot either.
    await store.put("principals", "d1", { id: "d1", kind: "agent_of_human", parentId: "local", scopes: ["doc:write"] });
    await store.put("principals", "t1", { id: "t1", kind: "user_token", parentId: "local", scopes: ["doc:write"] });
    await expect(run("d1", ["agents", "create"], { handle: "child", scopes: ["doc:read"] })).rejects.toThrow("only a person");
    await expect(run("t1", ["agents", "create"], { handle: "child", scopes: ["doc:read"] })).rejects.toThrow("only a person");
    // 2. A person with narrow scopes cannot widen.
    await store.put("principals", "ann", { id: "ann", kind: "human", scopes: ["doc:write"] });
    await expect(run("ann", ["agents", "create"], { handle: "wide", scopes: ["doc:admin"] })).rejects.toThrow("exceed your own");
    await expect(run("ann", ["agents", "create"], { handle: "wide", scopes: ["sheet:read"] })).rejects.toThrow("exceed your own");
    await expect(run("ann", ["agents", "create"], { handle: "star", scopes: ["*:read"] })).rejects.toThrow("exceed your own");
    await expect(run("ann", ["agents", "create"], { handle: "ok", scopes: ["doc:read"] })).resolves.toMatchObject({ handle: "ok" });
    expect((await store.get("handles", "wide"))).toBeNull();
  });

  test("a handle is made once, and bad input is a usage error", async () => {
    const { run } = await setup();
    await run(undefined, ["agents", "create"], { handle: "helper", scopes: ["doc:read"] });
    await expect(run(undefined, ["agents", "create"], { handle: "helper", scopes: ["doc:read"] })).rejects.toThrow("handle taken");
    for (const handle of ["A", "x", "has space", "-lead"]) await expect(run(undefined, ["agents", "create"], { handle, scopes: ["doc:read"] })).rejects.toThrow(UsageError);
    for (const scopes of [[], ["doc"], ["doc:everything"], undefined]) await expect(run(undefined, ["agents", "create"], { handle: "okay", scopes } as Args)).rejects.toThrow(UsageError);
  });
});

describe("principals list", () => {
  test("shows ids, kinds, handles, and scopes, and nothing else a record holds", async () => {
    const { store, run } = await setup();
    await store.put("principals", "ann", { id: "ann", kind: "human", scopes: ["doc:read"], email: "ann@example.com", tokenHash: "abc" });
    const { principals } = (await run(undefined, ["principals", "list"], {})) as { principals: Record<string, unknown>[] };
    expect(principals.find((p) => p.id === "ann")).toEqual({ id: "ann", kind: "human", scopes: ["doc:read"] });
    expect(JSON.stringify(principals)).not.toMatch(/example\.com|tokenHash/);
    await store.put("principals", "bad", { id: "bad", kind: "agent", scopes: [], handle: "jo@ex.io" });
    const again = (await run(undefined, ["principals", "list"], {})) as { principals: Record<string, unknown>[] };
    expect(again.principals.find((p) => p.id === "bad")).toEqual({ id: "bad", kind: "agent", scopes: [] });
    await expect(run(undefined, ["principals", "list"], { limit: 201 })).rejects.toThrow(UsageError);
  });
});

describe("principals list for an agent", () => {
  test("an agent without all rights cannot list the principals", async () => {
    const { run } = await setup();
    const made = (await run(undefined, ["agents", "create"], { handle: "helper", scopes: ["doc:admin"] })) as { id: string };
    await expect(run(made.id, ["principals", "list"], {})).rejects.toThrow("forbidden");
  });
});

describe("the actor", () => {
  test("an unknown, revoked, or expired actor is refused by every command", async () => {
    const { store, run, tick } = await setup();
    // The clock of `run` is 1_000 plus the ticks. `old` expires at 1_500.
    const made = (await run(undefined, ["agents", "create"], { handle: "helper", scopes: ["doc:read"] })) as { id: string };
    await store.put("principals", "gone", { id: "gone", kind: "human", scopes: ["*:admin"], revokedAt: 500 });
    await store.put("principals", "old", { id: "old", kind: "human", scopes: ["*:admin"], expiresAt: 1_500 });
    tick(1_000);
    for (const id of ["ghost", "gone", "old"]) {
      // `links resolve` is what a visitor with a token does, so it has no actor.
      for (const command of COMMANDS.filter((c) => c.tool !== "identity_links_resolve")) {
        const args: Args = { resource: "r", type: "doc", handle: "zed", scopes: ["doc:read"], kind: "human", subject: "x", role: "viewer", invite: "i", link: "l", token: "t" };
        await expect(command.run(await openApp(store, { as: id, now: () => 2_000 }), args), `${id} ${command.path.join(" ")}`).rejects.toThrow(/cannot act as/);
      }
    }
    await expect(run(made.id, ["whoami"], {})).resolves.toMatchObject({ kind: "agent" });
  });

  test("an agent with a viewer role and a stranger cannot list grants", async () => {
    const { store, run } = await setup();
    const made = (await run(undefined, ["agents", "create"], { handle: "helper", scopes: ["doc:read"] })) as { id: string };
    await run(undefined, ["resources", "create"], { type: "doc", id: "r1" });
    await run(undefined, ["grants", "set"], { resource: "r1", kind: "agent", subject: made.id, role: "viewer" });
    await expect(run(made.id, ["grants", "list"], { resource: "r1" })).rejects.toThrow("forbidden");
    await store.put("principals", "eve", { id: "eve", kind: "human", scopes: ["*:admin"] });
    await expect(run("eve", ["grants", "list"], { resource: "r1" })).rejects.toThrow("forbidden");
  });
});
