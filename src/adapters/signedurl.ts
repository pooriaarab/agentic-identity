// HMAC-signed blob URLs, for backends that cannot make presigned URLs. The adapter signs a URL
// that your server verifies with `verifySignedBlobUrl`, then serves the key itself.
import { assertResponseHeaders, type Blobs } from "../ports.js";

const hex = (bytes: ArrayBuffer) => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");

async function hmacKey(secret: string, usage: "sign" | "verify") {
  return crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [usage]);
}

export function assertSecret(secret: unknown): void {
  if (typeof secret !== "string" || new TextEncoder().encode(secret).length < 32) throw new Error("the URL secret must be a string of at least 32 bytes");
}

// A JSON list reads one way, so no two tuples share a signed text.
const signedText = (key: string, method: string, expires: string, disposition: string | null, type: string | null) =>
  new TextEncoder().encode(JSON.stringify([method, key, expires, disposition, type]));

type SignOptions = Parameters<Blobs["signedUrl"]>[1];

/** Makes the URL for `Blobs.signedUrl`. It checks the key, the lifetime, and the response headers. */
export async function signBlobUrl(key: string, opts: SignOptions, config: { urlBase: string; urlSecret: string; now: () => number }): Promise<string> {
  const { method, expiresInSeconds } = opts;
  if (key === "") throw new Error("blob key must not be empty");
  if (!Number.isInteger(expiresInSeconds) || expiresInSeconds < 1 || expiresInSeconds > 604800) {
    throw new RangeError("expiresInSeconds must be an integer from 1 to 604800");
  }
  assertResponseHeaders(opts);
  const [disposition, type] = [opts.responseContentDisposition ?? null, opts.responseContentType ?? null];
  const expires = String(config.now() + expiresInSeconds * 1000);
  const sig = hex(await crypto.subtle.sign("HMAC", await hmacKey(config.urlSecret, "sign"), signedText(key, method, expires, disposition, type)));
  const url = new URL(config.urlBase);
  for (const [name, value] of Object.entries({ key, method, expires, sig })) url.searchParams.set(name, value);
  if (disposition !== null) url.searchParams.set("disposition", disposition);
  if (type !== null) url.searchParams.set("type", type);
  return url.toString();
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
