import { mkdtempSync, readdirSync } from "node:fs";
import { readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { runAuditContract, runBlobsContract, runStoreContract } from "../testing.js";
import { createFileBlobs, createFileStore } from "./file.js";

// `shared` names one dataset, so it maps to one folder. Without it, each store gets a fresh folder.
const dirs = new Map<string, string>();
const dirFor = (shared?: string) => {
  if (shared === undefined) return mkdtempSync(join(tmpdir(), "aid-file-"));
  if (!dirs.has(shared)) dirs.set(shared, mkdtempSync(join(tmpdir(), "aid-file-")));
  return dirs.get(shared)!;
};
const URL_SECRET = "s".repeat(32);

runStoreContract(({ shared, ...rest }) => createFileStore({ ...rest, dir: dirFor(shared) }));
runAuditContract(({ shared, ...rest }) => createFileStore({ ...rest, dir: dirFor(shared) }));
runBlobsContract(({ shared, ...rest }) =>
  createFileBlobs({ ...rest, dir: dirFor(shared), urlBase: "https://files.example/blob", urlSecret: URL_SECRET }),
);

it("keeps keys with slashes, dots, and long names apart and leaves no temp file", async () => {
  const dir = dirFor();
  const blobs = createFileBlobs({ dir });
  const keys = ["a/b", "a", "../x", "a/b/", "é/ü", "k".repeat(2000), "A", "a\\b"];
  for (const [i, k] of keys.entries()) await blobs.put(k, Uint8Array.of(i));
  for (const [i, k] of keys.entries()) expect((await blobs.get(k))!.data).toEqual(Uint8Array.of(i));
  const store = createFileStore({ dir });
  await store.put("docs", "Ab", { n: 1 });
  await store.put("docs", "aB", { n: 2 });
  expect((await store.get("docs", "Ab"))!.n).toBe(1);
  expect((await store.get("docs", "aB"))!.n).toBe(2);
  const all = [...readdirSync(join(dir, "blobs")), ...readdirSync(join(dir, "docs", "docs"))];
  expect(all.filter((n) => n.endsWith(".tmp"))).toEqual([]);
});

it("reads the data again from a new instance on the same folder", async () => {
  const dir = dirFor();
  await createFileStore({ dir }).put("docs", "a", { x: 1 });
  await createFileBlobs({ dir }).put("k", Uint8Array.of(7), { contentType: "text/plain" });
  expect(await createFileStore({ dir }).get("docs", "a")).toEqual({ x: 1 });
  expect(await createFileBlobs({ dir }).head("k")).toMatchObject({ size: 1, contentType: "text/plain" });
});

it("refuses to sign without a URL secret of 32 bytes", async () => {
  expect(() => createFileBlobs({ dir: dirFor(), urlBase: "https://x.example/b", urlSecret: "short" })).toThrow();
  await expect(createFileBlobs({ dir: dirFor() }).signedUrl("k", { method: "GET", expiresInSeconds: 60 })).rejects.toThrow();
});

it("lets one of two waiters take a lock that a dead process left", async () => {
  const dir = dirFor();
  const blobs = createFileBlobs({ dir });
  await blobs.put("k", Uint8Array.of(0));
  const old = new Date(Date.now() - 120_000);
  await writeFile(join(dir, "blobs", ".lock"), "dead-owner");
  await utimes(join(dir, "blobs", ".lock"), old, old);
  const [one, two] = [createFileBlobs({ dir }), createFileBlobs({ dir })];
  const version = (await one.head("k"))!.version;
  const results = await Promise.all([one, two, one, two].map((b, i) => b.put("k", Uint8Array.of(i + 1), { ifMatch: version })));
  expect(results.filter((r) => r !== null)).toHaveLength(1);
});

it("does not remove a lock that another owner holds", async () => {
  const dir = dirFor();
  const blobs = createFileBlobs({ dir });
  await blobs.put("k", Uint8Array.of(0));
  // The token on disk is not ours, as when another process took over a stale lock.
  await writeFile(join(dir, "blobs", ".lock"), "someone-else");
  const wait = blobs.put("k", Uint8Array.of(1)).catch(() => null);
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(await readFile(join(dir, "blobs", ".lock"), "utf8")).toBe("someone-else");
  await rm(join(dir, "blobs", ".lock"));
  expect(await wait).not.toBeNull();
});

it("throws on a damaged doc file and never reads it as a missing doc", async () => {
  const dir = dirFor();
  const store = createFileStore({ dir });
  await store.put("docs", "a", { x: 1 });
  const folder = join(dir, "docs", "docs");
  const file = join(folder, readdirSync(folder).find((n) => n.endsWith(".json"))!);
  for (const text of ["null", "{}", "", "{", '{"id":"other","version":"v","doc":{}}', '{"id":"a","version":"v","doc":"str"}', '{"id":"a","version":"","doc":{}}']) {
    await writeFile(file, text);
    await expect(store.get("docs", "a")).rejects.toThrow(/damaged/);
    await expect(store.query("docs")).rejects.toThrow(/damaged/);
    await expect(store.put("docs", "b", { y: 1 }).then(() => store.transaction(async (tx) => tx.get("docs", "a")))).rejects.toThrow(/damaged/);
  }
});

it("leaves no temp file when a transaction or a refused put does not commit", async () => {
  const dir = dirFor();
  const store = createFileStore({ dir });
  await store.put("docs", "z", { x: 0 });
  await expect(
    store.transaction(async (tx) => {
      await tx.put("docs", "a", { x: 1 });
      throw new Error("stop");
    }),
  ).rejects.toThrow("stop");
  const blobs = createFileBlobs({ dir });
  await blobs.put("k", Uint8Array.of(1));
  expect(await blobs.put("k", Uint8Array.of(2), { ifNoneMatch: "*" })).toBeNull();
  const names = [...readdirSync(join(dir, "blobs")), ...readdirSync(join(dir, "docs"), { recursive: true }).map(String)];
  expect(names.filter((n) => n.endsWith(".tmp"))).toEqual([]);
});
