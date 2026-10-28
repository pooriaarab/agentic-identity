import { expect, it } from "vitest";
import { runBlobsContract, runStoreContract } from "../testing.js";
import { createMemoryBlobs, createMemoryStore } from "./memory.js";

runStoreContract((options) => createMemoryStore(options));
runBlobsContract((options) => createMemoryBlobs(options));

it("does not claim a region that nobody checked", () => {
  expect(createMemoryStore().region).toBe("unknown");
  expect(createMemoryBlobs().region).toBe("unknown");
});
