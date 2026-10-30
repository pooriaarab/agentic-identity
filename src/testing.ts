// Contract suites. Run each one against every adapter of that port:
//   runStoreContract((options) => new MyStore(options));
// The suites use vitest, an optional peer dependency.
import { describe, expect, it } from "vitest";
import { deletePerson, exportPerson } from "./gdpr.js";
import { MAX_RESOURCE_CLAIM_REFERENCES, ResourceClaimConflictError, createSharing } from "./core/sharing.js";
import type { AuditEntry, PrincipalContext } from "./core/principals.js";
import { StoreConflictError, type AdapterOptions, type Auth, type Blobs, type Doc, type Json, type Mail, type MailMessage, type Page, type Query, type Queue, type Realtime, type Region, type RoomKey, type Store, type StoreOps } from "./ports.js";

type Make<T, O = AdapterOptions> = (options: O) => T | Promise<T>;

/**
 * `shared` names one backing dataset. Two stores made with the same `shared`
 * value see the same data, as two Worker isolates on one database do. A store
 * made without it has data of its own.
 */
export type StoreOptions = AdapterOptions & { shared?: string };

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

const HOLD_MS = 100;

/**
 * A write from another store that starts while a transaction runs. The transaction waits a
 * short time for it, then goes on, so no backend can hang the test. `landed` says whether the
 * write took effect in that time.
 *
 * An optimistic backend lets the write land, then runs the transaction again or gives up with
 * `StoreConflictError`. A pessimistic backend (a Firestore server SDK locks every doc a
 * transaction reads) holds the write until the transaction ends. Both are correct. A lost
 * update is not: a run that a landed write overtook must never commit.
 */
function raceWrite(write: () => Promise<unknown>) {
  const pending: Promise<unknown>[] = [];
  return {
    async start(): Promise<boolean> {
      const done = write();
      pending.push(done);
      return Promise.race([done.then(() => true), new Promise<false>((resolve) => setTimeout(() => resolve(false), HOLD_MS))]);
    },
    settle: () => Promise.all(pending),
  };
}

function regionTests<T extends { region: Region }>(make: Make<T>) {
  it("reports the region it was given and refuses a name that is not a region", async () => {
    for (const region of ["eu", "us", "unknown"] as const) expect((await make({ region })).region).toBe(region);
    await expect(Promise.resolve().then(() => make({ region: "mars" as Region }))).rejects.toThrow();
  });
}

