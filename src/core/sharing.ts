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

export type Resource = { id: string; type: string; parentId?: string | null };
export type Decision = { allowed: boolean; role?: Role };
type Identity = { email?: string; handle?: string };

const randomToken = () => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const sha256 = async (text: string) =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))].map((b) => b.toString(16).padStart(2, "0")).join("");
const finiteOrAbsent = (v: unknown) => v === undefined || v === null || (typeof v === "number" && Number.isFinite(v));

export function createSharing(store: Store, options: { now?: () => number } = {}) {
  const now = options.now ?? Date.now;
  const forbidden = () => new Error("forbidden");
  const subjectOf = (ctx: PrincipalContext) => ctx.chain[0]?.id;

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
    const subject = ctx && subjectOf(ctx);
    for (const folder of subject ? found.path : []) {
      best = Math.max(best, rank((await store.get("grants", `${folder}:${subject}`))?.role));
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
  const keepAnotherOwner = async (tx: StoreOps, resourceId: string, subjectId: string) => {
    const owners = await tx.query("grants", { where: { resourceId, role: "owner" }, limit: 2 });
    if (!owners.items.some((o) => o.data.subjectId !== subjectId)) throw new Error("the last owner cannot be removed");
  };
  const putGrant = (tx: Pick<Store, "put">, resourceId: string, subjectId: string, role: Role) =>
    tx.put("grants", `${resourceId}:${subjectId}`, { resourceId, subjectId, role });

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

    async grant(ctx: PrincipalContext, resourceId: string, subjectId: string, role: Role): Promise<void> {
      assertRole(role);
      if (!SAFE_ID.test(subjectId)) throw new Error("invalid subject");
      await requireAdmin(ctx, resourceId);
      await store.transaction(async (tx) => {
        if (role !== "owner" && (await tx.get("grants", `${resourceId}:${subjectId}`))?.role === "owner") await keepAnotherOwner(tx, resourceId, subjectId);
        await putGrant(tx, resourceId, subjectId, role);
      });
    },

    async revokeGrant(ctx: PrincipalContext, resourceId: string, subjectId: string): Promise<void> {
      await requireAdmin(ctx, resourceId);
      await store.transaction(async (tx) => {
        if ((await tx.get("grants", `${resourceId}:${subjectId}`))?.role === "owner") await keepAnotherOwner(tx, resourceId, subjectId);
        await tx.delete("grants", `${resourceId}:${subjectId}`);
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
        const current = rank((await tx.get("grants", `${invite.resourceId}:${subject}`))?.role);
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
