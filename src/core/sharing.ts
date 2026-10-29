// Sharing: resources, roles, folders, invites, links, and `can`.
// Roles belong to the root of a chain (the person, or an agent with its own
// identity). A delegated agent gets that role, cut down by its scopes.
import type { Doc, Store, StoreOps } from "../ports.js";
import { auditEntry, hasScope, type Action, type AuditEntry, type PrincipalContext } from "./principals.js";

export const ROLES = ["viewer", "commenter", "editor", "owner"] as const;
export type Role = (typeof ROLES)[number];

/** The role an action needs. */
const NEEDS: Record<Action, Role> = { read: "viewer", comment: "commenter", write: "editor", admin: "owner" };
/** The most resources on a path to the root, the resource included. */
export const MAX_FOLDER_DEPTH = 16;

const rank = (role: unknown) => ROLES.indexOf(role as Role);
/** The default and the largest page of `listAudit`. */
export const AUDIT_PAGE = 50;
export const MAX_AUDIT_PAGE = 200;
const linkRoles: readonly Role[] = ROLES.filter((r) => r !== "owner");
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;

/** The kinds of principal that sit at the root of a chain, so the kinds that hold a role. */
export const SUBJECT_KINDS = ["human", "agent"] as const;
export type SubjectKind = (typeof SUBJECT_KINDS)[number];
/** Who holds a role. A person and an agent with the same id are two subjects. */
export type Subject = { kind: SubjectKind; id: string };
export type Grant = { resourceId: string; subjectKind: SubjectKind; subjectId: string; role: Role };

export type Resource = { id: string; type: string; parentId?: string | null };
export type Decision = { allowed: boolean; role?: Role };
type Identity = { email?: string; handle?: string };

const randomToken = () => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const sha256 = async (text: string) =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))].map((b) => b.toString(16).padStart(2, "0")).join("");
const finiteOrAbsent = (v: unknown) => v === undefined || v === null || (typeof v === "number" && Number.isFinite(v));

/** `:` cannot be in a resource id, a kind, or a subject id, so a key names one grant. */
const grantKey = (resourceId: string, subject: Subject) => `${resourceId}:${subject.kind}:${subject.id}`;

const putGrant = (tx: Pick<Store, "put">, resourceId: string, subject: Subject, role: Role) =>
  tx.put("grants", grantKey(resourceId, subject), { resourceId, subjectKind: subject.kind, subjectId: subject.id, role });

const assertSubject = (subject: unknown): Subject => {
  const { kind, id } = (subject ?? {}) as Partial<Subject>;
  if (!SUBJECT_KINDS.includes(kind as SubjectKind)) throw new Error(`invalid subject kind "${String(kind)}"`);
  if (typeof id !== "string" || !SAFE_ID.test(id)) throw new Error("invalid subject");
  return { kind: kind as SubjectKind, id };
};

