// File-backed Blobs for Node: local development, tests, and CLIs. Each object is one file: a length,
// a JSON header, then the bytes. A write goes to a temp file in the same folder, is synced, and is
// renamed over the target, so a reader sees the old bytes or the new bytes and never half of a write.
// File names are the SHA-256 of the key, so any key (slashes, non-ASCII, long) is safe on any file system.
import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { assertBlobPutOptions, parseRegion, type AdapterOptions, type BlobHead, type Blobs } from "../ports.js";
import { assertSecret, signBlobUrl } from "./signedurl.js";

export interface FileBlobsOptions extends AdapterOptions {
  /** The folder that holds the data. It is made when it is missing. Adapters on one folder share their data. */
  dir: string;
  /** The URL that `signedUrl` points at. Your server verifies it with `verifySignedBlobUrl`, then serves the key. */
  urlBase?: string;
  /** 32 bytes or more. With `urlBase`, it turns on `signedUrl`. */
  urlSecret?: string;
}

const LOCK_WAIT_MS = 10_000;
/** A lock that nobody touched for this long belongs to a process that died. */
const LOCK_STALE_MS = 60_000;
/** The owner of a lock touches it this often. */
const LOCK_BEAT_MS = 10_000;
const MAX_HEADER_BYTES = 1 << 20;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const isCode = (error: unknown, code: string) => (error as NodeJS.ErrnoException | undefined)?.code === code;

interface Staged {
  /** Moves the temp file into place. */
  commit(): Promise<void>;
  /** Removes the temp file when the write is not committed. */
  discard(): Promise<void>;
}

/** Best effort: syncs a folder so a rename survives a power loss. Some systems cannot open a folder. */
async function syncFolder(path: string): Promise<void> {
  try {
    const handle = await open(path, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // Not supported here. The write still holds against a crash of the process.
  }
}

/** Writes to a temp file next to `path` and syncs it. Nothing is visible until `commit` renames it. */
async function stage(path: string, ...parts: Uint8Array[]): Promise<Staged> {
  const temp = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temp, "wx");
  try {
    for (const part of parts) await handle.write(part);
    await handle.sync();
  } catch (error) {
    await handle.close();
    await rm(temp, { force: true });
    throw error;
  }
  await handle.close();
  return {
    async commit() {
      try {
        await rename(temp, path);
      } catch (error) {
        await rm(temp, { force: true });
        throw error;
      }
      await syncFolder(dirname(path));
    },
    discard: () => rm(temp, { force: true }),
  };
}

/**
 * Removes a lock that nobody touched for a minute. One taker at a time holds the `.steal` file and checks
 * the age again, so a lock that a new owner made in the meantime is never removed.
 */
async function breakStale(lock: string): Promise<void> {
  const guard = `${lock}.steal`;
  try {
    await writeFile(guard, "", { flag: "wx" });
  } catch (error) {
    if (!isCode(error, "EEXIST")) throw error;
    // A taker that died holding the guard must not block the lock for good.
    if ((await stat(guard).then((s) => Date.now() - s.mtimeMs, () => 0)) > LOCK_STALE_MS) {
      // Rename first: of the callers that saw the old guard, one wins the rename and the rest find nothing.
      const gone = `${guard}.${randomUUID()}.gone`;
      if (await rename(guard, gone).then(() => true, () => false)) await rm(gone, { force: true });
    }
    return;
  }
  try {
    if ((await stat(lock).then((s) => Date.now() - s.mtimeMs, () => 0)) > LOCK_STALE_MS) await rm(lock, { force: true });
  } finally {
    await rm(guard, { force: true });
  }
}

/**
 * One writer at a time per folder, across processes. The lock is a file made with `wx`, so one caller
 * makes it, and it holds the owner's token. The owner touches it while it works, so only a lock that
 * nobody touched for a minute (a dead process) is taken, and `breakStale` takes it one taker at a time.
 * An owner removes the lock only while the token is its own. A process that stalls for longer than the
 * stale time can still lose its lock, and this is the limit of the scheme.
 */
async function withLock<T>(root: string, fn: () => Promise<T>): Promise<T> {
  await mkdir(root, { recursive: true });
  const lock = join(root, ".lock");
  const token = randomUUID();
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      await writeFile(lock, token, { flag: "wx" });
      break;
    } catch (error) {
      if (!isCode(error, "EEXIST")) throw error;
    }
    const age = await stat(lock).then((s) => Date.now() - s.mtimeMs, () => 0);
    if (Date.now() > deadline) throw new Error(`could not take the lock on "${root}" in ${LOCK_WAIT_MS} ms`);
    if (age > LOCK_STALE_MS) await breakStale(lock);
    await sleep(5);
  }
  const beat = setInterval(() => void utimes(lock, new Date(), new Date()).catch(() => {}), LOCK_BEAT_MS);
  beat.unref();
  try {
    return await fn();
  } finally {
    clearInterval(beat);
    if ((await readFile(lock, "utf8").catch(() => null)) === token) await rm(lock, { force: true });
  }
}

