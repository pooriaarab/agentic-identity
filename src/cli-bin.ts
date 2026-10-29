#!/usr/bin/env node
import { runCli } from "./cli.js";

process.exitCode = await runCli(process.argv.slice(2), process.env, {
  out: (text) => console.log(text),
  err: (text) => console.error(text),
});