export function createSharing(store: Store, options: { now?: () => number } = {}) {
  const now = options.now ?? Date.now;
  const forbidden = () => new Error("forbidden");
  /** The root of the chain. A root of another kind holds no role. */
  const subjectOf = (ctx: PrincipalContext): Subject | undefined => {
    const root = ctx.chain[0];
    return root && SUBJECT_KINDS.includes(root.kind as SubjectKind) ? { kind: root.kind as SubjectKind, id: root.id } : undefined;
  };

  /** The resource and its folders, nearest first. Null for a cycle, a path over the cap, or no resource. */
  async function pathOf(id: string): Promise<{ type: string; path: string[] } | null> {
    const path: string[] = [];
    let type: string | undefined;
    for (let cur: string | null | undefined = id; cur != null; ) {
      const found: Resource | null = await store.get<Resource>("resources", cur);
      if (!found) break;
      if (path.length >= MAX_FOLDER_DEPTH || path.includes(cur)) return null;
      path.push(cur);
      type ??= found.type;
      cur = found.parentId;
    }
    return type === undefined || path[0] !== id ? null : { type, path };
  }

  async function linkRole(token: string, path: string[], signedIn: boolean): Promise<Role | null> {
    if (token === "") return null;
    const [entry] = (await store.query("links", { where: { tokenHash: await sha256(token) }, limit: 1 })).items;
    const link = entry?.data;
    if (!link || !path.includes(link.resourceId as string) || !linkRoles.includes(link.role as Role)) return null;
    if (link.revokedAt != null || !finiteOrAbsent(link.expiresAt) || (link.expiresAt != null && (link.expiresAt as number) <= now())) return null;
    return link.signedInOnly === true && !signedIn ? null : (link.role as Role);
  }

  async function decide(ctx: PrincipalContext | null, action: Action, id: string, linkToken?: string): Promise<Decision> {
    if (!Object.hasOwn(NEEDS, action)) return { allowed: false };
    const found = await pathOf(id);
    if (!found || (ctx && !hasScope(ctx.scopes, `${found.type}:${action}`))) return { allowed: false };
    let best = -1;
    const subject = ctx ? subjectOf(ctx) : undefined;
    for (const folder of subject ? found.path : []) {
      best = Math.max(best, rank((await store.get("grants", grantKey(folder, subject!)))?.role));
    }
    if (linkToken !== undefined) best = Math.max(best, rank(await linkRole(linkToken, found.path, ctx !== null)));
    return best >= 0 && best >= rank(NEEDS[action]) ? { allowed: true, role: ROLES[best] as Role } : { allowed: false, ...(best >= 0 ? { role: ROLES[best] as Role } : {}) };
  }

  const requireAdmin = async (ctx: PrincipalContext, id: string) => {
    if (!(await decide(ctx, "admin", id)).allowed) throw forbidden();
  };
  const assertRole = (role: unknown, allowed: readonly Role[] = ROLES) => {
    if (!allowed.includes(role as Role)) throw new Error(`invalid role "${String(role)}"`);
  };
  // A time that JSON cannot hold (NaN, Infinity) would be stored as null, and null means never expires.
  const safeTime = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
  const futureTime = (value: unknown): number => {
    if (!safeTime(value) || (value as number) <= now()) throw new Error("expiresAt must be a whole time in the future");
    return value as number;
  };
  const lifetime = (ms: unknown): number => {
    if (!safeTime(ms) || !safeTime(now() + (ms as number))) throw new Error("expiresInMs must be a whole number of milliseconds above 0");
    return now() + (ms as number);
  };
  // The query guards the owner docs it returns. A rival demotion of one of them makes this
  // transaction run again, so two demotions never both pass on the same owner.
  // A grant without a valid kind is not honored, so it does not count as an owner.
  const keepAnotherOwner = async (tx: StoreOps, resourceId: string, subject: Subject) => {
    const owners = await tx.query("grants", { where: { resourceId, role: "owner" }, limit: 2 });
    const another = owners.items.some((o) => SUBJECT_KINDS.includes(o.data.subjectKind as SubjectKind) && !(o.data.subjectId === subject.id && o.data.subjectKind === subject.kind));
    if (!another) throw new Error("the last owner cannot be removed");
  };

  return {
    async createResource(ctx: PrincipalContext, input: { id?: string; type: string; parentId?: string }): Promise<Resource> {
      const resource: Resource = { id: input.id ?? crypto.randomUUID(), type: input.type, ...(input.parentId ? { parentId: input.parentId } : {}) };
      if (!/^[a-z][a-z0-9_-]*$/.test(resource.type) || !SAFE_ID.test(resource.id)) throw new Error("invalid resource");
      const subject = subjectOf(ctx);
      if (!subject || !hasScope(ctx.scopes, `${resource.type}:write`)) throw forbidden();
      if (input.parentId && (!(await store.get("resources", input.parentId)) || !(await decide(ctx, "write", input.parentId)).allowed)) throw forbidden();
      await store.transaction(async (tx) => {
        if (await tx.get("resources", resource.id)) throw new Error("resource exists");
        await tx.put("resources", resource.id, resource);
        await putGrant(tx, resource.id, subject, "owner");
      });
      return resource;
    },

    async grant(ctx: PrincipalContext, resourceId: string, subject: Subject, role: Role): Promise<void> {
      assertRole(role);
      const who = assertSubject(subject);
      await requireAdmin(ctx, resourceId);
      await store.transaction(async (tx) => {
        if (role !== "owner" && (await tx.get("grants", grantKey(resourceId, who)))?.role === "owner") await keepAnotherOwner(tx, resourceId, who);
        await putGrant(tx, resourceId, who, role);
      });
    },

    async revokeGrant(ctx: PrincipalContext, resourceId: string, subject: Subject): Promise<void> {
      const who = assertSubject(subject);
      await requireAdmin(ctx, resourceId);
      await store.transaction(async (tx) => {
        if ((await tx.get("grants", grantKey(resourceId, who)))?.role === "owner") await keepAnotherOwner(tx, resourceId, who);
        await tx.delete("grants", grantKey(resourceId, who));
      });
    },

    async createInvite(ctx: PrincipalContext, resourceId: string, input: { role: Role; email?: string; handle?: string; expiresInMs?: number }) {
      assertRole(input.role, linkRoles);
      if ((input.email === undefined) === (input.handle === undefined)) throw new Error("give an email or a handle");
      if (input.email !== undefined && !/^[^\s@]+@[^\s@]+$/.test(input.email)) throw new Error("invalid email");
      const expiresAt = input.expiresInMs === undefined ? undefined : lifetime(input.expiresInMs);
      await requireAdmin(ctx, resourceId);
      const id = crypto.randomUUID();
      await store.put("invites", id, {
        id, resourceId, role: input.role, createdBy: ctx.principalId,
        ...(input.email === undefined ? { handle: input.handle as string } : { email: input.email.toLowerCase() }),
        ...(expiresAt === undefined ? {} : { expiresAt }),
      });
      return { id };
    },

    /** `identity` comes from the verified sign-in: the email claim, or the agent's handle. */
    async acceptInvite(ctx: PrincipalContext, inviteId: string, identity: Identity): Promise<void> {
      const subject = subjectOf(ctx);
      if (!subject || ctx.chain.length !== 1) throw forbidden();
      await store.transaction(async (tx) => {
        const invite = await tx.get("invites", inviteId);
        const mine = invite?.email !== undefined ? ctx.kind === "human" && identity.email?.toLowerCase() === invite.email : ctx.kind === "agent" && identity.handle === invite?.handle;
        const live = invite && invite.acceptedAt === undefined && finiteOrAbsent(invite.expiresAt) && (invite.expiresAt == null || (invite.expiresAt as number) > now());
        if (!invite || !live || !mine) throw forbidden();
        const current = rank((await tx.get("grants", grantKey(invite.resourceId as string, subject)))?.role);
        await tx.put("invites", inviteId, { ...invite, acceptedAt: now() });
        if (rank(invite.role) > current) await putGrant(tx, invite.resourceId as string, subject, invite.role as Role);
      });
    },

    /** The token is returned once. Only its hash is stored. */
    async createLink(ctx: PrincipalContext, resourceId: string, input: { role: Role; expiresAt?: number; signedInOnly?: boolean }) {
      assertRole(input.role, linkRoles);
      const expiresAt = input.expiresAt === undefined ? undefined : futureTime(input.expiresAt);
      await requireAdmin(ctx, resourceId);
      const [id, token] = [crypto.randomUUID(), randomToken()];
      await store.put("links", id, {
        id, resourceId, role: input.role, tokenHash: await sha256(token), signedInOnly: input.signedInOnly === true,
        ...(expiresAt === undefined ? {} : { expiresAt }),
      });
      return { id, token };
    },

    async revokeLink(ctx: PrincipalContext, linkId: string): Promise<void> {
      const link = await store.get("links", linkId);
      if (!link) throw forbidden();
      await requireAdmin(ctx, link.resourceId as string);
      await store.put("links", linkId, { ...link, revokedAt: now() });
    },

    /** Decide, and write the audit entry for an allow and for a deny. `ctx` is null for a link visitor. */
    async can(ctx: PrincipalContext | null, action: Action, resourceId: string, opts: { linkToken?: string } = {}): Promise<Decision> {
      const decision = await decide(ctx, action, resourceId, opts.linkToken);
      const id = crypto.randomUUID();
      const entry = auditEntry(ctx, { id, at: now(), action: Object.hasOwn(NEEDS, action) ? action : "invalid", resourceId, outcome: decision.allowed ? "allowed" : "denied" });
      await store.put("audit", id, entry as unknown as Doc);
      return decision;
    },

    /** Newest first. Pass the `nextCursor` of the last page as `cursor` to read on. */
    async listAudit(ctx: PrincipalContext, resourceId: string, options: { limit?: number; cursor?: string } = {}): Promise<{ entries: AuditEntry[]; nextCursor?: string }> {
      const limit = options.limit ?? AUDIT_PAGE;
      if (!Number.isInteger(limit) || limit < 1 || limit > MAX_AUDIT_PAGE) throw new RangeError(`limit must be a whole number from 1 to ${MAX_AUDIT_PAGE}`);
      if (options.cursor !== undefined && typeof options.cursor !== "string") throw new Error("invalid cursor");
      await requireAdmin(ctx, resourceId);
      const page = await store.query("audit", { where: { resourceId }, orderBy: { field: "at", direction: "desc" }, limit, ...(options.cursor === undefined ? {} : { cursor: options.cursor }) });
      return { entries: page.items.map((item) => item.data as unknown as AuditEntry), ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }) };
    },
  };
}

