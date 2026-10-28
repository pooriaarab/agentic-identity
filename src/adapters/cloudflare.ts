// Cloudflare adapters. They use small structural types, so this file imports
// nothing from Cloudflare. Pass in a D1 or R2 binding.
//
// Residency is fixed when you create the resource, so `region` here declares
// where the resource lives. Create it in the EU:
//   wrangler d1 create <name> --location weur        (or eeur)
//   wrangler r2 bucket create <name> --jurisdiction eu
import {
  DEFAULT_LIMIT,
  assertCollection,
  assertId,
  type AdapterOptions,
  type Blobs,
  type Doc,
  type Page,
  type Query,
  type Scalar,
  type Store,
  type StoreOps,
} from "../ports.js";

export interface D1Statement {
  bind(...values: unknown[]): D1Statement;
  first<T>(): Promise<T | null>;
  all<T>(): Promise<{ results: T[] }>;
  run(): Promise<unknown>;
}

export interface D1Like {
  prepare(sql: string): D1Statement;
  /** Runs all statements in one transaction. */
  batch(statements: D1Statement[]): Promise<unknown[]>;
}

/**
 * One generic table keyed by collection and id. The body is JSON. Filters and
 * ordering read the body with SQLite JSON functions. For a large collection,
 * add an expression index per field you filter on, for example:
 *   CREATE INDEX docs_team ON store_docs (collection, json_extract(body, '$.team'));
 */
export const D1_SCHEMA =
  "CREATE TABLE IF NOT EXISTS store_docs (collection TEXT NOT NULL, id TEXT NOT NULL, body TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1, PRIMARY KEY (collection, id)) WITHOUT ROWID";

const MAX_TRANSACTION_ATTEMPTS = 50;

const UPSERT =
  "INSERT INTO store_docs (collection, id, body) VALUES (?, ?, ?) ON CONFLICT (collection, id) DO UPDATE SET body = excluded.body, version = store_docs.version + 1";

// Fails the whole batch with "malformed JSON" when the doc changed since it was read.
const GUARD =
  "SELECT CASE WHEN COALESCE((SELECT version FROM store_docs WHERE collection = ? AND id = ?), 0) = ? THEN 1 ELSE json('!') END";

const toBase64Url = (value: unknown) =>
  btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(value))))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

function fromBase64Url(text: string): [Scalar, string] {
  try {
    const bytes = Uint8Array.from(atob(text.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
    const [value, id] = JSON.parse(new TextDecoder().decode(bytes)) as [Scalar, unknown];
    if (typeof id !== "string") throw new Error();
    return [value, id];
  } catch {
    throw new Error("invalid cursor");
  }
}

function assertField(field: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(field)) throw new Error(`invalid field name "${field}"`);
  return `$.${field}`;
}

// A match on both the JSON type and the value, so true never equals 1.
function equals(field: string, value: Scalar): { sql: string; params: unknown[] } {
  const path = assertField(field);
  if (value === null) return { sql: "json_type(body, ?) = 'null'", params: [path] };
  if (typeof value === "boolean") return { sql: "json_type(body, ?) = ?", params: [path, value ? "true" : "false"] };
  const types = typeof value === "number" ? "'integer', 'real'" : "'text'";
  return { sql: `json_type(body, ?) IN (${types}) AND json_extract(body, ?) = ?`, params: [path, path, value] };
}

interface Row {
  id: string;
  body: string;
  version: number;
  v: Scalar;
}

async function runQuery(db: D1Like, collection: string, query: Query): Promise<{ rows: Row[]; next?: string }> {
  assertCollection(collection);
  const limit = query.limit ?? DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1) throw new RangeError("limit must be an integer of 1 or more");
  const field = query.orderBy?.field;
  const path = field === undefined ? undefined : assertField(field);
  const desc = query.orderBy?.direction === "desc";
  const value = path === undefined ? "id" : "json_extract(body, ?)";
  const valueParams = path === undefined ? [] : [path];

  const where = ["collection = ?"];
  const params: unknown[] = [collection];
  for (const [name, wanted] of Object.entries(query.where ?? {})) {
    const filter = equals(name, wanted);
    where.push(filter.sql);
    params.push(...filter.params);
  }
  if (path !== undefined) {
    where.push("COALESCE(json_type(body, ?), 'null') != 'null'");
    params.push(path);
  }
  if (query.cursor !== undefined) {
    const [after, afterId] = fromBase64Url(query.cursor);
    const cmp = desc ? "<" : ">";
    const bound = typeof after === "boolean" ? Number(after) : after;
    where.push(`(${value} ${cmp} ? OR (${value} = ? AND id ${cmp} ?))`);
    params.push(...valueParams, bound, ...valueParams, bound, afterId);
  }
  const dir = desc ? "DESC" : "ASC";
  const sql = `SELECT id, body, version, ${value} AS v FROM store_docs WHERE ${where.join(" AND ")} ORDER BY v ${dir}, id ${dir} LIMIT ?`;
  const { results } = await db
    .prepare(sql)
    .bind(...valueParams, ...params, limit + 1)
    .all<Row>();
  const page = results.slice(0, limit);
  const last = page[page.length - 1];
  return { rows: page, next: results.length > limit && last ? toBase64Url([last.v, last.id]) : undefined };
}

