// Sharing: resources, roles, folders, invites, links, and `can`.
// Roles belong to the root of a chain (the person, or an agent with its own
// identity). A delegated agent gets that role, cut down by its scopes.
import { StoreConflictError, type Doc, type Store, type StoreOps } from "../ports.js";
import { recordChange } from "./audit.js";
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
/** `deleteResource` removes the owner grants in one transaction, so it refuses more owners than this. */
export const MAX_OWNERS_ON_ERASE = 100;

/** `deleteResource` refused: the resource has children, or too many owners. */
export class EraseRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EraseRefusedError";
  }
}
const linkRoles: readonly Role[] = ROLES.filter((r) => r !== "owner");
/** The handle of an agent, as `agents create` and the Worker make it. */
const HANDLE = /^[a-z][a-z0-9_-]{1,31}$/;
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;

/** The kinds of principal that sit at the root of a chain, so the kinds that hold a role. */
export const SUBJECT_KINDS = ["human", "agent"] as const;
export type SubjectKind = (typeof SUBJECT_KINDS)[number];
/** Who holds a role. A person and an agent with the same id are two subjects. */
export type Subject = { kind: SubjectKind; id: string };
export type Grant = { resourceId: string; subjectKind: SubjectKind; subjectId: string; role: Role };

export type Resource = { id: string; type: string; parentId?: string | null };
export type Decision = { allowed: boolean; role?: Role };
export type InviteSummary = { id: string; resourceId: string; role: Role; for: "email" | "handle"; handle?: string; expiresAt?: number; acceptedAt?: number; revokedAt?: number };
type Identity = { email?: string; handle?: string };

/** The invites that one `acceptPendingInvites` call reads. */
const PENDING_PAGE = 50;

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

function pageOf(options: { limit?: number; cursor?: string }): { limit: number; cursor?: string } {
  const limit = options.limit ?? AUDIT_PAGE;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_AUDIT_PAGE) throw new RangeError(`limit must be a whole number from 1 to ${MAX_AUDIT_PAGE}`);
  if (options.cursor !== undefined && typeof options.cursor !== "string") throw new Error("invalid cursor");
  return { limit, ...(options.cursor === undefined ? {} : { cursor: options.cursor }) };
}

