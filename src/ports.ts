// The backend ports. App code talks to these and never to a vendor API.
// Every adapter must pass the contract suites in `agentic-identity/testing`.
import type { PrincipalContext } from "./core/principals.js";

/**
 * Where an adapter keeps data. It is a claim the operator makes, unless the
 * adapter can observe it. `"unknown"` is the default, and no policy accepts it.
 */
export const REGIONS = ["eu", "us", "unknown"] as const;
export type Region = (typeof REGIONS)[number];

export function parseRegion(value: unknown): Region {
  if (!REGIONS.includes(value as Region)) throw new Error(`invalid region "${String(value)}"`);
  return value as Region;
}

export interface AdapterOptions {
  region?: Region;
  /** Clock in epoch milliseconds. Tests set it. Adapters default to `Date.now`. */
  now?: () => number;
}

export function assertRegion(allowed: Region | "any", ...adapters: { region: Region }[]): void {
  for (const adapter of adapters) {
    if (allowed !== "any" && adapter.region !== allowed) {
      throw new Error(`adapter region "${adapter.region}" is outside allowed region "${allowed}"`);
    }
  }
}

export type Scalar = string | number | boolean | null;
export type Json = Scalar | Json[] | { [key: string]: Json };
export type Doc = { [key: string]: Json };

export interface Entry<T extends Doc = Doc> {
  id: string;
  data: T;
}

export interface Query {
  /** Top-level fields that must equal the value. All must match. Names are letters, digits, and `_`. */
  where?: Record<string, Scalar>;
  /**
   * Sort by one field. A doc without the field (or with null) is left out.
   * Ties sort by id. Keep one scalar type in the field: the order of mixed
   * types differs between adapters. A Firestore adapter needs `field != null`
   * for the null rule, and each equality filter needs its own composite index.
   */
  orderBy?: { field: string; direction?: "asc" | "desc" };
  /** 1 or more. Defaults to `DEFAULT_LIMIT`. */
  limit?: number;
  /** The `nextCursor` of the previous page. Use it with the same query. */
  cursor?: string;
}

export interface Page<T extends Doc = Doc> {
  items: Entry<T>[];
  /** Set only when more items exist. */
  nextCursor?: string;
}

export const DEFAULT_LIMIT = 100;

/**
 * A transaction kept conflicting with other writers, so it gave up. Nothing was written. Try
 * again later. An optimistic backend (memory, D1) throws it. A pessimistic backend (Firestore
 * server SDKs) holds a rival write until the transaction ends, so it may never throw it. An
 * adapter for such a backend maps an ABORTED result after its last retry to this error.
 */
export class StoreConflictError extends Error {
  constructor(message = "the data changed during the transaction") {
    super(message);
    this.name = "StoreConflictError";
  }
}

export interface StoreOps {
  get<T extends Doc = Doc>(collection: string, id: string): Promise<T | null>;
  /** Replaces the whole doc. Docs must be plain JSON. */
  put<T extends Doc = Doc>(collection: string, id: string, doc: T): Promise<void>;
  /** Deleting a missing doc is not an error. */
  delete(collection: string, id: string): Promise<void>;
  query<T extends Doc = Doc>(collection: string, query?: Query): Promise<Page<T>>;
}

export interface Store extends StoreOps {
  readonly region: Region;
  /**
   * All writes in `fn` apply together, or none do when `fn` throws. `fn` runs
   * again when a doc it read changed, so keep it free of side effects. Use
   * `tx`, never the store, inside `fn`.
   *
   * Every read must come before the first write. A `get` or `query` after a
   * `put` or `delete` throws. This is the Firestore rule. It is the only rule
   * that every adapter can follow, so an app behaves the same on all of them.
   *
   * When a write from another store races the transaction, there are two correct endings.
   * The transaction runs again, or throws `StoreConflictError` and writes nothing (optimistic).
   * Or the rival write waits for the lock and lands after the commit (pessimistic). A run that
   * a landed write overtook never commits, so no update is lost.
   *
   * A `query` guards only the docs it returned. To keep a value unique, use it
   * as the doc id, and do not check for a match with a query.
   */
  transaction<R>(fn: (tx: StoreOps) => Promise<R>): Promise<R>;
}

export function assertCollection(name: string): void {
  if (!/^[a-z][a-z0-9_]{0,63}$/.test(name)) throw new Error(`invalid collection name "${name}"`);
}

export function assertId(id: string): void {
  // Firestore also refuses ".", "..", and ids like "__name__".
  if (id.length === 0 || id.length > 256 || id.includes("/") || id === "." || id === ".." || /^__.*__$/.test(id)) {
    throw new Error(`invalid id "${id}"`);
  }
}

export function assertField(name: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`invalid field name "${name}"`);
}

export interface BlobObject {
  data: Uint8Array;
  contentType?: string;
  /** See `Blobs.put`. */
  version: string;
}

export interface BlobHead {
  size: number;
  contentType?: string;
  version: string;
}

export interface BlobPutOptions {
  contentType?: string;
  /** Write only when the key holds this version. A missing key never matches. */
  ifMatch?: string;
  /** `"*"` writes only when the key is absent. */
  ifNoneMatch?: "*";
}

