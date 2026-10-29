// Netlify Blobs adapters for the Store and Blobs ports. They use a small structural type for the
// Netlify Blobs `Store`, so this file imports nothing from Netlify. Pass in the result of
// `getStore(...)` from `@netlify/blobs`.
//
// Netlify Blobs is a key-value service. A write to one key can be conditional (`onlyIfNew`,
// `onlyIfMatch`), and that check is atomic. Nothing spans two keys.
//   - `Blobs` maps to it directly. One key holds the bytes, and the metadata holds the size and
//     content type. The ETag is the version.
//   - `Store` keeps one key per doc, named by the hash of its id, so a key never passes the 600 byte
//     limit. A transaction takes a lease lock on one key, runs, writes a journal of its writes into
//     the lock key (one conditional write checks the lease and stores the journal), applies them,
//     and clears the journal. A holder that finds a journal from a crashed holder
//     applies it first, so for the next lock holder a transaction lands whole or not at all.
//     A reader outside a transaction can see part of one while it applies.
// Every read call asks for `consistency: "strong"`, because the default is eventual. `list` takes no
// such option, so the Netlify store you pass to `createNetlifyStore` must be made with
// `getStore({ name, consistency: "strong" })`. The adapter refuses a store that says it is not.
import {
  StoreConflictError,
  assertBlobPutOptions,
  assertCollection,
  assertId,
  parseRegion,
  type AdapterOptions,
  type Blobs,
  type Doc,
  type Page,
  type Query,
  type Store,
  type StoreOps,
} from "../ports.js";
import { selectPage } from "./query.js";
import { assertSecret, signBlobUrl } from "./signedurl.js";

export { verifySignedBlobUrl } from "./signedurl.js";

/** The part of a Netlify Blobs `Store` that the adapters call. */
export interface NetlifyStoreLike {
  get(key: string, options: { type: "text" | "arrayBuffer"; consistency: "strong" }): Promise<any>;
  getWithMetadata(key: string, options: { type: "text" | "arrayBuffer"; consistency: "strong" }): Promise<{ data: any; etag?: string; metadata: Record<string, any> } | null>;
  getMetadata(key: string, options: { consistency: "strong" }): Promise<{ etag: string | undefined; metadata: Record<string, any> } | null>;
  set(key: string, data: string | ArrayBuffer, options?: { metadata?: Record<string, unknown>; onlyIfNew?: boolean; onlyIfMatch?: string }): Promise<{ modified: boolean; etag?: string }>;
  delete(key: string): Promise<void>;
  list(options: { prefix: string }): Promise<{ blobs: { key: string; etag: string }[] }>;
}

/**
 * The outcome of a transaction is not known: it failed after its journal was sent. It may still
 * commit, when the next transaction applies the journal. Do not run it again as if nothing happened.
 */
export class NetlifyCommitUncertainError extends Error {
  constructor(cause: unknown) {
    super("the transaction failed after it was journaled, and it may still commit", { cause });
    this.name = "NetlifyCommitUncertainError";
  }
}

export interface NetlifyOptions extends AdapterOptions {
  region: NonNullable<AdapterOptions["region"]>;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const sha256Hex = async (text: string) =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))].map((b) => b.toString(16).padStart(2, "0")).join("");
// A lone surrogate becomes U+FFFD in UTF-8, so two ids could share one hash. Refuse such a string.
const wellFormed = (text: string, what: string) => {
  if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text)) throw new Error(`${what} must be well-formed Unicode`);
};

export interface NetlifyStoreOptions extends AdapterOptions {
  /**
   * Must be `"strong"`, and must match how the Netlify store was made: `getStore({ name, consistency: "strong" })`.
   * `list` takes no per-call option, and a stale list can miss a doc that was just made.
   */
  consistency: "strong";
  /** How long a holder owns the lock before another may take it. Defaults to 30000. */
  leaseMs?: number;
  /** How long a transaction waits for the lock before it throws `StoreConflictError`. Defaults to 35000, a little over `leaseMs`, so it outwaits a crashed holder. */
  waitMs?: number;
}

