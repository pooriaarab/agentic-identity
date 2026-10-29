// An in-process fake of the Firestore REST surface that the adapter uses: get, runQuery,
// commit, beginTransaction, and rollback. It locks like Firestore: a transaction locks each doc
// it reads (a missing doc too, and every doc a query returns), a write from outside waits for
// the lock, and a transaction that waits too long gets 409 ABORTED. Used when no emulator runs.
type Value = Record<string, unknown>;
type Fields = Record<string, Value>;
interface Stored {
  fields: Fields;
}
interface Waiter {
  owner: string;
  grant: () => void;
}
interface Lock {
  owner: string;
  queue: Waiter[];
}

class HttpError extends Error {
  constructor(
    readonly code: number,
    readonly status: string,
  ) {
    super(status);
  }
}

const decode = (value: Value): unknown => {
  if ("nullValue" in value) return null;
  if ("booleanValue" in value) return value.booleanValue;
  if ("integerValue" in value) return Number(value.integerValue);
  if ("doubleValue" in value) return value.doubleValue;
  if ("stringValue" in value) return value.stringValue;
  if ("referenceValue" in value) return value.referenceValue;
  return undefined; // a map or an array: never equal to a scalar
};
const kind = (value: Value): string => {
  const tag = Object.keys(value)[0]!;
  return tag === "integerValue" || tag === "doubleValue" ? "number" : tag;
};

const compare = (a: unknown, b: unknown): number =>
  typeof a !== typeof b ? (typeof a < typeof b ? -1 : 1) : (a as string) < (b as string) ? -1 : (a as string) > (b as string) ? 1 : 0;

export interface FakeFirestoreOptions {
  /** How long a transaction waits for a lock before Firestore aborts it. Defaults to 1000 ms. */
  lockTimeoutMs?: number;
}

