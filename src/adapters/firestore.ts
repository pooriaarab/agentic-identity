// Firestore adapter for the Store port. It speaks the Firestore REST API through an injected
// `fetch`, so it runs in Workers, Node, and Cloud Functions without the Firebase SDK, and it
// imports nothing from Google.
//
// Firestore is a pessimistic backend: a transaction locks the docs it reads, so a rival write
// waits until the transaction ends. A transaction that cannot get its locks ends with ABORTED.
// The adapter runs it again, and throws `StoreConflictError` after the last attempt.
//
// `createFirestoreBlobs` keeps `Blobs` in Firestore docs, cut into chunks, so one backend holds
// both ports and the emulator can run the Blobs contract. Use Cloud Storage for big files.
import {
  DEFAULT_LIMIT,
  StoreConflictError,
  assertCollection,
  assertField,
  assertId,
  assertBlobPutOptions,
  parseRegion,
  type AdapterOptions,
  type Blobs,
  type Doc,
  type Json,
  type Page,
  type Query,
  type Store,
  type StoreOps,
} from "../ports.js";
import { assertSecret, signBlobUrl } from "./signedurl.js";

export { verifySignedBlobUrl } from "./signedurl.js";

export interface FirestoreOptions extends AdapterOptions {
  projectId: string;
  /** Defaults to `(default)`. */
  databaseId?: string;
  /** The `fetch` to call. Pass `globalThis.fetch`, or a wrapper that adds retries or tracing. */
  fetch: typeof fetch;
  /** An OAuth access token, or a function that returns one. Leave it out for the emulator. */
  token?: string | (() => string | Promise<string>);
  /** Defaults to `https://firestore.googleapis.com`. For the emulator, use `http://<FIRESTORE_EMULATOR_HOST>`. */
  baseUrl?: string;
  /** How often a transaction runs when Firestore aborts it. Defaults to 8. */
  maxAttempts?: number;
}

/** A Firestore call failed. It holds the HTTP status and the Firestore status code, never a doc. */
export class FirestoreError extends Error {
  constructor(
    readonly httpStatus: number,
    readonly code: string,
  ) {
    super(`firestore request failed: ${httpStatus} ${code}`);
    this.name = "FirestoreError";
  }
}

type Value =
  | { nullValue: null }
  | { booleanValue: boolean }
  | { integerValue: string }
  | { doubleValue: number }
  | { stringValue: string }
  | { arrayValue: { values?: Value[] } }
  | { mapValue: { fields?: Record<string, Value> } };
type Fields = Record<string, Value>;

function encode(value: Json, ancestors: object[] = []): Value {
  if (value === null) return { nullValue: null };
  switch (typeof value) {
    case "boolean":
      return { booleanValue: value };
    case "string":
      return { stringValue: value };
    case "number":
      if (!Number.isFinite(value)) throw new Error("a doc cannot hold NaN or Infinity");
      return Number.isSafeInteger(value) ? { integerValue: String(value) } : { doubleValue: value };
    case "object": {
      if (ancestors.includes(value)) throw new Error("a doc must not contain a cycle");
      const path = [...ancestors, value];
      if (Array.isArray(value)) {
        // Firestore refuses an array that holds an array.
        return { arrayValue: { values: value.map((item) => (Array.isArray(item) ? fail("Firestore cannot store an array in an array") : encode(item, path))) } };
      }
      const proto = Object.getPrototypeOf(value) as unknown;
      if (proto !== Object.prototype && proto !== null) throw new Error("a doc must be plain JSON");
      return { mapValue: { fields: encodeFields(value, path) } };
    }
    default:
      throw new Error("a doc must be plain JSON");
  }
}

function fail(message: string): never {
  throw new Error(message);
}

