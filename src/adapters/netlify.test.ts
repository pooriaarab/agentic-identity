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
import { NetlifyCommitUncertainError, createNetlifyBlobs, createNetlifyStore, verifySignedBlobUrl, type NetlifyStoreLike } from "./netlify.js";
import { createFakeNetlifyStore } from "./netlify.fake.js";

type StoreOptions = Partial<Parameters<typeof createNetlifyStore>[1]>;
const strongStore = (fake: NetlifyStoreLike, options: StoreOptions = {}) => createNetlifyStore(fake, { consistency: "strong", ...options });
const SECRET = "s".repeat(32);
const URL_BASE = "https://files.example/blob";
const fakes = new Map<string, NetlifyStoreLike>();
const fakeFor = (shared: string) => fakes.get(shared) ?? fakes.set(shared, createFakeNetlifyStore()).get(shared)!;
const shareds = (options: { shared?: string; region?: string }) => options.shared ?? crypto.randomUUID();

const makeStore = (options: { shared?: string; region?: string }) => strongStore(fakeFor(shareds(options)), options as never);
const makeBlobs = (options: { shared?: string; region?: string }) =>
  createNetlifyBlobs(fakeFor(shareds(options)), { region: "unknown", ...options, urlBase: URL_BASE, urlSecret: SECRET } as never);

// The real client retries a request that failed, and a retry of a write that had landed gets a 412.
const makeRetryStore = (options: { shared?: string; region?: string }) => {
  const shared = options.shared ?? crypto.randomUUID();
  if (!fakes.has(shared)) fakes.set(shared, createFakeNetlifyStore({ retryAfterLanding: true }));
  return strongStore(fakes.get(shared)!, options as never);
};
const makeRetryBlobs = (options: { shared?: string; region?: string }) => {
  const shared = options.shared ?? crypto.randomUUID();
  if (!fakes.has(shared)) fakes.set(shared, createFakeNetlifyStore({ retryAfterLanding: true }));
  return createNetlifyBlobs(fakes.get(shared)!, { region: "unknown", ...options, urlBase: URL_BASE, urlSecret: SECRET } as never);
};

runStoreContract(makeStore);
runAuditContract(makeStore);
runBlobsContract(makeBlobs);
describe("when a write lands and its retry is refused", () => {
  runStoreContract(makeRetryStore);
  runBlobsContract(makeRetryBlobs);
});