export function createSharing(store: Store, options: { now?: () => number } = {}) {
  const now = options.now ?? Date.now;
  const forbidden = () => new Error("forbidden");
  /** The root of the chain. A root of another kind holds no role. */
  const rootSubject = (ctx: PrincipalContext): Subject | undefined => {
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
    const subject = ctx ? rootSubject(ctx) : undefined;
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

  // A grant stored before kinds sits at `<resource>:<id>`. A later grant or revoke is the newer
  // decision, so it removes that doc when the principal with that id is of this kind, and the
  // migration cannot bring it back.
  const legacyKeyOf = async (tx: StoreOps, resourceId: string, who: Subject) =>
    (await tx.get("principals", who.id))?.kind === who.kind ? `${resourceId}:${who.id}` : undefined;

  // A write that hangs on a resource reads the resource in its own transaction, and writes the
  // same doc back after its other reads. An erase reads and deletes the resource in a transaction
  // too. So a write that lands first changes the doc the erase read, and the erase runs again and
  // sees it. A write that lands later finds no resource and is refused.
  const requireResource = async (tx: StoreOps, resourceId: string) => {
    const found = await tx.get<Resource>("resources", resourceId);
    if (!found) throw forbidden();
    return found;
  };
  const touch = (tx: StoreOps, found: Resource) => tx.put("resources", found.id, found);

  /** `identity` comes from the verified sign-in: the email claim, or the agent's handle. */
  const accept = async (ctx: PrincipalContext, inviteId: string, identity: Identity): Promise<void> => {
    const subject = rootSubject(ctx);
    if (!subject || ctx.chain.length !== 1) throw forbidden();
    await store.transaction(async (tx) => {
      const invite = await tx.get("invites", inviteId);
      const mine = invite?.email !== undefined ? ctx.kind === "human" && identity.email?.toLowerCase() === invite.email : ctx.kind === "agent" && identity.handle === invite?.handle;
      const live = invite && invite.acceptedAt === undefined && invite.revokedAt == null && finiteOrAbsent(invite.expiresAt) && (invite.expiresAt == null || (invite.expiresAt as number) > now());
      if (!invite || !live || !mine) throw forbidden();
      const target = await requireResource(tx, invite.resourceId as string);
      const current = rank((await tx.get("grants", grantKey(invite.resourceId as string, subject)))?.role);
      await touch(tx, target);
      await tx.put("invites", inviteId, { ...invite, acceptedAt: now() });
      if (rank(invite.role) > current) await putGrant(tx, invite.resourceId as string, subject, invite.role as Role);
      await recordChange(tx, ctx, { action: "invite.accept", resourceId: invite.resourceId as string, targetKind: "invite", targetId: inviteId }, now());
    });
  };

  return {
    async createResource(ctx: PrincipalContext, input: { id?: string; type: string; parentId?: string }): Promise<Resource> {
      const resource: Resource = { id: input.id ?? crypto.randomUUID(), type: input.type, ...(input.parentId ? { parentId: input.parentId } : {}) };
      if (!/^[a-z][a-z0-9_-]*$/.test(resource.type) || !SAFE_ID.test(resource.id)) throw new Error("invalid resource");
      const subject = rootSubject(ctx);
      if (!subject || !hasScope(ctx.scopes, `${resource.type}:write`)) throw forbidden();
      if (input.parentId && (!(await store.get("resources", input.parentId)) || !(await decide(ctx, "write", input.parentId)).allowed)) throw forbidden();
      await store.transaction(async (tx) => {
        const parent = input.parentId ? await requireResource(tx, input.parentId) : undefined;
        if (await tx.get("resources", resource.id)) throw new Error("resource exists");
        // An allowed entry for a missing resource is left over from an erase that stopped. Its new owner must not read it.
        if ((await tx.query("audit", { where: { resourceId: resource.id, outcome: "allowed" }, limit: 1 })).items.length > 0) throw new Error("resource id has old audit entries");
        if (parent) await touch(tx, parent);
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
        const legacy = await legacyKeyOf(tx, resourceId, who);
        const found = await requireResource(tx, resourceId);
        if (role !== "owner" && (await tx.get("grants", grantKey(resourceId, who)))?.role === "owner") await keepAnotherOwner(tx, resourceId, who);
        await touch(tx, found);
        if (legacy) await tx.delete("grants", legacy);
        await putGrant(tx, resourceId, who, role);
        await recordChange(tx, ctx, { action: "grant.set", resourceId, targetKind: who.kind, targetId: who.id }, now());
      });
    },

    async revokeGrant(ctx: PrincipalContext, resourceId: string, subject: Subject): Promise<void> {
      const who = assertSubject(subject);
      await requireAdmin(ctx, resourceId);
      await store.transaction(async (tx) => {
        const legacy = await legacyKeyOf(tx, resourceId, who);
        const found = await requireResource(tx, resourceId);
        const held = await tx.get("grants", grantKey(resourceId, who));
        if (held?.role === "owner") await keepAnotherOwner(tx, resourceId, who);
        // A revoke of a grant that does not exist changes nothing, so it leaves no entry.
        if (!held && !(legacy && (await tx.get("grants", legacy)))) return;
        await touch(tx, found);
        if (legacy) await tx.delete("grants", legacy);
        await tx.delete("grants", grantKey(resourceId, who));
        await recordChange(tx, ctx, { action: "grant.revoke", resourceId, targetKind: who.kind, targetId: who.id }, now());
      });
    },

    /** The grants on one resource that are honored, in id order. Needs an owner. Pass the `nextCursor` as `cursor` to read on. */
    async listGrants(ctx: PrincipalContext, resourceId: string, options: { limit?: number; cursor?: string } = {}): Promise<{ grants: Grant[]; nextCursor?: string }> {
      const limit = options.limit ?? AUDIT_PAGE;
      if (!Number.isInteger(limit) || limit < 1 || limit > MAX_AUDIT_PAGE) throw new RangeError(`limit must be a whole number from 1 to ${MAX_AUDIT_PAGE}`);
      if (options.cursor !== undefined && typeof options.cursor !== "string") throw new Error("invalid cursor");
      await requireAdmin(ctx, resourceId);
      const page = await store.query("grants", { where: { resourceId }, limit, ...(options.cursor === undefined ? {} : { cursor: options.cursor }) });
      const honored = page.items.filter((g) => SUBJECT_KINDS.includes(g.data.subjectKind as SubjectKind) && rank(g.data.role) >= 0);
      return { grants: honored.map((g) => g.data as unknown as Grant), ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }) };
    },

    /**
     * Erases a resource and what hangs on it: its grants, invites, links, and audit entries. A
     * resource with children is refused, so no child is left without its folder. Needs an owner.
     * The erase is not one step. It removes links, invites, audit entries, and the other grants
     * first, then the owner grants and the resource in one transaction, then the audit entries that
     * a change wrote in between. If it stops after the transaction, those entries stay, and
     * `createResource` refuses the id until an operator removes them from `audit`. A failed erase leaves the
     * resource with fewer shares, and running it again finishes the job. A grant, link, invite, or
     * child that races the erase is refused or erased. `can` writes its audit entry without a
     * transaction, so an entry written in the last moments before the commit, or after it, can
     * stay. A later `deleteResource` removes it, and the entries of a missing resource are not
     * part of the erase.
     */
    async deleteResource(ctx: PrincipalContext, resourceId: string): Promise<void> {
      await requireAdmin(ctx, resourceId);
      if ((await store.query("resources", { where: { parentId: resourceId }, limit: 1 })).items.length > 0) throw new EraseRefusedError("the resource has children");
      if ((await store.query("grants", { where: { resourceId, role: "owner" }, limit: MAX_OWNERS_ON_ERASE + 1 })).items.length > MAX_OWNERS_ON_ERASE) throw new EraseRefusedError("too many owners: revoke some first");
      // Every doc of the resource but an owner's grant, in pages by cursor. The owners go in the transaction.
      const sweep = async (collections: string[]) => {
        for (const collection of collections) {
          for (let cursor: string | undefined; ; ) {
            const page = await store.query(collection, { where: { resourceId }, limit: 100, ...(cursor === undefined ? {} : { cursor }) });
            await Promise.all(page.items.filter((d) => collection !== "grants" || d.data.role !== "owner").map((d) => store.delete(collection, d.id)));
            if ((cursor = page.nextCursor) === undefined) break;
          }
        }
      };
      await sweep(["links", "invites", "grants", "audit"]);
      await store.transaction(async (tx) => {
        await requireResource(tx, resourceId);
        if ((await tx.query("resources", { where: { parentId: resourceId }, limit: 1 })).items.length > 0) throw new EraseRefusedError("the resource has children");
        // What a write added since the sweep. Each write changed the resource doc, so none can land after this read and commit.
        const rest: [string, string][] = [];
        for (const collection of ["grants", "links", "invites"]) {
          const cap = collection === "grants" ? 2 * MAX_OWNERS_ON_ERASE : MAX_OWNERS_ON_ERASE;
          const left = await tx.query(collection, { where: { resourceId }, limit: cap + 1 });
          if (left.items.length > cap) throw new StoreConflictError("too many docs are left on the resource, try again");
          rest.push(...left.items.map((d): [string, string] => [collection, d.id]));
        }
        for (const [collection, id] of rest) await tx.delete(collection, id);
        await tx.delete("resources", resourceId);
      });
      // A change that committed after the first sweep wrote its entry in its own transaction, and no
      // change can commit after this one. So this sweep removes every such entry.
      await sweep(["audit"]);
    },

    async createInvite(ctx: PrincipalContext, resourceId: string, input: { role: Role; email?: string; handle?: string; expiresInMs?: number }) {
      assertRole(input.role, linkRoles);
      if ((input.email === undefined) === (input.handle === undefined)) throw new Error("give an email or a handle");
      if (input.handle !== undefined && (typeof input.handle !== "string" || !HANDLE.test(input.handle))) throw new Error("invalid handle");
      if (input.email !== undefined && !/^[^\s@]+@[^\s@]+$/.test(input.email)) throw new Error("invalid email");
      const expiresAt = input.expiresInMs === undefined ? undefined : lifetime(input.expiresInMs);
      await requireAdmin(ctx, resourceId);
      const id = crypto.randomUUID();
      await store.transaction(async (tx) => {
        await touch(tx, await requireResource(tx, resourceId));
        await tx.put("invites", id, {
          id, resourceId, role: input.role, createdBy: ctx.principalId,
          ...(input.email === undefined ? { handle: input.handle as string } : { email: input.email.toLowerCase() }),
          ...(expiresAt === undefined ? {} : { expiresAt }),
        });
        await recordChange(tx, ctx, { action: "invite.create", resourceId, targetKind: "invite", targetId: id }, now());
      });
      return { id };
    },

    /**
     * The invites on one resource, in id order. Needs an owner. It leaves out the email, so a list
     * never carries an address: it says whether the invite is for an email or for a handle.
     */
    async listInvites(ctx: PrincipalContext, resourceId: string, options: { limit?: number; cursor?: string } = {}): Promise<{ invites: InviteSummary[]; nextCursor?: string }> {
      const paging = pageOf(options);
      await requireAdmin(ctx, resourceId);
      const page = await store.query("invites", { where: { resourceId }, ...paging });
      // An invite with neither an email nor a valid handle is not honored, so it is not listed. A
      // handle that is not valid could be an address that an older version stored.
      const listed = page.items.filter(({ data: d }) => typeof d.email === "string" || (typeof d.handle === "string" && HANDLE.test(d.handle)));
      const invites = listed.map(({ data: d }): InviteSummary => ({
        id: d.id as string, resourceId, role: d.role as Role, for: typeof d.email === "string" ? "email" : "handle",
        ...(typeof d.email !== "string" ? { handle: d.handle as string } : {}),
        ...(typeof d.expiresAt === "number" ? { expiresAt: d.expiresAt } : {}),
        ...(typeof d.acceptedAt === "number" ? { acceptedAt: d.acceptedAt } : {}),
        ...(d.revokedAt != null ? { revokedAt: typeof d.revokedAt === "number" ? d.revokedAt : 0 } : {}),
      }));
      return { invites, ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }) };
    },

    /** `identity` comes from the verified sign-in: the email claim, or the agent's handle. */
    acceptInvite: accept,

    /** Needs an owner of the invite's resource. An accepted invite cannot be revoked: the grant stays, and `revokeGrant` removes it. */
    async revokeInvite(ctx: PrincipalContext, inviteId: string): Promise<void> {
      const invite = await store.get("invites", inviteId);
      if (!invite) throw forbidden();
      await requireAdmin(ctx, invite.resourceId as string);
      // In a transaction, so an invite that an erase removed in between is not put back.
      await store.transaction(async (tx) => {
        const current = await tx.get("invites", inviteId);
        if (!current) throw forbidden();
        if (current.acceptedAt !== undefined) throw new Error("invite already accepted");
        if (current.revokedAt != null) return;
        await tx.put("invites", inviteId, { ...current, revokedAt: now() });
        await recordChange(tx, ctx, { action: "invite.revoke", resourceId: current.resourceId as string, targetKind: "invite", targetId: inviteId }, now());
      });
    },

    /**
     * Accepts the live invites for the caller's verified email, or for the handle of an agent with its own
     * identity, and returns how many it took. It reads one page of `PENDING_PAGE` invites, so one call stays
     * bounded. When `nextCursor` is set, call again with it to read on. An invite that is expired, taken, or
     * not the caller's is skipped. A delegated agent takes none. Any other failure, such as a store error, is thrown.
     */
    async acceptPendingInvites(ctx: PrincipalContext, identity: Identity, options: { cursor?: string } = {}): Promise<{ accepted: number; nextCursor?: string }> {
      if (options.cursor !== undefined && typeof options.cursor !== "string") throw new Error("invalid cursor");
      let where: Record<string, string> | null = null;
      if (ctx.kind === "human" && typeof identity.email === "string") where = { email: identity.email.toLowerCase() };
      else if (ctx.kind === "agent" && typeof identity.handle === "string") where = { handle: identity.handle };
      if (!where || ctx.chain.length !== 1) return { accepted: 0 };
      const page = await store.query("invites", { where, limit: PENDING_PAGE, ...(options.cursor === undefined ? {} : { cursor: options.cursor }) });
      let accepted = 0;
      for (const { id, data } of page.items) {
        if (data.acceptedAt !== undefined) continue;
        try {
          await accept(ctx, id, identity);
          accepted += 1;
        } catch (error) {
          // Expired, taken in a race, or the resource is gone: the next invite still counts. A store failure is not that.
          if (!(error instanceof Error && error.message === "forbidden")) throw error;
        }
      }
      return { accepted, ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }) };
    },

    /** The token is returned once. Only its hash is stored. */
    async createLink(ctx: PrincipalContext, resourceId: string, input: { role: Role; expiresAt?: number; signedInOnly?: boolean }) {
      assertRole(input.role, linkRoles);
      const expiresAt = input.expiresAt === undefined ? undefined : futureTime(input.expiresAt);
      await requireAdmin(ctx, resourceId);
      const [id, token] = [crypto.randomUUID(), randomToken()];
      const tokenHash = await sha256(token);
      await store.transaction(async (tx) => {
        await touch(tx, await requireResource(tx, resourceId));
        await tx.put("links", id, {
          id, resourceId, role: input.role, tokenHash, signedInOnly: input.signedInOnly === true,
          ...(expiresAt === undefined ? {} : { expiresAt }),
        });
        await recordChange(tx, ctx, { action: "link.create", resourceId, targetKind: "link", targetId: id }, now());
      });
      return { id, token };
    },

    async revokeLink(ctx: PrincipalContext, linkId: string): Promise<void> {
      const link = await store.get("links", linkId);
      if (!link) throw forbidden();
      await requireAdmin(ctx, link.resourceId as string);
      // In a transaction, so a link that an erase removed in between is not put back.
      await store.transaction(async (tx) => {
        const current = await tx.get("links", linkId);
        if (!current) throw forbidden();
        await tx.put("links", linkId, { ...current, revokedAt: now() });
        await recordChange(tx, ctx, { action: "link.revoke", resourceId: link.resourceId as string, targetKind: "link", targetId: linkId }, now());
      });
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
      const page = pageOf(options);
      await requireAdmin(ctx, resourceId);
      const found = await store.query("audit", { where: { resourceId }, orderBy: { field: "at", direction: "desc" }, ...page });
      return { entries: found.items.map((item) => item.data as unknown as AuditEntry), ...(found.nextCursor === undefined ? {} : { nextCursor: found.nextCursor }) };
    },

    /**
     * Everything done by a person and by the agents and tokens that act for them, newest first. It
     * includes access checks. Only the person may read it, not an agent or a token.
     */
    async listPersonAudit(ctx: PrincipalContext, options: { limit?: number; cursor?: string } = {}): Promise<{ entries: AuditEntry[]; nextCursor?: string }> {
      const page = pageOf(options);
      if (ctx.kind !== "human" || ctx.chain.length !== 1) throw forbidden();
      const found = await store.query("audit", { where: { rootId: ctx.principalId }, orderBy: { field: "at", direction: "desc" }, ...page });
      return { entries: found.items.map((item) => item.data as unknown as AuditEntry), ...(found.nextCursor === undefined ? {} : { nextCursor: found.nextCursor }) };
    },
  };
}

