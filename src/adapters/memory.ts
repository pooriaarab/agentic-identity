// In-memory adapters for tests and local development. Data is lost on exit.
import {
  DEFAULT_LIMIT,
  assertCollection,
  assertField,
  assertId,
  parseRegion,
  type AdapterOptions,
  type BlobObject,
  type Blobs,
  type Doc,
  type Json,
  type Page,
  type Query,
  type Store,
  type StoreOps,
} from "../ports.js";

interface Backend {
  tables: Map<string, Map<string, { doc: Doc; version: number }>>;
  /** Every write takes the next number, so a doc that is deleted and made again never repeats a version. */
  clock: number;
}

const backends = new Map<string, Backend>();
const newBackend = (): Backend => ({ tables: new Map(), clock: 0 });
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const compare = (a: Json, b: Json): number =>
  typeof a !== typeof b ? (typeof a < typeof b ? -1 : 1) : (a as string) < (b as string) ? -1 : (a as string) > (b as string) ? 1 : 0;

interface Tx {
  /** The version each doc had when the transaction first read it. 0 means missing. */
  seen: Map<string, number>;
  writes: Map<string, { collection: string; id: string; doc: Doc | null }>;
}

function storeOps(b: Backend, tx?: Tx): StoreOps {
  const key = (collection: string, id: string) => `${collection}/${id}`;
  const noReadAfterWrite = () => {
    if (tx && tx.writes.size > 0) throw new Error("a transaction must read before it writes");
  };
  const see = (collection: string, id: string, version: number) => {
    if (tx && !tx.seen.has(key(collection, id))) tx.seen.set(key(collection, id), version);
  };
  const write = (collection: string, id: string, doc: Doc | null) => {
    assertCollection(collection);
    assertId(id);
    if (tx) {
      tx.writes.set(key(collection, id), { collection, id, doc });
    } else {
      applyWrite(b, collection, id, doc);
    }
  };
  return {
    async get<T extends Doc>(collection: string, id: string) {
      assertCollection(collection);
      assertId(id);
      noReadAfterWrite();
      const found = b.tables.get(collection)?.get(id);
      see(collection, id, found?.version ?? 0);
      return found ? copy(found.doc as T) : null;
    },
    async put(collection, id, doc) {
      write(collection, id, copy(doc));
    },
    async delete(collection, id) {
      write(collection, id, null);
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
      let rows = [...(b.tables.get(collection) ?? [])]
        .filter(([, found]) => Object.entries(query.where ?? {}).every(([k, v]) => k in found.doc && found.doc[k] === v))
        .map(([id, found]) => ({ id, found, v: (field === undefined ? id : found.doc[field]) as Json }))
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
      for (const row of page) see(collection, row.id, row.found.version);
      return {
        items: page.map((row) => ({ id: row.id, data: copy(row.found.doc as T) })),
        ...(rows.length > limit && last ? { nextCursor: Buffer.from(JSON.stringify([last.v, last.id])).toString("base64url") } : {}),
      };
    },
  };
}

function applyWrite(b: Backend, collection: string, id: string, doc: Doc | null): void {
  if (doc === null) {
    b.tables.get(collection)?.delete(id);
    return;
  }
  if (!b.tables.has(collection)) b.tables.set(collection, new Map());
  b.tables.get(collection)!.set(id, { doc, version: ++b.clock });
}

const MAX_TRANSACTION_RUNS = 50;

/**
 * Stores made with the same `shared` name use one dataset. A transaction checks
 * the version of each doc it read when it commits, and runs again on a change.
 */
export function createMemoryStore(options: AdapterOptions & { shared?: string } = {}): Store {
  const region = options.region === undefined ? "unknown" : parseRegion(options.region);
  const backend =
    options.shared === undefined ? newBackend() : (backends.get(options.shared) ?? backends.set(options.shared, newBackend()).get(options.shared)!);
  return {
    region,
    ...storeOps(backend),
    async transaction(fn) {
      for (let run = 0; run < MAX_TRANSACTION_RUNS; run++) {
        const tx: Tx = { seen: new Map(), writes: new Map() };
        const result = await fn(storeOps(backend, tx));
        // No await from here to the end, so no other writer gets in between.
        const unchanged = [...tx.seen].every(([k, version]) => {
          const slash = k.indexOf("/");
          return (backend.tables.get(k.slice(0, slash))?.get(k.slice(slash + 1))?.version ?? 0) === version;
        });
        if (!unchanged) continue;
        for (const w of tx.writes.values()) applyWrite(backend, w.collection, w.id, w.doc);
        return result;
      }
      throw new Error("transaction kept conflicting");
    },
  };
}

export function createMemoryBlobs(options: AdapterOptions = {}): Blobs {
  const objects = new Map<string, BlobObject>();
  const now = options.now ?? Date.now;
  const need = (key: string) => {
    if (key === "") throw new Error("blob key must not be empty");
  };
  return {
    region: options.region === undefined ? "unknown" : parseRegion(options.region),
    async put(key, data, opts) {
      need(key);
      objects.set(key, { data: data.slice(), ...(opts?.contentType ? { contentType: opts.contentType } : {}) });
    },
    async get(key) {
      need(key);
      const found = objects.get(key);
      return found ? { ...found, data: found.data.slice() } : null;
    },
    async delete(key) {
      need(key);
      objects.delete(key);
    },
    async signedUrl(key, { method, expiresInSeconds }) {
      need(key);
      if (!Number.isInteger(expiresInSeconds) || expiresInSeconds < 1 || expiresInSeconds > 604800) {
        throw new RangeError("expiresInSeconds must be an integer from 1 to 604800");
      }
      return `memory://blobs/${encodeURIComponent(key)}?method=${method}&expires=${now() + expiresInSeconds * 1000}`;
    },
  };
}
