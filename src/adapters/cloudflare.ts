// Cloudflare adapters. They use small structural types, so this file imports
// nothing from Cloudflare. Pass in a D1 or R2 binding.
//
// Residency is fixed when you create the resource, so `region` here is a claim:
// it declares where the resource lives, and it has no default. D1 also reports
// the region that served a query, and the store refuses one that disagrees.
// Create the resources in the EU:
//   wrangler d1 create <name> --location weur        (or eeur)
//   wrangler r2 bucket create <name> --jurisdiction eu
import {
  DEFAULT_LIMIT,
  assertCollection,
  assertField,
  assertId,
  parseRegion,
  type AdapterOptions,
  type Blobs,
  type Doc,
  type Page,
  type Query,
  type Region,
  type Scalar,
  type Store,
  type StoreOps,
  StoreConflictError,
  assertBlobPutOptions,
  assertResponseHeaders,
} from "../ports.js";

export interface D1Statement {
  bind(...values: unknown[]): D1Statement;
  first<T>(): Promise<T | null>;
  all<T>(): Promise<{ results: T[]; meta?: { served_by_region?: string } }>;
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

// Every write takes a new random version, below 2^53 so JavaScript reads it exactly.
// A counter would restart when a doc is deleted and made again, and a stale
// transaction would then pass its check. Zero means "missing".
const NEW_VERSION = "1 + abs(random() % 9007199254740990)";

const UPSERT =
  `INSERT INTO store_docs (collection, id, body, version) VALUES (?, ?, ?, ${NEW_VERSION}) ON CONFLICT (collection, id) DO UPDATE SET body = excluded.body, version = ${NEW_VERSION}`;

// Fails the whole batch with "malformed JSON" when the doc changed since it was read.
const GUARD =
  "SELECT CASE WHEN COALESCE((SELECT version FROM store_docs WHERE collection = ? AND id = ?), 0) = ? THEN 1 ELSE json('!') END";

const toBase64Url = (value: unknown) => {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = "";
  // Spreading a long array into one call overflows the stack.
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
};

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

function jsonPath(field: string): string {
  assertField(field);
  return `$.${field}`;
}

// The D1 codes of each declared region. Anything else is outside it, and so is a missing code.
const SERVED_IN: Record<"eu" | "us", string[]> = { eu: ["WEUR", "EEUR"], us: ["WNAM", "ENAM"] };

function assertServedIn(region: Region, served: unknown): void {
  if (region === "unknown") return;
  if (served === undefined) throw new Error(`the database did not report where it served a query, so region "${region}" is not confirmed`);
  if (typeof served !== "string" || !SERVED_IN[region].includes(served.toUpperCase())) {
    throw new Error(`the database served a query from outside the declared region "${region}"`);
  }
}

// A match on both the JSON type and the value, so true never equals 1.
function equals(field: string, value: Scalar): { sql: string; params: unknown[] } {
  const path = jsonPath(field);
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

async function runQuery(db: D1Like, region: Region, collection: string, query: Query): Promise<{ rows: Row[]; next?: string }> {
  assertCollection(collection);
  const limit = query.limit ?? DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1) throw new RangeError("limit must be an integer of 1 or more");
  const field = query.orderBy?.field;
  const path = field === undefined ? undefined : jsonPath(field);
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
  const { results, meta } = await db
    .prepare(sql)
    .bind(...valueParams, ...params, limit + 1)
    .all<Row>();
  assertServedIn(region, meta?.served_by_region);
  const page = results.slice(0, limit);
  const last = page[page.length - 1];
  return { rows: page, next: results.length > limit && last ? toBase64Url([last.v, last.id]) : undefined };
}

const toPage = <T extends Doc>(rows: Row[], next?: string): Page<T> => ({
  items: rows.map((row) => ({ id: row.id, data: JSON.parse(row.body) as T })),
  ...(next === undefined ? {} : { nextCursor: next }),
});

export function createD1Store(db: D1Like, options: AdapterOptions & { region: Region }): Store {
  const region = parseRegion(options.region);
  const readRow = async (collection: string, id: string) => {
    assertCollection(collection);
    assertId(id);
    const { results, meta } = await db.prepare("SELECT body, version FROM store_docs WHERE collection = ? AND id = ? LIMIT 1").bind(collection, id).all<Row>();
    assertServedIn(region, meta?.served_by_region);
    return results[0] ?? null;
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
    region,
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
      const { rows, next } = await runQuery(db, region, collection, query);
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
      // Keep the first version seen. A later read of a changed doc must not hide the change.
      const note = (collection: string, id: string, version: number) => {
        if (!seen.has(`${collection}/${id}`)) seen.set(`${collection}/${id}`, { collection, id, version });
      };
      const readFirst = () => {
        if (writes.length > 0) throw new Error("a transaction must read before it writes");
      };
      const result = await fn({
        async get<T extends Doc>(collection: string, id: string) {
          readFirst();
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
          readFirst();
          const { rows, next } = await runQuery(db, region, collection, query);
          for (const row of rows) note(collection, row.id, row.version);
          return toPage<T>(rows, next);
        },
      });
      // A read-only transaction still checks its reads, so it sees one moment.
      if (seen.size === 0 && writes.length === 0) return result;
      const guards = [...seen.values()].map((s) => db.prepare(GUARD).bind(s.collection, s.id, s.version));
      try {
        await db.batch([...guards, ...writes]);
        return result;
      } catch (error) {
        if (!String(error instanceof Error ? error.message : error).includes("malformed JSON")) throw error;
      }
    }
    throw new StoreConflictError(`transaction kept conflicting after ${MAX_TRANSACTION_ATTEMPTS} attempts`);
  }
}

