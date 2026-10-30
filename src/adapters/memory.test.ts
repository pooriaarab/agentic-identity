import { expect, it } from "vitest";
import { runResourceClaimContract, runAuthContract, runAuditContract, runBlobsContract, runMailContract, runQueueContract, runRealtimeContract, runStoreContract } from "../testing.js";
import { createHmacRealtime } from "./hmac.js";
import { createMemoryAuth, createMemoryBlobs, createMemoryMail, createMemoryQueue, createMemoryStore } from "./memory.js";

runStoreContract((options) => createMemoryStore(options));
runAuditContract((options) => createMemoryStore(options));
runResourceClaimContract((options) => createMemoryStore(options));
runBlobsContract((options) => createMemoryBlobs(options));
runAuthContract((options) => createMemoryAuth(options));
runRealtimeContract((options) => createHmacRealtime(options));
runMailContract((options) => {
  const mail = createMemoryMail(options);
  return { mail, delivered: () => mail.outbox() };
});
runQueueContract((options) => {
  const queue = createMemoryQueue(options);
  return { queue, run: () => queue.run(), dead: (topic) => queue.dead(topic) };
});

it("keeps stores without a shared name apart", async () => {
  const [one, two] = [createMemoryStore(), createMemoryStore()];
  await one.put("docs", "a", { x: 1 });
  expect(await two.get("docs", "a")).toBeNull();
});

it("does not claim a region that nobody checked", () => {
  expect(createMemoryStore().region).toBe("unknown");
  expect(createMemoryBlobs().region).toBe("unknown");
});
