// The backend ports. App code talks to these and never to a vendor API.
// Every adapter must pass the contract suites in `agentic-identity/testing`.
/** Where an adapter keeps data. Adapters default to "eu". */
export type Region = "eu" | "us" | "any";

export interface AdapterOptions {
  region?: Region;
  /** Clock in epoch milliseconds. Tests set it. Adapters default to `Date.now`. */
  now?: () => number;
}

export function assertRegion(allowed: Region, ...adapters: { region: Region }[]): void {
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
  /** Top-level fields that must equal the value. All must match. */
  where?: Record<string, Scalar>;
  /** Sort by one field. A doc without the field (or with null) is left out. Ties sort by id. */
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
   * All writes in `fn` apply together, or none do when `fn` throws. `fn` may
   * run more than once, so keep it free of side effects. Read before you
   * write. Use `tx`, never the store, inside `fn`.
   */
  transaction<R>(fn: (tx: StoreOps) => Promise<R>): Promise<R>;
}

export function assertCollection(name: string): void {
  if (!/^[a-z][a-z0-9_]{0,63}$/.test(name)) throw new Error(`invalid collection name "${name}"`);
}

export function assertId(id: string): void {
  if (id.length === 0 || id.length > 256 || id.includes("/")) throw new Error(`invalid id "${id}"`);
}

export interface BlobObject {
  data: Uint8Array;
  contentType?: string;
}

export interface Blobs {
  readonly region: Region;
  put(key: string, data: Uint8Array, options?: { contentType?: string }): Promise<void>;
  get(key: string): Promise<BlobObject | null>;
  /** Deleting a missing key is not an error. */
  delete(key: string): Promise<void>;
  /** A time-limited URL. `expiresInSeconds` runs from 1 to 604800 (7 days). */
  signedUrl(key: string, options: { method: "GET" | "PUT"; expiresInSeconds: number }): Promise<string>;
}
