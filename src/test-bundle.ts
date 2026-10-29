// Builds an entry file to one script, so a test can spawn it without `dist/`.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";

export async function bundleEntry(entry: string): Promise<string> {
  const outfile = join(mkdtempSync(join(tmpdir(), "ai-bin-")), "bin.mjs");
  await build({ entryPoints: [entry], bundle: true, platform: "node", format: "esm", outfile, logLevel: "silent", banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" } });
  return outfile;
}
