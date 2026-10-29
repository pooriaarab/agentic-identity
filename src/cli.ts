// The `agentic-identity` command line. It works on a local JSON file and shares the command table
// with the MCP server (it will read it too). Output is JSON on stdout. Errors go to stderr as `error: <message>`.
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs, type ParseArgsConfig } from "node:util";
import { createFileStore } from "./adapters/file.js";
import { COMMANDS, UsageError, openApp, type Args, type Command } from "./commands.js";
import { VERSION } from "./version.js";

export interface Io {
  out(text: string): void;
  err(text: string): void;
}

const GLOBAL_OPTIONS = `Options for every command:
  --store <file>  The store file. Default: $AGENTIC_IDENTITY_STORE, or $AGENTIC_IDENTITY_HOME/store.json,
                  or ~/.agentic-identity/store.json
  --as <id>       The principal that acts. Default: $AGENTIC_IDENTITY_AS, or "local" (made on first use)
  -h, --help      Show help
  --version       Show the version`;

const words = (c: Command) => c.path.join(" ");
const flagOf = (c: Command) => (c.args.some((a) => a.positional) ? ` ${c.args.filter((a) => a.positional).map((a) => `<${a.name}>`).join(" ")}` : "");

function commandHelp(c: Command): string {
  const lines = c.args.map((a) => `  ${a.positional ? `<${a.name}>` : `--${a.name}${a.type === "boolean" ? "" : ` <${a.type}>`}`}  ${a.description}${a.choices ? ` One of: ${a.choices.join(", ")}.` : ""}${a.required ? " Required." : ""}`);
  return [`Usage: agentic-identity ${words(c)}${flagOf(c)}${c.args.some((a) => !a.positional) ? " [options]" : ""}`, "", c.summary, ...(lines.length ? ["", "Arguments:", ...lines] : []), "", GLOBAL_OPTIONS].join("\n");
}

function mainHelp(): string {
  return ["Usage: agentic-identity <command> [options]", "", "People, agents, and the access they share. Works on a local file store.", "", "Commands:", ...COMMANDS.map((c) => `  ${(words(c) + flagOf(c)).padEnd(46)}${c.summary}`), "", GLOBAL_OPTIONS].join("\n");
}

/** Options that take a value. A value is not a command word, and not a flag. */
const VALUE_OPTIONS = new Set(["--store", "--as", ...COMMANDS.flatMap((c) => c.args.filter((x) => !x.positional && x.type !== "boolean").map((x) => `--${x.name}`))]);

/**
 * The command words come first. `flags` holds the flags that stand alone, so `--help` as the value
 * of an option, or after `--`, is not one. Nothing after `--` is a flag.
 */
function split(argv: string[]): { words: string[]; rest: string[]; flags: string[] } {
  const found: string[] = [];
  const rest: string[] = [];
  const flags: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (token === "--") {
      rest.push(...argv.slice(i));
      break;
    }
    if (VALUE_OPTIONS.has(token)) {
      rest.push(token, ...argv.slice(i + 1, i + 2));
      i++;
    } else if (token.startsWith("-")) {
      rest.push(token);
      flags.push(token);
    } else if (found.length >= 2) rest.push(token);
    else found.push(token);
  }
  return { words: found, rest, flags };
}

function findCommand(found: string[]): { command?: Command; extra: string[] } {
  for (const take of [2, 1]) {
    const command = COMMANDS.find((c) => c.path.length === take && c.path.every((w, i) => found[i] === w));
    if (command) return { command, extra: found.slice(take) };
  }
  return { extra: found };
}