/**
 * Rewrites grants stored before grants had a kind. They were keyed `<resource>:<id>`. The kind
 * comes from the principal with that id: `human` or `agent`. Until a grant is rewritten it is not
 * honored. A grant that exists at the new key keeps its role: it is the later decision. A grant whose principal is missing or has another kind is left as it is, and is listed
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
      if (!old || SUBJECT_KINDS.includes(old.subjectKind as SubjectKind) || typeof old.resourceId !== "string" || typeof old.subjectId !== "string") return false;
      const kind = (await tx.get("principals", old.subjectId))?.kind;
      if (!SUBJECT_KINDS.includes(kind as SubjectKind) || rank(old.role) < 0 || !SAFE_ID.test(old.subjectId) || !SAFE_ID.test(old.resourceId)) return false;
      const subject: Subject = { kind: kind as SubjectKind, id: old.subjectId };
      if (grantKey(old.resourceId, subject) === id) return false;
      // A grant that exists at the new key is the later decision, so it keeps its role.
      const present = await tx.get("grants", grantKey(old.resourceId, subject));
      await putGrant(tx, old.resourceId, subject, rank(present?.role) >= 0 ? (present!.role as Role) : (old.role as Role));
      await tx.delete("grants", id);
      return true;
    });
    if (done) migrated++;
    else unresolved.push(id);
  }
  return { migrated, unresolved };
}
