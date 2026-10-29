import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
    // Contention tests wait on real locks in the Firestore emulator.
    testTimeout: process.env.FIRESTORE_EMULATOR_HOST ? 300_000 : 5_000,
  },
});
