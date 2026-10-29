import { mkdtempSync, readdirSync } from "node:fs";
import { readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { runBlobsContract } from "../testing.js";
import { createFileBlobs } from "./file.js";

// `shared` names one dataset, so it maps to one folder. Without it, each adapter gets a fresh folder.
const dirs = new Map<string, string>();
const dirFor = (shared?: string) => {
  if (shared === undefined) return mkdtempSync(join(tmpdir(), "aid-fileblobs-"));
  if (!dirs.has(shared)) dirs.set(shared, mkdtempSync(join(tmpdir(), "aid-fileblobs-")));
  return dirs.get(shared)!;
};
const URL_SECRET = "s".repeat(32);

runBlobsContract(({ shared, ...rest }) =>
  createFileBlobs({ ...rest, dir: dirFor(shared), urlBase: "https://files.example/blob", urlSecret: URL_SECRET }),
);

it("keeps keys with slashes, dots, and long names apart and leaves no temp file", async () => {
  const dir = dirFor();
  const blobs = createFileBlobs({ dir });
  const keys = ["a/b", "a", "../x", "a/b/", "é/ü", "k".repeat(2000), "A", "a\\b"];
  for (const [i, k] of keys.entries()) await blobs.put(k, Uint8Array.of(i));
  for (const [i, k] of keys.entries()) expect((await blobs.get(k))!.data).toEqual(Uint8Array.of(i));
  expect(readdirSync(join(dir, "blobs")).filter((n) => n.endsWith(".tmp"))).toEqual([]);
});

it("reads the data again from a new instance on the same folder", async () => {
  const dir = dirFor();
  await createFileBlobs({ dir }).put("k", Uint8Array.of(7), { contentType: "text/plain" });
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

it("waits on a fresh lock and leaves it alone", async () => {
  const dir = dirFor();
  const blobs = createFileBlobs({ dir });
  await blobs.put("k", Uint8Array.of(0));
  // The token on disk is not ours, as when another process holds the lock.
  await writeFile(join(dir, "blobs", ".lock"), "someone-else");
  const wait = blobs.put("k", Uint8Array.of(1)).catch(() => null);
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(await readFile(join(dir, "blobs", ".lock"), "utf8")).toBe("someone-else");
  await rm(join(dir, "blobs", ".lock"));
  expect(await wait).not.toBeNull();
});

it("leaves no temp file when a put is refused", async () => {
  const dir = dirFor();
  const blobs = createFileBlobs({ dir });
  await blobs.put("k", Uint8Array.of(1));
  expect(await blobs.put("k", Uint8Array.of(2), { ifNoneMatch: "*" })).toBeNull();
  expect(readdirSync(join(dir, "blobs")).filter((n) => n.endsWith(".tmp"))).toEqual([]);
});

it("throws on a blob header of the wrong shape", async () => {
  const dir = dirFor();
  const blobs = createFileBlobs({ dir });
  await blobs.put("k", Uint8Array.of(1));
  const file = join(dir, "blobs", readdirSync(join(dir, "blobs")).find((n) => n.endsWith(".blob"))!);
  for (const header of ["null", '{"key":"k","size":1}', '{"key":"k","size":1,"version":"v","contentType":5}']) {
    const text = Buffer.from(header);
    const lead = Buffer.alloc(4);
    lead.writeUInt32BE(text.length);
    await writeFile(file, Buffer.concat([lead, text, Buffer.from([1])]));
    await expect(blobs.get("k")).rejects.toThrow(/damaged/);
    await expect(blobs.head("k")).rejects.toThrow(/damaged/);
  }
});
