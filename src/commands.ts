// One table of commands. The CLI reads it, and the MCP server will read it too, so both do the same things.
// A command acts as one principal on one Store, and returns plain JSON. It never returns a secret
// it did not just make, and it never returns an email address.
import { ACTIONS, hasScope, isScope, resolveChain, type Action, type Principal, type PrincipalContext } from "./core/principals.js";
import { ROLES, SUBJECT_KINDS, createSharing, type Role, type SubjectKind } from "./core/sharing.js";
import type { Store } from "./ports.js";

/** The person that a new store starts with, and the one a command acts as by default. */
export const LOCAL_PERSON = "local";

export class UsageError extends Error {}

export interface Arg {
  name: string;
  type: "string" | "number" | "boolean" | "list";
  description: string;
  /** Taken from the command line without a flag, in the order listed. */
  positional?: boolean;
  required?: boolean;
  choices?: readonly string[];
}

export type Args = Record<string, string | number | boolean | string[] | undefined>;

export interface App {
  store: Store;
  now: () => number;
  /** The principal that the command acts as. Fails when it is unknown, revoked, or expired. */
  actor(): Promise<PrincipalContext>;
}

export interface Command {
  /** Words after the program name: `["grants", "list"]`. */
  path: string[];
  /** The MCP tool name. */
  tool: string;
  summary: string;
  args: Arg[];
  run(app: App, args: Args): Promise<unknown>;
}

export async function openApp(store: Store, options: { as?: string; now?: () => number } = {}): Promise<App> {
  const now = options.now ?? Date.now;
  const as = options.as ?? LOCAL_PERSON;
  // Only the default person is made on first use. Any other name must already exist.
  if (as === LOCAL_PERSON && !(await store.get("principals", LOCAL_PERSON))) {
    await store.transaction(async (tx) => {
      if (!(await tx.get("principals", LOCAL_PERSON))) await tx.put("principals", LOCAL_PERSON, { id: LOCAL_PERSON, kind: "human", scopes: ["*:admin"] });
    });
  }
  return {
    store,
    now,
    async actor() {
      const found = await resolveChain(as, async (id) => ((await store.get("principals", id)) ?? undefined) as unknown as Principal | undefined, { now: now() });
      if (!found.ok) throw new UsageError(`cannot act as the chosen principal: ${found.reason}`);
      return found;
    },
  };
}

const str = (args: Args, name: string): string => {
  const value = args[name];
  if (typeof value !== "string" || value === "") throw new UsageError(`missing ${name}`);
  return value;
};
const opt = <T>(value: T | undefined, key: string) => (value === undefined ? {} : { [key]: value });
const paging = (args: Args) => ({ ...opt(args.limit as number | undefined, "limit"), ...opt(args.cursor as string | undefined, "cursor") });

const resource: Arg = { name: "resource", type: "string", description: "The resource id.", positional: true, required: true };
const limit: Arg = { name: "limit", type: "number", description: "The most items in a page (1 to 200)." };
const cursor: Arg = { name: "cursor", type: "string", description: "The nextCursor of the last page." };
const expiresInMs: Arg = { name: "expires-in-ms", type: "number", description: "Time to live, in milliseconds." };

const checkExpiry = (ms: unknown) => {
  if (ms !== undefined && (typeof ms !== "number" || !Number.isSafeInteger(ms) || ms <= 0)) throw new UsageError("expires-in-ms must be a positive whole number");
};
const isPerson = (ctx: PrincipalContext) => ctx.kind === "human" && ctx.chain.length === 1;

