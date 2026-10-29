import { runStoreContract } from "../testing.js";
import { createMemoryStore } from "./memory.js";
import type { Store } from "../ports.js";

// A store that locks like a Firestore server SDK: a transaction holds the lock while it
// runs, so a plain write from another store waits until the transaction ends. It never
// retries and never throws StoreConflictError. The Store contract must accept it, or a
// correct adapter for such a backend could not pass the shared suite.
const locks = new Map<string, Promise<void>>();

function createPessimisticStore(options: { shared?: string; region?: string } = {}): Store {
  const key = options.shared ?? crypto.randomUUID();
  const inner = createMemoryStore(options as Parameters<typeof createMemoryStore>[0]);
  const locked = async <R>(work: () => Promise<R>): Promise<R> => {
    const before = locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    locks.set(key, new Promise<void>((resolve) => (release = resolve)));
    await before;
    try {
      return await work();
    } finally {
      release();
    }
  };
  return {
    region: inner.region,
    get: (c, id) => inner.get(c, id),
    query: (c, q) => inner.query(c, q),
    put: (c, id, doc) => locked(() => inner.put(c, id, doc)),
    delete: (c, id) => locked(() => inner.delete(c, id)),
    transaction: (fn) => locked(() => inner.transaction(fn)),
  } as Store;
}

runStoreContract((options) => createPessimisticStore(options));
