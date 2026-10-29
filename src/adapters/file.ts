// File-backed Store and Blobs for Node: local development, tests, and CLIs. Each doc and each object
// is one file. A write goes to a temp file in the same folder, is synced, and is renamed over the
// target, so a reader sees the old bytes or the new bytes and never half of a write. File names are
// the SHA-256 of the id or key, so any id or key (slashes, non-ASCII, long) is safe on any file system.
import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  DEFAULT_LIMIT,
  StoreConflictError,
  assertBlobPutOptions,
  assertCollection,
  assertField,
  assertId,
  parseRegion,
  type AdapterOptions,
  type BlobHead,
  type Blobs,
  type Doc,
  type Json,
  type Page,
  type Query,
  type Store,
  type StoreOps,
} from "../ports.js";
import { assertSecret, signBlobUrl } from "./signedurl.js";

export interface FileOptions extends AdapterOptions {
  /** The folder that holds the data. It is made when it is missing. Adapters on one folder share their data. */
  dir: string;
}

const LOCK_WAIT_MS = 10_000;
/** A lock older than this belongs to a process that died. */
const LOCK_STALE_MS = 60_000;
const MAX_TRANSACTION_RUNS = 50;
const MAX_HEADER_BYTES = 1 << 20;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const isCode = (error: unknown, code: string) => (error as NodeJS.ErrnoException | undefined)?.code === code;

/** Writes to a temp file, syncs it, then renames it over `path`. Returns the rename step. */
async function stage(path: string, ...parts: Uint8Array[]): Promise<() => Promise<void>> {
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
  return async () => {
    try {
      await rename(temp, path);
    } catch (error) {
      await rm(temp, { force: true });
      throw error;
    }
  };
}

/** One writer at a time per folder, across processes: `mkdir` is atomic, so one caller makes the lock folder. */
async function withLock<T>(root: string, fn: () => Promise<T>): Promise<T> {
  await mkdir(root, { recursive: true });
  const lock = join(root, ".lock");
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      await mkdir(lock);
      break;
    } catch (error) {
      if (!isCode(error, "EEXIST")) throw error;
    }
    const age = await stat(lock).then((s) => Date.now() - s.mtimeMs, () => 0);
    if (age > LOCK_STALE_MS) await rm(lock, { recursive: true, force: true });
    else if (Date.now() > deadline) throw new Error(`could not take the lock on "${root}" in ${LOCK_WAIT_MS} ms`);
    else await sleep(5);
  }
  try {
    return await fn();
  } finally {
    await rm(lock, { recursive: true, force: true });
  }
}

const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const compare = (a: Json, b: Json): number =>
  typeof a !== typeof b ? (typeof a < typeof b ? -1 : 1) : (a as string) < (b as string) ? -1 : (a as string) > (b as string) ? 1 : 0;

interface DocFile {
  id: string;
  version: string;
  doc: Doc;
}

interface Tx {
  /** The version each doc had when the transaction first read it. "0" means missing. */
  seen: Map<string, string>;
  writes: Map<string, { collection: string; id: string; doc: Doc | null }>;
}

/**
 * A `Store` in a folder. Stores made on one folder share its data, also across processes.
 * A transaction checks the version of each doc it read under a lock, and runs again on a change.
 * A commit that is cut short by a crash can leave some of its writes applied.
 */