function encodeFields(doc: { [key: string]: Json }, ancestors: object[] = [doc]): Fields {
  const fields: Fields = {};
  for (const [key, value] of Object.entries(doc)) {
    if (value === undefined) continue;
    // Firestore refuses an empty key and a key like "__name__".
    if (key === "" || /^__.*__$/.test(key)) throw new Error(`invalid field name "${key}" in a doc`);
    fields[key] = encode(value, ancestors);
  }
  return fields;
}

function decode(value: Value): Json {
  if ("nullValue" in value) return null;
  if ("booleanValue" in value) return value.booleanValue;
  if ("integerValue" in value) return Number(value.integerValue);
  if ("doubleValue" in value) return value.doubleValue;
  if ("stringValue" in value) return value.stringValue;
  if ("arrayValue" in value) return (value.arrayValue.values ?? []).map(decode);
  if ("mapValue" in value) return decodeFields(value.mapValue.fields ?? {});
  throw new Error("unsupported Firestore value type");
}

function decodeFields(fields: Fields): Doc {
  return Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, decode(value)]));
}

interface Write {
  update?: { name: string; fields: Fields };
  delete?: string;
}

interface RunQueryRow {
  document?: { name: string; fields?: Fields };
}

const toBase64Url = (text: string) => {
  let binary = "";
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const fromBase64Url = (cursor: string) => {
  const binary = atob(cursor.replace(/-/g, "+").replace(/_/g, "/"));
  return new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)));
};

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const isAborted = (error: unknown) => error instanceof FirestoreError && (error.code === "ABORTED" || error.httpStatus === 409);