/** Letters, digits, and `!#$&^_.+-`, as a header would carry them. A type has one slash. */
const MEDIA_TYPE = /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*(;[ -~]*)?$/;
const DISPOSITION = /^(attachment|inline)(;[ -~]*)?$/i;

export function assertBlobPutOptions(options: BlobPutOptions | undefined): void {
  if (options === undefined) return;
  const { ifMatch, ifNoneMatch } = options;
  if (ifMatch !== undefined && (typeof ifMatch !== "string" || ifMatch === "")) throw new Error("ifMatch must be a version");
  if (ifNoneMatch !== undefined && ifNoneMatch !== "*") throw new Error('ifNoneMatch must be "*"');
  if (ifMatch !== undefined && ifNoneMatch !== undefined) throw new Error("give ifMatch or ifNoneMatch, not both");
}

/** The response headers a download URL may fix. Printable ASCII only, so a value cannot split a response. */
export function assertResponseHeaders(options: { method: string; responseContentDisposition?: unknown; responseContentType?: unknown }): void {
  const { responseContentDisposition: disposition, responseContentType: type } = options;
  if (disposition === undefined && type === undefined) return;
  if (options.method !== "GET") throw new Error("response headers apply to a GET URL");
  if (disposition !== undefined && (typeof disposition !== "string" || disposition.length > 1024 || !DISPOSITION.test(disposition))) throw new Error("invalid responseContentDisposition");
  if (type !== undefined && (typeof type !== "string" || type.length > 255 || !MEDIA_TYPE.test(type))) throw new Error("invalid responseContentType");
}

export interface Blobs {
  readonly region: Region;
  /**
   * Returns the new version, or null when `ifMatch` or `ifNoneMatch` did not hold. A refused put
   * changes nothing. The check and the write are one step, so two writers cannot both win.
   *
   * A version names the stored bytes. It differs after a write of other bytes, and it is opaque:
   * an R2 etag, a GCS generation, a counter. Do not compare versions for order.
   */
  put(key: string, data: Uint8Array, options?: BlobPutOptions): Promise<{ version: string } | null>;
  get(key: string): Promise<BlobObject | null>;
  /** The size, content type, and version, without the data. */
  head(key: string): Promise<BlobHead | null>;
  /** Deleting a missing key is not an error. */
  delete(key: string): Promise<void>;
  /**
   * A time-limited URL. `expiresInSeconds` runs from 1 to 604800 (7 days). On a GET URL,
   * `responseContentDisposition` and `responseContentType` are signed in, so the holder of the
   * link cannot change how the bytes are served. Each is printable ASCII.
   */
  signedUrl(
    key: string,
    options: { method: "GET" | "PUT"; expiresInSeconds: number; responseContentDisposition?: string; responseContentType?: string },
  ): Promise<string>;
}

export interface Auth {
  /** Read the credential on a request. Returns null for a missing, bad, expired, or revoked one. Never throws on bad input. */
  authenticate(request: Request): Promise<PrincipalContext | null>;
}

export interface RoomKey {
  /** Letters, digits, `_` and `-`. It appears in every token. */
  id: string;
  /** 32 bytes or more. */
  secret: string;
}

export type RoomAccess = "read" | "write";

export interface RoomGrant {
  room: string;
  principalId: string;
  access: RoomAccess;
  /** Epoch milliseconds. */
  expiresAt: number;
}

export interface Realtime {
  readonly region: Region;
  /** `ttlSeconds` runs from 1 to 86400. */
  issueRoomToken(grant: { room: string; principalId: string; access: RoomAccess; ttlSeconds: number }): Promise<string>;
  /** Null for any token that is not valid for this room right now. Never throws on bad input. */
  verifyRoomToken(token: string, room: string): Promise<RoomGrant | null>;
}

export interface MailMessage {
  /** One address. */
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export interface Mail {
  readonly region: Region;
  send(message: MailMessage): Promise<{ id: string }>;
}

export function assertMailMessage(m: MailMessage): void {
  if (typeof m.to !== "string" || typeof m.subject !== "string" || typeof m.text !== "string" || (m.html !== undefined && typeof m.html !== "string")) throw new Error("invalid message");
  if (!/^[^\s@<>,;"]+@[^\s@<>,;"]+\.[^\s@<>,;"]+$/.test(m.to) || m.to.length > 254) throw new Error("invalid recipient address");
  if (m.subject.length === 0 || m.subject.length > 200 || /[\r\n]/.test(m.subject)) throw new Error("invalid subject");
  if (m.text.length === 0 || m.text.length > 200_000 || (m.html?.length ?? 0) > 200_000) throw new Error("invalid body");
}

export type QueueHandler = (body: Json, meta: { attempt: number }) => Promise<void>;

/** A handler that throws gets the message again, until this many attempts. */
export const QUEUE_MAX_ATTEMPTS = 3;

export interface Queue {
  readonly region: Region;
  /** `delaySeconds` runs from 0 to 86400. The body must be JSON. */
  send(topic: string, body: Json, options?: { delaySeconds?: number }): Promise<void>;
  /** One handler per topic. A second call for the same topic throws. */
  consume(topic: string, handler: QueueHandler): void;
}

export function assertTopic(name: string): void {
  if (!/^[a-z][a-z0-9_-]{0,63}$/.test(name)) throw new Error(`invalid topic "${name}"`);
}
