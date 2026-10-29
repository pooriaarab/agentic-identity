import { builtinModules } from "node:module";
import { build } from "esbuild";
import { describe, expect, test } from "vitest";

const builtins = new Set(builtinModules.map((name) => name.replace(/^node:/, "")));

function isNodeImport(path: string): boolean {
  return path.startsWith("node:") || builtins.has(path.split("/")[0] ?? path);
}

describe("worker bundles", () => {
  test.each(["src/index.ts", "src/sdk.ts", "src/worker.ts"])(
    "%s imports no Node builtin",
    async (entry) => {
      const result = await build({
        entryPoints: [entry],
        bundle: true,
        write: false,
        metafile: true,
        format: "esm",
        platform: "neutral",
        conditions: ["workerd", "worker", "browser"],
        mainFields: ["module", "main"],
        external: ["node:*"],
        logLevel: "silent",
      });
      const found = Object.values(result.metafile.outputs)
        .flatMap((out) => out.imports)
        .map((imp) => imp.path)
        .filter(isNodeImport);
      expect(found).toEqual([]);
    },
  );
});