describe("Netlify store lock and journal", () => {
  const bump = (store: ReturnType<typeof createNetlifyStore>) =>
    store.transaction(async (tx) => {
      const doc = (await tx.get<{ n: number }>("counters", "c"))!;
      await tx.put("counters", "c", { n: doc.n + 1 });
    });

  // The journal lives in the lock key. Undefined means that no journal is left.
  const journalOf = async (fake: NetlifyStoreLike) => (JSON.parse((await fake.get("lock", { type: "text", consistency: "strong" })) as string) as { writes?: unknown }).writes;

  const twoDocs = (store: ReturnType<typeof createNetlifyStore>) =>
    store.transaction(async (tx) => {
      await tx.put("docs", "a", { n: 1 });
      await tx.put("docs", "b", { n: 2 });
    });

  // A store whose doc writes fail from the second one on, while `broken.on` is set. With `once`, only one write fails.
  const breakable = (fake: NetlifyStoreLike, once = false) => {
    const broken = { on: true, sets: 0 };
    const store: NetlifyStoreLike = {
      ...fake,
      set: async (key, data, options) => {
        if (broken.on && key.startsWith("d/") && ++broken.sets >= 2) {
          if (once) broken.on = false;
          throw new Error("write failed");
        }
        return fake.set(key, data, options);
      },
    };
    return { store, broken };
  };

  it("finishes the journal at once after a write that fails once, and the transaction commits", async () => {
    const fake = createFakeNetlifyStore();
    await twoDocs(strongStore(breakable(fake, true).store, { waitMs: 500 }));
    const reader = strongStore(fake);
    expect([await reader.get("docs", "a"), await reader.get("docs", "b")]).toEqual([{ n: 1 }, { n: 2 }]);
    expect(await journalOf(fake)).toBeUndefined();
  });

  it("finishes the writes of a holder that stopped after it wrote the journal", async () => {
    const fake = createFakeNetlifyStore();
    const { store, broken } = breakable(fake);
    const failure = await twoDocs(strongStore(store, { waitMs: 500 })).catch((e: unknown) => e);
    // The caller learns that the outcome is unknown, and that no retry is safe to assume.
    expect(failure).toBeInstanceOf(NetlifyCommitUncertainError);
    expect(((failure as Error).cause as Error).message).toBe("write failed");
    expect(await strongStore(fake).get("docs", "b")).toBeNull();
    broken.on = false;
    // The next transaction on any adapter replays the journal before its own reads.
    const next = strongStore(fake);
    await next.transaction(async (tx) => {
      expect(await tx.get("docs", "b")).toEqual({ n: 2 });
    });
    expect(await next.get("docs", "a")).toEqual({ n: 1 });
    expect(await journalOf(fake)).toBeUndefined();
  });

  it("stops a holder whose lease a rival took while it applied, so it cannot write over the rival", async () => {
    const fake = createFakeNetlifyStore();
    let clock = 0;
    const options = { now: () => clock, leaseMs: 100, waitMs: 200 };
    const rival = strongStore(fake, options);
    let docWrites = 0;
    const stalling: NetlifyStoreLike = {
      ...fake,
      set: async (key, data, opts) => {
        const result = await fake.set(key, data, opts);
        if (key.startsWith("d/") && ++docWrites === 1) {
          clock = 500; // the lease runs out after the first doc write
          await rival.put("docs", "b", { who: "rival" });
        }
        return result;
      },
    };
    await expect(twoDocs(strongStore(stalling, options))).rejects.toBeInstanceOf(NetlifyCommitUncertainError);
    expect(await rival.get("docs", "a")).toEqual({ n: 1 });
    expect(await rival.get("docs", "b")).toEqual({ who: "rival" });
  });

  it("refuses the journal of a holder whose lease ran out while it waited to write it, so it cannot undo a rival", async () => {
    const fake = createFakeNetlifyStore();
    let clock = 0;
    const options = { now: () => clock, leaseMs: 100, waitMs: 200 };
    const rival = strongStore(fake, options);
    const slow: NetlifyStoreLike = {
      ...fake,
      set: async (key, data, opts) => {
        if (key === "lock" && String(data).includes('"writes"')) {
          clock = 500; // the journal write is delayed past the lease, and a rival commits meanwhile
          await rival.put("docs", "a", { who: "rival" });
        }
        return fake.set(key, data, opts);
      },
    };
    await expect(twoDocs(strongStore(slow, options))).rejects.toBeInstanceOf(StoreConflictError);
    const reader = strongStore(fake, options);
    await reader.put("docs", "z", { n: 0 }); // the next transaction would replay a journal, if one landed
    expect([await reader.get("docs", "a"), await reader.get("docs", "b")]).toEqual([{ who: "rival" }, null]);
  });

  // A doc write that the client delays past the lease, and a rival who commits meanwhile.
  for (const kind of ["put", "delete"] as const) {
    it(`refuses a late doc ${kind} that would land over a rival's commit`, async () => {
      const fake = createFakeNetlifyStore();
      let clock = 0;
      const options = { now: () => clock, leaseMs: 100, waitMs: 200 };
      const rival = strongStore(fake, options);
      await rival.put("docs", "x", { v: 0 });
      let delayed = false;
      const slow: NetlifyStoreLike = {
        ...fake,
        set: async (key, data, opts) => {
          if (key.startsWith("d/docs/") && !delayed && String(data).includes('"id":"x"') && opts?.onlyIfMatch !== undefined) {
            delayed = true;
            clock = 500; // the write is delayed past the lease, and a rival takes over and commits
            await rival.put("docs", "x", { v: 2 });
          }
          return fake.set(key, data, opts);
        },
      };
      const late = strongStore(slow, options).transaction(async (tx) => {
        await tx.get("docs", "x");
        if (kind === "put") await tx.put("docs", "x", { v: 1 });
        else await tx.delete("docs", "x");
      });
      await expect(late).rejects.toBeInstanceOf(NetlifyCommitUncertainError);
      expect(await rival.get("docs", "x")).toEqual({ v: 2 });
      await rival.put("docs", "y", { v: 0 }); // the next transaction replays any journal that is left
      expect(await rival.get("docs", "x")).toEqual({ v: 2 });
    });
  }

  it("hides a deleted doc from get and query, and lets a later put bring it back", async () => {
    const store = strongStore(createFakeNetlifyStore());
    await store.put("docs", "a", { n: 1 });
    await store.delete("docs", "a");
    expect(await store.get("docs", "a")).toBeNull();
    expect((await store.query("docs", {})).items).toEqual([]);
    await store.put("docs", "a", { n: 2 });
    expect(await store.get("docs", "a")).toEqual({ n: 2 });
  });

  it("reports an unknown outcome when the journal write itself fails", async () => {
    const fake = createFakeNetlifyStore();
    const lossy: NetlifyStoreLike = {
      ...fake,
      set: async (key, data, options) => (key === "lock" && String(data).includes('"writes"') ? Promise.reject(new Error("dropped")) : fake.set(key, data, options)),
    };
    await expect(twoDocs(strongStore(lossy, { waitMs: 100 }))).rejects.toBeInstanceOf(NetlifyCommitUncertainError);
  });

  it("fails a read-only transaction whose lease a rival took while it read", async () => {
    const fake = createFakeNetlifyStore();
    let clock = 0;
    const options = { now: () => clock, leaseMs: 100, waitMs: 200 };
    const store = strongStore(fake, options);
    const rival = strongStore(fake, options);
    await expect(
      store.transaction(async (tx) => {
        await tx.get("docs", "a");
        clock = 500;
        await rival.put("docs", "a", { n: 1 });
      }),
    ).rejects.toBeInstanceOf(StoreConflictError);
  });

  it("keeps a lock it cannot parse, or one with a bad journal, as held", async () => {
    const fake = createFakeNetlifyStore();
    await fake.set("lock", JSON.stringify({ owner: null, expiresAt: 0, writes: [{ collection: "Bad Name", id: "a", doc: null }] }));
    await expect(strongStore(fake, { waitMs: 100 }).put("docs", "a", { n: 1 })).rejects.toBeInstanceOf(StoreConflictError);
  });

  it("refuses a doc stored under another key", async () => {
    const fake = createFakeNetlifyStore();
    const store = strongStore(fake);
    await store.put("docs", "a", { n: 1 });
    await store.put("docs", "b", { n: 2 });
    const [one, two] = (await fake.list({ prefix: "d/docs/" })).blobs;
    await fake.set(one!.key, (await fake.get(two!.key, { type: "text", consistency: "strong" })) as string);
    await expect(store.query("docs", {})).rejects.toThrow("wrong key");
  });

  it("refuses a Netlify store that is not strongly consistent, and a missing consistency option", () => {
    for (const consistency of ["eventual", "other"]) {
      expect(() => strongStore({ ...createFakeNetlifyStore(), client: { consistency } } as never)).toThrow("strong");
    }
    expect(() => strongStore({ ...createFakeNetlifyStore(), client: { consistency: "strong" } } as never)).not.toThrow();
    for (const options of [undefined, {}, { consistency: "eventual" }]) {
      expect(() => createNetlifyStore(createFakeNetlifyStore(), options as never)).toThrow("strong");
    }
  });

  it("gives up on a write made inside a transaction, and does not hang", async () => {
    const store = strongStore(createFakeNetlifyStore(), { waitMs: 100 });
    await expect(store.transaction(() => store.put("docs", "a", { n: 1 }))).rejects.toBeInstanceOf(StoreConflictError);
    await store.put("docs", "b", { n: 1 });
  });

  it("treats an empty ETag from a lock write as an error, never as a condition", async () => {
    const fake = createFakeNetlifyStore();
    const emptyEtag: NetlifyStoreLike = { ...fake, set: async (key, data, options) => ({ ...(await fake.set(key, data, options)), etag: "" }) };
    await expect(strongStore(emptyEtag, { waitMs: 100 }).put("docs", "a", { n: 1 })).rejects.toThrow("no ETag");
    await expect(createNetlifyBlobs(emptyEtag, { region: "eu", urlBase: URL_BASE, urlSecret: SECRET }).put("k", Uint8Array.of(1))).rejects.toThrow("no ETag");
  });

  it("keeps ids under the Netlify key limit, and refuses an id with a lone surrogate", async () => {
    const store = strongStore(createFakeNetlifyStore());
    const long = ["日".repeat(256), "😀".repeat(128), "é".repeat(256)];
    for (const [i, id] of long.entries()) await store.put("docs", id, { i });
    expect((await store.query("docs", {})).items.map((item) => [item.id, item.data.i]).sort()).toEqual(long.map((id, i) => [id, i]).sort());
    for (const id of ["a\uD800", "\uDC00b"]) {
      await expect(store.put("docs", id, { x: 1 })).rejects.toThrow("well-formed");
      await expect(store.get("docs", id)).rejects.toThrow("well-formed");
    }
    expect((await store.query("docs", {})).items).toHaveLength(3);
  });

  it("takes the lock from a holder whose lease ran out, and keeps it from one whose lease runs", async () => {
    const fake = createFakeNetlifyStore();
    let clock = 1_000;
    await fake.set("lock", JSON.stringify({ owner: "gone", expiresAt: 1_500 }));
    const store = strongStore(fake, { now: () => clock, leaseMs: 100, waitMs: 200 });
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
      const store = strongStore(fake, { waitMs: 100 });
      await expect(store.put("docs", "a", { n: 1 })).rejects.toBeInstanceOf(StoreConflictError);
      expect(await store.get("docs", "a")).toBeNull();
    }
  });

  it("writes nothing when another holder took the lease while fn ran", async () => {
    const fake = createFakeNetlifyStore();
    let clock = 0;
    const store = strongStore(fake, { now: () => clock, leaseMs: 100, waitMs: 100 });
    const rival = strongStore(fake, { now: () => clock, leaseMs: 100, waitMs: 100 });
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
    const store = strongStore(createFakeNetlifyStore(), { waitMs: 200 });
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
    const store = strongStore(createFakeNetlifyStore());
    const ids = ["a:b", "a", "é-ü", "a.b", "日本語", "x".repeat(256)];
    for (const [i, id] of ids.entries()) await store.put("docs", id, { i });
    expect((await store.query("docs", {})).items.map((item) => item.id).sort()).toEqual([...ids].sort());
    for (const [i, id] of ids.entries()) expect(await store.get("docs", id)).toEqual({ i });
  });

  it("loses no update when four adapter objects share one store", async () => {
    const fake = createFakeNetlifyStore();
    const stores = Array.from({ length: 4 }, () => strongStore(fake));
    await stores[0]!.put("counters", "c", { n: 0 });
    await Promise.all(Array.from({ length: 16 }, (_, i) => bump(stores[i % 4]!)));
    expect(await stores[0]!.get("counters", "c")).toEqual({ n: 16 });
  });

  it("refuses bad options", () => {
    for (const options of [{ leaseMs: 0 }, { waitMs: 1.5 }]) expect(() => strongStore(createFakeNetlifyStore(), options)).toThrow(RangeError);
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
    await expect(blobs.put("a\uD800", Uint8Array.of(1))).rejects.toThrow("well-formed");
    await expect(blobs.put("c", Uint8Array.of(1), { contentType: `text/${"x".repeat(2000)}` })).rejects.toThrow(RangeError);
    await expect(blobs.put("c", Uint8Array.of(1), { contentType: `text/${"é".repeat(600)}` })).rejects.toThrow(RangeError);
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

  it("tells an eventual store from a strong one", () => {
    const url = "http://localhost:1";
    const make = (consistency?: "strong") => getStore({ name: "c", siteID: "site", token: "t", apiURL: url, edgeURL: url, uncachedEdgeURL: url, ...(consistency ? { consistency } : {}) });
    expect(() => strongStore(make() as unknown as NetlifyStoreLike)).toThrow("strong");
    expect(() => strongStore(make("strong") as unknown as NetlifyStoreLike)).not.toThrow();
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
    expect((await real.getMetadata(key, { consistency: "strong" }))!.metadata).toMatchObject({ size: 1 });
    await blobs.delete("k");
    await blobs.delete("k");
    expect(await real.getMetadata(key, { consistency: "strong" })).toBeNull();
  });

  it("answers the fake's script the same way", async () => {
    const script = async (store: NetlifyStoreLike) => {
      const log: unknown[] = [];
      const shape = (r: { modified: boolean; etag?: string }) => ({ modified: r.modified, etag: r.etag ? "non-empty" : r.etag });
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
