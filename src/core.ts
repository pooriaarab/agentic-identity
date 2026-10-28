import { randomUUID } from "node:crypto";

// Brand config. Each pack defines one brand and reuses it in the
// library, the CLI, and the MCP server so the three faces agree.

export interface BrandConfig {
  name: string;
  command: string;
  description: string;
  keywords: string[];
  version: string;
}

export function defineBrand(config: BrandConfig): BrandConfig {
  for (const key of ["name", "command", "version"] as const) {
    if (config[key].trim().length === 0) {
      throw new Error(`brand ${key} must not be empty`);
    }
  }
  return Object.freeze({ ...config, keywords: [...config.keywords] });
}

// Logger. Logs go to stderr so result output on stdout stays clean.

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

export interface Logger {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface LoggerOptions {
  level?: LogLevel;
  quiet?: boolean;
  sink?: (line: string) => void;
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const level = options.level ?? "info";
  const quiet = options.quiet ?? false;
  const sink =
    options.sink ?? ((line: string) => process.stderr.write(`${line}\n`));
  const emit = (at: LogLevel, message: string): void => {
    if (quiet) return;
    if (LEVEL_ORDER[at] < LEVEL_ORDER[level]) return;
    sink(`[${at}] ${message}`);
  };
  return {
    debug: (message) => emit("debug", message),
    info: (message) => emit("info", message),
    warn: (message) => emit("warn", message),
    error: (message) => emit("error", message),
  };
}

// Errors. Adapters and guards throw these. Callers catch and report.
// Nothing in this core swallows a failure and returns success.

export class GuardError extends Error {
  readonly code = "GUARD_DENIED";

  constructor(message: string) {
    super(message);
    this.name = "GuardError";
  }
}

export class VendorError extends Error {
  readonly code = "VENDOR_FAILED";
  readonly status?: number;

  constructor(message: string, options: { status?: number; cause?: unknown } = {}) {
    super(message, { cause: options.cause });
    this.name = "VendorError";
    this.status = options.status;
  }
}

// Guards. Caps bound total dispatches. Quiet hours block a UTC window.
// The blocklist blocks texts that contain a banned term.

export interface CapsConfig {
  maxDispatches?: number;
}

export interface QuietHoursConfig {
  startHour?: number;
  endHour?: number;
}

export interface GuardsConfig {
  caps?: CapsConfig;
  quietHours?: QuietHoursConfig;
  blocklist?: string[];
  now?: () => Date;
}

export interface Guards {
  readonly dispatchCount: number;
  checkDispatch(text: string): void;
  recordDispatch(): void;
}

function assertHour(value: number | undefined, label: string): void {
  if (value === undefined) return;
  if (!Number.isInteger(value) || value < 0 || value > 24) {
    throw new Error(`${label} must be an integer from 0 to 24`);
  }
}

export function createGuards(config: GuardsConfig = {}): Guards {
  const maxDispatches = config.caps?.maxDispatches;
  if (
    maxDispatches !== undefined &&
    (!Number.isInteger(maxDispatches) || maxDispatches < 0)
  ) {
    throw new Error("caps.maxDispatches must be an integer of 0 or more");
  }
  const startHour = config.quietHours?.startHour;
  const endHour = config.quietHours?.endHour;
  assertHour(startHour, "quietHours.startHour");
  assertHour(endHour, "quietHours.endHour");
  const blocklist = (config.blocklist ?? []).map((term) => term.toLowerCase());
  const now = config.now ?? (() => new Date());
  let count = 0;

  const inQuietHours = (date: Date): boolean => {
    if (startHour === undefined || endHour === undefined) return false;
    const hour = date.getUTCHours();
    if (startHour <= endHour) {
      return hour >= startHour && hour < endHour;
    }
    return hour >= startHour || hour < endHour;
  };

  return {
    get dispatchCount(): number {
      return count;
    },
    checkDispatch(text: string): void {
      if (maxDispatches !== undefined && count >= maxDispatches) {
        throw new GuardError(
          `dispatch cap reached (${maxDispatches} of ${maxDispatches})`,
        );
      }
      if (inQuietHours(now())) {
        throw new GuardError(
          `quiet hours block dispatches from ${startHour}:00 to ${endHour}:00 UTC`,
        );
      }
      const lowered = text.toLowerCase();
      for (const term of blocklist) {
        if (term.length > 0 && lowered.includes(term)) {
          throw new GuardError(`text matches blocklisted term "${term}"`);
        }
      }
    },
    recordDispatch(): void {
      count += 1;
    },
  };
}

// Router adapters. Each adapter delivers one text and returns a receipt.
// Adapters throw VendorError on failure. They never swallow it.

export interface DispatchReceipt {
  adapter: string;
  id: string;
  chars: number;
  at: string;
}

export interface RouterAdapter {
  readonly name: string;
  dispatch(text: string): Promise<DispatchReceipt>;
}

export class LocalRouterAdapter implements RouterAdapter {
  readonly name = "local";

