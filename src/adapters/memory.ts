// In-memory adapters for tests and local development. Data is lost on exit.
import type { PrincipalContext } from "../core/principals.js";
import {
  QUEUE_MAX_ATTEMPTS,
  StoreConflictError,
  assertBlobPutOptions,
  assertCollection,
  assertResponseHeaders,
  assertId,
  assertMailMessage,
  assertTopic,
  parseRegion,
  type AdapterOptions,
  type Auth,
  type BlobObject,
  type Blobs,
  type Doc,
  type Json,
  type Mail,
  type MailMessage,
  type Page,
  type Query,
  type Queue,
  type QueueHandler,
  type Store,
  type StoreOps,
} from "../ports.js";
import { selectPage } from "./query.js";

interface Backend {
  tables: Map<string, Map<string, { doc: Doc; version: number }>>;
  /** Every write takes the next number, so a doc that is deleted and made again never repeats a version. */
  clock: number;
}

const backends = new Map<string, Backend>();
const newBackend = (): Backend => ({ tables: new Map(), clock: 0 });
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

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
      const found = b.tables.get(collection) ?? new Map<string, { doc: Doc; version: number }>();
      const { page, nextCursor } = selectPage([...found].map(([id, entry]) => ({ id, doc: entry.doc })), query);
      for (const row of page) see(collection, row.id, found.get(row.id)!.version);
      return { items: page.map((row) => ({ id: row.id, data: copy(row.doc as T) })), ...(nextCursor === undefined ? {} : { nextCursor }) };
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
      throw new StoreConflictError();
    },
  };
}

interface BlobBackend {
  objects: Map<string, { data: Uint8Array; contentType?: string; version: string }>;
  /** Every write takes the next number, so a version never repeats on a key that is deleted and made again. */
  clock: number;
}
const blobBackends = new Map<string, BlobBackend>();

/** Blobs made with the same `shared` name use one dataset. A check and its write run with no await between them. */
export function createMemoryBlobs(options: AdapterOptions & { shared?: string } = {}): Blobs {
  const backend: BlobBackend =
    options.shared === undefined
      ? { objects: new Map(), clock: 0 }
      : (blobBackends.get(options.shared) ?? blobBackends.set(options.shared, { objects: new Map(), clock: 0 }).get(options.shared)!);
  const now = options.now ?? Date.now;
  const need = (key: string) => {
    if (key === "") throw new Error("blob key must not be empty");
  };
  return {
    region: options.region === undefined ? "unknown" : parseRegion(options.region),
    async put(key, data, opts) {
      need(key);
      assertBlobPutOptions(opts);
      const current = backend.objects.get(key);
      if ((opts?.ifNoneMatch === "*" && current) || (opts?.ifMatch !== undefined && current?.version !== opts.ifMatch)) return null;
      const version = String(++backend.clock);
      backend.objects.set(key, { data: data.slice(), version, ...(opts?.contentType ? { contentType: opts.contentType } : {}) });
      return { version };
    },
    async get(key) {
      need(key);
      const found = backend.objects.get(key);
      return found ? { ...found, data: found.data.slice() } : null;
    },
    async head(key) {
      need(key);
      const found = backend.objects.get(key);
      return found ? { size: found.data.length, version: found.version, ...(found.contentType ? { contentType: found.contentType } : {}) } : null;
    },
    async delete(key) {
      need(key);
      backend.objects.delete(key);
    },
    async signedUrl(key, opts) {
      need(key);
      const { method, expiresInSeconds } = opts;
      if (!Number.isInteger(expiresInSeconds) || expiresInSeconds < 1 || expiresInSeconds > 604800) {
        throw new RangeError("expiresInSeconds must be an integer from 1 to 604800");
      }
      assertResponseHeaders(opts);
      const extra = [
        opts.responseContentDisposition === undefined ? "" : `&disposition=${encodeURIComponent(opts.responseContentDisposition)}`,
        opts.responseContentType === undefined ? "" : `&type=${encodeURIComponent(opts.responseContentType)}`,
      ].join("");
      return `memory://blobs/${encodeURIComponent(key)}?method=${method}&expires=${now() + expiresInSeconds * 1000}${extra}`;
    },
  };
}

/** Credentials live in memory. Use the store-backed adapter for real sign-in. */
export function createMemoryAuth(options: AdapterOptions = {}) {
  const now = options.now ?? Date.now;
  const grants = new Map<string, { context: PrincipalContext; expiresAt?: number }>();
  const auth: Auth = {
    async authenticate(request) {
      const match = /^Bearer ([A-Za-z0-9_-]{1,512})$/.exec(request.headers.get("authorization") ?? "");
      const found = match ? grants.get(match[1]!) : undefined;
      return found && (found.expiresAt === undefined || found.expiresAt > now()) ? copy(found.context) : null;
    },
  };
  return {
    auth,
    async issue(context: PrincipalContext, opts: { expiresAt?: number } = {}) {
      const token = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
      grants.set(token, { context: copy(context), ...(opts.expiresAt === undefined ? {} : { expiresAt: opts.expiresAt }) });
      return token;
    },
    async revoke(credential: string) {
      grants.delete(credential);
    },
  };
}

export function createMemoryMail(options: AdapterOptions = {}): Mail & { outbox(): MailMessage[] } {
  const sent: MailMessage[] = [];
  return {
    region: options.region === undefined ? "unknown" : parseRegion(options.region),
    async send(message) {
      assertMailMessage(message);
      sent.push(copy(message));
      return { id: crypto.randomUUID() };
    },
    outbox: () => copy(sent),
  };
}

interface Pending {
  topic: string;
  body: Json;
  due: number;
  seq: number;
  attempt: number;
}

/** Messages wait in memory until `run()` delivers them. Nothing delivers by itself. */
export function createMemoryQueue(options: AdapterOptions = {}): Queue & { run(): Promise<void>; dead(topic: string): Json[] } {
  const now = options.now ?? Date.now;
  const handlers = new Map<string, QueueHandler>();
  const parked = new Map<string, Json[]>();
  let pending: Pending[] = [];
  let seq = 0;
  return {
    region: options.region === undefined ? "unknown" : parseRegion(options.region),
    async send(topic, body, opts = {}) {
      assertTopic(topic);
      const delay = opts.delaySeconds ?? 0;
      if (!Number.isInteger(delay) || delay < 0 || delay > 86_400) throw new RangeError("delaySeconds must be an integer from 0 to 86400");
      pending.push({ topic, body: copy(body), due: now() + delay * 1000, seq: seq++, attempt: 1 });
    },
    consume(topic, handler) {
      assertTopic(topic);
      if (handlers.has(topic)) throw new Error(`topic "${topic}" already has a handler`);
      handlers.set(topic, handler);
    },
    async run() {
      for (;;) {
        const due = pending.filter((m) => m.due <= now() && handlers.has(m.topic)).sort((a, b) => a.due - b.due || a.seq - b.seq)[0];
        if (!due) return;
        pending = pending.filter((m) => m !== due);
        try {
          await handlers.get(due.topic)!(copy(due.body), { attempt: due.attempt });
        } catch {
          if (due.attempt >= QUEUE_MAX_ATTEMPTS) parked.set(due.topic, [...(parked.get(due.topic) ?? []), due.body]);
          else pending.push({ ...due, attempt: due.attempt + 1 });
        }
      }
    },
    dead: (topic) => copy(parked.get(topic) ?? []),
  };
}