export interface R2ObjectLike {
  etag: string;
  size: number;
  httpMetadata?: { contentType?: string };
}

export interface R2Like {
  /** Returns null when `onlyIf` did not hold. */
  put(
    key: string,
    value: Uint8Array,
    options?: { httpMetadata?: { contentType?: string }; onlyIf?: { etagMatches?: string; etagDoesNotMatch?: string } },
  ): Promise<{ etag: string } | null>;
  get(key: string): Promise<(R2ObjectLike & { arrayBuffer(): Promise<ArrayBuffer> }) | null>;
  head(key: string): Promise<R2ObjectLike | null>;
  delete(key: string): Promise<unknown>;
}

const hex = (bytes: ArrayBuffer) => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");

async function hmacKey(secret: string, usage: "sign" | "verify") {
  return crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [usage]);
}

function assertSecret(secret: unknown): void {
  if (typeof secret !== "string" || new TextEncoder().encode(secret).length < 32) throw new Error("the URL secret must be a string of at least 32 bytes");
}

// A JSON list reads one way, so no two tuples share a signed text.
const signedText = (key: string, method: string, expires: string, disposition: string | null, type: string | null) =>
  new TextEncoder().encode(JSON.stringify([method, key, expires, disposition, type]));

export interface R2Options extends AdapterOptions {
  region: Region;
  /** Where your Worker serves signed blob URLs. Call `verifySignedBlobUrl` there. */
  urlBase: string;
  /** At least 32 bytes. There is no default. Use one secret per bucket. */
  urlSecret: string;
}

/**
 * An R2 bucket as `Blobs`. The R2 binding cannot make presigned URLs, so
 * `signedUrl` makes a URL that your Worker verifies and then serves from the bucket.
 */
