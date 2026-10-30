// Starts the MCP server for a store file. `agentic-identity-mcp` and `agentic-identity mcp` both call it.
import type { Readable, Writable } from "node:stream";
import { parseArgs } from "node:util";
import { createFileStore } from "./adapters/file.js";
import { COMMANDS, openApp, storePath } from "./commands.js";
import { serveStdio } from "./mcp.js";
import { VERSION } from "./version.js";

export const MCP_HELP = `Usage: agentic-identity-mcp [options]

Serves the agentic-identity commands as MCP tools over stdio (JSON-RPC, one message per line).
Add it to an MCP client as the command \`npx agentic-identity-mcp\` (or \`npx agentic-identity mcp\`).
The agentic-identity-mcp bin also accepts one leading mcp argument.
The agentic-identity mcp form does not accept another mcp argument.
The tools are: ${COMMANDS.map((c) => c.tool).join(", ")}.

Options:
  --store <file>  The store file. Default: $AGENTIC_IDENTITY_STORE, or $AGENTIC_IDENTITY_HOME/store.json,
                  or ~/.agentic-identity/store.json
  --as <id>       The principal the tools act as. Default: $AGENTIC_IDENTITY_AS, or "local"
  -h, --help      Show help
  --version       Show the version`;

export async function runMcp(argv: string[], env: Record<string, string | undefined>, input: Readable, output: Writable, err: (text: string) => void): Promise<number> {
  try {
    const { values } = parseArgs({ args: argv, options: { store: { type: "string" }, as: { type: "string" }, help: { type: "boolean", short: "h" }, version: { type: "boolean" } }, allowPositionals: false, strict: true });
    if (values.version) return output.write(`${VERSION}\n`), 0;
    if (values.help) return output.write(`${MCP_HELP}\n`), 0;
    const store = createFileStore({ path: storePath(env, values.store) });
    const as = values.as ?? env.AGENTIC_IDENTITY_AS;
    await serveStdio({ app: () => openApp(store, as === undefined ? {} : { as }) }, input, output);
    return 0;
  } catch {
    err("error: bad option or value. Run with --help.");
    return 2;
  }
}
