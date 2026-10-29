import { mkdtempSync, readdirSync } from "node:fs";
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