export function createR2Blobs(bucket: R2Like, options: R2Options): Blobs {
  const region = parseRegion(options.region);
  assertSecret(options.urlSecret);
  const now = options.now ?? Date.now;
  const need = (key: string) => {
    if (key === "") throw new Error("blob key must not be empty");
  };
  return {
    region,
    async put(key, data, opts) {
      need(key);
      assertBlobPutOptions(opts);
      // The bucket checks the condition and writes in one step. A null means it did not hold.
      const onlyIf = opts?.ifMatch !== undefined ? { etagMatches: opts.ifMatch } : opts?.ifNoneMatch === "*" ? { etagDoesNotMatch: "*" } : undefined;
      const metadata = opts?.contentType ? { httpMetadata: { contentType: opts.contentType } } : {};
      const stored = await bucket.put(key, data, onlyIf || opts?.contentType ? { ...metadata, ...(onlyIf ? { onlyIf } : {}) } : undefined);
      return stored ? { version: stored.etag } : null;
    },
    async get(key) {
      need(key);
      const object = await bucket.get(key);
      if (!object) return null;
      const contentType = object.httpMetadata?.contentType;
      return { data: new Uint8Array(await object.arrayBuffer()), version: object.etag, ...(contentType ? { contentType } : {}) };
    },
    async head(key) {
      need(key);
      const object = await bucket.head(key);
      const contentType = object?.httpMetadata?.contentType;
      return object ? { size: object.size, version: object.etag, ...(contentType ? { contentType } : {}) } : null;
    },
    async delete(key) {
      need(key);
      await bucket.delete(key);
    },
    async signedUrl(key, opts) {
      need(key);
      const { method, expiresInSeconds } = opts;
      if (!Number.isInteger(expiresInSeconds) || expiresInSeconds < 1 || expiresInSeconds > 604800) {
        throw new RangeError("expiresInSeconds must be an integer from 1 to 604800");
      }
      assertResponseHeaders(opts);
      const [disposition, type] = [opts.responseContentDisposition ?? null, opts.responseContentType ?? null];
      const expires = String(now() + expiresInSeconds * 1000);
      const sig = hex(await crypto.subtle.sign("HMAC", await hmacKey(options.urlSecret, "sign"), signedText(key, method, expires, disposition, type)));
      const url = new URL(options.urlBase);
      for (const [name, value] of Object.entries({ key, method, expires, sig })) url.searchParams.set(name, value);
      if (disposition !== null) url.searchParams.set("disposition", disposition);
      if (type !== null) url.searchParams.set("type", type);
      return url.toString();
    },
  };
}

/** Checks a URL made by `signedUrl`. Returns the key, the method, and any signed response headers, or null for any problem. */
export async function verifySignedBlobUrl(
  url: string,
  options: { secret: string; now?: () => number },
): Promise<{ key: string; method: "GET" | "PUT"; responseContentDisposition?: string; responseContentType?: string } | null> {
  // A missing secret is a setup error. Throw, so it is never a quiet "invalid URL".
  assertSecret(options.secret);
  try {
    const params = new URL(url).searchParams;
    const key = params.get("key");
    const method = params.get("method");
    const expires = params.get("expires");
    const sig = params.get("sig");
    if (!key || !expires || !sig || (method !== "GET" && method !== "PUT")) return null;
    if (!/^[0-9a-f]{64}$/.test(sig) || !/^\d{1,16}$/.test(expires) || !(Number(expires) > (options.now ?? Date.now)())) return null;
    const bytes = Uint8Array.from(sig.match(/../g) as string[], (pair) => Number.parseInt(pair, 16));
    const [disposition, type] = [params.get("disposition"), params.get("type")];
    assertResponseHeaders({ method, ...(disposition === null ? {} : { responseContentDisposition: disposition }), ...(type === null ? {} : { responseContentType: type }) });
    const valid = await crypto.subtle.verify("HMAC", await hmacKey(options.secret, "verify"), bytes, signedText(key, method, expires, disposition, type));
    return valid ? { key, method, ...(disposition === null ? {} : { responseContentDisposition: disposition }), ...(type === null ? {} : { responseContentType: type }) } : null;
  } catch {
    return null;
  }
}
