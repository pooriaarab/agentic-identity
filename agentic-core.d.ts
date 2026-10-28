// Frozen contract v1 for the agentic core.
//
// Every pack builds against this file unchanged. The implementation in
// src/core.ts must satisfy every line here. src/contract.test.ts pins
// the two together, so drift fails typecheck.
//
// To change this contract: raise the version, add a migration note in
// docs/agentic-core.md, and update all packs in one pass.

export interface BrandConfig {
  name: string;
  command: string;
  description: string;
  keywords: string[];
  version: string;
}

export function defineBrand(config: BrandConfig): BrandConfig;

export type LogLevel = "debug" | "info" | "warn" | "error";

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

export function createLogger(options?: LoggerOptions): Logger;

export class GuardError extends Error {
  readonly code: "GUARD_DENIED";
  constructor(message: string);
}

export class VendorError extends Error {
  readonly code: "VENDOR_FAILED";
  readonly status?: number;
  constructor(message: string, options?: { status?: number; cause?: unknown });
}

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

export function createGuards(config?: GuardsConfig): Guards;

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
  readonly name: "local";
  dispatch(text: string): Promise<DispatchReceipt>;
}

export interface HttpRouterOptions {
  timeoutMs?: number;
  fetchFn?: typeof fetch;
}

export class HttpRouterAdapter implements RouterAdapter {
  readonly name: "http";
  constructor(endpoint: string, options?: HttpRouterOptions);
  dispatch(text: string): Promise<DispatchReceipt>;
}

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

export function recordCost(entry: { kind: string; adapter: string; units: number }): void;

export function getCostReport(): CostReport;

export function resetCosts(): void;

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

export function createDryRunResult(text: string, adapterName: string): DispatchResult;

export function dispatchText(text: string, options?: DispatchOptions): Promise<DispatchResult>;

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

export function summarizeText(text: string, options?: SummarizeOptions): TextSummary;