export function createFileStore(options: FileOptions): Store {
  const region = options.region === undefined ? "unknown" : parseRegion(options.region);
  const root = join(options.dir, "docs");
  const folder = (collection: string) => join(root, collection);
  const pathOf = (collection: string, id: string) => join(folder(collection), `${hash(id)}.json`);
  const key = (collection: string, id: string) => `${collection}/${id}`;

  const read = async (collection: string, id: string): Promise<DocFile | null> => {
    try {
      return JSON.parse(await readFile(pathOf(collection, id), "utf8")) as DocFile;
    } catch (error) {
      if (isCode(error, "ENOENT")) return null;
      throw error;
    }
  };

  const stageWrite = async (collection: string, id: string, doc: Doc | null) => {
    if (doc === null) return () => rm(pathOf(collection, id), { force: true });
    await mkdir(folder(collection), { recursive: true });
    return stage(pathOf(collection, id), Buffer.from(JSON.stringify({ id, version: randomUUID(), doc } satisfies DocFile)));
  };

  const ops = (tx?: Tx): StoreOps => {
    const noReadAfterWrite = () => {
      if (tx && tx.writes.size > 0) throw new Error("a transaction must read before it writes");
    };
    const see = (collection: string, id: string, version: string) => {
      if (tx && !tx.seen.has(key(collection, id))) tx.seen.set(key(collection, id), version);
    };
    const write = async (collection: string, id: string, doc: Doc | null) => {
      assertCollection(collection);
      assertId(id);
      if (tx) tx.writes.set(key(collection, id), { collection, id, doc });
      else await withLock(root, async () => (await stageWrite(collection, id, doc))());
    };
    return {
      async get<T extends Doc>(collection: string, id: string) {
        assertCollection(collection);
        assertId(id);
        noReadAfterWrite();
        const found = await read(collection, id);
        see(collection, id, found?.version ?? "0");
        return found ? (found.doc as T) : null;
      },
      async put(collection, id, doc) {
        await write(collection, id, copy(doc));
      },
      async delete(collection, id) {
        await write(collection, id, null);
      },
      async query<T extends Doc>(collection: string, query: Query = {}): Promise<Page<T>> {
        assertCollection(collection);
        noReadAfterWrite();
        const limit = query.limit ?? DEFAULT_LIMIT;
        if (!Number.isInteger(limit) || limit < 1) throw new RangeError("limit must be an integer of 1 or more");
        for (const name of Object.keys(query.where ?? {})) assertField(name);
        const field = query.orderBy?.field;
        if (field !== undefined) assertField(field);
        const sign = query.orderBy?.direction === "desc" ? -1 : 1;
        const order = (x: { v: Json; id: string }, y: { v: Json; id: string }) => sign * (compare(x.v, y.v) || compare(x.id, y.id));
        const names = await readdir(folder(collection)).catch((error) => (isCode(error, "ENOENT") ? [] : Promise.reject(error)));
        const files: DocFile[] = [];
        for (const name of names) {
          if (!name.endsWith(".json")) continue;
          try {
            files.push(JSON.parse(await readFile(join(folder(collection), name), "utf8")) as DocFile);
          } catch (error) {
            // A doc deleted after the listing is gone, as if the listing came later.
            if (!isCode(error, "ENOENT")) throw error;
          }
        }
        let rows = files
          .filter((f) => Object.entries(query.where ?? {}).every(([k, v]) => k in f.doc && f.doc[k] === v))
          .map((f) => ({ f, id: f.id, v: (field === undefined ? f.id : f.doc[field]) as Json }))
          .filter((row) => row.v !== undefined && row.v !== null)
          .sort(order);
        if (query.cursor !== undefined) {
          let after: { v: Json; id: string };
          try {
            const [v, id] = JSON.parse(Buffer.from(query.cursor, "base64url").toString()) as [Json, string];
            if (typeof id !== "string") throw new Error();
            after = { v, id };
          } catch {
            throw new Error("invalid cursor");
          }
          rows = rows.filter((row) => order(row, after) > 0);
        }
        const page = rows.slice(0, limit);
        const last = page[page.length - 1];
        for (const row of page) see(collection, row.id, row.f.version);
        return {
          items: page.map((row) => ({ id: row.id, data: row.f.doc as T })),
          ...(rows.length > limit && last ? { nextCursor: Buffer.from(JSON.stringify([last.v, last.id])).toString("base64url") } : {}),
        };
      },
    };
  };

  return {
    region,
    ...ops(),
    async transaction(fn) {
      for (let run = 0; run < MAX_TRANSACTION_RUNS; run++) {
        const tx: Tx = { seen: new Map(), writes: new Map() };
        const result = await fn(ops(tx));
        const committed = await withLock(root, async () => {
          for (const [k, version] of tx.seen) {
            const slash = k.indexOf("/");
            if (((await read(k.slice(0, slash), k.slice(slash + 1)))?.version ?? "0") !== version) return false;
          }
          // Stage every write first, so the renames that follow are all that is left to do.
          const steps = [];
          for (const w of tx.writes.values()) steps.push(await stageWrite(w.collection, w.id, w.doc));
          for (const step of steps) await step();
          return true;
        });
        if (committed) return result;
      }
      throw new StoreConflictError();
    },
  };
}

export interface FileBlobsOptions extends FileOptions {
  /** The URL that `signedUrl` points at. Your server verifies it with `verifySignedBlobUrl`, then serves the key. */
  urlBase?: string;
  /** 32 bytes or more. With `urlBase`, it turns on `signedUrl`. */
  urlSecret?: string;
}

interface Header {
  key: string;
  version: string;
  contentType?: string;
  size: number;
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
      const header = JSON.parse(text.toString("utf8")) as Header;
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
      return withLock(root, async () => {
        const current = (await load(key, false))?.header;
        if ((opts?.ifNoneMatch === "*" && current) || (opts?.ifMatch !== undefined && current?.version !== opts.ifMatch)) return null;
        await (await stage(pathOf(key), lead, text, data))();
        return { version: header.version };
      });
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
      await withLock(root, () => rm(pathOf(key), { force: true }));
    },
    async signedUrl(key, opts) {
      if (!signing) throw new Error("signedUrl needs urlBase and urlSecret");
      return signBlobUrl(key, opts, { urlBase: options.urlBase!, urlSecret: options.urlSecret!, now });
    },
  };
}
