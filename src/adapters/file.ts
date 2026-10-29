// A Store that keeps its data in one JSON file, for local use and for the CLI and the MCP server.
// It holds the data in memory (the memory adapter does the queries and the transactions) and writes
// the file after each change. Other processes may use the file too. Each call first reads the file
// again when another process changed it. A write that another process overtook is refused with
// `StoreConflictError` and changes nothing, so a lost update never happens.
import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { StoreConflictError, parseRegion, type AdapterOptions, type Doc, type Store, type StoreOps } from "../ports.js";
import { createMemoryStore } from "./memory.js";

const FORMAT = 1;
// The wait blocks the process (a synchronous sleep), so a long-lived process that shares the file
// stalls for at most this long. A write holds the lock for a moment. A writer waits longer than a lock takes to count as stale,
// so one command after a crash still gets through.
const LOCK_WAIT_MS = 5_000;
const LOCK_STALE_MS = 3_000;

interface Shared {
  path: string;
  inner: Store;
  /** What the file holds: collection, then id. */
  mirror: Map<string, Map<string, Doc>>;
  /** What the file looked like when this copy was read or written. `undefined` forces a read. */
  seen: string | undefined;
  /** The end of the last call. Calls on one path run one after another, so memory and file agree. */
  queue: Promise<unknown>;
}
const files = new Map<string, Promise<Shared>>();

const isDoc = (value: unknown): value is Doc => typeof value === "object" && value !== null && !Array.isArray(value);

/** Changes on each write by any process, because a write replaces the file. */
function signature(path: string): string {
  try {
    const s = statSync(path);
    return `${s.ino}:${s.size}:${s.mtimeMs}`;
  } catch {
    return "";
  }
}

function readFile(path: string): Map<string, Map<string, Doc>> {
  const mirror = new Map<string, Map<string, Doc>>();
  if (!existsSync(path)) return mirror;
  const bad = () => new Error(`${path} is not an agentic-identity store file`);
  // The message of a parse error quotes the start of the input, so it must not reach the caller.
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw bad();
  }
  const collections = isDoc(parsed) && parsed.format === FORMAT ? parsed.collections : undefined;
  if (!isDoc(collections)) throw bad();
  for (const [name, docs] of Object.entries(collections)) {
    if (!isDoc(docs) || !Object.values(docs).every(isDoc)) throw bad();
    mirror.set(name, new Map(Object.entries(docs).map(([id, doc]) => [id, doc as Doc])));
  }
  return mirror;
}

/** Fills a new memory store from the file. A transaction on the old one cannot commit into it. */
async function load(shared: Shared): Promise<void> {
  const seen = signature(shared.path);
  const mirror = readFile(shared.path);
  const inner = createMemoryStore();
  // The memory store refuses a bad collection name or id. Its message quotes the name, so it is not passed on.
  for (const [name, docs] of mirror) for (const [id, doc] of docs) await inner.put(name, id, doc).catch(() => Promise.reject(new Error(`${shared.path} is not an agentic-identity store file`)));
  Object.assign(shared, { inner, mirror, seen });
}

function open(path: string): Promise<Shared> {
  let known = files.get(path);
  if (!known) {
    const shared: Shared = { path, inner: createMemoryStore(), mirror: new Map(), seen: undefined, queue: Promise.resolve() };
    known = load(shared).then(() => shared);
    // A file that cannot be read is not kept, so a later call tries again.
    known.catch(() => files.delete(path));
    files.set(path, known);
  }
  return known;
}

const serial = <R>(shared: Shared, fn: () => Promise<R>): Promise<R> => {
  const run = shared.queue.then(fn);
  shared.queue = run.catch(() => undefined);
  return run;
};

const refresh = async (shared: Shared) => {
  if (shared.seen !== signature(shared.path)) await load(shared);
};

const unlinkQuietly = (path: string) => {
  try {
    unlinkSync(path);
  } catch {
    // Already gone.
  }
};

const sleep = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * One writer at a time, across processes. A lock that a crash left behind is removed after a while.
 * Two waiters can both remove such a lock and both take a new one, so `fn` gets `owned`, which it
 * calls just before it renames the file: it is false when another process took the lock over.
 */
