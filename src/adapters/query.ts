// The query rules of the `Store` port, for adapters that read every doc of a collection and
// filter in memory (the memory and Netlify adapters).
import { DEFAULT_LIMIT, assertField, type Doc, type Json, type Query } from "../ports.js";

const compare = (a: Json, b: Json): number =>
  typeof a !== typeof b ? (typeof a < typeof b ? -1 : 1) : (a as string) < (b as string) ? -1 : (a as string) > (b as string) ? 1 : 0;

/** Filters, sorts, and cuts one page. The rows are the docs of one collection. */
export function selectPage(rows: Iterable<{ id: string; doc: Doc }>, query: Query): { page: { id: string; doc: Doc }[]; nextCursor?: string } {
  const limit = query.limit ?? DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1) throw new RangeError("limit must be an integer of 1 or more");
  for (const name of Object.keys(query.where ?? {})) assertField(name);
  const field = query.orderBy?.field;
  if (field !== undefined) assertField(field);
  const sign = query.orderBy?.direction === "desc" ? -1 : 1;
  const order = (x: { v: Json; id: string }, y: { v: Json; id: string }) => sign * (compare(x.v, y.v) || compare(x.id, y.id));
  let sorted = [...rows]
    .filter(({ doc }) => Object.entries(query.where ?? {}).every(([k, v]) => k in doc && doc[k] === v))
    .map((row) => ({ ...row, v: (field === undefined ? row.id : row.doc[field]) as Json }))
    .filter((row) => row.v !== undefined && row.v !== null)
    .sort(order);
  if (query.cursor !== undefined) {
    let after: { v: Json; id: string };
    try {
      const [v, id] = JSON.parse(Buffer.from(query.cursor, "base64url").toString()) as [Json, string];
      if (typeof id !== "string") throw new Error();
      after = { v, id };
    } catch {
      throw new Error("invalid cursor");
    }
    sorted = sorted.filter((row) => order(row, after) > 0);
  }
  const page = sorted.slice(0, limit);
  const last = page[page.length - 1];
  return {
    page,
    ...(sorted.length > limit && last ? { nextCursor: Buffer.from(JSON.stringify([last.v, last.id])).toString("base64url") } : {}),
  };
}
