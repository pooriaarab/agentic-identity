// The MCP server. It speaks JSON-RPC 2.0 over stdio, one JSON message per line, and serves the same
// command table as the CLI: each command is a tool. It handles one message at a time, in order.
import type { Readable, Writable } from "node:stream";
import { createInterface } from "node:readline";
import { COMMANDS, UsageError, checkArgs, describeError, type App, type Args, type Arg, type Command } from "./commands.js";
import { VERSION } from "./version.js";

const PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const MAX_LINE = 1_000_000;

type Id = string | number | null;
type Message = { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };
type Reply = { jsonrpc: "2.0"; id: Id; result?: unknown; error?: { code: number; message: string } };

const reply = (id: Id, result: unknown): Reply => ({ jsonrpc: "2.0", id, result });
const fail = (id: Id, code: number, message: string): Reply => ({ jsonrpc: "2.0", id, error: { code, message } });
/** A tool argument is named like the flag, with `_` for `-`. */
const propOf = (a: Arg) => a.name.replace(/-/g, "_");

function schemaOf(command: Command) {
  const property = (a: Arg) => ({
    type: a.type === "list" ? "array" : a.type === "number" ? "integer" : a.type,
    ...(a.type === "list" ? { items: { type: "string" } } : {}),
    description: a.description,
    ...(a.choices ? { enum: [...a.choices] } : {}),
  });
  return {
    type: "object",
    properties: Object.fromEntries(command.args.map((a) => [propOf(a), property(a)])),
    required: command.args.filter((a) => a.required).map(propOf),
    additionalProperties: false,
  };
}

/** Turns tool input into the command's arguments, and refuses a name or a type that does not fit. */
function argsOf(command: Command, input: unknown): Args {
  if (input === undefined) input = {};
  if (typeof input !== "object" || input === null || Array.isArray(input)) throw new UsageError("arguments must be an object");
  const given = input as Record<string, unknown>;
  const known = new Map(command.args.map((a) => [propOf(a), a]));
  const args: Args = {};
  for (const key of Object.keys(given)) if (!known.has(key)) throw new UsageError("unknown argument");
  for (const [key, a] of known) {
    const value = given[key];
    if (value === undefined) continue;
    const ok =
      a.type === "string" ? typeof value === "string"
      : a.type === "boolean" ? typeof value === "boolean"
      : a.type === "number" ? typeof value === "number" && Number.isSafeInteger(value)
      : Array.isArray(value) && value.every((v) => typeof v === "string");
    if (!ok) throw new UsageError(`${key} must be ${a.type === "list" ? "a list of strings" : a.type === "number" ? "a whole number" : `a ${a.type}`}`);
    args[a.name] = value as Args[string];
  }
  checkArgs(command, args);
  return args;
}

export interface McpOptions {
  /** Opens the app for one call. It runs for each call, so a change to the store file shows at once. */
  app: () => Promise<App>;
  commands?: Command[];
}

/** Handles one message. It returns the reply, or nothing for a notification. */
export function createMcpHandler(options: McpOptions) {
  const commands = options.commands ?? COMMANDS;
  return async function handle(message: unknown): Promise<Reply | undefined> {
    if (typeof message !== "object" || message === null || Array.isArray(message)) return fail(null, -32600, "invalid request");
    const { jsonrpc, id, method, params } = message as Message;
    const isRequest = id !== undefined;
    if (jsonrpc !== "2.0" || typeof method !== "string" || (isRequest && typeof id !== "string" && typeof id !== "number")) return fail(typeof id === "string" || typeof id === "number" ? id : null, -32600, "invalid request");
    // A notification has no id and gets no reply.
    if (!isRequest) return undefined;
    const rid = id as Id;
    const p = (typeof params === "object" && params !== null && !Array.isArray(params) ? params : {}) as Record<string, unknown>;

    if (method === "initialize") {
      const wanted = typeof p.protocolVersion === "string" ? p.protocolVersion : "";
      return reply(rid, { protocolVersion: PROTOCOLS.includes(wanted) ? wanted : PROTOCOLS[0], capabilities: { tools: { listChanged: false } }, serverInfo: { name: "agentic-identity", version: VERSION } });
    }
    if (method === "ping") return reply(rid, {});
    if (method === "tools/list") {
      return reply(rid, { tools: commands.map((c) => ({ name: c.tool, description: c.summary, inputSchema: schemaOf(c) })) });
    }
    if (method === "tools/call") {
      const command = typeof p.name === "string" ? commands.find((c) => c.tool === p.name) : undefined;
      if (!command) return fail(rid, -32602, "unknown tool");
      // A failed call is a result with `isError`, so the agent can read it and try again.
      try {
        const out = await command.run(await options.app(), argsOf(command, p.arguments));
        const structured = out !== null && typeof out === "object" && !Array.isArray(out) ? { structuredContent: out } : {};
        return reply(rid, { content: [{ type: "text", text: JSON.stringify(out) }], ...structured });
      } catch (error) {
        return reply(rid, { isError: true, content: [{ type: "text", text: describeError(error) }] });
      }
    }
    return fail(rid, -32601, "method not found");
  };
}

/** Reads messages from `input` and writes replies to `output`. Resolves when `input` ends. */
export async function serveStdio(options: McpOptions, input: Readable, output: Writable): Promise<void> {
  const handle = createMcpHandler(options);
  const send = (r: Reply) => output.write(`${JSON.stringify(r)}\n`);
  let queue: Promise<unknown> = Promise.resolve();
  for await (const line of createInterface({ input, crlfDelay: Infinity })) {
    if (line.trim() === "") continue;
    queue = queue.then(async () => {
      let message: unknown;
      try {
        if (line.length > MAX_LINE) throw new Error("too long");
        message = JSON.parse(line);
      } catch {
        // The parse error never quotes the input.
        return void send(fail(null, -32700, "parse error"));
      }
      const r = await handle(message).catch(() => fail(null, -32603, "internal error"));
      if (r) send(r);
    });
  }
  await queue;
}
