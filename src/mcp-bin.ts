#!/usr/bin/env node
import { runMcp } from "./mcp-run.js";

process.exitCode = await runMcp(process.argv.slice(2), process.env, process.stdin, process.stdout, (text) => console.error(text));