/** One fake database. Pass the returned `fetch` to `createFirestoreStore`. Two stores that share a fake share data. */
export function createFakeFirestore(options: FakeFirestoreOptions = {}): { fetch: typeof fetch } {
  const timeout = options.lockTimeoutMs ?? 1000;
  const docs = new Map<string, Stored>();
  const locks = new Map<string, Lock>();
  const transactions = new Map<string, Set<string>>();
  let counter = 0;

  const acquire = (path: string, owner: string): Promise<void> => {
    const lock = locks.get(path);
    if (!lock) {
      locks.set(path, { owner, queue: [] });
      return Promise.resolve();
    }
    if (lock.owner === owner) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = { owner, grant: resolve };
      const timer = setTimeout(() => {
        lock.queue.splice(lock.queue.indexOf(waiter), 1);
        reject(new HttpError(409, "ABORTED"));
      }, timeout);
      waiter.grant = () => {
        clearTimeout(timer);
        resolve();
      };
      lock.queue.push(waiter);
    });
  };

  const release = (path: string, owner: string): void => {
    const lock = locks.get(path);
    if (!lock || lock.owner !== owner) return;
    const next = lock.queue.shift();
    if (!next) {
      locks.delete(path);
      return;
    }
    lock.owner = next.owner;
    next.grant();
  };

  const finish = (transaction: string): void => {
    for (const path of transactions.get(transaction) ?? []) release(path, transaction);
    transactions.delete(transaction);
  };

  const lockFor = async (transaction: string, path: string): Promise<void> => {
    const held = transactions.get(transaction);
    if (!held) throw new HttpError(400, "INVALID_ARGUMENT");
    await acquire(path, transaction);
    held.add(path);
  };

  const snapshot = (relative: string): Stored | undefined => docs.get(relative);

  function runQuery(body: Record<string, any>): { path: string; stored: Stored }[] {
    const q = body.structuredQuery;
    const collection: string = q.from[0].collectionId;
    const filters: any[] = !q.where ? [] : q.where.compositeFilter ? q.where.compositeFilter.filters : [q.where];
    const orderBy: any[] = q.orderBy ?? [];
    const field: string | undefined = orderBy.find((o) => o.field.fieldPath !== "__name__")?.field.fieldPath;
    const sign = orderBy[0]?.direction === "DESCENDING" ? -1 : 1;
    const value = (row: { path: string; stored: Stored }) =>
      field === undefined ? row.path.slice(collection.length + 1) : decode(row.stored.fields[field] ?? { nullValue: null });
    const idOf = (row: { path: string }) => row.path.slice(collection.length + 1);
    const matches = (stored: Stored) =>
      filters.every((f) => {
        if (f.unaryFilter) {
          const present = f.unaryFilter.field.fieldPath in stored.fields;
          const isNull = present && "nullValue" in stored.fields[f.unaryFilter.field.fieldPath]!;
          if (f.unaryFilter.op === "IS_NULL") return isNull;
          if (f.unaryFilter.op === "IS_NOT_NULL") return present && !isNull;
        }
        if (f.fieldFilter?.op === "EQUAL") {
          const got = stored.fields[f.fieldFilter.field.fieldPath];
          return got !== undefined && kind(got) === kind(f.fieldFilter.value) && decode(got) !== undefined && compare(decode(got), decode(f.fieldFilter.value)) === 0;
        }
        throw new HttpError(400, "INVALID_ARGUMENT");
      });
    let rows = [...docs]
      .filter(([path]) => path.startsWith(`${collection}/`) && !path.slice(collection.length + 1).includes("/"))
      .map(([path, stored]) => ({ path, stored }))
      .filter((row) => matches(row.stored));
    const order = (x: { path: string; stored: Stored }, y: { path: string; stored: Stored }) => sign * (compare(value(x), value(y)) || compare(idOf(x), idOf(y)));
    rows.sort(order);
    if (q.startAt) {
      const values: unknown[] = q.startAt.values.map(decode);
      const ref = String(values[values.length - 1]);
      const after = { path: ref.slice(ref.indexOf("/documents/") + "/documents/".length), stored: { fields: {} } as Stored };
      const startValue = field === undefined ? idOf(after) : values[0];
      rows = rows.filter((row) => sign * (compare(value(row), startValue) || compare(idOf(row), idOf(after))) > 0);
    }
    return rows.slice(0, q.limit ?? rows.length);
  }

  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  async function handle(method: string, url: URL, body: any): Promise<Response> {
    const marker = "/documents";
    const at = url.pathname.indexOf(marker);
    if (!url.pathname.startsWith("/v1/projects/") || at < 0) throw new HttpError(404, "NOT_FOUND");
    const database = url.pathname.slice("/v1/".length, at);
    const rest = url.pathname.slice(at + marker.length);
    const relative = (resource: string) => resource.slice(`${database}/documents/`.length);
    const transaction = url.searchParams.get("transaction") ?? body?.transaction ?? undefined;

    if (method === "POST" && rest === ":beginTransaction") {
      const id = btoa(`tx-${++counter}`);
      transactions.set(id, new Set());
      return json(200, { transaction: id });
    }
    if (method === "POST" && rest === ":rollback") {
      finish(body.transaction);
      return json(200, {});
    }
    if (method === "GET") {
      const [, collection, id] = rest.split("/").map(decodeURIComponent);
      const path = `${collection}/${id}`;
      if (transaction !== undefined) await lockFor(transaction, path);
      const found = snapshot(path);
      return found ? json(200, { name: `${database}/documents/${path}`, fields: found.fields }) : json(404, { error: { code: 404, status: "NOT_FOUND" } });
    }
    if (method === "POST" && rest === ":runQuery") {
      let rows = runQuery(body);
      if (transaction !== undefined) {
        // Lock what the query returned, then run it again until it returns nothing unlocked.
        for (let round = 0; round < 10; round++) {
          for (const row of rows) await lockFor(transaction, row.path);
          const again = runQuery(body);
          const held = transactions.get(transaction)!;
          const settled = again.every((row) => held.has(row.path));
          rows = again;
          if (settled) break;
        }
      }
      return json(
        200,
        rows.length === 0 ? [{ readTime: "now" }] : rows.map((row) => ({ document: { name: `${database}/documents/${row.path}`, fields: row.stored.fields }, readTime: "now" })),
      );
    }
    if (method === "POST" && rest === ":commit") {
      const writes: { update?: { name: string; fields: Fields }; delete?: string }[] = body.writes ?? [];
      const paths = [...new Set(writes.map((w) => relative(w.update?.name ?? w.delete!)))].sort();
      const owner = transaction ?? `write-${++counter}`;
      try {
        if (transaction !== undefined && !transactions.has(transaction)) throw new HttpError(400, "INVALID_ARGUMENT");
        for (const path of paths) {
          if (transaction !== undefined) await lockFor(transaction, path);
          else await acquire(path, owner);
        }
        for (const w of writes) {
          if (w.update) docs.set(relative(w.update.name), { fields: w.update.fields });
          else docs.delete(relative(w.delete!));
        }
      } finally {
        if (transaction !== undefined) finish(transaction);
        else for (const path of paths) release(path, owner);
      }
      return json(200, { writeResults: writes.map(() => ({})), commitTime: "now" });
    }
    throw new HttpError(404, "NOT_FOUND");
  }

  return {
    async fetch(input, init) {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      try {
        const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
        return await handle(init?.method ?? "GET", url, body);
      } catch (error) {
        if (error instanceof HttpError) return json(error.code, { error: { code: error.code, status: error.status } });
        throw error;
      }
    },
  };
}
