// A person's data: export it as JSON, or delete it for good. A person owns their
// agents, grants, and tokens (every principal below them), and the resources only
// they own. Each step reads what the earlier steps found, so nothing is guessed.
import type { Doc, Store } from "./ports.js";

type Docs = { id: string; data: Doc }[];

async function all(store: Store, collection: string, where: Record<string, string>): Promise<Docs> {
  const found: Docs = [];
  for (let cursor: string | undefined; ; ) {
    const page = await store.query(collection, { where, ...(cursor ? { cursor } : {}) });
    found.push(...page.items);
    if (!(cursor = page.nextCursor)) return found;
  }
}

const many = async (store: Store, collection: string, field: string, values: string[]) =>
  (await Promise.all(values.map((value) => all(store, collection, { [field]: value })))).flat();

/** The person, the agents they made, and every principal below any of them. */
async function principalsOf(store: Store, personId: string): Promise<Docs> {
  const found = new Map<string, Doc>();
  let frontier = [personId, ...(await all(store, "principals", { ownerId: personId })).map((p) => p.id)];
  for (let depth = 0; frontier.length > 0 && depth < 8; depth++) {
    const batch = frontier.filter((id) => !found.has(id));
    for (const id of batch) found.set(id, ((await store.get("principals", id)) ?? {}) as Doc);
    frontier = (await many(store, "principals", "parentId", batch)).map((p) => p.id);
  }
  return [...found].map(([id, data]) => ({ id, data }));
}

/** The resources that only these people own. A resource that someone else owns stays, even inside a deleted folder. */
async function soleOwned(store: Store, people: string[]): Promise<string[]> {
  const mine = (await many(store, "grants", "subjectId", people)).filter((g) => g.data.role === "owner");
  const sole: string[] = [];
  for (const g of mine) {
    const owners = (await all(store, "grants", { resourceId: g.data.resourceId as string, role: "owner" })).map((o) => o.data.subjectId as string);
    if (owners.every((o) => people.includes(o))) sole.push(g.data.resourceId as string);
  }
  return sole;
}

export async function exportPerson(store: Store, personId: string) {
  const principals = await principalsOf(store, personId);
  const ids = principals.map((p) => p.id);
  const grants = await many(store, "grants", "subjectId", ids);
  const resources = await Promise.all([...new Set(grants.map((g) => g.data.resourceId as string))].map((id) => store.get("resources", id)));
  const credentials = (await many(store, "credentials", "principalId", ids)).map(({ data }) => ({ principalId: data.principalId, kind: data.kind, label: data.label ?? null, expiresAt: data.expiresAt ?? null, revokedAt: data.revokedAt ?? null }));
  const invites = (await many(store, "invites", "createdBy", ids)).map(({ data }) => ({ id: data.id, resourceId: data.resourceId, role: data.role, acceptedAt: data.acceptedAt ?? null }));
  return {
    user: await store.get("users", personId),
    principals: principals.map((p) => p.data),
    credentials,
    grants: grants.map((g) => g.data),
    resources: resources.filter((r) => r !== null),
    invites,
    audit: (await many(store, "audit", "principalId", ids)).map((a) => a.data),
  };
}

/** Removes the data first and the sign-in last, so a failed delete can run again. */
export async function deletePerson(store: Store, personId: string): Promise<void> {
  const principals = await principalsOf(store, personId);
  const ids = principals.map((p) => p.id);
  const user = await store.get("users", personId);
  const remove = async (collection: string, docs: Docs) => void (await Promise.all(docs.map((d) => store.delete(collection, d.id))));
  const owned = await soleOwned(store, ids);
  for (const collection of ["grants", "links", "invites", "audit"]) await remove(collection, await many(store, collection, "resourceId", owned));
  await Promise.all(owned.map((id) => store.delete("resources", id)));
  await remove("grants", await many(store, "grants", "subjectId", ids));
  await remove("invites", await many(store, "invites", "createdBy", ids));
  if (typeof user?.email === "string") await remove("invites", await all(store, "invites", { email: user.email }));
  await remove("audit", await many(store, "audit", "principalId", ids));
  await remove("credentials", await many(store, "credentials", "principalId", ids));
  // A freed handle can be made again, so an invite to it must go, or its next owner would accept it.
  const handles = principals.flatMap((p) => (typeof p.data.handle === "string" ? [p.data.handle] : []));
  await remove("invites", await many(store, "invites", "handle", handles));
  await Promise.all(handles.map((handle) => store.delete("handles", handle)));
  await Promise.all(principals.map((p) => store.delete("principals", p.id)));
  await store.delete("users", personId);
}
