// Spawns the real CLI on a store file. Each step is a separate process, so it also shows that the file keeps the data.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, test } from "vitest";
import { COMMANDS } from "./commands.js";
import { bundleEntry } from "./test-bundle.js";

let bin = "";
const store = join(mkdtempSync(join(tmpdir(), "ai-cli-")), "store.json");
beforeAll(async () => {
  bin = await bundleEntry("src/cli-bin.ts");
}, 60_000);

const run = (...args: string[]) => {
  const r = spawnSync(process.execPath, [bin, "--store", store, ...args], { encoding: "utf8", env: { PATH: process.env.PATH ?? "" } });
  return { code: r.status, out: r.stdout, err: r.stderr, json: () => JSON.parse(r.stdout) };
};

// Each step spawns a process, and the VM is shared, so give the tests room.
describe("agentic-identity CLI", { timeout: 60_000 }, () => {
  test("--help exits 0 for the program and for every command", () => {
    expect(run("--help").code).toBe(0);
    expect(run("--help").out).toContain("grants list");
    for (const c of COMMANDS) {
      const r = run(...c.path, "--help");
      expect(r.code, c.path.join(" ")).toBe(0);
      expect(r.out).toContain(`Usage: agentic-identity ${c.path.join(" ")}`);
    }
  });

  test("prints the version, and a bad command is a usage error", () => {
    expect(run("--version").out.trim()).toMatch(/^\d+\.\d+\.\d+/);
    const bad = run("nope");
    expect(bad.code).toBe(2);
    expect(bad.err).toContain("unknown command");
    expect(run("grants", "set", "doc1").code).toBe(2);
    expect(run("grants", "list", "doc1", "--limit", "x").code).toBe(2);
    expect(run("grants", "list", "doc1", "--bogus").code).toBe(2);
  });

  test("flags may come before or after the arguments, and a value is never a flag", () => {
    expect(run("resources", "create", "doc", "--id", "d9").code).toBe(0);
    expect(run("audit", "--limit", "5", "d9").code).toBe(0);
    expect(run("audit", "d9", "--limit", "5").code).toBe(0);
    const swallowed = run("resources", "create", "doc", "--id", "--version");
    expect(swallowed.code).toBe(2);
    expect(swallowed.out).toBe("");
    expect(run("--as", "--help", "whoami").code).toBe(2);
    expect(run("whoami", "--", "--help").code).toBe(2);
    expect(run("--as", "ghost", "--as", "local", "whoami").code).toBe(2);
    expect(run("--as", "ghost", "whoami").err).toContain("cannot act as");
  });

  test("a repeated flag and a loose number are usage errors", () => {
    expect(run("agents", "create", "twice", "--scopes", "doc:read", "--scopes", "*:admin").code).toBe(2);
    expect(run("audit", "d9", "--limit", "0x10").code).toBe(2);
    expect(run("audit", "d9", "--limit", "1e2").code).toBe(2);
    expect(run("links", "create", "d9", "viewer", "--expires-in-ms", "-5").code).toBe(2);
  });

  test("an error does not echo an email that was mistyped", () => {
    for (const args of [["invites", "accept", "abc", "ann@example.com"], ["ann@example.com"], ["--as", "ann@example.com", "whoami"], ["invites", "create", "d9", "viewer", "--ann@example.com"]]) {
      const r = run(...args);
      expect(r.code, args.join(" ")).toBeGreaterThan(0);
      expect(r.err).not.toContain("example.com");
    }
  });

  test("principals, grants, invites, links, and audit work across processes", () => {
    expect(run("whoami").json()).toMatchObject({ principalId: "local", kind: "human", chain: [{ id: "local", kind: "human" }] });
    expect(run("resources", "create", "doc", "--id", "doc1").json()).toEqual({ id: "doc1", type: "doc" });

    const agent = run("agents", "create", "helper", "--scopes", "doc:read").json();
    expect(agent).toMatchObject({ handle: "helper", scopes: ["doc:read"] });
    expect(run("agents", "create", "helper", "--scopes", "doc:read").code).toBe(1);
    expect(run("agents", "create", "wide", "--scopes", "nope").code).toBe(2);
    expect(run("principals", "list").json().principals.map((p: { id: string }) => p.id).sort()).toEqual(["local", agent.id].sort());

    // The agent has no role yet, and a viewer cannot list grants.
    expect(run("--as", agent.id, "grants", "list", "doc1").code).toBe(1);
    expect(run("grants", "set", "doc1", "agent", agent.id, "viewer").json()).toEqual({ ok: true });
    expect(run("--as", agent.id, "grants", "list", "doc1").code).toBe(1);
    const grants = run("grants", "list", "doc1").json().grants;
    expect(grants).toHaveLength(2);
    expect(run("grants", "revoke", "doc1", "agent", agent.id).json()).toEqual({ ok: true });
    expect(run("grants", "list", "doc1").json().grants).toHaveLength(1);

    const invite = run("invites", "create", "doc1", "editor", "--handle", "helper").json();
    expect(run("invites", "create", "doc1", "editor").code).toBe(2);
    expect(run("invites", "list", "doc1").json().invites).toMatchObject([{ id: invite.id, for: "handle", handle: "helper", role: "editor" }]);
    expect(run("--as", agent.id, "invites", "accept", invite.id).json()).toEqual({ ok: true });
    expect(run("--as", agent.id, "invites", "accept", invite.id).code).toBe(1);
    expect(run("invites", "list", "doc1").json().invites[0].acceptedAt).toBeTypeOf("number");

    const person = run("invites", "create", "doc1", "viewer", "--email", "Ann@Example.com").json();
    expect(run("invites", "accept", person.id, "--email", "other@example.com").code).toBe(1);
    expect(run("invites", "list", "doc1").out.toLowerCase()).not.toContain("example.com");

    const link = run("links", "create", "doc1", "viewer").json();
    expect(link.token).toBeTypeOf("string");
    expect(run("links", "resolve", "doc1", link.token).json()).toEqual({ allowed: true, role: "viewer" });
    expect(run("links", "resolve", "doc1", link.token, "--action", "write").json()).toMatchObject({ allowed: false });
    expect(run("links", "revoke", link.id).json()).toEqual({ ok: true });
    expect(run("links", "resolve", "doc1", link.token).json()).toEqual({ allowed: false });

    const audit = run("audit", "doc1").json().entries as { action: string; principalKind: string; machineMade: boolean }[];
    expect(audit.map((e) => e.action)).toEqual(expect.arrayContaining(["grant.set", "grant.revoke", "invite.create", "invite.accept", "link.create", "link.revoke", "read"]));
    expect(audit.find((e) => e.action === "invite.accept")).toMatchObject({ principalKind: "agent", machineMade: true });
  });

  test("a signed-in-only link gives nothing to a visitor, and a usage error exits 2", () => {
    run("resources", "create", "doc", "--id", "doc2");
    const link = run("links", "create", "doc2", "viewer", "--signed-in-only").json();
    expect(run("links", "resolve", "doc2", link.token).json()).toEqual({ allowed: false });
    expect(run("invites", "create", "doc2", "viewer").code).toBe(2);
    expect(run("invites", "create", "doc2", "viewer", "--handle", "bot", "--expires-in-ms", "0").code).toBe(2);
    expect(run("audit", "doc2", "--limit", "0").code).toBe(2);
    // The file is private and keeps no token, only its hash.
    expect(statSync(store).mode & 0o777).toBe(0o600);
    expect(readFileSync(store, "utf8")).not.toContain(link.token);
  });

  test("a file that is not a store is refused without showing it", () => {
    const stray = join(mkdtempSync(join(tmpdir(), "ai-stray-")), "contacts.txt");
    writeFileSync(stray, "jo@ex.io\nalice.secret@example.com\n");
    const r = spawnSync(process.execPath, [bin, "--store", stray, "whoami"], { encoding: "utf8" });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("not an agentic-identity store file");
    expect(r.stderr + r.stdout).not.toMatch(/ex\.io|example\.com/);
  });
});