  async dispatch(text: string): Promise<DispatchReceipt> {
    if (typeof text !== "string") {
      throw new VendorError("local adapter needs a string");
    }
    return {
      adapter: this.name,
      id: randomUUID(),
      chars: text.length,
      at: new Date().toISOString(),
    };
  }
}

export interface HttpRouterOptions {
  timeoutMs?: number;
  fetchFn?: typeof fetch;
}

export class HttpRouterAdapter implements RouterAdapter {
  readonly name = "http";
  private readonly endpoint: string;
  private readonly timeoutMs: number;
  private readonly fetchFn: typeof fetch;

  constructor(endpoint: string, options: HttpRouterOptions = {}) {
    if (endpoint.trim().length === 0) {
      throw new Error("http adapter needs an endpoint URL");
    }
    this.endpoint = endpoint;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.fetchFn = options.fetchFn ?? fetch;
  }

  async dispatch(text: string): Promise<DispatchReceipt> {
    let response: Response;
    try {
      response = await this.fetchFn(this.endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new VendorError(`http adapter request failed: ${String(error)}`, {
        cause: error,
      });
    }
    if (!response.ok) {
      throw new VendorError(
        `http adapter got status ${response.status} from ${this.endpoint}`,
        { status: response.status },
      );
    }
    return {
      adapter: this.name,
      id: randomUUID(),
      chars: text.length,
      at: new Date().toISOString(),
    };
  }
}

// Cost report. Each real dispatch records one entry. Dry runs record
// nothing. The report answers "what did this pack spend".

export interface CostEntry {
  kind: string;
  adapter: string;
  units: number;
  at: string;
}

export interface CostReport {
  entries: CostEntry[];
  dispatches: number;
  units: number;
}

const costEntries: CostEntry[] = [];

export function recordCost(entry: {
  kind: string;
  adapter: string;
  units: number;
}): void {
  costEntries.push({ ...entry, at: new Date().toISOString() });
}

export function getCostReport(): CostReport {
  const entries = costEntries.map((entry) => ({ ...entry }));
  return {
    entries,
    dispatches: entries.filter((entry) => entry.kind === "dispatch").length,
    units: entries.reduce((sum, entry) => sum + entry.units, 0),
  };
}

export function resetCosts(): void {
  costEntries.length = 0;
}

// Dispatch entry. Runs guards, then routes, then records cost.
// Dry run walks the same path but calls no adapter and records no cost.

export interface DispatchOptions {
  adapter?: RouterAdapter;
  guards?: Guards;
  logger?: Logger;
  dryRun?: boolean;
}

export interface DispatchResult {
  dryRun: boolean;
  adapter: string;
  chars: number;
  receipt?: DispatchReceipt;
}

export function createDryRunResult(text: string, adapterName: string): DispatchResult {
  return { dryRun: true, adapter: adapterName, chars: text.length };
}

export async function dispatchText(
  text: string,
  options: DispatchOptions = {},
): Promise<DispatchResult> {
  const adapter = options.adapter ?? new LocalRouterAdapter();
  options.guards?.checkDispatch(text);
  if (options.dryRun === true) {
    options.logger?.info(`dry run: would dispatch ${text.length} chars`);
    return createDryRunResult(text, adapter.name);
  }
  const receipt = await adapter.dispatch(text);
  options.guards?.recordDispatch();
  recordCost({ kind: "dispatch", adapter: adapter.name, units: text.length });
  options.logger?.info(`dispatched ${text.length} chars via ${adapter.name}`);
  return { dryRun: false, adapter: adapter.name, chars: text.length, receipt };
}

// Summarize. Pure text stats. The sample capability every face exposes.

export interface TopWord {
  word: string;
  count: number;
}

export interface TextSummary {
  chars: number;
  words: number;
  lines: number;
  topWords: TopWord[];
}

export interface SummarizeOptions {
  topN?: number;
}

export function summarizeText(
  text: string,
  options: SummarizeOptions = {},
): TextSummary {
  const topN = options.topN ?? 5;
  const tokens = text.split(/\s+/).filter((token) => token.length > 0);
  const counts = new Map<string, number>();
  for (const token of tokens) {
    const word = token.toLowerCase().replace(/[^a-z0-9]+/g, "");
    if (word.length === 0) continue;
    counts.set(word, (counts.get(word) ?? 0) + 1);
  }
  const topWords = [...counts.entries()]
    .map(([word, count]) => ({ word, count }))
    .sort((a, b) => b.count - a.count || a.word.localeCompare(b.word))
    .slice(0, Math.max(0, topN));
  return {
    chars: text.length,
    words: tokens.length,
    lines: text.length === 0 ? 0 : text.split("\n").length,
    topWords,
  };
}
