// Account export and erase across apps. Each app gives an exporter and an eraser (the
// `AccountApp` port). Export joins every app's files into one zip with a manifest. Erase runs
// every app's eraser and writes one audit entry per app. No Node API is used: a Worker can run it.
import type { Doc, Store } from "./ports.js";
import { auditEntry, type PrincipalContext } from "./core/principals.js";

export interface AccountFile {
  /** A relative path inside the app's folder, with `/` separators. */
  path: string;
  content: string | Uint8Array;
}

/** What an app gives so a person can take their data out and have it erased. */
export interface AccountApp {
  /** A short stable id: lower case letters, digits, `.`, `_`, `-`. It names the app's folder in the zip. */
  id: string;
  /** Returns every file the app holds about the subject. Return `[]` when it holds none. */
  exportFor(subject: string): Promise<AccountFile[]>;
  /** Deletes everything the app holds about the subject. It must be safe to run twice. */
  eraseFor(subject: string): Promise<void>;
}

export interface ManifestFile {
  path: string;
  bytes: number;
  sha256: string;
}

export interface AccountManifest {
  version: 1;
  subject: string;
  generatedAt: number;
  apps: { id: string; files: ManifestFile[] }[];
}

export interface AccountOptions {
  now?: () => number;
  /** Who runs the request. It goes in the audit entries. `null` is recorded as anonymous. */
  actor?: PrincipalContext | null;
}

/** An app failed to export, or gave a bad file. No zip is made: a partial export would pass for a full one. */
export class AccountExportError extends Error {
  constructor(readonly appId: string, options?: { cause?: unknown }) {
    super(`export failed for app "${appId}"`, options);
    this.name = "AccountExportError";
  }
}

// Same marker as the `deletePerson` tombstone. `SAFE_ID` rejects the parentheses, so no real id equals it.
const ERASED = "(erased)";
const APP_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const FILE_LIMIT = 65_535;
const BYTE_LIMIT = 0xffff_ffff;
const encoder = new TextEncoder();
const bytesOf = (content: string | Uint8Array) => (typeof content === "string" ? encoder.encode(content) : content);
const NAME_LIMIT = 0xffff;

function checkApps(apps: AccountApp[]): void {
  const seen = new Set<string>();
  for (const app of apps) {
    if (typeof app.id !== "string" || !APP_ID.test(app.id) || app.id === "manifest.json") throw new Error("invalid app id");
    if (seen.has(app.id)) throw new Error(`duplicate app id "${app.id}"`);
    seen.add(app.id);
  }
}

function checkPath(path: unknown): asserts path is string {
  if (typeof path !== "string" || path === "" || path.startsWith("/") || path.includes("\\") || path.includes("\0")) throw new Error("invalid file path");
  if (path.split("/").some((part) => part === "" || part === "." || part === "..")) throw new Error("invalid file path");
}

async function sha256(data: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", data as Uint8Array<ArrayBuffer>));
  return [...digest].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of data) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * Writes a zip with stored (not compressed) entries. The same input gives the same bytes: entries
 * sort by name by code unit, and every time field is 1980-01-01. No zip64: it throws past 65,535
 * entries or 4 GiB.
 */
