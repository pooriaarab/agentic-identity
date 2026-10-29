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

/**
 * The grants these principals hold. A grant belongs to a person (`human`) or to an agent with its
 * own identity (`agent`), never to the other kind with the same id. A grant stored before kinds
 * existed has no kind. It goes too, so an erase leaves nothing behind.
 */
async function grantsOf(store: Store, personId: string, principals: Docs): Promise<Docs> {
  const kinds = new Map(principals.map((p) => [p.id, p.id === personId ? "human" : p.data.kind]));
  const found = await many(store, "grants", "subjectId", principals.map((p) => p.id));
  return found.filter((g) => {
    const kind = kinds.get(g.data.subjectId as string);
    return g.data.subjectKind === undefined || g.data.subjectKind === kind;
  });
}

/** The resources that only these people own. A resource that someone else owns stays, even inside a deleted folder. */
async function soleOwned(store: Store, mine: Docs): Promise<string[]> {
  const gone = new Set(mine.map((g) => g.id));
  const sole: string[] = [];
  for (const g of mine.filter((g) => g.data.role === "owner")) {
    const owners = await all(store, "grants", { resourceId: g.data.resourceId as string, role: "owner" });
    if (owners.every((o) => gone.has(o.id))) sole.push(g.data.resourceId as string);
  }
  return sole;
}

export async function exportPerson(store: Store, personId: string) {
  const principals = await principalsOf(store, personId);
  const ids = principals.map((p) => p.id);
  const grants = await grantsOf(store, personId, principals);
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
    // Entries the person made, and entries of changes that named the person.
    audit: [...new Map([...(await many(store, "audit", "principalId", ids)), ...(await many(store, "audit", "targetId", ids))].map((a) => [a.id, a.data])).values()],
  };
}

const ERASED = "erased";

/** Blanks the target of every audit entry that names one of these ids. */
async function redactTargets(store: Store, targetIds: string[]): Promise<void> {
  for (const entry of await many(store, "audit", "targetId", targetIds)) await store.put("audit", entry.id, { ...entry.data, targetId: ERASED });
}

/** Removes the data first and the sign-in last, so a failed delete can run again. */
export async function deletePerson(store: Store, personId: string): Promise<void> {
  const principals = await principalsOf(store, personId);
  const ids = principals.map((p) => p.id);
  const user = await store.get("users", personId);
  const remove = async (collection: string, docs: Docs) => void (await Promise.all(docs.map((d) => store.delete(collection, d.id))));
  const mine = await grantsOf(store, personId, principals);
  const owned = await soleOwned(store, mine);
  for (const collection of ["grants", "links", "invites", "audit"]) await remove(collection, await many(store, collection, "resourceId", owned));
  await Promise.all(owned.map((id) => store.delete("resources", id)));
  await remove("grants", mine);
  // Entries about a person or an invite that goes are kept, with the target blanked, so a log of
  // changes on a resource that stays does not name what was erased.
  const gone = new Set(ids);
  const invites = await many(store, "invites", "createdBy", ids);
  if (typeof user?.email === "string") invites.push(...(await all(store, "invites", { email: user.email })));
  invites.forEach((i) => gone.add(i.id));
  await redactTargets(store, [...gone]);
  await remove("invites", invites);
  await remove("audit", await many(store, "audit", "principalId", ids));
  await remove("credentials", await many(store, "credentials", "principalId", ids));
  // A freed handle can be made again, so an invite to it must go, or its next owner would accept it.
  const handles = principals.flatMap((p) => (typeof p.data.handle === "string" ? [p.data.handle] : []));
  const handleInvites = await many(store, "invites", "handle", handles);
  await redactTargets(store, handleInvites.map((i) => i.id));
  await remove("invites", handleInvites);
  await Promise.all(handles.map((handle) => store.delete("handles", handle)));
  await Promise.all(principals.map((p) => store.delete("principals", p.id)));
  await store.delete("users", personId);
}
