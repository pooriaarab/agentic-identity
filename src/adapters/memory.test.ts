import { expect, it } from "vitest";
import { runBlobsContract, runStoreContract } from "../testing.js";
import { createMemoryBlobs, createMemoryStore } from "./memory.js";

runStoreContract((options) => createMemoryStore(options));
runBlobsContract((options) => createMemoryBlobs(options));

it("keeps stores without a shared name apart", async () => {
  const [one, two] = [createMemoryStore(), createMemoryStore()];
  await one.put("docs", "a", { x: 1 });
  expect(await two.get("docs", "a")).toBeNull();
});

it("does not claim a region that nobody checked", () => {
  expect(createMemoryStore().region).toBe("unknown");
  expect(createMemoryBlobs().region).toBe("unknown");
});