interface Header {
  key: string;
  version: string;
  contentType?: string;
  size: number;
}

function parseHeader(text: string): Header {
  let found: unknown;
  try {
    found = JSON.parse(text);
  } catch {
    throw new Error("blob file is damaged");
  }
  const h = found as Partial<Header> | null;
  const ok =
    typeof h === "object" && h !== null && typeof h.key === "string" && typeof h.version === "string" && h.version !== "" &&
    Number.isInteger(h.size) && (h.contentType === undefined || typeof h.contentType === "string");
  if (!ok) throw new Error("blob file is damaged");
  return h as Header;
}

/**
 * `Blobs` in a folder. An object is one file: a length, a JSON header, then the bytes. One rename
 * swaps all three, and a lock makes `ifMatch` and `ifNoneMatch` hold across stores and processes.
 */
export function createFileBlobs(options: FileBlobsOptions): Blobs {
  const region = options.region === undefined ? "unknown" : parseRegion(options.region);
  const now = options.now ?? Date.now;
  const root = join(options.dir, "blobs");
  const signing = options.urlBase !== undefined || options.urlSecret !== undefined;
  if (signing) {
    assertSecret(options.urlSecret);
    if (typeof options.urlBase !== "string") throw new Error("urlBase is required with urlSecret");
  }
  const pathOf = (key: string) => join(root, `${hash(key)}.blob`);
  const need = (key: string) => {
    if (key === "") throw new Error("blob key must not be empty");
  };

  /** Reads the header, and the bytes too when `withData` is set. */
  const load = async (key: string, withData: boolean): Promise<{ header: Header; data?: Uint8Array } | null> => {
    let handle;
    try {
      handle = await open(pathOf(key), "r");
    } catch (error) {
      if (isCode(error, "ENOENT")) return null;
      throw error;
    }
    try {
      const lead = Buffer.alloc(4);
      const total = (await handle.stat()).size;
      if (total < 4 || (await handle.read(lead, 0, 4, 0)).bytesRead !== 4) throw new Error("blob file is damaged");
      const length = lead.readUInt32BE(0);
      if (length > MAX_HEADER_BYTES || 4 + length > total) throw new Error("blob file is damaged");
      const text = Buffer.alloc(length);
      await handle.read(text, 0, length, 4);
      const header = parseHeader(text.toString("utf8"));
      if (header.key !== key || header.size !== total - 4 - length) throw new Error("blob file is damaged");
      if (!withData) return { header };
      const data = Buffer.alloc(header.size);
      await handle.read(data, 0, header.size, 4 + length);
      return { header, data: new Uint8Array(data) };
    } finally {
      await handle.close();
    }
  };

  return {
    region,
    async put(key, data, opts) {
      need(key);
      assertBlobPutOptions(opts);
      const header: Header = { key, version: randomUUID(), size: data.length, ...(opts?.contentType ? { contentType: opts.contentType } : {}) };
      const text = Buffer.from(JSON.stringify(header));
      const lead = Buffer.alloc(4);
      lead.writeUInt32BE(text.length);
      await mkdir(root, { recursive: true });
      const staged = await stage(pathOf(key), lead, text, data);
      try {
        return await withLock(root, async () => {
          const current = (await load(key, false))?.header;
          if ((opts?.ifNoneMatch === "*" && current) || (opts?.ifMatch !== undefined && current?.version !== opts.ifMatch)) return null;
          await staged.commit();
          return { version: header.version };
        });
      } finally {
        await staged.discard();
      }
    },
    async get(key) {
      need(key);
      const found = await load(key, true);
      if (!found) return null;
      const { header } = found;
      return { data: found.data!, version: header.version, ...(header.contentType ? { contentType: header.contentType } : {}) };
    },
    async head(key) {
      need(key);
      const found = await load(key, false);
      if (!found) return null;
      const { header } = found;
      return { size: header.size, version: header.version, ...(header.contentType ? { contentType: header.contentType } : {}) } satisfies BlobHead;
    },
    async delete(key) {
      need(key);
      await withLock(root, async () => {
        await rm(pathOf(key), { force: true });
        await syncFolder(root);
      });
    },
    async signedUrl(key, opts) {
      if (!signing) throw new Error("signedUrl needs urlBase and urlSecret");
      return signBlobUrl(key, opts, { urlBase: options.urlBase!, urlSecret: options.urlSecret!, now });
    },
  };
}