/** Creates a `Store` over the Firestore REST API. */
export function createFirestoreStore(options: FirestoreOptions): Store {
  const region = options.region === undefined ? "unknown" : parseRegion(options.region);
  const database = `projects/${options.projectId}/databases/${options.databaseId ?? "(default)"}`;
  const root = `${(options.baseUrl ?? "https://firestore.googleapis.com").replace(/\/+$/, "")}/v1/${database}/documents`;
  const maxAttempts = options.maxAttempts ?? 8;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) throw new RangeError("maxAttempts must be an integer of 1 or more");

  async function call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T | null> {
    const token = typeof options.token === "function" ? await options.token() : options.token;
    const response = await options.fetch(`${root}${path}`, {
      method,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = text === "" ? null : JSON.parse(text);
    } catch {
      parsed = null;
    }
    if (response.status === 404 && method === "GET") return null;
    if (!response.ok) {
      const status = (parsed as { error?: { status?: unknown } } | null)?.error?.status;
      throw new FirestoreError(response.status, typeof status === "string" ? status : "UNKNOWN");
    }
    return parsed as T;
  }

  const name = (collection: string, id: string) => `${database}/documents/${collection}/${id}`;
  const encodedPath = (collection: string, id: string) => `/${collection}/${encodeURIComponent(id)}`;
  const idOf = (resource: string) => resource.slice(resource.lastIndexOf("/") + 1);

  const writeOf = (collection: string, id: string, doc: Doc | null): Write => {
    assertCollection(collection);
    assertId(id);
    return doc === null ? { delete: name(collection, id) } : { update: { name: name(collection, id), fields: encodeFields(doc) } };
  };

  async function read<T extends Doc>(collection: string, id: string, transaction?: string): Promise<T | null> {
    assertCollection(collection);
    assertId(id);
    if (transaction !== undefined) {
      // The transaction id is a bytes field. The emulator cannot read one from a URL query, so send it in a body.
      const rows = (await call<{ found?: { fields?: Fields } }[]>("POST", ":batchGet", { documents: [name(collection, id)], transaction })) ?? [];
      const found = rows.find((row) => row.found)?.found;
      return found ? (decodeFields(found.fields ?? {}) as T) : null;
    }
    const found = await call<{ fields?: Fields }>("GET", encodedPath(collection, id));
    return found ? (decodeFields(found.fields ?? {}) as T) : null;
  }

  async function query<T extends Doc>(collection: string, q: Query, transaction?: string): Promise<Page<T>> {
    assertCollection(collection);
    const limit = q.limit ?? DEFAULT_LIMIT;
    if (!Number.isInteger(limit) || limit < 1) throw new RangeError("limit must be an integer of 1 or more");
    for (const field of Object.keys(q.where ?? {})) assertField(field);
    const field = q.orderBy?.field;
    if (field !== undefined) assertField(field);
    const direction = q.orderBy?.direction === "desc" ? "DESCENDING" : "ASCENDING";

    const filters: object[] = Object.entries(q.where ?? {}).map(([path, value]) =>
      value === null
        ? { unaryFilter: { op: "IS_NULL", field: { fieldPath: path } } }
        : { fieldFilter: { field: { fieldPath: path }, op: "EQUAL", value: encode(value) } },
    );
    // A doc without the field, or with null, is left out of an ordered query.
    if (field !== undefined) filters.push({ unaryFilter: { op: "IS_NOT_NULL", field: { fieldPath: field } } });

    let startAt: object | undefined;
    if (q.cursor !== undefined) {
      let value: Json;
      let id: string;
      try {
        const parsed = JSON.parse(fromBase64Url(q.cursor)) as [Json, string];
        [value, id] = parsed;
        if (typeof id !== "string" || !Array.isArray(parsed) || parsed.length !== 2) throw new Error();
        if (field === undefined ? value !== id : value === null || typeof value === "object") throw new Error();
      } catch {
        throw new Error("invalid cursor");
      }
      const ref = { referenceValue: name(collection, id) };
      startAt = { before: false, values: field === undefined ? [ref] : [encode(value), ref] };
    }

    const structuredQuery = {
      from: [{ collectionId: collection }],
      ...(filters.length === 0 ? {} : { where: filters.length === 1 ? filters[0] : { compositeFilter: { op: "AND", filters } } }),
      orderBy: [...(field === undefined ? [] : [{ field: { fieldPath: field }, direction }]), { field: { fieldPath: "__name__" }, direction }],
      ...(startAt ? { startAt } : {}),
      limit: limit + 1,
    };
    const rows = (await call<RunQueryRow[]>("POST", ":runQuery", { structuredQuery, ...(transaction === undefined ? {} : { transaction }) })) ?? [];
    const found = rows.flatMap((row) => (row.document ? [{ id: idOf(row.document.name), data: decodeFields(row.document.fields ?? {}) as T }] : []));
    const items = found.slice(0, limit);
    const last = items[items.length - 1];
    const cursorValue = (item: { id: string; data: Doc }): Json => {
      const value = field === undefined ? item.id : (item.data[field] as Json);
      if (typeof value === "object" && value !== null) throw new Error(`cannot page by "${field}": a doc holds an array or a map there`);
      return value;
    };
    return {
      items,
      ...(found.length > limit && last ? { nextCursor: toBase64Url(JSON.stringify([cursorValue(last), last.id])) } : {}),
    };
  }

  const commit = (writes: Write[], transaction?: string) =>
    call("POST", ":commit", { writes, ...(transaction === undefined ? {} : { transaction }) });

  return {
    region,
    get: (collection, id) => read(collection, id),
    query: (collection, q = {}) => query(collection, q),
    async put(collection, id, doc) {
      await commit([writeOf(collection, id, doc)]);
    },
    async delete(collection, id) {
      await commit([writeOf(collection, id, null)]);
    },
    async transaction<R>(fn: (tx: StoreOps) => Promise<R>): Promise<R> {
      let previous: string | undefined;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        // Firestore ages a transaction that retries an earlier one, so it does not lose to younger ones again.
        if (attempt > 1) await sleep(Math.random() * 20 * 2 ** (attempt - 1));
        let id: string;
        try {
          const begun = await call<{ transaction: string }>("POST", ":beginTransaction", {
            options: { readWrite: { ...(previous === undefined ? {} : { retryTransaction: previous }) } },
          });
          id = begun?.transaction ?? fail("firestore did not start a transaction");
        } catch (error) {
          if (isAborted(error)) continue;
          throw error;
        }
        previous = id;
        const writes = new Map<string, Write>();
        const noReadAfterWrite = () => {
          if (writes.size > 0) throw new Error("a transaction must read before it writes");
        };
        const tx: StoreOps = {
          async get<T extends Doc>(collection: string, docId: string) {
            noReadAfterWrite();
            return read<T>(collection, docId, id);
          },
          async query<T extends Doc>(collection: string, q: Query = {}) {
            noReadAfterWrite();
            return query<T>(collection, q, id);
          },
          async put(collection, docId, doc) {
            writes.set(`${collection}/${docId}`, writeOf(collection, docId, doc));
          },
          async delete(collection, docId) {
            writes.set(`${collection}/${docId}`, writeOf(collection, docId, null));
          },
        };
        try {
          const result = await fn(tx);
          await commit([...writes.values()], id);
          return result;
        } catch (error) {
          // A commit that Firestore aborted has ended the transaction already. Any other end needs a rollback.
          await call("POST", ":rollback", { transaction: id }).catch(() => undefined);
          if (!isAborted(error)) throw error;
        }
      }
      throw new StoreConflictError();
    },
  };
}