/**
 * Rewrites grants stored before grants had a kind. They were keyed `<resource>:<id>`. The kind
 * comes from the principal with that id: `human` or `agent`. Until a grant is rewritten it is not
 * honored. A grant whose principal is missing or has another kind is left as it is, and is listed
 * in `unresolved` as its doc id. Run it again after a failure: it skips what is done.
 */
export async function migrateGrants(store: Store): Promise<{ migrated: number; unresolved: string[] }> {
  const legacy: string[] = [];
  for (let cursor: string | undefined; ; ) {
    const page = await store.query("grants", { limit: 100, ...(cursor === undefined ? {} : { cursor }) });
    for (const g of page.items) if (!SUBJECT_KINDS.includes(g.data.subjectKind as SubjectKind)) legacy.push(g.id);
    if ((cursor = page.nextCursor) === undefined) break;
  }
  let migrated = 0;
  const unresolved: string[] = [];
  for (const id of legacy) {
    const done = await store.transaction(async (tx) => {
      const old = await tx.get("grants", id);
      if (!old || typeof old.resourceId !== "string" || typeof old.subjectId !== "string") return false;
      const kind = (await tx.get("principals", old.subjectId))?.kind;
      if (!SUBJECT_KINDS.includes(kind as SubjectKind) || rank(old.role) < 0 || !SAFE_ID.test(old.subjectId) || !SAFE_ID.test(old.resourceId)) return false;
      const subject: Subject = { kind: kind as SubjectKind, id: old.subjectId };
      const present = await tx.get("grants", grantKey(old.resourceId, subject));
      await putGrant(tx, old.resourceId, subject, ROLES[Math.max(rank(old.role), rank(present?.role))] as Role);
      await tx.delete("grants", id);
      return true;
    });
    if (done) migrated++;
    else unresolved.push(id);
  }
  return { migrated, unresolved };
}
