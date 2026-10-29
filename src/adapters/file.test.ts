import { mkdtempSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { runAuditContract, runStoreContract } from "../testing.js";
import { StoreConflictError } from "../ports.js";
import { createFileStore } from "./file.js";

const dir = mkdtempSync(join(tmpdir(), "ai-file-"));
let n = 0;
const pathFor = (shared?: string) => join(dir, `${shared ?? `own-${n++}`}.json`);

runStoreContract((options) => createFileStore({ ...options, path: pathFor(options.shared) }));
runAuditContract((options) => createFileStore({ ...options, path: pathFor(options.shared) }));

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
  writeFileSync(`${path}.lock`, "");
  await expect(store.put("docs", "b", { x: 2 })).rejects.toThrow("locked");
  unlinkSync(`${path}.lock`);
  expect(await store.get("docs", "b")).toBeNull();
  await store.put("docs", "c", { x: 3 });
  expect(Object.keys(onDisk(path).docs).sort()).toEqual(["a", "c"]);
}, 10_000);

it("writes only the run of a transaction that committed", async () => {
  const path = pathFor();
  const [one, two] = [createFileStore({ path }), createFileStore({ path })];
  await one.put("docs", "a", { x: 0 });
  let runs = 0;
  await one.transaction(async (tx) => {
    runs++;
    await tx.get("docs", "a");
    if (runs === 1) await two.put("docs", "a", { x: 5 });
    await tx.put("docs", `run${runs}`, { runs });
  });
  expect(runs).toBe(2);
  expect(Object.keys(onDisk(path).docs).sort()).toEqual(["a", "run2"]);
});

it("refuses a file that holds a doc that is not an object", async () => {
  for (const docs of [{ local: null }, { x: "str" }, { y: [1] }]) {
    const path = pathFor();
    writeFileSync(path, JSON.stringify({ format: 1, collections: { principals: docs } }));
    await expect(createFileStore({ path }).get("principals", "x")).rejects.toThrow("not an agentic-identity store file");
  }
});

it("refuses a write when the file was read again in this process after the transaction began", async () => {
  const path = pathFor();
  const [one, two] = [createFileStore({ path }), createFileStore({ path })];
  await one.put("docs", "a", { n: 0 });
  await expect(
    one.transaction(async (tx) => {
      const a = await tx.get("docs", "a");
      // Another process saves a = 10. A second store here reads the file again, then this write lands.
      writeFileSync(`${path}.other`, JSON.stringify({ format: 1, collections: { docs: { a: { n: 10 } } } }));
      renameSync(`${path}.other`, path);
      await two.get("docs", "a");
      await tx.put("docs", "a", { n: (a?.n as number) + 1 });
    }),
  ).rejects.toThrow(StoreConflictError);
  expect(onDisk(path).docs.a).toEqual({ n: 10 });
  expect(await one.get("docs", "a")).toEqual({ n: 10 });
});

it("does not show the start of a file that is not a store", async () => {
  const path = pathFor();
  writeFileSync(path, "jo@ex.io");
  const error = await createFileStore({ path }).get("docs", "a").catch((e: Error) => e);
  expect(String(error)).toContain("not an agentic-identity store file");
  expect(String(error)).not.toContain("ex.io");
});
