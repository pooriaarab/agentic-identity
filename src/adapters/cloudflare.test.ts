// The same contract suites run here against a real D1 database and a real R2
// bucket, both served by miniflare. The signed URL has its own failure list,
// written before the code:
//  1. A URL that was valid must stop verifying after any change to the key,
//     the method, the expiry, or the signature.
//  2. An expired URL fails, including at the exact expiry time.
//  3. A URL signed with another secret fails.
//  4. A URL with missing parts, or text that is not a URL, returns null and does not throw.
//  5. A short secret is refused when the adapter is built. There is no default secret.
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runBlobsContract, runStoreContract } from "../testing.js";
import { D1_SCHEMA, createD1Store, createR2Blobs, verifySignedBlobUrl, type D1Like, type R2Like } from "./cloudflare.js";

const SECRET = "0123456789abcdef-secret";
const URL_BASE = "https://files.example.test/blob";

let mf: Miniflare;
let db: D1Like;
let bucket: R2Like;

beforeAll(async () => {
  mf = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok'); } }",
    d1Databases: { DB: "contract-db" },
    r2Buckets: { BUCKET: "contract-bucket" },
  });
  db = (await mf.getD1Database("DB")) as unknown as D1Like;
  bucket = (await mf.getR2Bucket("BUCKET")) as unknown as R2Like;
  await db.prepare(D1_SCHEMA).run();
});

afterAll(() => mf.dispose());

runStoreContract(async (options) => {
  await db.prepare("DELETE FROM store_docs").run();
  return createD1Store(db, options);
});

runBlobsContract((options) => {
  const prefix = `${crypto.randomUUID()}/`;
  const scoped: R2Like = {
    put: (key, value, opts) => bucket.put(prefix + key, value, opts),
    get: (key) => bucket.get(prefix + key),
    delete: (key) => bucket.delete(prefix + key),
  };
  return createR2Blobs(scoped, { ...options, urlBase: URL_BASE, urlSecret: SECRET });
});

describe("signed blob URLs", () => {
  const now = () => 1_000_000;
  const sign = (method: "GET" | "PUT" = "GET") =>
    createR2Blobs({} as R2Like, { now, urlBase: URL_BASE, urlSecret: SECRET }).signedUrl("a b/é.txt", { method, expiresInSeconds: 60 });
  const verify = (url: string, at = now(), secret = SECRET) => verifySignedBlobUrl(url, { secret, now: () => at });
  const change = (url: string, name: string, value: string) => {
    const copy = new URL(url);
    copy.searchParams.set(name, value);
    return copy.toString();
  };

  it("verifies a fresh URL and returns the key and method", async () => {
    expect(await verify(await sign("PUT"))).toEqual({ key: "a b/é.txt", method: "PUT" });
  });

  it.each([
    ["key", "other.txt"],
    ["method", "PUT"],
    ["expires", "9999999"],
    ["sig", "00".repeat(32)],
  ])("rejects a changed %s", async (name, value) => {
    expect(await verify(change(await sign(), name, value))).toBeNull();
  });

  it("rejects an expired URL, including at the exact expiry time", async () => {
    const url = await sign();
    expect(await verify(url, now() + 59_999)).not.toBeNull();
    expect(await verify(url, now() + 60_000)).toBeNull();
  });

  it("rejects another secret, missing parts, and text that is not a URL", async () => {
    const url = await sign();
    expect(await verify(url, now(), "another-secret-0123456789")).toBeNull();
    const bare = new URL(url);
    bare.searchParams.delete("sig");
    expect(await verify(bare.toString())).toBeNull();
    expect(await verify("not a url")).toBeNull();
  });

  it("refuses a short secret", () => {
    expect(() => createR2Blobs({} as R2Like, { urlBase: URL_BASE, urlSecret: "short" })).toThrow();
  });
});
