// Netlify Blobs adapters for the Store and Blobs ports. They use a small structural type for the
// Netlify Blobs `Store`, so this file imports nothing from Netlify. Pass in the result of
// `getStore(...)` from `@netlify/blobs`.
//
// Netlify Blobs is a key-value service. A write to one key can be conditional (`onlyIfNew`,
// `onlyIfMatch`), and that check is atomic. Nothing spans two keys.
//   - `Blobs` maps to it directly. One key holds the bytes, and the metadata holds the size and
//     content type. The ETag is the version.
//   - `Store` keeps one key per doc, named by the hash of its id, so a key never passes the 600 byte
//     limit. A transaction takes a lease lock on one key, runs, writes a journal of its writes,
//     applies them, and drops the journal. A holder that finds a journal from a crashed holder
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
  /** How long a holder owns the lock before another may take it. Defaults to 30000. */
  leaseMs?: number;
  /** How long a transaction waits for the lock before it throws `StoreConflictError`. Defaults to 35000, a little over `leaseMs`, so it outwaits a crashed holder. */
  waitMs?: number;
}

interface Lock {
  owner: string | null;
  expiresAt: number;
}

type JournalWrite = { collection: string; id: string; doc: Doc | null };

/**
 * A `Store` on one Netlify Blobs store. Give each `Store` its own Netlify store, since it
 * owns every key in it. Every write, in or out of a transaction, takes the lease lock, so
 * writes run one at a time. A `query` reads every doc of the collection, so use it for small
 * collections.
 */
