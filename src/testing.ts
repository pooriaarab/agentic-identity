// Contract suites. Run each one against every adapter of that port:
//   runStoreContract((options) => new MyStore(options));
// The suites use vitest, an optional peer dependency.
import { describe, expect, it } from "vitest";
import type { AdapterOptions, Blobs, Doc, Page, Query, Region, Store } from "./ports.js";

type Make<T> = (options: AdapterOptions) => T | Promise<T>;

const ids = (page: Page) => page.items.map((entry) => entry.id);

async function walk(store: Store, collection: string, query: Query): Promise<string[]> {
  const seen: string[] = [];
  let cursor: string | undefined;
  // A broken cursor must fail the test, not loop forever.
  for (let pages = 0; pages < 50; pages++) {
    const page: Page = await store.query(collection, { ...query, cursor });
    seen.push(...ids(page));
    cursor = page.nextCursor;
    if (cursor === undefined) return seen;
  }
  throw new Error("cursor did not reach the last page in 50 pages");
}

function regionTests<T extends { region: Region }>(make: Make<T>) {
  it("reports the region it was given and defaults to eu", async () => {
    expect((await make({ region: "us" })).region).toBe("us");
    expect((await make({})).region).toBe("eu");
  });
}

export function runStoreContract(make: Make<Store>): void {
  describe("Store contract", () => {
    regionTests(make);

    it("returns null for a missing doc, replaces the whole doc on put, and deletes", async () => {
      const s = await make({});
      expect(await s.get("docs", "a")).toBeNull();
      await s.put("docs", "a", { x: 1, y: "gone" });
      await s.put("docs", "a", { x: 2 });
      expect(await s.get("docs", "a")).toEqual({ x: 2 });
      await s.delete("docs", "a");
      await s.delete("docs", "a");
      expect(await s.get("docs", "a")).toBeNull();
    });

    it("keeps collections apart and stores copies", async () => {
      const s = await make({});
      const input = { nested: { n: 1 } };
      await s.put("one", "a", input);
      input.nested.n = 99;
      const read = (await s.get<{ nested: { n: number } }>("one", "a"))!;
      read.nested.n = 42;
      expect(await s.get("one", "a")).toEqual({ nested: { n: 1 } });
      expect(await s.get("two", "a")).toBeNull();
    });

    it("rejects bad names and docs that are not JSON", async () => {
      const s = await make({});
      await expect(s.put("Bad Name", "a", {})).rejects.toThrow();
      await expect(s.put("docs", "", {})).rejects.toThrow();
      await expect(s.put("docs", "a/b", {})).rejects.toThrow();
      const loop: Doc = {};
      loop.self = loop;
      await expect(s.put("docs", "a", loop)).rejects.toThrow();
      expect(await s.get("docs", "a")).toBeNull();
    });

    async function seeded() {
      const s = await make({});
      const rows: [string, Doc][] = [
        ["a", { team: "x", n: 3, on: true, tag: null }],
        ["b", { team: "x", n: 1, on: false }],
        ["c", { team: "y", n: 2, on: true, tag: null }],
        ["d", { team: "x", n: 2 }],
        ["e", { team: "y" }],
      ];
      for (const [id, doc] of rows) await s.put("rows", id, doc);
      return s;
    }

    it("filters by equality on strings, numbers, booleans, and null, and all must match", async () => {
      const s = await seeded();
      expect(ids(await s.query("rows", { where: { team: "x" } }))).toEqual(["a", "b", "d"]);
      expect(ids(await s.query("rows", { where: { n: 2 } }))).toEqual(["c", "d"]);
      expect(ids(await s.query("rows", { where: { on: true, team: "y" } }))).toEqual(["c"]);
      expect(ids(await s.query("rows", { where: { tag: null } }))).toEqual(["a", "c"]);
      expect(ids(await s.query("rows", { where: { team: "z" } }))).toEqual([]);
      expect(ids(await s.query("nothing"))).toEqual([]);
    });

    it("orders by one field, leaves out docs without it, and breaks ties by id", async () => {
      const s = await seeded();
      expect(ids(await s.query("rows", { orderBy: { field: "n" } }))).toEqual(["b", "c", "d", "a"]);
      expect(ids(await s.query("rows", { orderBy: { field: "n", direction: "desc" } }))).toEqual(["a", "d", "c", "b"]);
      expect(ids(await s.query("rows", { where: { team: "x" }, orderBy: { field: "n" } }))).toEqual(["b", "d", "a"]);
      expect(ids(await s.query("rows"))).toEqual(["a", "b", "c", "d", "e"]);
    });

    it("pages with limit and cursor without gaps or repeats", async () => {
      const s = await seeded();
      const first = await s.query("rows", { limit: 2, orderBy: { field: "n" } });
      expect(ids(first)).toEqual(["b", "c"]);
      expect(first.nextCursor).toBeDefined();
      expect((await s.query("rows", { limit: 5 })).nextCursor).toBeUndefined();
      const queries: Query[] = [{}, { orderBy: { field: "n" } }, { orderBy: { field: "n", direction: "desc" } }, { where: { team: "x" } }];
      for (const query of queries) {
        const all = ids(await s.query("rows", query));
        for (const limit of [1, 2, 3]) expect(await walk(s, "rows", { ...query, limit })).toEqual(all);
      }
    });

    it("rejects a bad limit or a garbage cursor", async () => {
      const s = await seeded();
      for (const limit of [0, -1, 1.5]) await expect(s.query("rows", { limit })).rejects.toThrow();
      await expect(s.query("rows", { cursor: "not-a-cursor" })).rejects.toThrow();
    });

    it("commits a transaction and returns its result", async () => {
      const s = await make({});
      const out = await s.transaction(async (tx) => {
        await tx.put("docs", "a", { x: 1 });
        return "done";
      });
      expect(out).toBe("done");
      expect(await s.get("docs", "a")).toEqual({ x: 1 });
    });

    it("rolls back every write when the transaction throws", async () => {
      const s = await make({});
      await s.put("docs", "keep", { x: 1 });
      await expect(
        s.transaction(async (tx) => {
          await tx.put("docs", "new", { x: 2 });
          await tx.delete("docs", "keep");
          throw new Error("stop");
        }),
      ).rejects.toThrow("stop");
      expect(await s.get("docs", "new")).toBeNull();
      expect(await s.get("docs", "keep")).toEqual({ x: 1 });
    });

    it("loses no update when transactions run at the same time", async () => {
      const s = await make({});
      await s.put("counters", "c", { n: 0 });
      await Promise.all(
        Array.from({ length: 20 }, () =>
          s.transaction(async (tx) => {
            const doc = (await tx.get<{ n: number }>("counters", "c"))!;
            await tx.put("counters", "c", { n: doc.n + 1 });
          }),
        ),
      );
      expect(await s.get("counters", "c")).toEqual({ n: 20 });
    });
  });
}

