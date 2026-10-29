import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { runAuditContract, runStoreContract } from "../testing.js";
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
