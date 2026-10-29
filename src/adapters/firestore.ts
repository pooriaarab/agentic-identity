// Firestore adapter for the Store port. It speaks the Firestore REST API through an injected
// `fetch`, so it runs in Workers, Node, and Cloud Functions without the Firebase SDK, and it
// imports nothing from Google.
//
// Firestore is a pessimistic backend: a transaction locks the docs it reads, so a rival write
// waits until the transaction ends. A transaction that cannot get its locks ends with ABORTED.
// The adapter runs it again, and throws `StoreConflictError` after the last attempt.
import {
  DEFAULT_LIMIT,
  StoreConflictError,
  assertCollection,
  assertField,
  assertId,
  parseRegion,
  type AdapterOptions,
  type Doc,
  type Json,
  type Page,
  type Query,
  type Store,
  type StoreOps,
} from "../ports.js";

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
    const query = transaction === undefined ? "" : `?transaction=${encodeURIComponent(transaction)}`;
    const found = await call<{ fields?: Fields }>("GET", `${encodedPath(collection, id)}${query}`);
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