interface Lock {
  owner: string | null;
  expiresAt: number;
  /** The journal of the holder: the writes of a transaction that is not yet applied. */
  writes?: JournalWrite[];
}

interface Held {
  write(writes: JournalWrite[] | undefined): Promise<void>;
  readonly pending: JournalWrite[] | undefined;
}

type JournalWrite = { collection: string; id: string; doc: Doc | null };

/**
 * A `Store` on one Netlify Blobs store. Give each `Store` its own Netlify store, since it
 * owns every key in it. Every write, in or out of a transaction, takes the lease lock, so
 * writes run one at a time. A `query` reads every doc of the collection, so use it for small
 * collections.
 */
export function createNetlifyStore(blobs: NetlifyStoreLike, options: NetlifyStoreOptions): Store {
  if (options?.consistency !== "strong") throw new Error('pass consistency: "strong", and make the Netlify store with getStore({ name, consistency: "strong" })');
  const region = options.region === undefined ? "unknown" : parseRegion(options.region);
  const now = options.now ?? Date.now;
  const leaseMs = options.leaseMs ?? 30_000;
  const waitMs = options.waitMs ?? 35_000;
  for (const [name, value] of [["leaseMs", leaseMs], ["waitMs", waitMs]] as const) {
    if (!Number.isInteger(value) || value < 1) throw new RangeError(`${name} must be an integer of 1 or more`);
  }
  // `list` has no consistency option, so it uses the store's own. Refuse a store that says it is eventual.
  // (A wrapper hides the field, which is why the option above is required too.)
  const own = (blobs as { client?: { consistency?: unknown } }).client?.consistency;
  if (own !== undefined && own !== "strong") throw new Error('make the Netlify store with getStore({ name, consistency: "strong" })');
  const strong = { consistency: "strong" } as const;
  const docKey = async (collection: string, id: string) => {
    assertCollection(collection);
    assertId(id);
    wellFormed(id, "an id");
    return `d/${collection}/${await sha256Hex(id)}`;
  };

  /** A key holds `{ id, doc }`, because the key holds only a hash of the id. Null for a missing doc and for a tombstone. */
  const readDoc = async (key: string): Promise<{ id: string; doc: Doc } | null> => {
    const text = (await blobs.get(key, { type: "text", ...strong })) as string | null;
    if (text === null) return null;
    const stored = JSON.parse(text) as { id?: unknown; doc?: unknown };
    const { id, doc } = stored;
    // A null doc is a tombstone: a delete is a conditional write of one, because Netlify has no conditional delete.
    if (typeof id !== "string" || typeof doc !== "object" || Array.isArray(doc)) throw new Error("a stored doc is not readable");
    // The key names the hash of the id. A value under another key is not this doc.
    if (key !== `${key.slice(0, key.lastIndexOf("/") + 1)}${await sha256Hex(id)}`) throw new Error("a stored doc is under the wrong key");
    return doc === null ? null : { id, doc: doc as Doc };
  };

  async function readAll(collection: string): Promise<{ id: string; doc: Doc }[]> {
    const prefix = `d/${collection}/`;
    const { blobs: listed } = await blobs.list({ prefix });
    const rows: { id: string; doc: Doc }[] = [];
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(8, listed.length) }, async () => {
        while (next < listed.length) {
          const { key } = listed[next++]!;
          const found = await readDoc(key);
          if (found) rows.push(found);
        }
      }),
    );
    return rows;
  }

  const reads = (): StoreOps => ({
    async get<T extends Doc>(collection: string, id: string) {
      return ((await readDoc(await docKey(collection, id)))?.doc ?? null) as T | null;
    },
    async query<T extends Doc>(collection: string, query: Query = {}): Promise<Page<T>> {
      assertCollection(collection);
      const { page, nextCursor } = selectPage(await readAll(collection), query);
      return { items: page.map((row) => ({ id: row.id, data: row.doc as T })), ...(nextCursor === undefined ? {} : { nextCursor }) };
    },
    async put() {
      throw new Error("use a transaction");
    },
    async delete() {
      throw new Error("use a transaction");
    },
  });

  const encodeLock = (owner: string | null, writes?: JournalWrite[]): string =>
    JSON.stringify({ owner, expiresAt: owner === null ? 0 : now() + leaseMs, ...(writes ? { writes } : {}) } satisfies Lock);

  /** Null for a lock that is not readable. A lock that is not readable counts as held. */
  const parseLock = (text: unknown): Lock | null => {
    try {
      const lock = JSON.parse(String(text)) as Partial<Lock>;
      if (typeof lock.expiresAt !== "number" || !Number.isFinite(lock.expiresAt) || (lock.owner !== null && typeof lock.owner !== "string")) return null;
      if (lock.writes !== undefined) {
        if (!Array.isArray(lock.writes)) return null;
        for (const w of lock.writes) {
          assertCollection(w.collection);
          assertId(w.id);
          wellFormed(w.id, "an id");
          if (w.doc !== null && (typeof w.doc !== "object" || Array.isArray(w.doc))) return null;
        }
      }
      return lock as Lock;
    } catch {
      return null;
    }
  };

  /**
   * Takes the lease. The lock key also holds the journal of the holder, so a write of the journal
   * and the check of the lease are one conditional write. Returns the ETag of the lock key, and the
   * journal of an earlier holder that must be applied. A write that landed but whose answer was
   * lost shows as `modified: false` (the client retries it and gets a 412), so a lock that names
   * us is ours.
   */
  async function acquire(owner: string, deadline: number): Promise<{ etag: string; pending?: JournalWrite[] }> {
    for (;;) {
      const current = await blobs.getWithMetadata("lock", { type: "text", ...strong });
      if (current === null) {
        const won = await blobs.set("lock", encodeLock(owner), { onlyIfNew: true });
        if (won.modified && won.etag) return { etag: won.etag };
        if (won.modified) throw new Error("the lock write returned no ETag");
      } else {
        const held = parseLock(current.data);
        if (held !== null && held.owner === owner) {
          if (!current.etag) throw new Error("the lock has no ETag");
          return { etag: current.etag, ...(held.writes ? { pending: held.writes } : {}) };
        }
        if (held !== null && (held.owner === null || held.expiresAt <= now())) {
          // An empty ETag would turn the conditional write into an unconditional one.
          if (!current.etag) throw new Error("the lock has no ETag");
          const won = await blobs.set("lock", encodeLock(owner, held.writes), { onlyIfMatch: current.etag });
          if (won.modified && won.etag) return { etag: won.etag, ...(held.writes ? { pending: held.writes } : {}) };
          if (won.modified) throw new Error("the lock write returned no ETag");
        }
      }
      if (Date.now() >= deadline) throw new StoreConflictError("could not get the store lock in time");
      await sleep(10 + Math.random() * 40);
    }
  }

  // One transaction at a time per adapter object, so its own callers do not poll against each other. After a
  // timeout the order is not kept, and the lock key still keeps the transactions apart.
  // A call that has waited `waitMs` in all, for its turn and for the lock, gives up. A write made inside a
  // transaction waits for its own transaction, so it gives up.
  let queue: Promise<unknown> = Promise.resolve();

  async function locked<R>(work: (held: Held) => Promise<R>): Promise<R> {
    const deadline = Date.now() + waitMs;
    const previous = queue;
    let release!: () => void;
    queue = new Promise<void>((resolve) => (release = resolve));
    try {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          previous.catch(() => undefined),
          new Promise((_, reject) => (timer = setTimeout(() => reject(new StoreConflictError("waited too long for an earlier transaction")), Math.max(0, deadline - Date.now())))),
        ]);
      } finally {
        clearTimeout(timer);
      }
      const owner = crypto.randomUUID();
      const taken = await acquire(owner, deadline);
      let etag = taken.etag;
      let pending = taken.pending;
      const held: Held = {
        /** Writes the lock key with the given journal. It fails unless the lock is still ours. */
        async write(writes) {
          const done = await blobs.set("lock", encodeLock(owner, writes), { onlyIfMatch: etag });
          if (done.modified && done.etag) {
            etag = done.etag;
            pending = writes;
            return;
          }
          // Our write may have landed, and a retry of it was refused. Look at the lock.
          const now = await blobs.getWithMetadata("lock", { type: "text", ...strong });
          const lock = now === null ? null : parseLock(now.data);
          if (now?.etag && lock !== null && lock.owner === owner && (lock.writes === undefined) === (writes === undefined)) {
            etag = now.etag;
            pending = lock.writes;
            return;
          }
          throw new StoreConflictError("the store lock was lost");
        },
        get pending() {
          return pending;
        },
      };
      try {
        if (pending) await applyWrites(pending, held);
        return await work(held);
      } finally {
        // Free the lock only if it is still ours, and keep a journal that is not done. A lost lease makes this a no-op.
        await blobs.set("lock", encodeLock(null, pending), { onlyIfMatch: etag }).catch(() => undefined);
      }
    } finally {
      release();
    }
  }

  /**
   * Applies a journal. A doc write is conditional on the ETag that was read before the lease was renewed,
   * so a write that is delayed past the lease (the client retries for a long time) cannot land over a
   * rival's commit: the rival changed the ETag, and Netlify refuses the write. A delete writes a tombstone,
   * since Netlify has no conditional delete.
   */
  async function applyWrites(writes: JournalWrite[], held: Held): Promise<void> {
    for (const w of writes) {
      const key = await docKey(w.collection, w.id);
      const before = await blobs.getMetadata(key, strong); // read first, then renew: see above
      if (before !== null && !before.etag) throw new Error("a stored doc has no ETag");
      await held.write(writes);
      const body = JSON.stringify({ id: w.id, doc: w.doc });
      const done = await blobs.set(key, body, before === null ? { onlyIfNew: true } : { onlyIfMatch: before.etag! });
      if (done.modified) continue;
      // A refusal is a rival's write, unless our own write landed and the client's retry was refused.
      if ((await blobs.get(key, { type: "text", ...strong })) !== body) throw new StoreConflictError("the store lock was lost");
    }
    await held.write(undefined);
  }

  async function transaction<R>(fn: (tx: StoreOps) => Promise<R>): Promise<R> {
    return locked(async (held) => {
      const writes = new Map<string, JournalWrite>();
      const noReadAfterWrite = () => {
        if (writes.size > 0) throw new Error("a transaction must read before it writes");
      };
      const read = reads();
      const stage = async (collection: string, id: string, doc: Doc | null) => {
        await docKey(collection, id); // checks the names before anything is written
        writes.set(`${collection}/${id}`, { collection, id, doc: doc === null ? null : (JSON.parse(JSON.stringify(doc)) as Doc) });
      };
      const tx: StoreOps = {
        get: (collection, id) => (noReadAfterWrite(), read.get(collection, id)),
        query: (collection, q) => (noReadAfterWrite(), read.query(collection, q)),
        put: (collection, id, doc) => stage(collection, id, doc),
        delete: (collection, id) => stage(collection, id, null),
      };
      const result = await fn(tx);
      const list = [...writes.values()];
      if (list.length === 0) {
        await held.write(held.pending); // the lease must have held while fn read
        return result;
      }
      // One conditional write checks the lease and stores the journal. If it fails with an error that is
      // not a refusal, it may have landed.
      await held.write(list).catch((error: unknown) => {
        if (error instanceof StoreConflictError) throw error;
        throw new NetlifyCommitUncertainError(error);
      });
      try {
        await applyWrites(list, held);
      } catch (error) {
        // Finish the journal now if we can, so no reader keeps seeing half of it. If that works, the
        // transaction did commit, and its caller gets the result. If not, the next holder finishes it.
        if (error instanceof StoreConflictError) throw new NetlifyCommitUncertainError(error);
        await applyWrites(list, held).catch(() => {
          throw new NetlifyCommitUncertainError(error);
        });
      }
      return result;
    });
  }

  const single = (collection: string, id: string, doc: Doc | null) =>
    transaction(async (tx) => (doc === null ? tx.delete(collection, id) : tx.put(collection, id, doc)));

  return {
    region,
    get: reads().get,
    query: reads().query,
    put: (collection, id, doc) => single(collection, id, doc),
    delete: (collection, id) => single(collection, id, null),
    transaction,
  };
}