export interface FirestoreBlobsOptions extends FirestoreOptions {
  /** Where your server serves signed blob URLs. Call `verifySignedBlobUrl` there. */
  urlBase: string;
  /** At least 32 bytes. There is no default. Use one secret per database. */
  urlSecret: string;
  /** The collection that holds one doc per key. Chunks go in `<collection>_chunks`. Defaults to `blobs`. */
  collection?: string;
  /** The largest object. Defaults to 32 MiB. */
  maxBytes?: number;
  /** The bytes in one chunk doc, up to 768 KiB. A doc holds 1 MiB, and base64 adds a third. Defaults to 512 KiB. */
  chunkBytes?: number;
}

type BlobMeta = { key: string; size: number; version: string; chunks: number; chunkBytes: number; contentType?: string };

const toBase64 = (bytes: Uint8Array) => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};
const fromBase64 = (text: string) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
const sha256Hex = async (text: string) =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))].map((b) => b.toString(16).padStart(2, "0")).join("");

/**
 * `Blobs` over Firestore docs. A key has one meta doc, and its bytes sit in chunk docs named by
 * version. A put writes the new chunks first, then swaps the meta doc in one transaction that
 * checks `ifMatch` or `ifNoneMatch`. A reader sees the old bytes or the new bytes, never a mix.
 * A crash between the steps leaves orphan chunks, which no reader sees.
 */
