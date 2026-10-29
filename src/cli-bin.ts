#!/usr/bin/env node
import { runCli } from "./cli.js";
import { runMcp } from "./mcp-run.js";

// `agentic-identity mcp` starts the MCP server. It is the same server as `agentic-identity-mcp`.
process.exitCode = process.argv[2] === "mcp"
  ? await runMcp(process.argv.slice(3), process.env, process.stdin, process.stdout, (text) => console.error(text))
  : await runCli(process.argv.slice(2), process.env, {
  out: (text) => console.log(text),
  err: (text) => console.error(text),
});