export function runStoreContract(make: Make<Store, StoreOptions>): void {
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
      for (const id of ["", "a/b", ".", "..", "__name__", "__x__"]) await expect(s.put("docs", id, {})).rejects.toThrow();
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

    it("never matches across types: true is not 1, and \"1\" is not 1", async () => {
      const s = await make({});
      const values: [string, Json][] = [["num", 1], ["bool", true], ["text", "1"], ["zero", 0], ["no", false], ["nil", null]];
      for (const [id, v] of values) await s.put("typed", id, { v });
      expect(ids(await s.query("typed", { where: { v: 1 } }))).toEqual(["num"]);
      expect(ids(await s.query("typed", { where: { v: true } }))).toEqual(["bool"]);
      expect(ids(await s.query("typed", { where: { v: "1" } }))).toEqual(["text"]);
      expect(ids(await s.query("typed", { where: { v: 0 } }))).toEqual(["zero"]);
      expect(ids(await s.query("typed", { where: { v: false } }))).toEqual(["no"]);
      expect(ids(await s.query("typed", { where: { v: null } }))).toEqual(["nil"]);
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

    it("pages over ids and sort values that are not ASCII", async () => {
      const s = await make({});
      for (const [id, name] of [["名", "龍"], ["é", "ж"], ["😀", "a"]] as const) await s.put("intl", id, { name });
      for (const query of [{}, { orderBy: { field: "name" } }] as Query[]) {
        const all = ids(await s.query("intl", query));
        expect(all).toHaveLength(3);
        expect(await walk(s, "intl", { ...query, limit: 1 })).toEqual(all);
      }
    });

    it("rejects a field name that is a path or has symbols, in where and in orderBy", async () => {
      const s = await seeded();
      for (const field of ["a.b", "a b", "", "$x", "a/b", "1a"]) {
        await expect(s.query("rows", { where: { [field]: 1 } })).rejects.toThrow();
        await expect(s.query("rows", { orderBy: { field } })).rejects.toThrow();
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
      await Promise.all(Array.from({ length: 20 }, () => bump(s)));
      expect(await s.get("counters", "c")).toEqual({ n: 20 });
    });

    // One instance alone cannot show a missing conflict check: a lock inside the
    // instance hides it. Two instances on one backend can.
    it("loses no update when two stores on one backend run transactions at the same time", async () => {
      const shared = crypto.randomUUID();
      const [one, two] = [await make({ shared }), await make({ shared })];
      await one.put("counters", "c", { n: 0 });
      await Promise.all(Array.from({ length: 20 }, (_, i) => bump(i % 2 === 0 ? one : two)));
      expect(await two.get("counters", "c")).toEqual({ n: 20 });
    });

    // The next four cases race a write from another store against a transaction. A backend that
    // retries ends one way, and a backend that locks ends the other way. No update may be lost.
    it("never commits a run that another store's write overtook, for a doc it read", async () => {
      const shared = crypto.randomUUID();
      const [one, two] = [await make({ shared }), await make({ shared })];
      await one.put("docs", "a", { x: 1 });
      const race = raceWrite(() => two.put("docs", "a", { x: 10 }));
      let runs = 0;
      let landed = false;
      await one.transaction(async (tx) => {
        landed = false;
        const doc = (await tx.get<{ x: number }>("docs", "a"))!;
        if (++runs === 1) landed = await race.start();
        await tx.put("docs", "b", { x: doc.x + 1 });
      });
      expect(landed).toBe(false);
      await race.settle();
      expect(await one.get("docs", "a")).toEqual({ x: 10 });
      expect(await one.get("docs", "b")).toEqual(runs === 2 ? { x: 11 } : { x: 2 });
    });

    it("never commits a read-only run that another store's write overtook", async () => {
      const shared = crypto.randomUUID();
      const [one, two] = [await make({ shared }), await make({ shared })];
      await one.put("docs", "a", { x: 1 });
      const race = raceWrite(() => two.put("docs", "a", { x: 2 }));
      const seen: number[] = [];
      let landed = false;
      await one.transaction(async (tx) => {
        landed = false;
        seen.push((await tx.get<{ x: number }>("docs", "a"))!.x);
        if (seen.length === 1) landed = await race.start();
      });
      expect(landed).toBe(false);
      await race.settle();
      expect(seen).toEqual(seen.length === 2 ? [1, 2] : [1]);
    });

    // A doc that was deleted and made again must not look unchanged.
    it("never commits a run that another store's delete and write overtook", async () => {
      const shared = crypto.randomUUID();
      const [one, two] = [await make({ shared }), await make({ shared })];
      await one.put("members", "x", { role: "viewer" });
      const race = raceWrite(async () => {
        await two.delete("members", "x");
        await two.put("members", "x", { role: "owner" });
      });
      let runs = 0;
      let landed = false;
      await one.transaction(async (tx) => {
        landed = false;
        const doc = (await tx.get("members", "x"))!;
        if (++runs === 1) landed = await race.start();
        await tx.put("members", "x", { ...doc, note: "n" });
      });
      expect(landed).toBe(false);
      await race.settle();
      // The write ends last in both cases. A rerun sees its doc, and the other order loses nothing.
      expect(await one.get("members", "x")).toEqual(runs === 2 ? { role: "owner", note: "n" } : { role: "owner" });
    });

    // A query guards the docs it returned. The failure cases: a rival write changes a returned
    // doc, a rival delete removes one, and a rival write changes a doc a read-only run returned.
    it("never commits a run that another store's write overtook, for a doc a query returned", async () => {
      const shared = crypto.randomUUID();
      const [one, two] = [await make({ shared }), await make({ shared })];
      await one.put("members", "x", { team: "a", role: "owner" });
      const race = raceWrite(() => two.put("members", "x", { team: "a", role: "viewer" }));
      let runs = 0;
      let landed = false;
      let owners = 0;
      await one.transaction(async (tx) => {
        landed = false;
        owners = (await tx.query("members", { where: { team: "a", role: "owner" } })).items.length;
        if (++runs === 1) landed = await race.start();
        await tx.put("results", "r", { owners });
      });
      expect(landed).toBe(false);
      await race.settle();
      // A run that counted the owner before the demotion must not commit its count.
      expect(await one.get("results", "r")).toEqual({ owners: runs === 2 ? 0 : 1 });
    });

    it("never commits a run that another store's delete overtook, for a doc a query returned", async () => {
      const shared = crypto.randomUUID();
      const [one, two] = [await make({ shared }), await make({ shared })];
      await one.put("members", "x", { team: "a" });
      const race = raceWrite(() => two.delete("members", "x"));
      let runs = 0;
      let landed = false;
      await one.transaction(async (tx) => {
        landed = false;
        const found = (await tx.query("members", { where: { team: "a" } })).items.length;
        if (++runs === 1) landed = await race.start();
        await tx.put("results", "r", { found });
      });
      expect(landed).toBe(false);
      await race.settle();
      expect(await one.get("results", "r")).toEqual({ found: runs === 2 ? 0 : 1 });
    });

    it("never commits a read-only run that another store's write overtook, for a doc a query returned", async () => {
      const shared = crypto.randomUUID();
      const [one, two] = [await make({ shared }), await make({ shared })];
      await one.put("members", "x", { team: "a", n: 1 });
      const race = raceWrite(() => two.put("members", "x", { team: "a", n: 2 }));
      const seen: unknown[] = [];
      let landed = false;
      await one.transaction(async (tx) => {
        landed = false;
        seen.push((await tx.query("members", { where: { team: "a" } })).items[0]?.data.n);
        if (seen.length === 1) landed = await race.start();
      });
      expect(landed).toBe(false);
      await race.settle();
      expect(seen).toEqual(seen.length === 2 ? [1, 2] : [1]);
    });

    // The rule Firestore sets, so that one app behaves the same on every adapter.
    it("fails a read that comes after a write in the same transaction, and writes nothing", async () => {
      const s = await make({});
      await s.put("docs", "a", { x: 1 });
      const reads: ((tx: StoreOps) => Promise<unknown>)[] = [
        (tx) => tx.get("docs", "a"),
        (tx) => tx.get("docs", "other"),
        (tx) => tx.query("docs"),
      ];
      for (const read of reads) {
        for (const write of [(tx: StoreOps) => tx.put("docs", "new", { x: 2 }), (tx: StoreOps) => tx.delete("docs", "a")]) {
          await expect(
            s.transaction(async (tx) => {
              await write(tx);
              await read(tx);
            }),
          ).rejects.toThrow();
        }
      }
      expect(await s.get("docs", "a")).toEqual({ x: 1 });
      expect(await s.get("docs", "new")).toBeNull();
    });

    // A doc id is how an app keeps a name unique, so two stores must not both claim it.
    it("lets only one of two stores claim the same doc id at the same time", async () => {
      for (let round = 0; round < 10; round++) {
        const shared = crypto.randomUUID();
        const [one, two] = [await make({ shared }), await make({ shared })];
        const claim = (store: Store, by: string) =>
          store.transaction(async (tx) => {
            if (await tx.get("names", "folder-1:report")) return false;
            await tx.put("names", "folder-1:report", { by });
            await tx.put("nodes", by, { name: "report" });
            return true;
          });
        const won = await Promise.all([claim(one, "a"), claim(two, "b"), claim(one, "c"), claim(two, "d")]);
        expect(won.filter(Boolean)).toHaveLength(1);
        expect((await one.query("nodes")).items).toHaveLength(1);
      }
    });

    // The read-modify-write of one doc, with the work done between the read and the write.
    it("keeps a read-modify-write of one doc whole when another store edits it in between", async () => {
      const shared = crypto.randomUUID();
      const [one, two] = [await make({ shared }), await make({ shared })];
      await one.put("decks", "d", { parts: [] });
      const add = (store: Store, part: string) =>
        store.transaction(async (tx) => {
          const deck = (await tx.get<{ parts: string[] }>("decks", "d"))!;
          await new Promise((r) => setTimeout(r, 5));
          await tx.put("decks", "d", { parts: [...deck.parts, part] });
        });
      await Promise.all(["a", "b", "c", "d", "e", "f"].map((part, i) => add(i % 2 === 0 ? one : two, part)));
      expect(((await one.get<{ parts: string[] }>("decks", "d"))!.parts).sort()).toEqual(["a", "b", "c", "d", "e", "f"]);
    });

    // Every run is overtaken, or none is. A transaction ends in one of two ways. It gives up with
    // StoreConflictError and writes nothing, or it commits before the other write lands.
    it("gives up with StoreConflictError and writes nothing, or commits before a rival write lands", async () => {
      const shared = crypto.randomUUID();
      const [one, two] = [await make({ shared }), await make({ shared })];
      await one.put("counters", "k", { v: 0 });
      let runs = 0;
      const rivals: ReturnType<typeof raceWrite>[] = [];
      let landed = false;
      const outcome = await one
        .transaction(async (tx) => {
          landed = false;
          const read = (await tx.get<{ v: number }>("counters", "k"))!;
          const rival = raceWrite(() => two.put("counters", "k", { v: 100 + ++runs }));
          rivals.push(rival);
          landed = await rival.start();
          await tx.put("counters", "k", { v: read.v + 1 });
          await tx.put("counters", "out", { v: 1 });
        })
        .then(
          () => "committed",
          (error: unknown) => {
            if (error instanceof StoreConflictError) return "gave up";
            throw error;
          },
        );
      await Promise.all(rivals.map((r) => r.settle()));
      // Every rival write lands, and the last one wins. The transaction's write never covers it.
      expect(await one.get("counters", "k")).toEqual({ v: 100 + runs });
      if (outcome === "gave up") {
        expect(await one.get("counters", "out")).toBeNull();
        expect(runs).toBeGreaterThan(1);
      } else {
        expect(landed).toBe(false);
        expect(await one.get("counters", "out")).toEqual({ v: 1 });
      }
    }, 15_000);

    it("allows reads before writes, and many writes after the reads", async () => {
      const s = await make({});
      await s.put("docs", "a", { x: 1 });
      await s.transaction(async (tx) => {
        await tx.get("docs", "a");
        await tx.query("docs");
        await tx.put("docs", "b", { x: 2 });
        await tx.put("docs", "b", { x: 3 });
        await tx.delete("docs", "a");
      });
      expect(await s.get("docs", "b")).toEqual({ x: 3 });
      expect(await s.get("docs", "a")).toBeNull();
    });
  });
}

const bump = (store: Store) =>
  store.transaction(async (tx) => {
    const doc = (await tx.get<{ n: number }>("counters", "c"))!;
    await tx.put("counters", "c", { n: doc.n + 1 });
  });

export function runBlobsContract(make: Make<Blobs, StoreOptions>): void {
  describe("Blobs contract", () => {
    regionTests(make);

    it("gives every object a version on put, get, and head, and head holds no data", async () => {
      const b = await make({});
      const put = (await b.put("k", Uint8Array.of(1, 2, 3), { contentType: "text/plain" }))!;
      expect(typeof put.version).toBe("string");
      expect(put.version).not.toBe("");
      expect((await b.get("k"))!.version).toBe(put.version);
      const head = (await b.head("k"))!;
      expect(head).toEqual({ size: 3, contentType: "text/plain", version: put.version });
      expect(head).not.toHaveProperty("data");
      expect(await b.head("missing")).toBeNull();
      const next = (await b.put("k", Uint8Array.of(9)))!;
      expect(next.version).not.toBe(put.version);
    });

    it("writes with ifNoneMatch only when the key is absent", async () => {
      const b = await make({});
      expect(await b.put("k", Uint8Array.of(1), { ifNoneMatch: "*", contentType: "text/plain" })).not.toBeNull();
      expect(await b.put("k", Uint8Array.of(2), { ifNoneMatch: "*", contentType: "text/html" })).toBeNull();
      const kept = (await b.get("k"))!;
      expect([...kept.data, kept.contentType]).toEqual([1, "text/plain"]);
      await b.delete("k");
      expect(await b.put("k", Uint8Array.of(3), { ifNoneMatch: "*" })).not.toBeNull();
    });

    it("writes with ifMatch only when the version is the current one", async () => {
      const b = await make({});
      expect(await b.put("k", Uint8Array.of(1), { ifMatch: "anything" })).toBeNull();
      expect(await b.get("k")).toBeNull();
      const v1 = (await b.put("k", Uint8Array.of(1), { contentType: "text/plain" }))!.version;
      const v2 = (await b.put("k", Uint8Array.of(2), { ifMatch: v1 }))!.version;
      expect(v2).not.toBe(v1);
      expect(await b.put("k", Uint8Array.of(3), { ifMatch: v1, contentType: "text/html" })).toBeNull();
      const kept = (await b.get("k"))!;
      expect([...kept.data, kept.version]).toEqual([2, v2]);
      expect(kept.contentType).toBeUndefined();
      await b.delete("k");
      expect(await b.put("k", Uint8Array.of(4), { ifMatch: v2 })).toBeNull();
      expect(await b.get("k")).toBeNull();
    });

    it("refuses a bad condition before it writes", async () => {
      const b = await make({});
      const bad: unknown[] = [{ ifMatch: "" }, { ifMatch: 1 }, { ifMatch: null }, { ifNoneMatch: "x" }, { ifNoneMatch: "" }, { ifMatch: "v", ifNoneMatch: "*" }];
      for (const options of bad) await expect(b.put("k", Uint8Array.of(1), options as never)).rejects.toThrow();
      expect(await b.get("k")).toBeNull();
    });

    // Two instances on one backend, as two Worker isolates on one bucket.
    it("lets only one of two instances create a key at the same time", async () => {
      for (let round = 0; round < 5; round++) {
        const shared = crypto.randomUUID();
        const [one, two] = [await make({ shared }), await make({ shared })];
        const results = await Promise.all([one, two, one, two].map((b, i) => b.put("k", Uint8Array.of(i), { ifNoneMatch: "*" })));
        expect(results.filter((r) => r !== null)).toHaveLength(1);
      }
    });

    it("loses no update when two instances run a compare-and-swap loop on one key", async () => {
      const shared = crypto.randomUUID();
      const [one, two] = [await make({ shared }), await make({ shared })];
      await one.put("counter", Uint8Array.of(0));
      const bump = async (b: Blobs) => {
        for (let tries = 0; tries < 100; tries++) {
          const current = (await b.get("counter"))!;
          if (await b.put("counter", Uint8Array.of(current.data[0]! + 1), { ifMatch: current.version })) return;
        }
        throw new Error("could not win a write in 100 tries");
      };
      await Promise.all(Array.from({ length: 12 }, (_, i) => bump(i % 2 === 0 ? one : two)));
      expect((await one.get("counter"))!.data[0]).toBe(12);
    });

    it("signs the response headers into a download URL", async () => {
      const b = await make({});
      const get = (extra: object = {}) => b.signedUrl("a", { method: "GET", expiresInSeconds: 60, ...extra });
      const urls = await Promise.all([
        get(),
        get({ responseContentDisposition: "attachment" }),
        get({ responseContentDisposition: 'attachment; filename="a.csv"' }),
        get({ responseContentType: "text/csv" }),
        get({ responseContentType: "text/csv; charset=utf-8" }),
        get({ responseContentDisposition: "attachment", responseContentType: "text/csv" }),
      ]);
      expect(new Set(urls).size).toBe(6);
    });

    it("refuses a response header that could split the response or is not a header value", async () => {
      const b = await make({});
      const sign = (extra: object) => b.signedUrl("a", { method: "GET", expiresInSeconds: 60, ...extra });
      const disposition = ["", "attachment\r\nSet-Cookie: x=1", "attachment\n", "a\u0000b", "attachment; filename=é", "x".repeat(1025), 5];
      const type = ["", "text", "text/csv\r\nX: y", "text/csv\u0000", "/csv", "text/", "x/".concat("y".repeat(300)), 5];
      for (const responseContentDisposition of disposition) await expect(sign({ responseContentDisposition })).rejects.toThrow();
      for (const responseContentType of type) await expect(sign({ responseContentType })).rejects.toThrow();
      await expect(b.signedUrl("a", { method: "PUT", expiresInSeconds: 60, responseContentType: "text/csv" })).rejects.toThrow();
    });

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

export interface AuthHarness {
  auth: Auth;
  /** Returns a credential for `context`. It stops working at `expiresAt` (epoch ms). */
  issue(context: PrincipalContext, options?: { expiresAt?: number }): Promise<string>;
  revoke(credential: string): Promise<void>;
}

const CONTEXT: PrincipalContext = {
  principalId: "agent-2",
  kind: "agent_of_agent",
  chain: [
    { id: "human-1", kind: "human" },
    { id: "agent-1", kind: "agent_of_human" },
    { id: "agent-2", kind: "agent_of_agent" },
  ],
  scopes: ["docs:read"],
};

export function runAuthContract(make: (options: AdapterOptions) => AuthHarness | Promise<AuthHarness>): void {
  describe("Auth contract", () => {
    const bearer = (token: string) => new Request("https://x.test/", { headers: { authorization: `Bearer ${token}` } });

    it("returns the context for a good credential, as a copy", async () => {
      const h = await make({});
      const token = await h.issue(CONTEXT);
      const got = (await h.auth.authenticate(bearer(token)))!;
      expect(got).toEqual(CONTEXT);
      expect(token.length).toBeGreaterThanOrEqual(32);
      got.scopes.push("*:admin");
      expect(await h.auth.authenticate(bearer(token))).toEqual(CONTEXT);
    });

    it("returns null, and does not throw, for a missing, wrong, or garbage credential", async () => {
      const h = await make({});
      const token = await h.issue(CONTEXT);
      const headers: (string | undefined)[] = [undefined, "", "Bearer", "Bearer ", "Bearer nope", `Basic ${token}`, `Bearer ${token}x`, `Bearer ${token.slice(1)}`, "Bearer " + "a".repeat(100_000)];
      for (const value of headers) {
        const request = new Request("https://x.test/", value === undefined ? {} : { headers: { authorization: value } });
        expect(await h.auth.authenticate(request)).toBeNull();
      }
    });

    it("stops accepting a revoked credential and leaves the others alone", async () => {
      const h = await make({});
      const [gone, kept] = [await h.issue(CONTEXT), await h.issue(CONTEXT)];
      await h.revoke(gone);
      expect(await h.auth.authenticate(bearer(gone))).toBeNull();
      expect(await h.auth.authenticate(bearer(kept))).not.toBeNull();
    });

    it("stops accepting a credential at its expiry time", async () => {
      let t = 1_000;
      const h = await make({ now: () => t });
      const token = await h.issue(CONTEXT, { expiresAt: 2_000 });
      t = 1_999;
      expect(await h.auth.authenticate(bearer(token))).not.toBeNull();
      t = 2_000;
      expect(await h.auth.authenticate(bearer(token))).toBeNull();
    });
  });
}

export function runRealtimeContract(make: (options: AdapterOptions & { keys: RoomKey[] }) => Realtime | Promise<Realtime>): void {
  describe("Realtime contract", () => {
    const [k1, k2] = [{ id: "k1", secret: "first-secret-0123456789-0123456789" }, { id: "k2", secret: "second-secret-0123456789-0123456789" }];
    const grant = { room: "doc:1", principalId: "human-1", access: "write" as const, ttlSeconds: 60 };
    const swap = (token: string, index: number, text: string) => token.split(".").map((p, i) => (i === index ? text : p)).join(".");
    const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");

    it("round-trips a grant and reports the region", async () => {
      const r = await make({ keys: [k1], now: () => 5_000 });
      expect(await r.verifyRoomToken(await r.issueRoomToken(grant), "doc:1")).toEqual({
        room: "doc:1",
        principalId: "human-1",
        access: "write",
        expiresAt: 65_000,
      });
      expect(r.region).toBe("unknown");
    });

    it("rejects another room, a changed payload, a changed signature, and a changed key id", async () => {
      const r = await make({ keys: [k1, k2] });
      const token = await r.issueRoomToken(grant);
      const payload = token.split(".")[1]!;
      const upgraded = b64({ ...JSON.parse(Buffer.from(payload, "base64url").toString()), access: "write", room: "doc:2" });
      expect(await r.verifyRoomToken(token, "doc:2")).toBeNull();
      expect(await r.verifyRoomToken(swap(token, 1, upgraded), "doc:2")).toBeNull();
      expect(await r.verifyRoomToken(swap(token, 2, "A".repeat(43)), "doc:1")).toBeNull();
      expect(await r.verifyRoomToken(swap(token, 0, "k2"), "doc:1")).toBeNull();
    });

    it("rejects a token at its exact expiry time", async () => {
      let t = 0;
      const r = await make({ keys: [k1], now: () => t });
      const token = await r.issueRoomToken(grant);
      t = 59_999;
      expect(await r.verifyRoomToken(token, "doc:1")).not.toBeNull();
      t = 60_000;
      expect(await r.verifyRoomToken(token, "doc:1")).toBeNull();
    });

    it("returns null for text that is not a token, and does not throw", async () => {
      const r = await make({ keys: [k1] });
      const good = await r.issueRoomToken(grant);
      for (const text of ["", "a", "a.b", "a.b.c.d", "k1..", "k1.%%%.%%%", "k1.e30.e30", good + ".x", "k1." + "a".repeat(100_000) + ".x"]) {
        expect(await r.verifyRoomToken(text, "doc:1")).toBeNull();
      }
    });

    it("signs with the first key and still accepts the older keys, until they are removed", async () => {
      const old = await make({ keys: [k1] });
      const oldToken = await old.issueRoomToken(grant);
      const rotated = await make({ keys: [k2, k1] });
      const newToken = await rotated.issueRoomToken(grant);
      expect(newToken.startsWith("k2.")).toBe(true);
      expect(await rotated.verifyRoomToken(oldToken, "doc:1")).not.toBeNull();
      expect(await rotated.verifyRoomToken(newToken, "doc:1")).not.toBeNull();
      expect(await (await make({ keys: [k2] })).verifyRoomToken(oldToken, "doc:1")).toBeNull();
      expect(await old.verifyRoomToken(newToken, "doc:1")).toBeNull();
      const same = await make({ keys: [{ id: "k1", secret: "another-secret-0123456789-0123456789" }] });
      expect(await same.verifyRoomToken(oldToken, "doc:1")).toBeNull();
    });

    it("refuses a room key secret under 32 bytes, counting bytes and not characters", async () => {
      const refuse = (secret: unknown) => expect(Promise.resolve().then(() => make({ keys: [{ id: "k1", secret: secret as string }] }))).rejects.toThrow();
      for (const secret of ["", "a".repeat(16), "a".repeat(31), "é".repeat(15), undefined, null, 32, new Uint8Array(32)]) await refuse(secret);
      for (const secret of ["a".repeat(32), "é".repeat(16), "🔑".repeat(8)]) expect(await make({ keys: [{ id: "k1", secret }] })).toBeDefined();
    });

    it("refuses bad keys and bad lifetimes", async () => {
      await expect(Promise.resolve().then(() => make({ keys: [] }))).rejects.toThrow();
      await expect(Promise.resolve().then(() => make({ keys: [{ id: "k1", secret: "short" }] }))).rejects.toThrow();
      await expect(Promise.resolve().then(() => make({ keys: [{ id: "a.b", secret: k1.secret }] }))).rejects.toThrow();
      await expect(Promise.resolve().then(() => make({ keys: [k1, { ...k2, id: "k1" }] }))).rejects.toThrow();
      const r = await make({ keys: [k1] });
      for (const ttlSeconds of [0, -1, 1.5, 86_401]) await expect(r.issueRoomToken({ ...grant, ttlSeconds })).rejects.toThrow();
      await expect(r.issueRoomToken({ ...grant, access: "admin" as "write" })).rejects.toThrow();
      await expect(r.issueRoomToken({ ...grant, room: "" })).rejects.toThrow();
    });
  });
}

export interface MailHarness {
  mail: Mail;
  /** Every message the adapter accepted, oldest first. */
  delivered(): MailMessage[] | Promise<MailMessage[]>;
}

export function runMailContract(make: (options: AdapterOptions) => MailHarness | Promise<MailHarness>): void {
  describe("Mail contract", () => {
    const message: MailMessage = { to: "ana@example.test", subject: "Invite", text: "Open the link." };

    it("delivers a message and gives each send its own id", async () => {
      const h = await make({});
      const [a, b] = [await h.mail.send(message), await h.mail.send({ ...message, html: "<p>Open</p>" })];
      expect(a.id).not.toBe(b.id);
      expect(await h.delivered()).toEqual([message, { ...message, html: "<p>Open</p>" }]);
      expect(h.mail.region).toBe("unknown");
    });

    it("refuses a bad address, a header injection, and an empty or huge body, and sends nothing", async () => {
      const h = await make({});
      const bad: Partial<MailMessage>[] = [
        { to: "" }, { to: "no-at-sign" }, { to: "a@b" }, { to: "a b@example.test" }, { to: "a@example.test,b@example.test" },
        { to: "a@example.test\r\nBcc: x@example.test" }, { to: "<a@example.test>" }, { to: "a\x00\x7f@example.test" },
        { subject: "" }, { subject: "Hi\r\nBcc: x@example.test" }, { subject: "x".repeat(999) },
        { text: "" }, { text: "x".repeat(200_001) },
        { subject: 7 as unknown as string }, { text: 42 as unknown as string }, { text: {} as unknown as string }, { html: null as unknown as string }, { html: {} as unknown as string }, { to: 5 as unknown as string },
      ];
      for (const patch of bad) await expect(h.mail.send({ ...message, ...patch })).rejects.toThrow();
      expect(await h.delivered()).toEqual([]);
    });
  });
}

export interface QueueHarness {
  queue: Queue;
  /** Delivers every message that is due now, retries included, then returns. */
  run(): Promise<void>;
  /** Bodies that failed every attempt on `topic`. */
  dead(topic: string): Json[] | Promise<Json[]>;
}

export function runQueueContract(make: (options: AdapterOptions) => QueueHarness | Promise<QueueHarness>): void {
  describe("Queue contract", () => {
    it("delivers in send order, keeps topics apart, and gives the handler a copy", async () => {
      const h = await make({});
      const got: Json[] = [];
      const other: Json[] = [];
      h.queue.consume("a", async (body) => void got.push(body));
      h.queue.consume("b", async (body) => void other.push(body));
      const body = { n: 1 };
      await h.queue.send("a", body);
      body.n = 99;
      await h.queue.send("b", "x");
      await h.queue.send("a", 2);
      await h.run();
      expect(got).toEqual([{ n: 1 }, 2]);
      expect(other).toEqual(["x"]);
    });

    it("holds a message until a handler exists and until its delay has passed", async () => {
      let t = 0;
      const h = await make({ now: () => t });
      const got: Json[] = [];
      await h.queue.send("a", "early");
      await h.queue.send("a", "late", { delaySeconds: 10 });
      await h.run();
      h.queue.consume("a", async (body) => void got.push(body));
      await h.run();
      expect(got).toEqual(["early"]);
      t = 9_999;
      await h.run();
      expect(got).toEqual(["early"]);
      t = 10_000;
      await h.run();
      expect(got).toEqual(["early", "late"]);
    });

    it("retries a failing handler with a growing attempt number, then parks the message", async () => {
      const h = await make({});
      const attempts: number[] = [];
      h.queue.consume("a", async (_body, meta) => {
        attempts.push(meta.attempt);
        throw new Error("boom");
      });
      await h.queue.send("a", { id: 1 });
      await h.run();
      expect(attempts).toEqual([1, 2, 3]);
      expect(await h.dead("a")).toEqual([{ id: 1 }]);
      await h.run();
      expect(attempts).toEqual([1, 2, 3]);
    });

    it("stops retrying once a handler succeeds", async () => {
      const h = await make({});
      const attempts: number[] = [];
      h.queue.consume("a", async (_body, meta) => {
        attempts.push(meta.attempt);
        if (meta.attempt < 2) throw new Error("once");
      });
      await h.queue.send("a", 1);
      await h.run();
      expect(attempts).toEqual([1, 2]);
      expect(await h.dead("a")).toEqual([]);
    });

    it("refuses a second handler, a bad topic, a bad delay, and a body that is not JSON", async () => {
      const h = await make({});
      h.queue.consume("a", async () => {});
      expect(() => h.queue.consume("a", async () => {})).toThrow();
      expect(() => h.queue.consume("Bad Topic", async () => {})).toThrow();
      await expect(h.queue.send("Bad Topic", 1)).rejects.toThrow();
      for (const delaySeconds of [-1, 1.5, 86_401]) await expect(h.queue.send("a", 1, { delaySeconds })).rejects.toThrow();
      const loop: Doc = {};
      loop.self = loop;
      await expect(h.queue.send("a", loop)).rejects.toThrow();
      expect(h.queue.region).toBe("unknown");
    });
  });
}

// Failure-mode list for the change log. Each case is a way a change could go unrecorded or leak.
//  1. A grant, a revoke, an invite, an accept, a link, and a link revoke each write one entry
//     with the actor, its kind and chain, the target, the action, the time, and the request id.
//  2. A change that fails (a caller who is not an owner, the last owner) writes no entry.
//  3. An entry holds no email, no handle, no link token, and no hash of one.
//  4. The log lists newest first, and a cursor reaches every entry once.
//  5. An agent's change is labeled with the agent kind and keeps the chain.
export function runAuditContract(make: Make<Store, StoreOptions>): void {
  describe("Audit contract", () => {
    const person = (id: string, requestId = `req-${id}`): PrincipalContext => ({ principalId: id, kind: "human", chain: [{ id, kind: "human" }], scopes: ["*:admin"], requestId });
    const setup = async () => {
      let t = 1_000;
      const store = await make({});
      const sharing = createSharing(store, { now: () => ++t });
      await sharing.createResource(person("ana"), { id: "doc1", type: "doc" });
      return { sharing, ana: person("ana", "req-1") };
    };
    const log = async (sharing: Awaited<ReturnType<typeof setup>>["sharing"], ctx: PrincipalContext) =>
      (await sharing.listAudit(ctx, "doc1", { limit: 200 })).entries.filter((e) => e.targetKind !== undefined);

    it("writes one entry for each change, with actor, target, action, time, and request id", async () => {
      const { sharing, ana } = await setup();
      await sharing.grant(ana, "doc1", { kind: "human", id: "bo" }, "editor");
      await sharing.revokeGrant(ana, "doc1", { kind: "human", id: "bo" });
      const invite = await sharing.createInvite(ana, "doc1", { role: "viewer", email: "cy@example.test" });
      await sharing.acceptInvite(person("cy"), invite.id, { email: "cy@example.test" });
      const link = await sharing.createLink(ana, "doc1", { role: "viewer" });
      await sharing.revokeLink(ana, link.id);
      const entries = await log(sharing, ana);
      expect(entries.map((e) => [e.action, e.targetKind, e.targetId]).reverse()).toEqual([
        ["grant.set", "human", "bo"],
        ["grant.revoke", "human", "bo"],
        ["invite.create", "invite", invite.id],
        ["invite.accept", "invite", invite.id],
        ["link.create", "link", link.id],
        ["link.revoke", "link", link.id],
      ]);
      const [first] = entries.slice(-1) as [AuditEntry];
      expect(first).toMatchObject({ principalId: "ana", principalKind: "human", rootId: "ana", resourceId: "doc1", requestId: "req-1", outcome: "allowed", chain: [{ id: "ana", kind: "human" }] });
      expect(typeof first.at).toBe("number");
      expect(entries.find((e) => e.action === "invite.accept")).toMatchObject({ principalId: "cy", requestId: "req-cy" });
    });

    it("writes no entry for a change that fails", async () => {
      const { sharing, ana } = await setup();
      await expect(sharing.grant(person("bo"), "doc1", { kind: "human", id: "bo" }, "owner")).rejects.toThrow();
      await expect(sharing.revokeGrant(ana, "doc1", { kind: "human", id: "ana" })).rejects.toThrow("last owner");
      await expect(sharing.createInvite(ana, "doc1", { role: "viewer" })).rejects.toThrow();
      // A revoke of a grant that was never made changes nothing.
      await sharing.revokeGrant(ana, "doc1", { kind: "human", id: "nobody" });
      expect(await log(sharing, ana)).toEqual([]);
    });

    it("keeps emails, handles, and link tokens out of the log", async () => {
      const { sharing, ana } = await setup();
      await sharing.createInvite(ana, "doc1", { role: "viewer", email: "cy@example.test" });
      await sharing.createInvite(ana, "doc1", { role: "viewer", handle: "scribe" });
      const link = await sharing.createLink(ana, "doc1", { role: "viewer" });
      const text = JSON.stringify((await sharing.listAudit(ana, "doc1", { limit: 200 })).entries);
      expect(text).not.toContain("example.test");
      expect(text).not.toContain("scribe");
      expect(text).not.toContain(link.token);
    });

    it("lists newest first and pages with a cursor", async () => {
      const { sharing, ana } = await setup();
      for (let i = 0; i < 5; i++) await sharing.grant(ana, "doc1", { kind: "human", id: `u${i}` }, "viewer");
      const seen: string[] = [];
      let cursor: string | undefined;
      for (let pages = 0; pages < 10; pages++) {
        const page = await sharing.listAudit(ana, "doc1", { limit: 2, ...(cursor === undefined ? {} : { cursor }) });
        seen.push(...page.entries.filter((e) => e.targetId !== undefined).map((e) => e.targetId as string));
        if ((cursor = page.nextCursor) === undefined) break;
      }
      expect(seen).toEqual(["u4", "u3", "u2", "u1", "u0"]);
    });

    it("lists what a person and their agents did, newest first, in pages", async () => {
      const { sharing, ana } = await setup();
      const agent: PrincipalContext = { principalId: "p1", kind: "agent_of_human", chain: [{ id: "ana", kind: "human" }, { id: "p1", kind: "agent_of_human" }], scopes: ["doc:admin"] };
      await sharing.grant(ana, "doc1", { kind: "human", id: "bo" }, "viewer");
      await sharing.createLink(agent, "doc1", { role: "viewer" });
      await sharing.grant(person("zed"), "doc1", { kind: "human", id: "bo" }, "viewer").catch(() => undefined);
      const seen: string[] = [];
      let cursor: string | undefined;
      for (let pages = 0; pages < 10; pages++) {
        const page = await sharing.listPersonAudit(ana, { limit: 2, ...(cursor === undefined ? {} : { cursor }) });
        seen.push(...page.entries.map((e) => e.action));
        if ((cursor = page.nextCursor) === undefined) break;
      }
      expect(seen).toEqual(["link.create", "grant.set"]);
      await expect(sharing.listPersonAudit(agent)).rejects.toThrow("forbidden");
    });

    it("labels a delegated agent and keeps its chain", async () => {
      const { sharing, ana } = await setup();
      const agent: PrincipalContext = { principalId: "p1", kind: "agent_of_human", chain: [{ id: "ana", kind: "human" }, { id: "p1", kind: "agent_of_human" }], scopes: ["doc:admin"] };
      await sharing.createLink(agent, "doc1", { role: "viewer" });
      const [entry] = await log(sharing, ana);
      expect(entry).toMatchObject({ action: "link.create", principalId: "p1", principalKind: "agent_of_human", machineMade: true, rootId: "ana", chain: [{ id: "ana", kind: "human" }, { id: "p1", kind: "agent_of_human" }] });
    });
  });
}

// Claim failure cases are listed before the contract: rival owners, duplicate references,
// failed creates/trash, lost claims during trash/restore, stale release, and corrupt data.
export function runResourceClaimContract(make: Make<Store, StoreOptions>): void {
  describe("Resource claim contract", () => {
    const ana = { kind: "human", id: "ana" } as const;
    const bo = { kind: "agent", id: "bo" } as const;
    const noop = async () => {};
    const setup = async () => {
      const shared = `claims-${crypto.randomUUID()}`;
      const [store, other] = await Promise.all([make({ shared }), make({ shared })]);
      return { store, a: createSharing(store), b: createSharing(other) };
    };

    it("allows exactly one subject across two stores that claim concurrently", async () => {
      const { store, a, b } = await setup();
      const results = await Promise.allSettled([
        a.claimResource("doc", ana, "ref-a", (tx) => tx.put("refs", "ref-a", { active: true })),
        b.claimResource("doc", bo, "ref-b", (tx) => tx.put("refs", "ref-b", { active: true })),
      ]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      const failure = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
      expect(failure.reason).toBeInstanceOf(ResourceClaimConflictError);
      expect((await store.query("refs")).items).toHaveLength(1);
    });

    it("reclaims idempotently and keeps the owner until the last reference releases", async () => {
      const { a, b } = await setup();
      await a.claimResource("doc", ana, "ref-a", noop);
      await expect(b.claimResource("doc", { kind: "agent", id: ana.id }, "ref-a", noop)).rejects.toBeInstanceOf(ResourceClaimConflictError);
      await b.claimResource("doc", ana, "ref-a", noop);
      await b.claimResource("doc", ana, "ref-b", noop);
      await a.releaseResourceClaim("doc", ana, "ref-a", noop);
      await expect(b.claimResource("doc", bo, "ref-c", noop)).rejects.toBeInstanceOf(ResourceClaimConflictError);
      await expect(a.releaseResourceClaim("doc", ana, "missing", noop)).rejects.toBeInstanceOf(ResourceClaimConflictError);
      await expect(a.releaseResourceClaim("doc", bo, "ref-b", noop)).rejects.toBeInstanceOf(ResourceClaimConflictError);
      await b.releaseResourceClaim("doc", ana, "ref-b", noop);
      await b.releaseResourceClaim("doc", ana, "ref-b", noop);
      await b.claimResource("doc", bo, "ref-c", noop);
    });

    it("rolls back a failed create and a failed trash with their reference writes", async () => {
      const { store, a, b } = await setup();
      const fail = async (tx: StoreOps) => {
        await tx.put("refs", "ref", { active: false });
        throw new Error("host failed");
      };
      await expect(a.claimResource("doc", ana, "ref", fail)).rejects.toThrow("host failed");
      expect(await store.get("refs", "ref")).toBeNull();
      await b.claimResource("doc", bo, "ref", (tx) => tx.put("refs", "ref", { active: true }));
      await expect(b.releaseResourceClaim("doc", bo, "ref", fail)).rejects.toThrow("host failed");
      expect(await store.get("refs", "ref")).toEqual({ active: true });
      await expect(a.claimResource("doc", ana, "new", noop)).rejects.toBeInstanceOf(ResourceClaimConflictError);
    });

    it("coordinates concurrent trash/restore and refuses restore after another owner claims", async () => {
      const { store, a, b } = await setup();
      const active = (value: boolean) => async (tx: StoreOps) => {
        const ref = await tx.get("refs", "ref");
        if (ref && typeof ref.active !== "boolean") throw new Error("bad reference");
        await tx.put("refs", "ref", { active: value });
      };
      await a.claimResource("doc", ana, "ref", active(true));
      await Promise.all([
        a.releaseResourceClaim("doc", ana, "ref", active(false)),
        b.claimResource("doc", ana, "ref", active(true)),
      ]);
      const ref = await store.get("refs", "ref");
      expect(Boolean(await store.get("resource_claims", "doc"))).toBe(ref!.active);
      await a.releaseResourceClaim("doc", ana, "ref", active(false));
      await b.claimResource("doc", bo, "other", noop);
      await expect(a.claimResource("doc", ana, "ref", active(true))).rejects.toBeInstanceOf(ResourceClaimConflictError);
      expect(await store.get("refs", "ref")).toEqual({ active: false });
    });

    it("exports and erases claims without touching another subject kind", async () => {
      const { store, a } = await setup();
      await a.claimResource("doc", ana, "ref", noop);
      await a.claimResource("other", { kind: "agent", id: ana.id }, "ref", noop);
      expect((await exportPerson(store, ana.id)).resourceClaims).toEqual([
        { resourceId: "doc", subjectKind: ana.kind, subjectId: ana.id, references: ["ref"] },
      ]);
      await deletePerson(store, ana.id);
      expect(await store.get("resource_claims", "doc")).toBeNull();
      expect(await store.get("resource_claims", "other")).not.toBeNull();
      await a.claimResource("doc", bo, "new", noop);
    });

    it("caps references with a typed conflict and still permits release", async () => {
      const { store, a } = await setup();
      const references = Array.from({ length: MAX_RESOURCE_CLAIM_REFERENCES }, (_, i) => `ref-${i}`);
      await store.put("resource_claims", "doc", { subjectKind: ana.kind, subjectId: ana.id, references });
      await a.claimResource("doc", ana, "ref-0", noop);
      await expect(a.claimResource("doc", ana, "extra", noop)).rejects.toBeInstanceOf(ResourceClaimConflictError);
      await a.releaseResourceClaim("doc", ana, "ref-0", noop);
      await a.claimResource("doc", ana, "extra", noop);
    });

    it("fails closed on corrupt claims and rejects invalid subjects or ids", async () => {
      const { store, a } = await setup();
      for (const held of ([{}, { subjectKind: ana.kind, subjectId: ana.id, references: null }, { subjectKind: ana.kind, subjectId: ana.id, references: [] }, { subjectKind: ana.kind, subjectId: ana.id, references: ["ref", "ref"] }] as Doc[])) {
        await store.put("resource_claims", "doc", held);
        await expect(a.claimResource("doc", ana, "ref", noop)).rejects.toBeInstanceOf(ResourceClaimConflictError);
        await expect(a.releaseResourceClaim("doc", ana, "ref", noop)).rejects.toBeInstanceOf(ResourceClaimConflictError);
      }
      await expect(a.claimResource("bad:id", ana, "ref", noop)).rejects.toThrow("invalid claim id");
      await expect(a.claimResource("doc", { kind: "human", id: "" }, "ref", noop)).rejects.toThrow("invalid subject");
    });
  });
}
