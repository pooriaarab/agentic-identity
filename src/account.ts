// Account export and erase across apps. Each app gives an exporter and an eraser (the
// `AccountApp` port). Export joins every app's files into one zip with a manifest. Erase runs
// every app's eraser and writes one audit entry per app. No Node API is used: a Worker can run it.
import type { Doc, Store } from "./ports.js";
import { auditEntry, PRINCIPAL_KINDS, type PrincipalContext } from "./core/principals.js";

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
  /** Who runs the request. It goes in the audit entries. `eraseAccount` needs it: `null` is recorded as anonymous on purpose, a missing value is an error. */
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
const decoder = new TextDecoder();
const bytesOf = (content: string | Uint8Array) => (typeof content === "string" ? encoder.encode(content) : content);
const NAME_LIMIT = 0xffff;

function checkApps(apps: AccountApp[]): void {
  if (!Array.isArray(apps) || apps.length === 0) throw new Error("apps are required");
  const seen = new Set<string>();
  for (const app of apps) {
    if (typeof app.id !== "string" || !APP_ID.test(app.id) || app.id === "manifest.json") throw new Error("invalid app id");
    if (seen.has(app.id)) throw new Error(`duplicate app id "${app.id}"`);
    seen.add(app.id);
  }
}

function checkPath(path: unknown): asserts path is string {
  if (typeof path !== "string" || path === "" || path.startsWith("/") || path.includes("\\") || path.includes("\0") || decoder.decode(encoder.encode(path)) !== path) throw new Error("invalid file path");
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
  for (let i = 1; i < sorted.length; i++) if (sorted[i].name === sorted[i - 1].name) throw new Error("two files have the same name");
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
 * One failing exporter aborts the whole export with an `AccountExportError`. A zip over the size limits throws a plain `Error`: no one app is to blame.
 */
export async function exportAccount(subject: string, apps: AccountApp[], options: AccountOptions = {}): Promise<{ zip: Uint8Array; manifest: AccountManifest }> {
  if (typeof subject !== "string" || subject === "") throw new Error("subject is required");
  checkApps(apps);
  const entries: { name: string; data: Uint8Array }[] = [];
  const generatedAt = (options.now ?? Date.now)();
  if (typeof generatedAt !== "number" || !Number.isFinite(generatedAt)) throw new Error("now must return a finite number");
  const manifest: AccountManifest = { version: 1, subject, generatedAt, apps: [] };
  for (const app of [...apps].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    const listed: ManifestFile[] = [];
    try {
      const files = await app.exportFor(subject);
      const paths = new Set<string>();
      const folders = new Set<string>();
      for (const file of files) {
        checkPath(file.path);
        // Compared without case: a Windows or macOS unzip would let one file overwrite the other.
        const key = file.path.normalize("NFC").toLowerCase();
        if (paths.has(key)) throw new Error("duplicate file path");
        for (let cut = key.indexOf("/"); cut !== -1; cut = key.indexOf("/", cut + 1)) {
          if (paths.has(key.slice(0, cut))) throw new Error("file path under a file");
        }
        paths.add(key);
        for (let cut = key.indexOf("/"); cut !== -1; cut = key.indexOf("/", cut + 1)) folders.add(key.slice(0, cut));
        if (folders.has(key)) throw new Error("file path over a file");
        if (typeof file.content === "string" && decoder.decode(encoder.encode(file.content)) !== file.content) throw new Error("file content is not valid text");
        const given = bytesOf(file.content);
        if (!(given instanceof Uint8Array)) throw new Error("file content must be a string or bytes");
        const data = typeof file.content === "string" ? given : new Uint8Array(given); // a later change to the exporter's buffer must not split the hash from the zip
        const name = `${app.id}/${file.path}`;
        if (encoder.encode(name).length > NAME_LIMIT) throw new Error("file name too long for a zip");
        entries.push({ name, data });
        listed.push({ path: file.path, bytes: data.length, sha256: await sha256(data) });
      }
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
 * kept those ids would vanish. When the actor is the subject, acts for the subject, or is an agent the subject owns, the entry is
 * written like the `deletePerson` tombstone: it names no one. Any other actor (an admin) stays.
 */
async function actorFor(store: Pick<Store, "get">, subject: string, actor: PrincipalContext | null): Promise<PrincipalContext | null> {
  if (actor === null) return null;
  const blank = { principalId: ERASED, kind: actor.kind, chain: [], ...(actor.requestId === undefined ? {} : { requestId: actor.requestId }) } as unknown as PrincipalContext;
  // A lookup that fails blanks the actor: that is the safe failure for privacy.
  try {
    return (await isMine(store, subject, actor)) ? blank : actor;
  } catch {
    return blank;
  }
}

async function isMine(store: Pick<Store, "get">, subject: string, actor: PrincipalContext): Promise<boolean> {
  const ids = [actor.principalId, ...actor.chain.map((step) => step.id)];
  let mine = ids.includes(subject);
  // An agent the subject made has an `ownerId` or a `parentId` that leads back to them.
  let frontier = ids;
  for (let depth = 0; !mine && frontier.length > 0 && depth < 8; depth++) {
    const next: string[] = [];
    for (const id of frontier) {
      const doc = await store.get("principals", id);
      for (const up of [doc?.ownerId, doc?.parentId]) {
        if (up === subject) mine = true;
        else if (typeof up === "string") next.push(up);
      }
    }
    frontier = next;
  }
  // A search that ran out of hops without an answer is a failed lookup: the caller blanks the actor.
  if (!mine && frontier.length > 0) throw new Error("owner search too deep");
  return mine;
}

export interface EraseResult {
  appId: string;
  ok: boolean;
  /** The error message of a failed eraser. It may name data: do not log it, and do not put personal data in it. */
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
 * audit entry, `person.erase` with `targetKind` `app` and `targetId` the app id, `allowed` or `denied`. The entry holds no
 * subject id. The caller erases the sign-in (see `deletePerson`) only when `ok` is true.
 */
export async function eraseAccount(subject: string, apps: AccountApp[], store: Pick<Store, "put" | "get">, options: AccountOptions = {}): Promise<EraseReport> {
  if (typeof subject !== "string" || subject === "") throw new Error("subject is required");
  checkApps(apps);
  if (options.actor === undefined) throw new Error("actor is required: pass a principal, or null for an anonymous request");
  if (options.actor !== null && !(PRINCIPAL_KINDS as readonly unknown[]).includes(options.actor.kind)) throw new Error("actor has no valid kind");
  const now = options.now ?? Date.now;
  // A clock that is broken fails before any eraser runs, so no erase goes without its entry.
  const first = now();
  if (typeof first !== "number" || !Number.isFinite(first)) throw new Error("now must return a finite number");
  // Found before the first eraser runs: an eraser may remove the principals this reads.
  const actor = await actorFor(store, subject, options.actor);
  const results: EraseResult[] = [];
  for (const app of apps) {
    let error: string | undefined;
    try {
      await app.eraseFor(subject);
    } catch (cause) {
      error = cause instanceof Error ? cause.message : "erase failed";
    }
    const id = crypto.randomUUID();
    let later = first;
    try {
      later = now();
    } catch {
      // The entry keeps the first time: the erase has run and must not go without its entry.
    }
    const entry = auditEntry(actor, { id, at: typeof later === "number" && Number.isFinite(later) ? later : first, action: "person.erase", outcome: error === undefined ? "allowed" : "denied", targetKind: "app", targetId: app.id });
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
