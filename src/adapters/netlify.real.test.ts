// The real `@netlify/blobs` client on its official local `BlobsServer`. It needs no secret and no
// network. A fidelity test runs one script on the fake (`netlify.fake.ts`) and on the real client
// and compares them. The CI job `netlify-real-client` sets REQUIRE_NETLIFY_REAL_CLIENT, so a job
// that skipped this file fails and does not pass on the fake.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getStore } from "@netlify/blobs";
import { BlobsServer } from "@netlify/blobs/server";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createNetlifyBlobs, createNetlifyStore, type NetlifyStoreLike } from "./netlify.js";
import { createFakeNetlifyStore } from "./netlify.fake.js";

const strongStore = (store: NetlifyStoreLike) => createNetlifyStore(store, { consistency: "strong" });
const SECRET = "s".repeat(32);
const URL_BASE = "https://files.example/blob";

let realTestsRun = 0;
const REAL_TESTS = 3;

describe("the real @netlify/blobs client on the local server", () => {
  afterEach(() => {
    realTestsRun += 1;
  });
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

// Outside the describe, so skipping the describe does not skip this guard.
it.runIf(process.env.REQUIRE_NETLIFY_REAL_CLIENT === "1")("ran every real-client test when CI asks for it", () => {
  expect(realTestsRun).toBe(REAL_TESTS);
});
