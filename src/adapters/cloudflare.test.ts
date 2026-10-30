// The same contract suites run here against a real D1 database and a real R2
// bucket, both served by miniflare. The signed URL has its own failure list,
// written before the code:
//  1. A URL that was valid must stop verifying after any change to the key,
//     the method, the expiry, or the signature.
//  2. An expired URL fails, including at the exact expiry time.
//  3. A URL signed with another secret fails.
//  4. A URL with missing parts, or text that is not a URL, returns null and does not throw.
//  5. A missing, empty, or short secret (under 32 bytes) is refused when the adapter is built
//     and when a URL is verified. There is no default secret. Bytes count, not characters.
//  6. A signed expiry that is not plain digits is refused, so one URL decodes one way.
// The store has its own list:
//  7. A doc deleted and made again must not look unchanged to a stale transaction.
//  8. A region is required. A database that reports another region than the one declared is refused.
//  9. A long text sort value must not break the cursor.
//  9b. A declared eu or us region is confirmed on every read (get, query, and the reads in a
//     transaction). A database that reports no region, a region that is not a text, or a code outside
//     the allowlist is refused. Codes compare without case.
// The Blobs port has conditional puts and signed response headers:
// 10. A put with ifMatch or ifNoneMatch uses the bucket's own precondition, so two isolates
//     cannot both win. A refused put returns null and changes nothing.
// 11. The response headers in a download URL (disposition, type) are signed. A URL changed in
//     those, or given them after it was signed, fails. Each one is returned to the Worker.
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runResourceClaimContract, runBlobsContract, runAuditContract, runStoreContract } from "../testing.js";
import { D1_SCHEMA, createD1Store, createR2Blobs, verifySignedBlobUrl, type D1Like, type D1Statement, type R2Like } from "./cloudflare.js";

const SECRET = "0123456789abcdef0123456789abcdef-secret";
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
  return createD1Store(db, { region: "unknown", ...options });
});

runAuditContract(async (options) => {
  await db.prepare("DELETE FROM store_docs").run();
  return createD1Store(db, { region: "unknown", ...options });
});

const claimDatasets = new Set<string | undefined>();
runResourceClaimContract(async (options) => {
  if (!claimDatasets.has(options.shared)) {
    claimDatasets.add(options.shared);
    await db.prepare("DELETE FROM store_docs").run();
  }
  return createD1Store(db, { region: "unknown", ...options });
});

it("loses no update when two store instances share one database", async () => {
  await db.prepare("DELETE FROM store_docs").run();
  const [one, two] = [createD1Store(db, { region: "unknown" }), createD1Store(db, { region: "unknown" })];
  await one.put("counters", "c", { n: 0 });
  const bump = (store: typeof one) =>
    store.transaction(async (tx) => {
      const doc = (await tx.get<{ n: number }>("counters", "c"))!;
      await tx.put("counters", "c", { n: doc.n + 1 });
    });
  await Promise.all(Array.from({ length: 10 }, (_, i) => bump(i % 2 === 0 ? one : two)));
  expect(await one.get("counters", "c")).toEqual({ n: 10 });
});

runBlobsContract((options) => {
  const prefix = `${options.shared ?? crypto.randomUUID()}/`;
  const scoped: R2Like = {
    put: (key, value, opts) => bucket.put(prefix + key, value, opts),
    get: (key) => bucket.get(prefix + key),
    head: (key) => bucket.head(prefix + key),
    delete: (key) => bucket.delete(prefix + key),
  };
  return createR2Blobs(scoped, { region: "unknown", ...options, urlBase: URL_BASE, urlSecret: SECRET });
});