export interface NetlifyBlobsOptions extends NetlifyOptions {
  /** Where your function serves signed blob URLs. Call `verifySignedBlobUrl` there. */
  urlBase: string;
  /** At least 32 bytes. There is no default. Use one secret per Netlify store. */
  urlSecret: string;
}

/** The metadata of a blob. Netlify keeps up to 2 KiB of it. */
interface BlobMetadata {
  size: number;
  contentType?: string;
  /** A random id of the write. A put that was retried by the client can tell its own write from a rival's. */
  write?: string;
}

function metadataOf(raw: Record<string, any>): BlobMetadata {
  const { size, contentType } = raw;
  if (!Number.isInteger(size) || size < 0 || (contentType !== undefined && typeof contentType !== "string")) throw new Error("a blob has bad metadata");
  return { size, ...(contentType ? { contentType } : {}) };
}

/** `Blobs` on a Netlify Blobs store. A key maps to one entry, and the ETag is the version. */
export function createNetlifyBlobs(blobs: NetlifyStoreLike, options: NetlifyBlobsOptions): Blobs {
  const region = parseRegion(options.region);
  assertSecret(options.urlSecret);
  const now = options.now ?? Date.now;
  const strong = { consistency: "strong" } as const;
  // The key is hashed, so any key is a valid Netlify key and the key length has no limit.
  const entry = async (key: string) => {
    if (key === "") throw new Error("blob key must not be empty");
    wellFormed(key, "a blob key");
    return `b/${await sha256Hex(key)}`;
  };
  return {
    region,
    async put(key, data, opts) {
      const id = await entry(key);
      assertBlobPutOptions(opts);
      const write = crypto.randomUUID();
      const metadata: BlobMetadata = { size: data.length, ...(opts?.contentType ? { contentType: opts.contentType } : {}), write };
      // Netlify keeps 2 KiB of metadata, as base64 of the UTF-8 JSON.
      if (new TextEncoder().encode(JSON.stringify(metadata)).length > 1000) throw new RangeError("the content type is too long");
      const condition = opts?.ifMatch !== undefined ? { onlyIfMatch: opts.ifMatch } : opts?.ifNoneMatch === "*" ? { onlyIfNew: true } : {};
      // Netlify checks the condition and writes in one step. `modified: false` means it did not hold.
      const written = await blobs.set(id, data.slice().buffer, { metadata: { ...metadata }, ...condition });
      if (!written.modified) {
        // The client retries a request that failed. If the first try landed, the retry got a 412 and
        // `modified: false` came back. Our write id in the metadata shows that it landed.
        const found = await blobs.getMetadata(id, strong);
        if (found?.etag && found.metadata.write === write) return { version: found.etag };
        return null;
      }
      if (!written.etag) throw new Error("the blob write returned no ETag");
      return { version: written.etag };
    },
    async get(key) {
      const found = await blobs.getWithMetadata(await entry(key), { type: "arrayBuffer", ...strong });
      if (!found) return null;
      if (!found.etag) throw new Error("a blob has no ETag");
      const { contentType } = metadataOf(found.metadata);
      return { data: new Uint8Array(found.data as ArrayBuffer), version: found.etag, ...(contentType ? { contentType } : {}) };
    },
    async head(key) {
      const found = await blobs.getMetadata(await entry(key), strong);
      if (!found) return null;
      if (!found.etag) throw new Error("a blob has no ETag");
      const { size, contentType } = metadataOf(found.metadata);
      return { size, version: found.etag, ...(contentType ? { contentType } : {}) };
    },
    async delete(key) {
      await blobs.delete(await entry(key));
    },
    signedUrl: (key, opts) => signBlobUrl(key, opts, { urlBase: options.urlBase, urlSecret: options.urlSecret, now }),
  };
}
