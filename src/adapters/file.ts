// A Store that keeps its data in one JSON file, for local use and for the CLI. It holds the data in
// memory (the memory adapter does the queries and the transactions) and writes the file after each
// change. One process at a time should use a file: two processes do not see each other's writes.
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseRegion, type AdapterOptions, type Doc, type Store, type StoreOps } from "../ports.js";
import { createMemoryStore } from "./memory.js";

const FORMAT = 1;

interface Shared {
  inner: Store;
  /** What the file holds: collection, then id. */
  mirror: Map<string, Map<string, Doc>>;
  save(): void;
}
const files = new Map<string, Shared>();

const isDoc = (value: unknown): value is Doc => typeof value === "object" && value !== null && !Array.isArray(value);

function readFile(path: string): Map<string, Map<string, Doc>> {
  const mirror = new Map<string, Map<string, Doc>>();
  if (!existsSync(path)) return mirror;
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  const collections = isDoc(parsed) && parsed.format === FORMAT ? parsed.collections : undefined;
  if (!isDoc(collections)) throw new Error(`${path} is not an agentic-identity store file`);
  for (const [name, docs] of Object.entries(collections)) {
    if (!isDoc(docs)) throw new Error(`${path} is not an agentic-identity store file`);
    mirror.set(name, new Map(Object.entries(docs).map(([id, doc]) => [id, doc as Doc])));
  }
  return mirror;
}

async function open(path: string): Promise<Shared> {
  const known = files.get(path);
  if (known) return known;
  const mirror = readFile(path);
  const inner = createMemoryStore({ shared: `file:${path}` });
  for (const [name, docs] of mirror) for (const [id, doc] of docs) await inner.put(name, id, doc);
  const save = () => {
    const collections = Object.fromEntries([...mirror].map(([name, docs]) => [name, Object.fromEntries(docs)]));
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    // Write beside the file and rename, so a crash never leaves half a file.
    const temp = `${path}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify({ format: FORMAT, collections }), { mode: 0o600 });
    chmodSync(temp, 0o600);
    renameSync(temp, path);
  };
  const shared = { inner, mirror, save };
  files.set(path, shared);
  return shared;
}

type Write = { collection: string; id: string; doc: Doc | null };

const apply = (shared: Shared, writes: Write[]) => {
  for (const { collection, id, doc } of writes) {
    if (doc === null) shared.mirror.get(collection)?.delete(id);
    else (shared.mirror.get(collection) ?? shared.mirror.set(collection, new Map()).get(collection)!).set(id, JSON.parse(JSON.stringify(doc)) as Doc);
  }
  if (writes.length > 0) shared.save();
};

/** Stores made on the same path in one process share their data. */
export function createFileStore(options: AdapterOptions & { path: string }): Store {
  const region = options.region === undefined ? "unknown" : parseRegion(options.region);
  const path = resolve(options.path);
  const ready = open(path);
  const trace = (ops: StoreOps, sink: Write[]): StoreOps => ({
    get: (c, id) => ops.get(c, id),
    query: (c, q) => ops.query(c, q),
    async put(collection, id, doc) {
      await ops.put(collection, id, doc);
      sink.push({ collection, id, doc });
    },
    async delete(collection, id) {
      await ops.delete(collection, id);
      sink.push({ collection, id, doc: null });
    },
  });
  const single = async <R>(run: (ops: StoreOps) => Promise<R>): Promise<R> => {
    const shared = await ready;
    const sink: Write[] = [];
    const result = await run(trace(shared.inner, sink));
    apply(shared, sink);
    return result;
  };
  return {
    region,
    get: (collection, id) => single((ops) => ops.get(collection, id)) as never,
    query: (collection, query) => single((ops) => ops.query(collection, query)) as never,
    put: (collection, id, doc) => single((ops) => ops.put(collection, id, doc)),
    delete: (collection, id) => single((ops) => ops.delete(collection, id)),
    async transaction(fn) {
      const shared = await ready;
      let sink: Write[] = [];
      // The memory adapter may run `fn` again, so only the writes of the run that committed count.
      const result = await shared.inner.transaction((tx) => {
        sink = [];
        return fn(trace(tx, sink));
      });
      apply(shared, sink);
      return result;
    },
  };
}
