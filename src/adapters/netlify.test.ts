// The contract suites run on a fake of the Netlify Blobs client (`netlify.fake.ts`). The local
// `BlobsServer` of `@netlify/blobs` cannot run them: it checks a condition and then writes in two
// steps, it builds an ETag from the file mtime, and it sends no ETag on a read. A second suite here
// runs the adapters on the real client and that server, for what the server does right, and a
// fidelity test runs one script on the fake and on the real client and compares them.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getStore } from "@netlify/blobs";
import { BlobsServer } from "@netlify/blobs/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { StoreConflictError } from "../ports.js";
import { runAuditContract, runBlobsContract, runStoreContract } from "../testing.js";
import { createNetlifyBlobs, createNetlifyStore, verifySignedBlobUrl, type NetlifyStoreLike } from "./netlify.js";
import { createFakeNetlifyStore } from "./netlify.fake.js";

const SECRET = "s".repeat(32);
const URL_BASE = "https://files.example/blob";
const fakes = new Map<string, NetlifyStoreLike>();
const fakeFor = (shared: string) => fakes.get(shared) ?? fakes.set(shared, createFakeNetlifyStore()).get(shared)!;
const shareds = (options: { shared?: string; region?: string }) => options.shared ?? crypto.randomUUID();

const makeStore = (options: { shared?: string; region?: string }) => createNetlifyStore(fakeFor(shareds(options)), options as never);
const makeBlobs = (options: { shared?: string; region?: string }) =>
  createNetlifyBlobs(fakeFor(shareds(options)), { region: "unknown", ...options, urlBase: URL_BASE, urlSecret: SECRET } as never);

runStoreContract(makeStore);
runAuditContract(makeStore);
runBlobsContract(makeBlobs);

