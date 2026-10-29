// Spawns the real MCP server and talks to it over stdio, as a client does.
import { type ChildProcessWithoutNullStreams, spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { COMMANDS } from "./commands.js";
import { bundleEntry } from "./test-bundle.js";

let mcpBin = "";
let cliBin = "";
const dir = mkdtempSync(join(tmpdir(), "ai-mcp-"));
const store = join(dir, "store.json");
const children: ChildProcessWithoutNullStreams[] = [];

beforeAll(async () => {
  [mcpBin, cliBin] = await Promise.all([bundleEntry("src/mcp-bin.ts"), bundleEntry("src/cli-bin.ts")]);
}, 60_000);
afterAll(() => children.forEach((c) => c.kill()));

/** A client with request/response by id. Every stdout line must be one JSON message. */
function client(bin: string, args: string[]) {
  const child = spawn(process.execPath, [bin, ...args], { env: { PATH: process.env.PATH ?? "" } });
  children.push(child);
  const waiting = new Map<number | null, (m: Record<string, unknown>) => void>();
  const lines: string[] = [];
  createInterface({ input: child.stdout }).on("line", (line) => {
    lines.push(line);
    const message = JSON.parse(line) as { id: number | null };
    waiting.get(message.id)?.(message as unknown as Record<string, unknown>);
  });
  const send = (message: unknown) => child.stdin.write(`${JSON.stringify(message)}\n`);
  const request = (id: number, method: string, params?: unknown) =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no reply to ${method}`)), 20_000);
      waiting.set(id, (m) => (clearTimeout(timer), resolve(m)));
      send({ jsonrpc: "2.0", id, method, params });
    });
  return { child, send, request, lines, close: () => new Promise<number | null>((r) => (child.on("exit", r), child.stdin.end())) };
}

describe("agentic-identity-mcp", () => {
  test("--help exits 0 on both entry points", () => {
    for (const [bin, args] of [[mcpBin, ["--help"]], [cliBin, ["mcp", "--help"]]] as const) {
      const r = spawnSync(process.execPath, [bin, ...args], { encoding: "utf8" });
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("identity_whoami");
    }
    expect(spawnSync(process.execPath, [mcpBin, "--bogus"], { encoding: "utf8" }).status).toBe(2);
  });

  test("--version prints the package version and exits 0 on both bins, and does not start the server", () => {
    const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
    for (const [bin, args] of [[mcpBin, ["--version"]], [cliBin, ["mcp", "--version"]], [cliBin, ["--version"]]] as const) {
      // No stdin is given: a server that started would wait on it, and the timeout would fail the test.
      const r = spawnSync(process.execPath, [bin, ...args], { encoding: "utf8", input: "", timeout: 20_000 });
      expect(r.status).toBe(0);
      expect(r.stdout.trim()).toBe(version);
      expect(r.stderr).toBe("");
    }
    expect(spawnSync(process.execPath, [mcpBin, "--version=1"], { encoding: "utf8" }).status).toBe(2);
  });

  test("initialize, tools/list, and a tool call work over stdio", { timeout: 60_000 }, async () => {
    const c = client(mcpBin, ["--store", store]);
    const init = await c.request(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } });
    expect(init.result).toMatchObject({ protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "agentic-identity" } });
    c.send({ jsonrpc: "2.0", method: "notifications/initialized" });

    const list = (await c.request(2, "tools/list")).result as { tools: { name: string }[] };
    expect(list.tools.map((t) => t.name)).toEqual(COMMANDS.map((x) => x.tool));

    const who = (await c.request(3, "tools/call", { name: "identity_whoami", arguments: {} })).result as { structuredContent: { principalId: string } };
    expect(who.structuredContent.principalId).toBe("local");

    const made = (await c.request(4, "tools/call", { name: "identity_resources_create", arguments: { type: "doc", id: "plan" } })).result as { isError?: boolean };
    expect(made.isError).toBeUndefined();
    const denied = (await c.request(5, "tools/call", { name: "identity_grants_set", arguments: { resource: "nope", kind: "human", subject: "x", role: "viewer" } })).result as { isError: boolean };
    expect(denied.isError).toBe(true);

    // A line that is not JSON gets a parse error with a null id, and the server goes on.
    c.child.stdin.write("this is not json\n");
    expect((await new Promise<Record<string, unknown>>((resolve) => { const t = setInterval(() => { const m = c.lines.map((l) => JSON.parse(l)).find((m) => m.error?.code === -32700); if (m) { clearInterval(t); resolve(m); } }, 20); })).error).toMatchObject({ code: -32700, message: "parse error" });
    expect((await c.request(6, "ping")).result).toEqual({});

    expect(await c.close()).toBe(0);
    // Nothing but JSON-RPC messages went to stdout, and the replies hold no input text.
    expect(c.lines.every((l) => JSON.parse(l).jsonrpc === "2.0")).toBe(true);
    expect(c.lines.join("\n")).not.toContain("this is not json");
  });

  test("the data persists, and `agentic-identity mcp` serves the same tools as the CLI sees", { timeout: 60_000 }, async () => {
    const c = client(cliBin, ["mcp", "--store", store]);
    await c.request(1, "initialize", { protocolVersion: "2025-06-18" });
    const grants = (await c.request(2, "tools/call", { name: "identity_grants_list", arguments: { resource: "plan" } })).result as { structuredContent: { grants: { subjectId: string; role: string }[] } };
    expect(grants.structuredContent.grants).toEqual([{ resourceId: "plan", subjectKind: "human", subjectId: "local", role: "owner" }]);
    await c.close();
    const cli = spawnSync(process.execPath, [cliBin, "--store", store, "grants", "list", "plan"], { encoding: "utf8" });
    expect(JSON.parse(cli.stdout).grants).toHaveLength(1);
  });

  test("the lifecycle tools work over stdio, and a bad argument is an error result", { timeout: 60_000 }, async () => {
    const own = join(dir, "lifecycle.json");
    const c = client(mcpBin, ["--store", own]);
    await c.request(1, "initialize", {});
    type Result = { isError?: boolean; content: { text: string }[]; structuredContent?: Record<string, string> };
    const call = async (id: number, name: string, args: object) => (await c.request(id, "tools/call", { name, arguments: args })).result as Result;
    const agent = (await call(2, "identity_agents_create", { handle: "robot", scopes: ["doc:read"] })).structuredContent!;
    const rotated = await call(3, "identity_keys_rotate", { principal: agent.id });
    expect(rotated.structuredContent).toMatchObject({ id: agent.id, apiKey: expect.stringMatching(/^aid_/) });
    expect(await call(4, "identity_principals_revoke", { principal: agent.id })).toMatchObject({ structuredContent: { revoked: agent.id } });
    expect(await call(5, "identity_keys_rotate", { principal: agent.id })).toMatchObject({ isError: true, content: [{ text: "bad principal" }] });
    await call(6, "identity_resources_create", { type: "doc", id: "tmp" });
    expect((await call(7, "identity_resources_delete", { resource: "tmp" })).structuredContent).toEqual({ deleted: true });
    expect(await call(8, "identity_resources_delete", { resource: "tmp" })).toMatchObject({ isError: true });
    // The erase needs the flag, as a boolean.
    expect(await call(9, "identity_account_erase", {})).toMatchObject({ isError: true, content: [{ text: "missing --yes" }] });
    expect(await call(10, "identity_account_erase", { yes: "true" })).toMatchObject({ isError: true });
    const out = join(dir, "me.zip");
    expect((await call(11, "identity_account_export", { out })).structuredContent).toMatchObject({ file: out });
    expect(await call(12, "identity_account_export", { out })).toMatchObject({ isError: true, content: [{ text: "the file exists" }] });
    expect(await call(13, "identity_account_erase", { yes: true })).toMatchObject({ structuredContent: { erased: true } });
    await c.close();
  });

  test("a call as an agent has the agent's rights", { timeout: 60_000 }, async () => {
    const made = spawnSync(process.execPath, [cliBin, "--store", store, "agents", "create", "scribe", "--scopes", "doc:read"], { encoding: "utf8" });
    const agent = JSON.parse(made.stdout).id as string;
    const c = client(mcpBin, ["--store", store, "--as", agent]);
    await c.request(1, "initialize", {});
    const r = (await c.request(2, "tools/call", { name: "identity_agents_create", arguments: { handle: "child", scopes: ["doc:read"] } })).result as { isError: boolean; content: { text: string }[] };
    expect(r).toMatchObject({ isError: true, content: [{ text: "only a person makes an agent" }] });
    await c.close();
  });
});