export function createFirestoreBlobs(options: FirestoreBlobsOptions): Blobs {
  assertSecret(options.urlSecret);
  const store = createFirestoreStore(options);
  const metas = options.collection ?? "blobs";
  const chunksOf = `${metas}_chunks`;
  const maxBytes = options.maxBytes ?? 32 * 1024 * 1024;
  const chunkBytes = options.chunkBytes ?? 512 * 1024;
  for (const [name, value] of [["maxBytes", maxBytes], ["chunkBytes", chunkBytes]] as const) {
    if (!Number.isInteger(value) || value < 1) throw new RangeError(`${name} must be an integer of 1 or more`);
  }
  if (chunkBytes > 768 * 1024) throw new RangeError("chunkBytes must be 786432 or less, so a chunk fits in a 1 MiB doc");
  const now = options.now ?? Date.now;
  const need = (key: string) => {
    if (key === "") throw new Error("blob key must not be empty");
  };
  const chunkId = (version: string, n: number) => `${version}_${n}`;

  // Eight at a time, so a large object does not open hundreds of requests.
  async function each(count: number, work: (n: number) => Promise<void>): Promise<void> {
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(8, count) }, async () => {
        while (next < count) await work(next++);
      }),
    );
  }
  const dropChunks = (meta: Pick<BlobMeta, "version" | "chunks">) => each(meta.chunks, (n) => store.delete(chunksOf, chunkId(meta.version, n)));
  const headOf = (meta: BlobMeta) => ({ size: meta.size, version: meta.version, ...(meta.contentType ? { contentType: meta.contentType } : {}) });

  return {
    region: store.region,
    async put(key, data, opts) {
      need(key);
      assertBlobPutOptions(opts);
      if (data.length > maxBytes) throw new RangeError(`a blob holds at most ${maxBytes} bytes`);
      const id = await sha256Hex(key);
      const version = crypto.randomUUID();
      const chunks = Math.ceil(data.length / chunkBytes);
      const meta: BlobMeta = { key, size: data.length, version, chunks, chunkBytes, ...(opts?.contentType ? { contentType: opts.contentType } : {}) };
      let committing = false;
      try {
        await each(chunks, (n) => store.put(chunksOf, chunkId(version, n), { data: toBase64(data.subarray(n * chunkBytes, (n + 1) * chunkBytes)) }));
        committing = true;
        const replaced = await store.transaction(async (tx) => {
          const current = await tx.get<BlobMeta>(metas, id);
          if ((opts?.ifNoneMatch === "*" && current) || (opts?.ifMatch !== undefined && current?.version !== opts.ifMatch)) return false as const;
          await tx.put(metas, id, meta);
          return current;
        });
        if (replaced === false) {
          await dropChunks(meta);
          return null;
        }
        if (replaced) await dropChunks(replaced).catch(() => undefined);
        return { version };
      } catch (error) {
        // After a commit that failed in a way we cannot read (a dropped connection, a 5xx), the write may
        // have landed and the meta doc may point at these chunks. Keep them then. An orphan costs space only.
        if (!committing || error instanceof StoreConflictError) await dropChunks(meta).catch(() => undefined);
        throw error;
      }
    },
    async get(key) {
      need(key);
      const id = await sha256Hex(key);
      // A put or delete can drop the chunks after we read the meta. Read the meta again then.
      for (let attempt = 0; attempt < 5; attempt++) {
        const meta = await store.get<BlobMeta>(metas, id);
        if (!meta) return null;
        // The meta doc names its own chunk size, so an instance with another `chunkBytes` still reads it.
        if (!Number.isInteger(meta.size) || !Number.isInteger(meta.chunkBytes) || meta.size < 0 || meta.chunkBytes < 1 || meta.chunks !== Math.ceil(meta.size / meta.chunkBytes)) {
          throw new Error("a blob has a bad meta doc");
        }
        const parts: Uint8Array[] = new Array(meta.chunks);
        let missing = false;
        await each(meta.chunks, async (n) => {
          const chunk = await store.get<{ data: string }>(chunksOf, chunkId(meta.version, n));
          if (chunk) parts[n] = fromBase64(chunk.data);
          else missing = true;
        });
        if (missing) continue;
        const data = new Uint8Array(meta.size);
        let offset = 0;
        for (const part of parts) {
          if (offset + part.length > meta.size) throw new Error("a blob has more bytes than its meta doc says");
          data.set(part, offset);
          offset += part.length;
        }
        if (offset !== meta.size) throw new Error("a blob has fewer bytes than its meta doc says");
        return { data, ...headOf(meta) };
      }
      throw new Error("a blob changed while it was read");
    },
    async head(key) {
      need(key);
      const meta = await store.get<BlobMeta>(metas, await sha256Hex(key));
      return meta ? headOf(meta) : null;
    },
    async delete(key) {
      need(key);
      const id = await sha256Hex(key);
      const gone = await store.transaction(async (tx) => {
        const current = await tx.get<BlobMeta>(metas, id);
        if (current) await tx.delete(metas, id);
        return current;
      });
      // The key is gone. A chunk that stays is an orphan that no read sees.
      if (gone) await dropChunks(gone).catch(() => undefined);
    },
    signedUrl: (key, opts) => signBlobUrl(key, opts, { urlBase: options.urlBase, urlSecret: options.urlSecret, now }),
  };
}
