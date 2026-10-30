#!/usr/bin/env node
import { runMcp } from "./mcp-run.js";

const args = process.argv.slice(2);
process.exitCode = await runMcp(args[0] === "mcp" ? args.slice(1) : args, process.env, process.stdin, process.stdout, (text) => console.error(text));
