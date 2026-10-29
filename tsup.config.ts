import { readFileSync } from "node:fs";
import { defineConfig } from "tsup";

const pkg = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf8"),
) as { version: string };

export default defineConfig({
  entry: ["src/index.ts", "src/testing.ts", "src/adapters/cloudflare.ts", "src/adapters/firestore.ts", "src/worker.ts", "src/sdk.ts", "src/http.ts"],
  external: ["vitest"],
  format: ["esm"],
  dts: true,
  clean: true,
  define: {
    __PACK_VERSION__: JSON.stringify(pkg.version),
  },
});
