import { runBlobsContract, runStoreContract } from "../testing.js";
import { createMemoryBlobs, createMemoryStore } from "./memory.js";

runStoreContract((options) => createMemoryStore(options));
runBlobsContract((options) => createMemoryBlobs(options));