function parseCommand(command: Command, rest: string[], extra: string[]): { values: Args; globals: { store?: string; as?: string; help?: boolean } } {
  const options: NonNullable<ParseArgsConfig["options"]> = {
    store: { type: "string" }, as: { type: "string" }, help: { type: "boolean", short: "h" },
    ...Object.fromEntries(command.args.filter((a) => !a.positional).map((a) => [a.name, { type: a.type === "boolean" ? "boolean" : "string" } as const])),
  };
  // The last value of a repeated flag would win, so a flag may come once.
  const upTo = rest.indexOf("--") < 0 ? rest.length : rest.indexOf("--");
  const named = rest.slice(0, upTo).filter((t) => t.startsWith("--")).map((t) => t.split("=")[0]);
  const again = named.find((t, i) => named.indexOf(t) !== i);
  if (again) throw new UsageError(`give ${again} once`);
  const parsed = parseArgs({ args: rest, options, allowPositionals: true, strict: true });
  const values: Args = {};
  const positional = command.args.filter((a) => a.positional);
  const given = [...extra, ...parsed.positionals];
  if (given.length > positional.length) throw new UsageError(`too many arguments: this command takes ${positional.length}`);
  positional.forEach((a, i) => (values[a.name] = given[i]));
  for (const a of command.args.filter((x) => !x.positional)) {
    const raw = parsed.values[a.name];
    if (raw === undefined) continue;
    if (a.type === "number") {
      const n = Number(raw);
      if (typeof raw !== "string" || !/^[0-9]{1,15}$/.test(raw) || !Number.isFinite(n)) throw new UsageError(`--${a.name} must be a whole number`);
      values[a.name] = n;
    } else values[a.name] = a.type === "list" ? String(raw).split(",").map((s) => s.trim()).filter(Boolean) : (raw as string | boolean);
  }
  return { values, globals: parsed.values as { store?: string; as?: string; help?: boolean } };
}

/**
 * A share-link token is base64url, so it can start with `-`. A long word that starts with one dash
 * is no flag (flags are `--name` or one letter), so it is held back as plain text while the
 * arguments are parsed.
 */
const LOOSE = /^-[A-Za-z0-9_-]{20,}$/;

export async function runCli(args: string[], env: Record<string, string | undefined>, io: Io): Promise<number> {
  const held = new Map<string, string>();
  const argv = args.map((t) => (LOOSE.test(t) ? (held.set(`\u0000${held.size}`, t), `\u0000${held.size - 1}`) : t));
  try {
    const { words: found, rest, flags } = split(argv);
    if (flags.includes("--version")) return io.out(VERSION), 0;
    const { command, extra } = findCommand(found);
    const help = flags.includes("--help") || flags.includes("-h");
    if (!command) {
      if (found.length === 0 || help) return io.out(mainHelp()), found.length === 0 && !help ? 2 : 0;
      throw new UsageError("unknown command. Run with --help.");
    }
    if (help) return io.out(commandHelp(command)), 0;
    const { values, globals } = parseCommand(command, rest, extra);
    for (const key of ["store", "as"] as const) if (globals[key] !== undefined && held.has(globals[key]!)) globals[key] = held.get(globals[key]!);
    for (const [name, value] of Object.entries(values)) if (typeof value === "string" && held.has(value)) values[name] = held.get(value);
    for (const a of command.args) if (a.required && values[a.name] === undefined) throw new UsageError(`missing ${a.positional ? `<${a.name}>` : `--${a.name}`}`);
    for (const a of command.args) if (a.choices && values[a.name] !== undefined && !a.choices.includes(String(values[a.name]))) throw new UsageError(`${a.name} must be one of: ${a.choices.join(", ")}`);
    const path = globals.store ?? env.AGENTIC_IDENTITY_STORE ?? join(env.AGENTIC_IDENTITY_HOME ?? join(homedir(), ".agentic-identity"), "store.json");
    const as = globals.as ?? env.AGENTIC_IDENTITY_AS;
    const app = await openApp(createFileStore({ path }), as === undefined ? {} : { as });
    io.out(JSON.stringify(await command.run(app, values), null, 2));
    return 0;
  } catch (error) {
    const code = (error as { code?: string }).code;
    // A parse error repeats the text of the flag, and a mistyped flag can be an address.
    io.err(`error: ${code?.startsWith("ERR_PARSE_ARGS") ? "bad option or value. Run with --help." : error instanceof Error ? error.message.replace(/^invalid id ".*"$/s, "invalid id") : String(error)}`);
    return error instanceof UsageError || (error instanceof RangeError && error.message.startsWith("limit must")) || (error as { code?: string }).code?.startsWith("ERR_PARSE_ARGS") ? 2 : 1;
  }
}