export function createNetlifyStore(blobs: NetlifyStoreLike, options: NetlifyStoreOptions = {}): Store {
  const region = options.region === undefined ? "unknown" : parseRegion(options.region);
  const now = options.now ?? Date.now;
  const leaseMs = options.leaseMs ?? 30_000;
  const waitMs = options.waitMs ?? 35_000;
  for (const [name, value] of [["leaseMs", leaseMs], ["waitMs", waitMs]] as const) {
    if (!Number.isInteger(value) || value < 1) throw new RangeError(`${name} must be an integer of 1 or more`);
  }
  // `list` has no consistency option, so it uses the store's own. Refuse a store that says it is eventual.
  const own = (blobs as { client?: { consistency?: unknown } }).client?.consistency;
  if (own !== undefined && own !== "strong") throw new Error('make the Netlify store with getStore({ name, consistency: "strong" })');
  const strong = { consistency: "strong" } as const;
  const docKey = async (collection: string, id: string) => {
    assertCollection(collection);
    assertId(id);
    wellFormed(id, "an id");
    return `d/${collection}/${await sha256Hex(id)}`;
  };

  /** A key holds `{ id, doc }`, because the key holds only a hash of the id. */
  const readDoc = async (key: string): Promise<{ id: string; doc: Doc } | null> => {
    const text = (await blobs.get(key, { type: "text", ...strong })) as string | null;
    if (text === null) return null;
    const stored = JSON.parse(text) as { id?: unknown; doc?: unknown };
    const { id, doc } = stored;
    if (typeof id !== "string" || typeof doc !== "object" || doc === null || Array.isArray(doc)) throw new Error("a stored doc is not readable");
    // The key names the hash of the id. A value under another key is not this doc.
    if (key !== `${key.slice(0, key.lastIndexOf("/") + 1)}${await sha256Hex(id)}`) throw new Error("a stored doc is under the wrong key");
    return { id, doc: doc as Doc };
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

  const lockBody = (owner: string | null): string => JSON.stringify({ owner, expiresAt: owner === null ? 0 : now() + leaseMs } satisfies Lock);

  /** Takes the lease. Returns the ETag of the lock key. A lock that is not readable counts as held. */
  async function acquire(owner: string): Promise<string> {
    const deadline = Date.now() + waitMs;
    for (;;) {
      const current = await blobs.getWithMetadata("lock", { type: "text", ...strong });
      let won: { modified: boolean; etag?: string };
      if (current === null) {
        won = await blobs.set("lock", lockBody(owner), { onlyIfNew: true });
      } else {
        const held = parseLock(current.data);
        const free = held !== null && (held.owner === null || (Number.isFinite(held.expiresAt) && held.expiresAt <= now()));
        // An empty ETag would turn the next conditional write into an unconditional one.
        if (free && !current.etag) throw new Error("the lock has no ETag");
        won = free ? await blobs.set("lock", lockBody(owner), { onlyIfMatch: current.etag! }) : { modified: false };
      }
      if (won.modified) {
        if (!won.etag) throw new Error("the lock write returned no ETag");
        return won.etag;
      }
      if (Date.now() >= deadline) throw new StoreConflictError("could not get the store lock in time");
      await sleep(10 + Math.random() * 40);
    }
  }

  const parseLock = (text: unknown): Lock | null => {
    try {
      const lock = JSON.parse(String(text)) as Partial<Lock>;
      return typeof lock.expiresAt === "number" && (lock.owner === null || typeof lock.owner === "string") ? (lock as Lock) : null;
    } catch {
      return null;
    }
  };

  // Each write renews the lease first, with a check that the lock is still ours. A holder that stalled past
  // its lease finds the lock taken, and stops before it writes over a rival.
  async function applyWrites(writes: JournalWrite[], renew: () => Promise<void>): Promise<void> {
    for (const w of writes) {
      await renew();
      const key = await docKey(w.collection, w.id);
      if (w.doc === null) await blobs.delete(key);
      else await blobs.set(key, JSON.stringify({ id: w.id, doc: w.doc }));
    }
    await renew();
    await blobs.delete("journal");
  }

  /** Finishes the writes of a holder that stopped after it wrote the journal. */
  async function replayJournal(renew: () => Promise<void>): Promise<void> {
    const text = (await blobs.get("journal", { type: "text", ...strong })) as string | null;
    if (text === null) return;
    let writes: JournalWrite[];
    try {
      writes = (JSON.parse(text) as { writes: JournalWrite[] }).writes;
      for (const w of writes) {
        assertCollection(w.collection);
        assertId(w.id);
        wellFormed(w.id, "an id");
        if (w.doc !== null && (typeof w.doc !== "object" || Array.isArray(w.doc))) throw new Error();
      }
    } catch {
      throw new Error("the store journal is not readable");
    }
    await applyWrites(writes, renew);
  }

  // One transaction at a time per adapter object, so its own callers do not poll against each other.
  // A call that waits longer than `waitMs` for its turn (a write made inside a transaction does) gives up.
  let queue: Promise<unknown> = Promise.resolve();

  async function locked<R>(work: (renew: () => Promise<void>, replay: () => Promise<void>) => Promise<R>): Promise<R> {
    const previous = queue;
    let release!: () => void;
    queue = new Promise<void>((resolve) => (release = resolve));
    try {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          previous.catch(() => undefined),
          new Promise((_, reject) => (timer = setTimeout(() => reject(new StoreConflictError("waited too long for an earlier transaction")), waitMs))),
        ]);
      } finally {
        clearTimeout(timer);
      }
      const owner = crypto.randomUUID();
      let etag = await acquire(owner);
      const renew = async () => {
        // A write that conditions on the lock ETag fails when another holder took the lease.
        const renewed = await blobs.set("lock", lockBody(owner), { onlyIfMatch: etag });
        if (!renewed.modified || !renewed.etag) throw new StoreConflictError("the store lock was lost");
        etag = renewed.etag;
      };
      try {
        await replayJournal(renew);
        return await work(renew, () => replayJournal(renew));
      } finally {
        // Free the lock only if it is still ours. A lost lease makes this a no-op.
        await blobs.set("lock", lockBody(null), { onlyIfMatch: etag }).catch(() => undefined);
      }
    } finally {
      release();
    }
  }

  async function transaction<R>(fn: (tx: StoreOps) => Promise<R>): Promise<R> {
    return locked(async (renew, replay) => {
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
      if (writes.size > 0) {
        await renew();
        // The holder replayed on entry, so the journal is empty. A refused write means a rival is here.
        const journaled = await blobs.set("journal", JSON.stringify({ writes: [...writes.values()] }), { onlyIfNew: true }).catch((error: unknown) => {
          throw new NetlifyCommitUncertainError(error); // the request may have landed before it failed
        });
        if (!journaled.modified) throw new StoreConflictError("the store journal is held by another transaction");
        try {
          await applyWrites([...writes.values()], renew);
        } catch (error) {
          // Finish the journal now if we can, so no reader keeps seeing half of it. If that works, the
          // transaction did commit, and its caller gets the result. If not, the next holder finishes it.
          if (error instanceof StoreConflictError) throw new NetlifyCommitUncertainError(error);
          await replay().catch(() => {
            throw new NetlifyCommitUncertainError(error);
          });
        }
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
      const metadata: BlobMetadata = { size: data.length, ...(opts?.contentType ? { contentType: opts.contentType } : {}) };
      // Netlify keeps 2 KiB of metadata, as base64 of the UTF-8 JSON.
      if (new TextEncoder().encode(JSON.stringify(metadata)).length > 1000) throw new RangeError("the content type is too long");
      const condition = opts?.ifMatch !== undefined ? { onlyIfMatch: opts.ifMatch } : opts?.ifNoneMatch === "*" ? { onlyIfNew: true } : {};
      // Netlify checks the condition and writes in one step. `modified: false` means it did not hold.
      const written = await blobs.set(id, data.slice().buffer, { metadata: { ...metadata }, ...condition });
      if (!written.modified) return null;
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