export const COMMANDS: Command[] = [
  {
    path: ["whoami"], tool: "identity_whoami", summary: "Show the principal that acts, its chain, and its scopes.", args: [],
    run: async (app) => {
      const { principalId, kind, chain, scopes } = await app.actor();
      return { principalId, kind, chain, scopes };
    },
  },
  {
    path: ["principals", "list"], tool: "identity_principals_list", summary: "List the principals in the store.", args: [limit, cursor],
    run: async (app, args) => {
      // The list names every principal with its scopes, so only an actor with all rights reads it.
      if (!hasScope((await app.actor()).scopes, "*:admin")) throw new Error("forbidden");
      const n = args.limit;
      if (n !== undefined && (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > 200)) throw new UsageError("limit must be a whole number from 1 to 200");
      const page = await app.store.query("principals", paging(args));
      const keep = ["id", "kind", "parentId", "ownerId", "scopes", "expiresAt", "revokedAt"];
      // A handle shows only when it has the form of one, so a bad record cannot put an address in the list.
      const show = (d: Record<string, unknown>) => ({ ...Object.fromEntries(keep.filter((k) => d[k] !== undefined).map((k) => [k, d[k]])), ...(typeof d.handle === "string" && /^[a-z][a-z0-9_-]{1,31}$/.test(d.handle) ? { handle: d.handle } : {}) });
      return { principals: page.items.map((i) => show(i.data)), ...opt(page.nextCursor, "nextCursor") };
    },
  },
  {
    path: ["agents", "create"], tool: "identity_agents_create", summary: "Make an agent with its own identity. Only a person can.",
    args: [
      { name: "handle", type: "string", description: "Lowercase letters, digits, `-`, `_`. 2 to 32 characters.", positional: true, required: true },
      { name: "scopes", type: "list", description: "Comma-separated scopes such as doc:write. They must fit inside your own.", required: true },
    ],
    run: async (app, args) => {
      const ctx = await app.actor();
      if (!isPerson(ctx)) throw new Error("only a person makes an agent");
      const handle = str(args, "handle");
      if (!/^[a-z][a-z0-9_-]{1,31}$/.test(handle)) throw new UsageError("bad handle");
      const scopes = args.scopes;
      if (!Array.isArray(scopes) || scopes.length === 0 || scopes.length > 32 || !scopes.every(isScope)) throw new UsageError("scopes must be a short list in the scope format, such as doc:write");
      if (!scopes.every((scope) => hasScope(ctx.scopes, scope))) throw new Error("scopes exceed your own");
      const id = `p_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
      await app.store.transaction(async (tx) => {
        if (await tx.get("handles", handle)) throw new Error("handle taken");
        await tx.put("handles", handle, { principalId: id });
        await tx.put("principals", id, { id, kind: "agent", scopes, handle, ownerId: ctx.principalId });
      });
      return { id, handle, scopes };
    },
  },
  {
    path: ["resources", "create"], tool: "identity_resources_create", summary: "Make a resource. The actor becomes its owner.",
    args: [
      { name: "type", type: "string", description: "The resource type, such as doc.", positional: true, required: true },
      { name: "id", type: "string", description: "The id. A random one is made when you leave it out." },
      { name: "parent", type: "string", description: "The id of the folder that holds it." },
    ],
    run: async (app, args) => createSharing(app.store, { now: app.now }).createResource(await app.actor(), { type: str(args, "type"), ...opt(args.id as string | undefined, "id"), ...opt(args.parent as string | undefined, "parentId") }),
  },
  {
    path: ["grants", "set"], tool: "identity_grants_set", summary: "Give a person or an agent a role on a resource. Needs an owner.",
    args: [
      resource,
      { name: "kind", type: "string", description: "Who holds the role.", positional: true, required: true, choices: SUBJECT_KINDS },
      { name: "subject", type: "string", description: "The principal id of the person or agent.", positional: true, required: true },
      { name: "role", type: "string", description: "The role to give.", positional: true, required: true, choices: ROLES },
    ],
    run: async (app, args) => {
      await createSharing(app.store, { now: app.now }).grant(await app.actor(), str(args, "resource"), { kind: str(args, "kind") as SubjectKind, id: str(args, "subject") }, str(args, "role") as Role);
      return { ok: true };
    },
  },
  {
    path: ["grants", "revoke"], tool: "identity_grants_revoke", summary: "Remove a role from a person or an agent. Needs an owner.",
    args: [resource, { name: "kind", type: "string", description: "Who holds the role.", positional: true, required: true, choices: SUBJECT_KINDS }, { name: "subject", type: "string", description: "The principal id.", positional: true, required: true }],
    run: async (app, args) => {
      await createSharing(app.store, { now: app.now }).revokeGrant(await app.actor(), str(args, "resource"), { kind: str(args, "kind") as SubjectKind, id: str(args, "subject") });
      return { ok: true };
    },
  },
  {
    path: ["grants", "list"], tool: "identity_grants_list", summary: "List the roles on a resource. Needs an owner.", args: [resource, limit, cursor],
    run: async (app, args) => createSharing(app.store, { now: app.now }).listGrants(await app.actor(), str(args, "resource"), paging(args)),
  },
  {
    path: ["invites", "create"], tool: "identity_invites_create", summary: "Invite a person by email or an agent by handle. Needs an owner.",
    args: [
      resource,
      { name: "role", type: "string", description: "The role the invite gives.", positional: true, required: true, choices: ROLES.filter((r) => r !== "owner") },
      { name: "email", type: "string", description: "The email of the person. Give this or a handle." },
      { name: "handle", type: "string", description: "The handle of the agent. Give this or an email." },
      expiresInMs,
    ],
    run: async (app, args) => {
      if ((args.email === undefined) === (args.handle === undefined)) throw new UsageError("give an email or a handle, not both");
      checkExpiry(args["expires-in-ms"]);
      return createSharing(app.store, { now: app.now }).createInvite(await app.actor(), str(args, "resource"), {
        role: str(args, "role") as Role, ...opt(args.email as string | undefined, "email"), ...opt(args.handle as string | undefined, "handle"), ...opt(args["expires-in-ms"] as number | undefined, "expiresInMs"),
      });
    },
  },
  {
    path: ["invites", "accept"], tool: "identity_invites_accept", summary: "Accept an invite as the actor.",
    args: [
      { name: "invite", type: "string", description: "The invite id.", positional: true, required: true },
      { name: "email", type: "string", description: "A person's email. This store does not verify it: whoever holds the file is trusted." },
    ],
    run: async (app, args) => {
      const ctx = await app.actor();
      // An agent's handle comes from its own record. A person says their email.
      const record = await app.store.get("principals", ctx.principalId);
      const handle = typeof record?.handle === "string" ? { handle: record.handle } : {};
      await createSharing(app.store, { now: app.now }).acceptInvite(ctx, str(args, "invite"), { ...opt(args.email as string | undefined, "email"), ...handle });
      return { ok: true };
    },
  },
  {
    path: ["invites", "list"], tool: "identity_invites_list", summary: "List the invites on a resource. It shows no email. Needs an owner.", args: [resource, limit, cursor],
    run: async (app, args) => createSharing(app.store, { now: app.now }).listInvites(await app.actor(), str(args, "resource"), paging(args)),
  },
  {
    path: ["links", "create"], tool: "identity_links_create", summary: "Make a share link. The token shows once. Needs an owner.",
    args: [
      resource,
      { name: "role", type: "string", description: "The role the link gives.", positional: true, required: true, choices: ROLES.filter((r) => r !== "owner") },
      expiresInMs,
      { name: "signed-in-only", type: "boolean", description: "The link works only for a principal that signed in." },
    ],
    run: async (app, args) => {
      const ms = args["expires-in-ms"];
      checkExpiry(ms);
      return createSharing(app.store, { now: app.now }).createLink(await app.actor(), str(args, "resource"), {
        role: str(args, "role") as Role, signedInOnly: args["signed-in-only"] === true, ...(ms === undefined ? {} : { expiresAt: app.now() + (ms as number) }),
      });
    },
  },
  {
    path: ["links", "revoke"], tool: "identity_links_revoke", summary: "Revoke a share link. Needs an owner.",
    args: [{ name: "link", type: "string", description: "The link id.", positional: true, required: true }],
    run: async (app, args) => {
      await createSharing(app.store, { now: app.now }).revokeLink(await app.actor(), str(args, "link"));
      return { ok: true };
    },
  },
  {
    path: ["links", "resolve"], tool: "identity_links_resolve", summary: "Ask what a link token allows on a resource. It writes an audit entry.",
    args: [
      resource,
      { name: "token", type: "string", description: "The link token.", positional: true, required: true },
      { name: "action", type: "string", description: "The action to check. The default is read.", choices: ACTIONS },
    ],
    // The visitor holds only the token, so the check runs with no principal.
    run: async (app, args) => createSharing(app.store, { now: app.now }).can(null, ((args.action as Action | undefined) ?? "read"), str(args, "resource"), { linkToken: str(args, "token") }),
  },
  {
    path: ["audit"], tool: "identity_audit", summary: "Read the audit log of a resource, newest first. Needs an owner.", args: [resource, limit, cursor],
    run: async (app, args) => createSharing(app.store, { now: app.now }).listAudit(await app.actor(), str(args, "resource"), paging(args)),
  },
];
