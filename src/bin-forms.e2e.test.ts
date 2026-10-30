import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { beforeAll, expect, test } from "vitest";
import { bundleEntry } from "./test-bundle.js";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string; bin: Record<string, string> };
const bins = Object.entries(pkg.bin);
const built = new Map<string, string>();

beforeAll(async () => {
  await Promise.all(bins.map(async ([name, path]) => {
    const entry = path.replace(/^\.\/dist\//, "src/").replace(/\.js$/, ".ts");
    built.set(name, await bundleEntry(entry));
  }));
}, 60_000);

test.each(bins)("%s supports its MCP executable forms", (name) => {
  const run = (args: string[], input = "") => spawnSync(process.execPath, [built.get(name)!, ...args], { input, encoding: "utf8", timeout: 20_000 });
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
});
