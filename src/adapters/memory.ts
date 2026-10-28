// In-memory adapters for tests and local development. Data is lost on exit.
import {
  DEFAULT_LIMIT,
  assertCollection,
  assertId,
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

type Tables = Map<string, Map<string, Doc>>;

const compare = (a: Json, b: Json): number =>
  typeof a !== typeof b ? (typeof a < typeof b ? -1 : 1) : (a as string) < (b as string) ? -1 : (a as string) > (b as string) ? 1 : 0;

function storeOps(tables: Tables): StoreOps {
  return {
    async get<T extends Doc>(collection: string, id: string) {
      assertCollection(collection);
      assertId(id);
      const doc = tables.get(collection)?.get(id);
      return doc ? (JSON.parse(JSON.stringify(doc)) as T) : null;
    },
    async put(collection, id, doc) {
      assertCollection(collection);
      assertId(id);
      const copy = JSON.parse(JSON.stringify(doc)) as Doc;
      if (!tables.has(collection)) tables.set(collection, new Map());
      tables.get(collection)!.set(id, copy);
    },
    async delete(collection, id) {
      assertCollection(collection);
      assertId(id);
      tables.get(collection)?.delete(id);
    },
    async query<T extends Doc>(collection: string, query: Query = {}): Promise<Page<T>> {
      assertCollection(collection);
      const limit = query.limit ?? DEFAULT_LIMIT;
      if (!Number.isInteger(limit) || limit < 1) throw new RangeError("limit must be an integer of 1 or more");
      const sign = query.orderBy?.direction === "desc" ? -1 : 1;
      const field = query.orderBy?.field;
      const order = (x: { v: Json; id: string }, y: { v: Json; id: string }) => sign * (compare(x.v, y.v) || compare(x.id, y.id));
      let rows = [...(tables.get(collection) ?? [])]
        .filter(([, doc]) => Object.entries(query.where ?? {}).every(([k, v]) => k in doc && doc[k] === v))
        .map(([id, doc]) => ({ id, doc, v: (field === undefined ? id : doc[field]) as Json }))
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
      return {
        items: page.map((row) => ({ id: row.id, data: JSON.parse(JSON.stringify(row.doc)) as T })),
        ...(rows.length > limit && last ? { nextCursor: Buffer.from(JSON.stringify([last.v, last.id])).toString("base64url") } : {}),
      };
    },
  };
}

export function createMemoryStore(options: AdapterOptions = {}): Store {
  let tables: Tables = new Map();
  let lock: Promise<unknown> = Promise.resolve();
  // One operation at a time, so a transaction sees no other writer.
  const exclusive = <R>(fn: () => Promise<R>): Promise<R> => {
    const run = lock.then(fn, fn);
    lock = run.catch(() => undefined);
    return run;
  };
  return {
    region: options.region ?? "eu",
    get: (c, id) => exclusive(() => storeOps(tables).get(c, id)),
    put: (c, id, doc) => exclusive(() => storeOps(tables).put(c, id, doc)),
    delete: (c, id) => exclusive(() => storeOps(tables).delete(c, id)),
    query: (c, q) => exclusive(() => storeOps(tables).query(c, q)),
    transaction: (fn) =>
      exclusive(async () => {
        const draft: Tables = new Map([...tables].map(([name, docs]) => [name, new Map(docs)]));
        const result = await fn(storeOps(draft));
        tables = draft;
        return result;
      }),
  };
}

export function createMemoryBlobs(options: AdapterOptions = {}): Blobs {
  const objects = new Map<string, BlobObject>();
  const now = options.now ?? Date.now;
  const need = (key: string) => {
    if (key === "") throw new Error("blob key must not be empty");
  };
  return {
    region: options.region ?? "eu",
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
