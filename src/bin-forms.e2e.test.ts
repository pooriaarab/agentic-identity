import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, test } from "vitest";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string; bin: Record<string, string> };
const bins = Object.entries(pkg.bin);
const dir = mkdtempSync(join(tmpdir(), "identity-bins-"));
beforeAll(() => {
  execFileSync(process.execPath, [fileURLToPath(new URL("../node_modules/tsup/dist/cli-default.js", import.meta.url)), "--out-dir", dir], { cwd: fileURLToPath(new URL("..", import.meta.url)), stdio: "pipe" });
  writeFileSync(join(dir, "package.json"), '{"type":"module"}');
}, 60_000);
afterAll(() => rmSync(dir, { recursive: true, force: true }));
test.each(bins)("%s supports its MCP executable forms", (name, path) => {
  const bin = join(dir, path.replace(/^\.\/dist\//, ""));
  const run = (args: string[], input = "") => spawnSync(process.platform === "win32" ? process.execPath : bin, process.platform === "win32" ? [bin, ...args] : args, { input, encoding: "utf8", timeout: 20_000, env: { PATH: process.env.PATH ?? "" } });
  const help = run(["--help"]);
  expect(help.status).toBe(0);
  expect(help.stdout).toContain(`Usage: ${name}`);
  expect(help.stderr).toBe("");
  const version = run(["--version"]);
  expect(version.status).toBe(0);
  expect(version.stdout.trim()).toBe(pkg.version);
  expect(version.stderr).toBe("");
  const mcpHelp = run(["--mcp", "--help"]);
  expect(mcpHelp.status).toBe(0);
  expect(mcpHelp.stdout).toContain("Usage: agentic-identity-mcp");
  const mcpVersion = run(["--mcp", "--version"]);
  expect(mcpVersion.status).toBe(0);
  expect(mcpVersion.stdout.trim()).toBe(pkg.version);
  for (const args of name.endsWith("-mcp") ? [[], ["mcp"], ["--mcp"]] : [["mcp"], ["--mcp"]]) {
    const request = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
    const started = run(args, `${request}\n`);
    expect(started.status).toBe(0);
    expect(started.stderr).toBe("");
    expect(JSON.parse(started.stdout).result.serverInfo).toEqual({ name: "agentic-identity", version: pkg.version });
    const bad = run([...args, "--bogus"]);
    expect(bad.status).toBe(2);
    expect(bad.stdout).toBe("");
    expect(bad.stderr).toContain("bad option");
  }
  for (const first of ["mcp", "--mcp"]) for (const second of ["mcp", "--mcp"]) {
    const repeated = run([first, second]);
    expect(repeated.status).toBe(2);
    expect(repeated.stdout).toBe("");
    expect(repeated.stderr).toContain("bad option");
  }
}, 60_000);