export function runBlobsContract(make: Make<Blobs>): void {
  describe("Blobs contract", () => {
    regionTests(make);

    it("returns null for a missing key, deletes a key, and accepts a delete of a missing one", async () => {
      const b = await make({});
      expect(await b.get("nope")).toBeNull();
      await b.delete("nope");
      await b.put("k", Uint8Array.of(1));
      await b.delete("k");
      expect(await b.get("k")).toBeNull();
    });

    it("round-trips every byte value, the content type, and an overwrite", async () => {
      const b = await make({});
      const bytes = Uint8Array.from({ length: 256 }, (_, i) => i);
      await b.put("dir/file.bin", bytes, { contentType: "application/octet-stream" });
      const got = (await b.get("dir/file.bin"))!;
      expect([...got.data]).toEqual([...bytes]);
      expect(got.contentType).toBe("application/octet-stream");
      await b.put("dir/file.bin", Uint8Array.of(7));
      expect([...(await b.get("dir/file.bin"))!.data]).toEqual([7]);
    });

    it("stores a copy of the input and returns a copy", async () => {
      const b = await make({});
      const input = Uint8Array.of(1, 2, 3);
      await b.put("k", input);
      input[0] = 9;
      const got = (await b.get("k"))!;
      got.data[1] = 9;
      expect([...(await b.get("k"))!.data]).toEqual([1, 2, 3]);
    });

    it("rejects an empty key", async () => {
      const b = await make({});
      await expect(b.put("", Uint8Array.of(1))).rejects.toThrow();
    });

    it("signs a different URL per key and method, and rejects a bad lifetime", async () => {
      const b = await make({});
      const urls = await Promise.all([
        b.signedUrl("a", { method: "GET", expiresInSeconds: 60 }),
        b.signedUrl("b", { method: "GET", expiresInSeconds: 60 }),
        b.signedUrl("a", { method: "PUT", expiresInSeconds: 60 }),
      ]);
      expect(new Set(urls).size).toBe(3);
      for (const url of urls) expect(() => new URL(url)).not.toThrow();
      for (const expiresInSeconds of [0, -5, 604801, 1.5]) {
        await expect(b.signedUrl("a", { method: "GET", expiresInSeconds })).rejects.toThrow();
      }
    });
  });
}