function withLock<R>(path: string, fn: (owned: () => boolean) => R): R {
  const lock = `${path}.lock`;
  const mine = `${process.pid}:${crypto.randomUUID()}`;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  for (const start = Date.now(); ; ) {
    try {
      writeFileSync(lock, mine, { flag: "wx", mode: 0o600 });
      break;
    } catch (error) {
      if ((error as { code?: string }).code !== "EEXIST") throw error;
      try {
        if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) unlinkSync(lock);
      } catch {
        // The holder released it. Try again.
      }
      if (Date.now() - start > LOCK_WAIT_MS) throw new StoreConflictError("the store file is locked by another process");
      sleep(10);
    }
  }
  const owned = () => {
    try {
      return readFileSync(lock, "utf8") === mine;
    } catch {
      return false;
    }
  };
  try {
    return fn(owned);
  } finally {
    // Never remove a lock that another process holds now. A failed unlock must not hide the result.
    if (owned()) unlinkQuietly(lock);
  }
}

type Write = { collection: string; id: string; doc: Doc | null };

/** Writes the file, or throws and leaves the file and this copy to be read again. */
function commit(shared: Shared, writes: Write[]): void {
  if (writes.length === 0) return;
  try {
    withLock(shared.path, (owned) => {
      if (shared.seen !== signature(shared.path)) throw new StoreConflictError("the store file changed during the write");
      const next = new Map([...shared.mirror].map(([name, docs]) => [name, new Map(docs)]));
      for (const { collection, id, doc } of writes) {
        if (doc === null) next.get(collection)?.delete(id);
        else (next.get(collection) ?? next.set(collection, new Map()).get(collection)!).set(id, JSON.parse(JSON.stringify(doc)) as Doc);
      }
      const collections = Object.fromEntries([...next].map(([name, docs]) => [name, Object.fromEntries(docs)]));
      // Write beside the file, flush, and rename, so a crash never leaves half a file.
      const temp = `${shared.path}.${process.pid}.tmp`;
      const fd = openSync(temp, "w", 0o600);
      try {
        writeSync(fd, JSON.stringify({ format: FORMAT, collections }));
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      chmodSync(temp, 0o600);
      // The last look before the rename: a holder that stalled past the stale time may have lost the lock.
      if (!owned() || shared.seen !== signature(shared.path)) {
        unlinkQuietly(temp);
        throw new StoreConflictError("the store file lock was taken over");
      }
      renameSync(temp, shared.path);
      shared.mirror = next;
      shared.seen = signature(shared.path);
    });
  } catch (error) {
    // The memory copy took the writes. Read the file again, so the copy does not hold what failed.
    shared.seen = undefined;
    throw error;
  }
}

/** Stores made on the same path in one process share their data, and their calls run one at a time. */
export function createFileStore(options: AdapterOptions & { path: string }): Store {
  const region = options.region === undefined ? "unknown" : parseRegion(options.region);
  const path = resolve(options.path);
  const trace = (ops: StoreOps, sink: Write[]): StoreOps => ({
    get: (c, id) => ops.get(c, id),
    query: (c, q) => ops.query(c, q),
    async put(collection, id, doc) {
      await ops.put(collection, id, doc);
      sink.push({ collection, id, doc });
    },
    async delete(collection, id) {
      await ops.delete(collection, id);
      sink.push({ collection, id, doc: null });
    },
  });
  const single = async <R>(run: (ops: StoreOps) => Promise<R>): Promise<R> => {
    const shared = await open(path);
    return serial(shared, async () => {
      await refresh(shared);
      const used = shared.inner;
      const sink: Write[] = [];
      const result = await run(trace(used, sink));
      commit(shared, sink);
      return result;
    });
  };
  return {
    region,
    get: (collection, id) => single((ops) => ops.get(collection, id)) as never,
    query: (collection, query) => single((ops) => ops.query(collection, query)) as never,
    put: (collection, id, doc) => single((ops) => ops.put(collection, id, doc)),
    delete: (collection, id) => single((ops) => ops.delete(collection, id)),
    async transaction(fn) {
      const shared = await open(path);
      // Use `tx`, never the store, inside `fn`: a call on the store waits for this one to end.
      return serial(shared, async () => {
        await refresh(shared);
        const used = shared.inner;
        let sink: Write[] = [];
        // The memory adapter may run `fn` again, so only the writes of the run that committed count.
        const result = await used.transaction((tx) => {
          sink = [];
          return fn(trace(tx, sink));
        });
        commit(shared, sink);
        return result;
      });
    },
  };
}

export { createFileBlobs, type FileBlobsOptions } from "./fileblobs.js";
