import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmdirSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { runResourceClaimContract, runAuditContract, runStoreContract } from "../testing.js";
import { StoreConflictError } from "../ports.js";
import { createFileStore } from "./file.js";

const dir = mkdtempSync(join(tmpdir(), "ai-file-"));
let n = 0;
const pathFor = (shared?: string) => join(dir, `${shared ?? `own-${n++}`}.json`);

runStoreContract((options) => createFileStore({ ...options, path: pathFor(options.shared) }));
runAuditContract((options) => createFileStore({ ...options, path: pathFor(options.shared) }));
runResourceClaimContract((options) => createFileStore({ ...options, path: pathFor(options.shared) }));

it("writes a private file that a fresh process would read back", async () => {
  const path = pathFor();
  const store = createFileStore({ path });
  await store.put("docs", "a", { x: 1 });
  await store.transaction(async (tx) => {
    await tx.put("docs", "b", { x: 2 });
    await tx.delete("docs", "a");
  });
  expect(statSync(path).mode & 0o777).toBe(0o600);
  expect(JSON.parse(readFileSync(path, "utf8")).collections).toEqual({ docs: { b: { x: 2 } } });
});

it("keeps nothing from a transaction that throws", async () => {
  const path = pathFor();
  const store = createFileStore({ path });
  await store.put("docs", "a", { x: 1 });
  await expect(store.transaction(async (tx) => { await tx.put("docs", "b", { x: 2 }); throw new Error("no"); })).rejects.toThrow("no");
  expect(JSON.parse(readFileSync(path, "utf8")).collections).toEqual({ docs: { a: { x: 1 } } });
});

it("refuses a file that is not a store", async () => {
  const path = pathFor();
  writeFileSync(path, '{"hello":1}');
  await expect(createFileStore({ path }).get("docs", "a")).rejects.toThrow("not an agentic-identity store file");
});

const onDisk = (path: string) => JSON.parse(readFileSync(path, "utf8")).collections;

it("keeps the writes of two stores made at once on a file that already has data", async () => {
  const path = pathFor();
  writeFileSync(path, JSON.stringify({ format: 1, collections: { docs: { seed: { x: 0 } } } }));
  const [a, b] = [createFileStore({ path }), createFileStore({ path })];
  await Promise.all([a.put("docs", "fromA", { x: 1 }), b.put("docs", "fromB", { x: 2 })]);
  expect(Object.keys(onDisk(path).docs).sort()).toEqual(["fromA", "fromB", "seed"]);
});

it("reads a change that another process made to the file", async () => {
  const path = pathFor();
  const store = createFileStore({ path });
  await store.put("docs", "a", { x: 1 });
  // Another process replaces the file, as a save does.
  writeFileSync(`${path}.other`, JSON.stringify({ format: 1, collections: { docs: { a: { x: 1 }, theirs: { x: 9 } } } }));
  renameSync(`${path}.other`, path);
  expect(await store.get("docs", "theirs")).toEqual({ x: 9 });
  await store.put("docs", "mine", { x: 2 });
  expect(Object.keys(onDisk(path).docs).sort()).toEqual(["a", "mine", "theirs"]);
});

it("refuses a write that another process overtook, and keeps nothing of it", async () => {
  const path = pathFor();
  const store = createFileStore({ path });
  await store.put("docs", "a", { x: 1 });
  await expect(
    store.transaction(async (tx) => {
      await tx.get("docs", "a");
      // The other process saves while this write is still pending.
      writeFileSync(`${path}.other`, JSON.stringify({ format: 1, collections: { docs: { a: { x: 1 }, theirs: { x: 9 } } } }));
      renameSync(`${path}.other`, path);
      await tx.put("docs", "late", { x: 3 });
    }),
  ).rejects.toThrow(StoreConflictError);
  expect(Object.keys(onDisk(path).docs).sort()).toEqual(["a", "theirs"]);
  expect(await store.get("docs", "late")).toBeNull();
  expect(await store.get("docs", "theirs")).toEqual({ x: 9 });
});

it("does not keep a write whose save failed", async () => {
  const path = pathFor();
  const store = createFileStore({ path });
  await store.put("docs", "a", { x: 1 });
  // A folder cannot be removed as a stale lock, so the lock stays held.
  mkdirSync(`${path}.lock`);
  await expect(store.put("docs", "b", { x: 2 })).rejects.toThrow("locked");
  rmdirSync(`${path}.lock`);
  expect(await store.get("docs", "b")).toBeNull();
  await store.put("docs", "c", { x: 3 });
  expect(Object.keys(onDisk(path).docs).sort()).toEqual(["a", "c"]);
}, 15_000);

it("refuses a file that holds a doc that is not an object", async () => {
  for (const docs of [{ local: null }, { x: "str" }, { y: [1] }]) {
    const path = pathFor();
    writeFileSync(path, JSON.stringify({ format: 1, collections: { principals: docs } }));
    await expect(createFileStore({ path }).get("principals", "x")).rejects.toThrow("not an agentic-identity store file");
  }
});

it("does not show a collection name from a bad file", async () => {
  const path = pathFor();
  writeFileSync(path, JSON.stringify({ format: 1, collections: { "a b@ex.io": { x: {} } } }));
  const error = await createFileStore({ path }).get("docs", "a").catch((e: Error) => e);
  expect(String(error)).toContain("not an agentic-identity store file");
  expect(String(error)).not.toContain("ex.io");
});

it("does not show the start of a file that is not a store", async () => {
  const path = pathFor();
  writeFileSync(path, "jo@ex.io");
  const error = await createFileStore({ path }).get("docs", "a").catch((e: Error) => e);
  expect(String(error)).toContain("not an agentic-identity store file");
  expect(String(error)).not.toContain("ex.io");
});

it("keeps memory and file the same when two calls overlap", async () => {
  const path = pathFor();
  const s = createFileStore({ path });
  await s.put("docs", "k", { v: "0" });
  const a = s.transaction(async (tx) => {
    await tx.put("docs", "k", { v: "A" });
  });
  const b = (async () => {
    await null;
    await null;
    return s.put("docs", "k", { v: "B" });
  })();
  await Promise.all([a, b]);
  expect(await s.get("docs", "k")).toEqual(onDisk(path).docs.k);
});

it("notices a replacement of the file that has the same size", async () => {
  const path = pathFor();
  const store = createFileStore({ path });
  await store.put("docs", "a", { x: 1 });
  writeFileSync(`${path}.other`, readFileSync(path, "utf8").replace('"x":1', '"x":2'));
  renameSync(`${path}.other`, path);
  expect(await store.get("docs", "a")).toEqual({ x: 2 });
});

it("removes a lock that a crash left behind", async () => {
  const path = pathFor();
  const store = createFileStore({ path });
  await store.put("docs", "a", { x: 1 });
  writeFileSync(`${path}.lock`, "crashed");
  const old = new Date(Date.now() - 60_000);
  utimesSync(`${path}.lock`, old, old);
  await store.put("docs", "b", { x: 2 });
  expect(Object.keys(onDisk(path).docs).sort()).toEqual(["a", "b"]);
});