const toPage = <T extends Doc>(rows: Row[], next?: string): Page<T> => ({
  items: rows.map((row) => ({ id: row.id, data: JSON.parse(row.body) as T })),
  ...(next === undefined ? {} : { nextCursor: next }),
});

export function createD1Store(db: D1Like, options: AdapterOptions = {}): Store {
  const readRow = async (collection: string, id: string) => {
    assertCollection(collection);
    assertId(id);
    return db.prepare("SELECT body, version FROM store_docs WHERE collection = ? AND id = ?").bind(collection, id).first<Row>();
  };
  const upsert = (collection: string, id: string, doc: Doc) => {
    assertCollection(collection);
    assertId(id);
    return db.prepare(UPSERT).bind(collection, id, JSON.stringify(doc));
  };
  const remove = (collection: string, id: string) => {
    assertCollection(collection);
    assertId(id);
    return db.prepare("DELETE FROM store_docs WHERE collection = ? AND id = ?").bind(collection, id);
  };

  let turn: Promise<unknown> = Promise.resolve();

  return {
    region: options.region ?? "eu",
    async get<T extends Doc>(collection: string, id: string) {
      const row = await readRow(collection, id);
      return row ? (JSON.parse(row.body) as T) : null;
    },
    async put(collection, id, doc) {
      await upsert(collection, id, doc).run();
    },
    async delete(collection, id) {
      await remove(collection, id).run();
    },
    async query<T extends Doc>(collection: string, query: Query = {}) {
      const { rows, next } = await runQuery(db, collection, query);
      return toPage<T>(rows, next);
    },
    // D1 has no interactive transactions. Reads record the version they saw,
    // writes wait in memory, and one atomic batch checks every version before
    // it writes. A changed doc makes the batch fail, and the function runs again.
    // This store runs its own transactions one at a time, so one isolate does
    // not fight itself. The version check guards against other isolates.
    transaction<R>(fn: (tx: StoreOps) => Promise<R>): Promise<R> {
      const run = turn.then(() => commit(fn));
      turn = run.catch(() => undefined);
      return run;
    },
  };

  async function commit<R>(fn: (tx: StoreOps) => Promise<R>): Promise<R> {
    for (let attempt = 0; attempt < MAX_TRANSACTION_ATTEMPTS; attempt++) {
      const seen = new Map<string, { collection: string; id: string; version: number }>();
      const writes: D1Statement[] = [];
      const note = (collection: string, id: string, version: number) => seen.set(`${collection}/${id}`, { collection, id, version });
      const result = await fn({
        async get<T extends Doc>(collection: string, id: string) {
          const row = await readRow(collection, id);
          note(collection, id, row?.version ?? 0);
          return row ? (JSON.parse(row.body) as T) : null;
        },
        async put(collection, id, doc) {
          writes.push(upsert(collection, id, doc));
        },
        async delete(collection, id) {
          writes.push(remove(collection, id));
        },
        async query<T extends Doc>(collection: string, query: Query = {}) {
          const { rows, next } = await runQuery(db, collection, query);
          for (const row of rows) note(collection, row.id, row.version);
          return toPage<T>(rows, next);
        },
      });
      if (writes.length === 0) return result;
      const guards = [...seen.values()].map((s) => db.prepare(GUARD).bind(s.collection, s.id, s.version));
      try {
        await db.batch([...guards, ...writes]);
        return result;
      } catch (error) {
        if (!String(error instanceof Error ? error.message : error).includes("malformed JSON")) throw error;
      }
    }
    throw new Error(`transaction kept conflicting after ${MAX_TRANSACTION_ATTEMPTS} attempts`);
  }
}