describe("signed blob URLs", () => {
  const now = () => 1_000_000;
  const sign = (method: "GET" | "PUT" = "GET") =>
    createR2Blobs({} as R2Like, { region: "eu", now, urlBase: URL_BASE, urlSecret: SECRET }).signedUrl("a b/é.txt", { method, expiresInSeconds: 60 });
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

  describe("response headers", () => {
    const headers = { responseContentDisposition: 'attachment; filename="a.csv"', responseContentType: "text/csv" };
    const signWith = (extra: object, method: "GET" | "PUT" = "GET") =>
      createR2Blobs({} as R2Like, { region: "eu", now, urlBase: URL_BASE, urlSecret: SECRET }).signedUrl("k", { method, expiresInSeconds: 60, ...extra });

    it("returns the signed disposition and type with the key and method", async () => {
      expect(await verify(await signWith(headers))).toEqual({ key: "k", method: "GET", ...headers });
      expect(await verify(await signWith({ responseContentType: "text/csv" }))).toEqual({ key: "k", method: "GET", responseContentType: "text/csv" });
      expect(await verify(await signWith({}))).toEqual({ key: "k", method: "GET" });
    });

    it.each([
      ["a changed disposition", (u: URL) => u.searchParams.set("disposition", "inline")],
      ["a changed type", (u: URL) => u.searchParams.set("type", "text/html")],
      ["a removed disposition", (u: URL) => u.searchParams.delete("disposition")],
      ["a removed type", (u: URL) => u.searchParams.delete("type")],
      ["a swapped pair", (u: URL) => { u.searchParams.set("disposition", "text/csv"); u.searchParams.set("type", "attachment"); }],
    ])("rejects %s", async (_name, edit) => {
      const url = new URL(await signWith(headers));
      edit(url);
      expect(await verify(url.toString())).toBeNull();
    });

    it("rejects a header added to a URL that was signed without one", async () => {
      for (const [name, value] of [["disposition", "attachment"], ["type", "text/html"]] as const) expect(await verify(change(await signWith({}), name, value))).toBeNull();
    });

    it("rejects a signed-looking header that is not a header value, and never signs a PUT with one", async () => {
      const url = new URL(await signWith(headers));
      url.searchParams.set("type", "text/csv\r\nSet-Cookie: x=1");
      expect(await verify(url.toString())).toBeNull();
      await expect(signWith(headers, "PUT")).rejects.toThrow();
    });
  });

  it("rejects an expired URL, including at the exact expiry time", async () => {
    const url = await sign();
    expect(await verify(url, now() + 59_999)).not.toBeNull();
    expect(await verify(url, now() + 60_000)).toBeNull();
  });

  it("rejects another secret, missing parts, and text that is not a URL", async () => {
    const url = await sign();
    expect(await verify(url, now(), "another-secret-0123456789-0123456789")).toBeNull();
    const bare = new URL(url);
    bare.searchParams.delete("sig");
    expect(await verify(bare.toString())).toBeNull();
    expect(await verify("not a url")).toBeNull();
  });

  it("refuses a missing, empty, or short secret to sign and to verify, and counts bytes", async () => {
    const build = (urlSecret: unknown) => () => createR2Blobs({} as R2Like, { region: "eu", urlBase: URL_BASE, urlSecret: urlSecret as string });
    for (const secret of [undefined, null, "", "short", "x".repeat(31), 12345]) expect(build(secret)).toThrow();
    for (const secret of [undefined, null, "", "short", "x".repeat(31), 12345]) {
      await expect(verifySignedBlobUrl(await sign(), { secret: secret as string, now })).rejects.toThrow();
    }
    expect(build("x".repeat(32))).not.toThrow();
    expect(build("é".repeat(16))).not.toThrow();
    expect(build("é".repeat(15))).toThrow();
  });

  it("refuses an expiry that is not plain digits", async () => {
    const url = await sign();
    expect(await verify(change(url, "expires", ` ${new URL(url).searchParams.get("expires")}`))).toBeNull();
    expect(await verify(change(url, "expires", `${new URL(url).searchParams.get("expires")}e0`))).toBeNull();
  });
});