export function writeZip(entries: { name: string; data: Uint8Array }[]): Uint8Array {
  const sorted = [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  if (sorted.length > FILE_LIMIT) throw new Error("too many files for a zip");
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  const DOS_TIME = 0;
  const DOS_DATE = (0 << 9) | (1 << 5) | 1; // 1980-01-01
  for (const { name, data } of sorted) {
    const nameBytes = encoder.encode(name);
    if (nameBytes.length > NAME_LIMIT) throw new Error("file name too long for a zip");
    const crc = crc32(data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, 0x0800, true); // UTF-8 names
    local.setUint16(8, 0, true); // stored
    local.setUint16(10, DOS_TIME, true);
    local.setUint16(12, DOS_DATE, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, data.length, true);
    local.setUint32(22, data.length, true);
    local.setUint16(26, nameBytes.length, true);
    const head = new DataView(new ArrayBuffer(46));
    head.setUint32(0, 0x02014b50, true);
    head.setUint16(4, 20, true);
    head.setUint16(6, 20, true);
    head.setUint16(8, 0x0800, true);
    head.setUint16(12, DOS_TIME, true);
    head.setUint16(14, DOS_DATE, true);
    head.setUint32(16, crc, true);
    head.setUint32(20, data.length, true);
    head.setUint32(24, data.length, true);
    head.setUint16(28, nameBytes.length, true);
    head.setUint32(42, offset, true);
    central.push(new Uint8Array(head.buffer), nameBytes);
    parts.push(new Uint8Array(local.buffer), nameBytes, data);
    offset += 30 + nameBytes.length + data.length;
    if (offset > BYTE_LIMIT) throw new Error("zip too large");
  }
  const centralSize = central.reduce((n, p) => n + p.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, sorted.length, true);
  end.setUint16(10, sorted.length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, offset, true);
  if (offset + centralSize > BYTE_LIMIT) throw new Error("zip too large");
  const all = [...parts, ...central, new Uint8Array(end.buffer)];
  const zip = new Uint8Array(all.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of all) {
    zip.set(p, at);
    at += p.length;
  }
  return zip;
}

/**
 * Asks every app for its files and returns one zip. The zip holds `manifest.json` and, for each
 * app, its files under `<app id>/`. With the same files and the same `now`, the bytes are equal.
 * One failing exporter aborts the whole export with an `AccountExportError`.
 */
export async function exportAccount(subject: string, apps: AccountApp[], options: AccountOptions = {}): Promise<{ zip: Uint8Array; manifest: AccountManifest }> {
  if (typeof subject !== "string" || subject === "") throw new Error("subject is required");
  checkApps(apps);
  const entries: { name: string; data: Uint8Array }[] = [];
  const manifest: AccountManifest = { version: 1, subject, generatedAt: (options.now ?? Date.now)(), apps: [] };
  for (const app of [...apps].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    const listed: ManifestFile[] = [];
    try {
      const files = await app.exportFor(subject);
      const paths = new Set<string>();
      for (const file of files) {
        checkPath(file.path);
        if (paths.has(file.path)) throw new Error("duplicate file path");
        for (let cut = file.path.indexOf("/"); cut !== -1; cut = file.path.indexOf("/", cut + 1)) {
          if (paths.has(file.path.slice(0, cut))) throw new Error("file path under a file");
        }
        paths.add(file.path);
        const data = bytesOf(file.content);
        if (!(data instanceof Uint8Array)) throw new Error("file content must be a string or bytes");
        entries.push({ name: `${app.id}/${file.path}`, data });
        listed.push({ path: file.path, bytes: data.length, sha256: await sha256(data) });
      }
      const sorted = [...paths];
      if (sorted.some((p) => sorted.some((q) => q.startsWith(`${p}/`)))) throw new Error("file path over a file");
    } catch (cause) {
      throw new AccountExportError(app.id, { cause });
    }
    listed.sort((a, b) => (a.path < b.path ? -1 : 1));
    manifest.apps.push({ id: app.id, files: listed });
  }
  entries.push({ name: "manifest.json", data: encoder.encode(JSON.stringify(manifest, null, 2)) });
  return { zip: writeZip(entries), manifest };
}

/**
 * `deletePerson` removes every audit entry that names the person or their agents, so an entry that
 * kept those ids would vanish. When the actor is the subject, or acts for the subject, the entry is
 * written like the `deletePerson` tombstone: it names no one. Any other actor (an admin) stays.
 */
function actorFor(subject: string, actor: PrincipalContext | null): PrincipalContext | null {
  if (actor === null) return null;
  if (actor.principalId !== subject && !actor.chain.some((step) => step.id === subject)) return actor;
  return { principalId: ERASED, kind: "human", chain: [], ...(actor.requestId === undefined ? {} : { requestId: actor.requestId }) } as unknown as PrincipalContext;
}

export interface EraseResult {
  appId: string;
  ok: boolean;
  /** The error message of a failed eraser. It may name data: do not log it. */
  error?: string;
  /** False when the audit entry for this app could not be written. */
  audited: boolean;
}

export interface EraseReport {
  /** True when every eraser and every audit write succeeded. */
  ok: boolean;
  results: EraseResult[];
}

/**
 * Runs every app's eraser, in order. A failing eraser does not stop the rest: the report names each
 * failure, and the caller runs the erase again (erasers are safe to repeat). Each app gets one
 * audit entry, `person.erase` on target `app:<id>`, `allowed` or `denied`. The entry holds no
 * subject id. The caller erases the sign-in (see `deletePerson`) only when `ok` is true.
 */
export async function eraseAccount(subject: string, apps: AccountApp[], store: Pick<Store, "put">, options: AccountOptions = {}): Promise<EraseReport> {
  if (typeof subject !== "string" || subject === "") throw new Error("subject is required");
  checkApps(apps);
  const now = options.now ?? Date.now;
  const results: EraseResult[] = [];
  for (const app of apps) {
    let error: string | undefined;
    try {
      await app.eraseFor(subject);
    } catch (cause) {
      error = cause instanceof Error ? cause.message : "erase failed";
    }
    const id = crypto.randomUUID();
    const entry = auditEntry(actorFor(subject, options.actor ?? null), { id, at: now(), action: "person.erase", outcome: error === undefined ? "allowed" : "denied", targetKind: "app", targetId: app.id });
    let audited = true;
    try {
      await store.put("audit", id, entry as unknown as Doc);
    } catch {
      audited = false;
    }
    results.push({ appId: app.id, ok: error === undefined, ...(error === undefined ? {} : { error }), audited });
  }
  return { ok: results.every((r) => r.ok && r.audited), results };
}