export interface R2Like {
  put(key: string, value: Uint8Array, options?: { httpMetadata?: { contentType?: string } }): Promise<unknown>;
  get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer>; httpMetadata?: { contentType?: string } } | null>;
  delete(key: string): Promise<unknown>;
}

const hex = (bytes: ArrayBuffer) => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");

async function hmacKey(secret: string, usage: "sign" | "verify") {
  return crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [usage]);
}

const signedText = (key: string, method: string, expires: string) => new TextEncoder().encode(`${method}\n${key}\n${expires}`);

export interface R2Options extends AdapterOptions {
  /** Where your Worker serves signed blob URLs. Call `verifySignedBlobUrl` there. */
  urlBase: string;
  /** At least 16 characters. There is no default. */
  urlSecret: string;
}

/**
 * An R2 bucket as `Blobs`. The R2 binding cannot make presigned URLs, so
 * `signedUrl` makes a URL that your Worker verifies and then serves from the bucket.
 */
export function createR2Blobs(bucket: R2Like, options: R2Options): Blobs {
  if (options.urlSecret.length < 16) throw new Error("urlSecret must be at least 16 characters");
  const now = options.now ?? Date.now;
  const need = (key: string) => {
    if (key === "") throw new Error("blob key must not be empty");
  };
  return {
    region: options.region ?? "eu",
    async put(key, data, opts) {
      need(key);
      await bucket.put(key, data, opts?.contentType ? { httpMetadata: { contentType: opts.contentType } } : undefined);
    },
    async get(key) {
      need(key);
      const object = await bucket.get(key);
      if (!object) return null;
      const contentType = object.httpMetadata?.contentType;
      return { data: new Uint8Array(await object.arrayBuffer()), ...(contentType ? { contentType } : {}) };
    },
    async delete(key) {
      need(key);
      await bucket.delete(key);
    },
    async signedUrl(key, { method, expiresInSeconds }) {
      need(key);
      if (!Number.isInteger(expiresInSeconds) || expiresInSeconds < 1 || expiresInSeconds > 604800) {
        throw new RangeError("expiresInSeconds must be an integer from 1 to 604800");
      }
      const expires = String(now() + expiresInSeconds * 1000);
      const sig = hex(await crypto.subtle.sign("HMAC", await hmacKey(options.urlSecret, "sign"), signedText(key, method, expires)));
      const url = new URL(options.urlBase);
      for (const [name, value] of Object.entries({ key, method, expires, sig })) url.searchParams.set(name, value);
      return url.toString();
    },
  };
}

/** Checks a URL made by `signedUrl`. Returns the key and method, or null for any problem. */
export async function verifySignedBlobUrl(
  url: string,
  options: { secret: string; now?: () => number },
): Promise<{ key: string; method: "GET" | "PUT" } | null> {
  try {
    const params = new URL(url).searchParams;
    const key = params.get("key");
    const method = params.get("method");
    const expires = params.get("expires");
    const sig = params.get("sig");
    if (!key || !expires || !sig || (method !== "GET" && method !== "PUT")) return null;
    if (!/^[0-9a-f]{64}$/.test(sig) || !(Number(expires) > (options.now ?? Date.now)())) return null;
    const bytes = Uint8Array.from(sig.match(/../g) as string[], (pair) => Number.parseInt(pair, 16));
    const valid = await crypto.subtle.verify("HMAC", await hmacKey(options.secret, "verify"), bytes, signedText(key, method, expires));
    return valid ? { key, method } : null;
  } catch {
    return null;
  }
}
