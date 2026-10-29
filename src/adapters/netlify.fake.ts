// An in-memory fake of the Netlify Blobs `Store` client, for the contract suites. It follows the
// real service where the adapters depend on it:
//   - A write with `onlyIfNew` or `onlyIfMatch` checks and writes in one step, and returns
//     `{ modified: false }` when the check fails. No await sits between the check and the write.
//   - Every write gives the key a new ETag, even for equal bytes. (The local `BlobsServer` of
//     `@netlify/blobs` builds an ETag from the file mtime, so two writes in one millisecond share one.)
//   - A read of a missing key returns null. `list` returns the keys under a prefix.
//   - Metadata is capped near 2 KiB, as base64 of its UTF-8 JSON.
//   - A key must pass the client's `validateKey`: not empty, not starting with `/` or `%2F`, at most 600 bytes of UTF-8.
// One thing no test here proves: that the live service returns, on a read, the ETag string that it takes in
// `If-Match`. The adapters depend on it. The real client reads the `etag` header, and the local server sends none.
// `netlify.test.ts` runs one script against this fake and against the real client on the local
// `BlobsServer`, and compares the results, so the fake cannot drift from the client.
import type { NetlifyStoreLike } from "./netlify.js";

interface Entry {
  data: ArrayBuffer;
  etag: string;
  metadata: Record<string, unknown>;
}

function validateKey(key: string): void {
  if (key === "") throw new Error("Blob key must not be empty.");
  if (key.startsWith("/") || key.startsWith("%2F")) throw new Error("Blob key must not start with forward slash (/).");
  if (new TextEncoder().encode(key).length > 600) throw new Error("Blob key must be at most 600 bytes of UTF-8.");
}

const copy = (data: string | ArrayBuffer): ArrayBuffer => (typeof data === "string" ? new TextEncoder().encode(data).buffer : data.slice(0)) as ArrayBuffer;

/** One fake store. Two adapters that get the same fake share data. */
export function createFakeNetlifyStore(): NetlifyStoreLike {
  const entries = new Map<string, Entry>();
  let clock = 0;
  const present = (key: string) => entries.get(key) ?? null;
  const asType = (data: ArrayBuffer, type: string) => (type === "text" ? new TextDecoder().decode(data) : data.slice(0));
  return {
    async get(key, options) {
      validateKey(key);
      const found = present(key);
      return found ? asType(found.data, options.type) : null;
    },
    async getWithMetadata(key, options) {
      validateKey(key);
      const found = present(key);
      return found ? { data: asType(found.data, options.type), etag: found.etag, metadata: structuredClone(found.metadata) } : null;
    },
    async getMetadata(key) {
      validateKey(key);
      const found = present(key);
      return found ? { etag: found.etag, metadata: structuredClone(found.metadata) } : null;
    },
    async set(key, data, options = {}) {
      validateKey(key);
      if (btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(options.metadata ?? {})))).length > 1900) throw new Error("Metadata object exceeds the 2 KiB limit.");
      const current = present(key);
      if (options.onlyIfNew && current) return { modified: false };
      if (options.onlyIfMatch !== undefined && (!current || current.etag !== options.onlyIfMatch)) return { modified: false };
      const etag = `"${++clock}"`;
      entries.set(key, { data: copy(data), etag, metadata: structuredClone(options.metadata ?? {}) });
      return { modified: true, etag };
    },
    async delete(key) {
      validateKey(key);
      entries.delete(key);
    },
    async list({ prefix }) {
      return { blobs: [...entries].filter(([key]) => key.startsWith(prefix)).map(([key, entry]) => ({ key, etag: entry.etag })) };
    },
  };
}