describe("Netlify store lock and journal", () => {
  const bump = (store: ReturnType<typeof createNetlifyStore>) =>
    store.transaction(async (tx) => {
      const doc = (await tx.get<{ n: number }>("counters", "c"))!;
      await tx.put("counters", "c", { n: doc.n + 1 });
    });

  it("finishes the writes of a holder that stopped after it wrote the journal", async () => {
    const fake = createFakeNetlifyStore();
    let sets = 0;
    // The holder dies on its second doc write: the journal exists, one doc is written.
    const dying: NetlifyStoreLike = {
      ...fake,
      set: async (key, data, options) => {
        if (key.startsWith("d/") && ++sets === 2) throw new Error("holder died");
        return fake.set(key, data, options);
      },
    };
    const holder = createNetlifyStore(dying, { waitMs: 500 });
    await expect(
      holder.transaction(async (tx) => {
        await tx.put("docs", "a", { n: 1 });
        await tx.put("docs", "b", { n: 2 });
      }),
    ).rejects.toThrow("holder died");
    expect(await createNetlifyStore(fake).get("docs", "b")).toBeNull();
    // The next transaction on any adapter replays the journal before its own reads.
    const next = createNetlifyStore(fake);
    await next.transaction(async (tx) => {
      expect(await tx.get("docs", "b")).toEqual({ n: 2 });
    });
    expect(await next.get("docs", "a")).toEqual({ n: 1 });
    expect(await fake.get("journal", { type: "text", consistency: "strong" })).toBeNull();
  });

  it("takes the lock from a holder whose lease ran out, and keeps it from one whose lease runs", async () => {
    const fake = createFakeNetlifyStore();
    let clock = 1_000;
    await fake.set("lock", JSON.stringify({ owner: "gone", expiresAt: 1_500 }));
    const store = createNetlifyStore(fake, { now: () => clock, leaseMs: 100, waitMs: 200 });
    await expect(store.put("docs", "a", { n: 1 })).rejects.toBeInstanceOf(StoreConflictError);
    expect(await store.get("docs", "a")).toBeNull();
    clock = 1_500;
    await store.put("docs", "a", { n: 1 });
    expect(await store.get("docs", "a")).toEqual({ n: 1 });
  });

  it("treats a lock it cannot read as held", async () => {
    for (const body of ["not json", JSON.stringify({ owner: "x", expiresAt: "soon" }), JSON.stringify({ owner: 5, expiresAt: 0 }), JSON.stringify({ expiresAt: 0 })]) {
      const fake = createFakeNetlifyStore();
      await fake.set("lock", body);
      const store = createNetlifyStore(fake, { waitMs: 100 });
      await expect(store.put("docs", "a", { n: 1 })).rejects.toBeInstanceOf(StoreConflictError);
      expect(await store.get("docs", "a")).toBeNull();
    }
  });

  it("writes nothing when another holder took the lease while fn ran", async () => {
    const fake = createFakeNetlifyStore();
    let clock = 0;
    const store = createNetlifyStore(fake, { now: () => clock, leaseMs: 100, waitMs: 100 });
    const rival = createNetlifyStore(fake, { now: () => clock, leaseMs: 100, waitMs: 100 });
    await expect(
      store.transaction(async (tx) => {
        await tx.get("docs", "a");
        clock = 500; // our lease ran out, and a rival takes the lock
        await rival.put("docs", "a", { who: "rival" });
        await tx.put("docs", "a", { who: "late" });
      }),
    ).rejects.toBeInstanceOf(StoreConflictError);
    expect(await store.get("docs", "a")).toEqual({ who: "rival" });
  });

  it("frees the lock when fn throws, and writes nothing", async () => {
    const store = createNetlifyStore(createFakeNetlifyStore(), { waitMs: 200 });
    await expect(
      store.transaction(async (tx) => {
        await tx.put("docs", "a", { n: 1 });
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await store.get("docs", "a")).toBeNull();
    await store.put("docs", "a", { n: 2 });
    expect(await store.get("docs", "a")).toEqual({ n: 2 });
  });

  it("keeps ids with colons, dots, and non-ASCII characters apart", async () => {
    const store = createNetlifyStore(createFakeNetlifyStore());
    const ids = ["a:b", "a", "é-ü", "a.b", "日本語", "x".repeat(256)];
    for (const [i, id] of ids.entries()) await store.put("docs", id, { i });
    expect((await store.query("docs", {})).items.map((item) => item.id).sort()).toEqual([...ids].sort());
    for (const [i, id] of ids.entries()) expect(await store.get("docs", id)).toEqual({ i });
  });

  it("loses no update when four adapter objects share one store", async () => {
    const fake = createFakeNetlifyStore();
    const stores = Array.from({ length: 4 }, () => createNetlifyStore(fake));
    await stores[0]!.put("counters", "c", { n: 0 });
    await Promise.all(Array.from({ length: 16 }, (_, i) => bump(stores[i % 4]!)));
    expect(await stores[0]!.get("counters", "c")).toEqual({ n: 16 });
  });

  it("refuses bad options", () => {
    for (const options of [{ leaseMs: 0 }, { waitMs: 1.5 }]) expect(() => createNetlifyStore(createFakeNetlifyStore(), options)).toThrow(RangeError);
  });
});

describe("Netlify blobs", () => {
  it("signs URLs that verifySignedBlobUrl accepts, and refuses a missing or short secret", async () => {
    const blobs = makeBlobs({});
    const url = await blobs.signedUrl("a/b", { method: "PUT", expiresInSeconds: 60 });
    expect(await verifySignedBlobUrl(url, { secret: SECRET })).toEqual({ key: "a/b", method: "PUT" });
    for (const urlSecret of [undefined, "", "short"]) {
      expect(() => createNetlifyBlobs(createFakeNetlifyStore(), { region: "eu", urlBase: URL_BASE, urlSecret: urlSecret as never })).toThrow();
    }
  });

  it("keeps long keys apart and refuses bad metadata", async () => {
    const fake = createFakeNetlifyStore();
    const blobs = createNetlifyBlobs(fake, { region: "eu", urlBase: URL_BASE, urlSecret: SECRET });
    await blobs.put("k".repeat(5000), Uint8Array.of(1));
    await blobs.put("k".repeat(5001), Uint8Array.of(2));
    expect([(await blobs.get("k".repeat(5000)))!.data[0], (await blobs.get("k".repeat(5001)))!.data[0]]).toEqual([1, 2]);
    await expect(blobs.put("c", Uint8Array.of(1), { contentType: `text/${"x".repeat(2000)}` })).rejects.toThrow();
    const [{ key }] = (await fake.list({ prefix: "b/" })).blobs;
    await fake.set(key, new ArrayBuffer(1), { metadata: { size: "1" } });
    await expect(blobs.get("k".repeat(5000))).rejects.toThrow("bad metadata");
    await expect(blobs.head("k".repeat(5000))).rejects.toThrow("bad metadata");
  });
});

// The real client on the official local server.
describe("the real @netlify/blobs client on the local server", () => {
  let server: BlobsServer;
  let directory: string;
  let real: NetlifyStoreLike;
  beforeAll(async () => {
    directory = mkdtempSync(join(tmpdir(), "netlify-blobs-"));
    server = new BlobsServer({ directory, token: "t" });
    const { port } = await server.start();
    const url = `http://localhost:${port}`;
    real = getStore({ name: "contract", siteID: "site", token: "t", apiURL: url, edgeURL: url, uncachedEdgeURL: url });
  });
  afterAll(async () => {
    await server.stop();
    rmSync(directory, { recursive: true, force: true });
  });

  it("runs a conditional put, a refused put, and a delete through the adapter", async () => {
    const blobs = createNetlifyBlobs(real, { region: "unknown", urlBase: URL_BASE, urlSecret: SECRET });
    const first = (await blobs.put("k", Uint8Array.of(1, 2), { ifNoneMatch: "*", contentType: "text/plain" }))!;
    expect(typeof first.version).toBe("string");
    expect(await blobs.put("k", Uint8Array.of(9), { ifNoneMatch: "*" })).toBeNull();
    expect(await blobs.put("k", Uint8Array.of(9), { ifMatch: "nope" })).toBeNull();
    const second = (await blobs.put("k", Uint8Array.of(3), { ifMatch: first.version }))!;
    expect(second.version).not.toBe(first.version);
    const [{ key }] = (await real.list({ prefix: "b/" })).blobs;
    expect(Buffer.from((await real.get(key, { type: "arrayBuffer", consistency: "strong" })) as ArrayBuffer)).toEqual(Buffer.from([3]));
    expect((await real.getMetadata(key, { consistency: "strong" }))!.metadata).toEqual({ size: 1 });
    await blobs.delete("k");
    await blobs.delete("k");
    expect(await real.getMetadata(key, { consistency: "strong" })).toBeNull();
  });

  it("answers the fake's script the same way", async () => {
    const script = async (store: NetlifyStoreLike) => {
      const log: unknown[] = [];
      const shape = (r: { modified: boolean; etag?: string }) => ({ modified: r.modified, etag: typeof r.etag });
      log.push(await store.get("x", { type: "text", consistency: "strong" }));
      log.push(await store.getMetadata("x", { consistency: "strong" }));
      const one = await store.set("p/x", "hi", { metadata: { size: 2 } });
      log.push(shape(one), shape(await store.set("p/x", "again", { onlyIfNew: true })));
      log.push(shape(await store.set("p/x", "no", { onlyIfMatch: '"stale"' })), shape(await store.set("p/none", "no", { onlyIfMatch: one.etag! })));
      const two = await store.set("p/x", "two", { onlyIfMatch: one.etag! });
      log.push(shape(two), two.etag !== one.etag);
      log.push(await store.get("p/x", { type: "text", consistency: "strong" }));
      log.push((await store.getMetadata("p/x", { consistency: "strong" }))!.metadata);
      await store.set("q/y", "other");
      log.push((await store.list({ prefix: "p/" })).blobs.map((b) => b.key), (await store.list({ prefix: "none/" })).blobs);
      await store.delete("p/x");
      await store.delete("p/x");
      log.push(await store.get("p/x", { type: "text", consistency: "strong" }));
      return log;
    };
    expect(await script(createFakeNetlifyStore())).toEqual(await script(real));
  });
});