describe("the D1 store", () => {
  it("gives a doc a new version on every write, including after a delete", async () => {
    await db.prepare("DELETE FROM store_docs").run();
    const [one, two] = [createD1Store(db, { region: "unknown" }), createD1Store(db, { region: "unknown" })];
    await one.put("members", "x", { role: "viewer" });
    const versions = new Set<number>();
    for (let i = 0; i < 20; i++) {
      await two.delete("members", "x");
      await two.put("members", "x", { role: "viewer" });
      versions.add((await db.prepare("SELECT version FROM store_docs WHERE id = 'x'").first<{ version: number }>())!.version);
    }
    expect(versions.size).toBe(20);
  });

  it("requires a region and refuses a name that is not a region", () => {
    expect(() => createD1Store(db, {} as { region: "eu" })).toThrow();
    expect(() => createD1Store(db, { region: "mars" as "eu" })).toThrow();
    expect(() => createR2Blobs({} as R2Like, { urlBase: URL_BASE, urlSecret: SECRET } as never)).toThrow();
  });

  const serving = (served: string | undefined): D1Like => {
    const wrap = (statement: D1Statement): D1Statement => ({
      bind: (...values) => wrap(statement.bind(...values)),
      first: () => statement.first(),
      run: () => statement.run(),
      all: async () => ({ ...(await statement.all()), meta: { served_by_region: served } }),
    });
    return { prepare: (sql) => wrap(db.prepare(sql)), batch: (statements) => db.batch(statements) };
  };

  it("refuses a database that serves a query outside the declared region", async () => {
    await expect(createD1Store(serving("WNAM"), { region: "eu" }).query("docs")).rejects.toThrow();
    await expect(createD1Store(serving("WEUR"), { region: "us" }).query("docs")).rejects.toThrow();
    expect((await createD1Store(serving("EEUR"), { region: "eu" }).query("docs")).items).toEqual([]);
    expect((await createD1Store(serving("eeur"), { region: "eu" }).query("docs")).items).toEqual([]);
  });

  it("fails closed when the database reports no region, on every read", async () => {
    for (const region of ["eu", "us"] as const) {
      const store = createD1Store(serving(undefined), { region });
      await expect(store.get("docs", "x")).rejects.toThrow(/did not report/);
      await expect(store.query("docs")).rejects.toThrow(/did not report/);
      await expect(store.transaction((tx) => tx.get("docs", "x"))).rejects.toThrow(/did not report/);
      await expect(store.transaction((tx) => tx.query("docs"))).rejects.toThrow(/did not report/);
    }
    const open = createD1Store(serving(undefined), { region: "unknown" });
    expect(await open.get("docs", "x")).toBeNull();
    expect((await open.query("docs")).items).toEqual([]);
  });

  it("reads a doc only when the served region is in the allowlist, and compares without case", async () => {
    const reads = (served: unknown, region: "eu" | "us") => createD1Store(serving(served as string), { region }).get("docs", "x");
    for (const code of ["WEUR", "weur", "Eeur", "EEUR"]) expect(await reads(code, "eu")).toBeNull();
    for (const code of ["WNAM", "enam", "Enam"]) expect(await reads(code, "us")).toBeNull();
    for (const code of ["WNAM", "wnam", "ENAM", "APAC", "oc", "", "XXXX", " WEUR", "WEUR\n", 5, null, {}]) await expect(reads(code, "eu")).rejects.toThrow();
    for (const code of ["WEUR", "weur", "EEUR", "APAC", "oc", "", "XXXX", 5]) await expect(reads(code, "us")).rejects.toThrow();
  });

  it("pages by a text value too long to spread into call arguments", async () => {
    await db.prepare("DELETE FROM store_docs").run();
    const store = createD1Store(db, { region: "unknown" });
    await store.put("long", "a", { t: "a".repeat(300_000) });
    await store.put("long", "b", { t: "b".repeat(300_000) });
    const first = await store.query("long", { orderBy: { field: "t" }, limit: 1 });
    const second = await store.query("long", { orderBy: { field: "t" }, limit: 1, cursor: first.nextCursor });
    expect([first.items[0]!.id, second.items[0]!.id]).toEqual(["a", "b"]);
  });
});
