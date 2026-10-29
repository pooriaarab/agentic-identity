export const PRINCIPAL_KINDS = ["human", "agent_of_human", "agent_of_agent", "agent", "user_token"] as const;
export type PrincipalKind = (typeof PRINCIPAL_KINDS)[number];

// Weakest first. A stronger action covers every weaker one.
export const ACTIONS = ["read", "comment", "write", "admin"] as const;
export type Action = (typeof ACTIONS)[number];

/** A scope is `<resource>:<action>`. The resource is a type name or `*` for all. */
export type Scope = string;

/** The most principals one chain holds, root and leaf included. */
export const MAX_CHAIN_DEPTH = 5;

export interface Principal {
  id: string;
  kind: PrincipalKind;
  /** The principal this one acts for. Roots (`human`, `agent`) have none. */
  parentId?: string;
  /** What this principal asks for. A root's scopes are its own rights. */
  scopes: Scope[];
  /** Epoch milliseconds. The grant stops at this time. */
  expiresAt?: number;
  /** Epoch milliseconds. Revoking one principal removes all below it. */
  revokedAt?: number;
}

export interface ChainStep {
  id: string;
  kind: PrincipalKind;
}

/** A resolved caller: who acts, for whom, and the rights that remain. */
export interface PrincipalContext {
  principalId: string;
  kind: PrincipalKind;
  /** Root first, the acting principal last. */
  chain: ChainStep[];
  scopes: Scope[];
  /** Set by the Worker for each request. It ties audit entries to the request that made them. */
  requestId?: string;
}

export type ChainFailure =
  | "unknown_principal"
  | "revoked"
  | "expired"
  | "cycle"
  | "depth_exceeded"
  | "invalid_chain"
  | "invalid_options";

export type Resolution = ({ ok: true } & PrincipalContext) | { ok: false; reason: ChainFailure; at: string };

const SCOPE_PATTERN = /^(\*|[a-z][a-z0-9_-]*):(read|comment|write|admin)$/;

const MAX_SCOPE_LENGTH = 64;

/** True only for a string in the exact scope grammar. Anything else, even a value that prints as a scope, is false. */
export function isScope(value: unknown): value is Scope {
  return typeof value === "string" && value.length <= MAX_SCOPE_LENGTH && SCOPE_PATTERN.test(value);
}

export function parseScope(scope: Scope): { resource: string; action: Action } {
  const match = SCOPE_PATTERN.exec(scope);
  if (!match) throw new Error(`invalid scope "${scope}"`);
  return { resource: match[1] as string, action: match[2] as Action };
}

const level = (action: Action): number => ACTIONS.indexOf(action);

/** True when `grant` allows everything `required` asks for. */
export function scopeCovers(grant: Scope, required: Scope): boolean {
  const g = parseScope(grant);
  const r = parseScope(required);
  return (g.resource === "*" || g.resource === r.resource) && level(g.action) >= level(r.action);
}

export function hasScope(scopes: Scope[], required: Scope): boolean {
  return scopes.some((scope) => scopeCovers(scope, required));
}

/** The rights both lists allow. The result never exceeds either side. */
export function intersectScopes(a: Scope[], b: Scope[]): Scope[] {
  const out = new Set<Scope>();
  for (const x of a.map(parseScope)) {
    for (const y of b.map(parseScope)) {
      const resource = x.resource === "*" ? y.resource : y.resource === "*" || y.resource === x.resource ? x.resource : null;
      if (resource === null) continue;
      out.add(`${resource}:${level(x.action) <= level(y.action) ? x.action : y.action}`);
    }
  }
  return [...out];
}

// Which parent kinds each kind may have. An empty list marks a root.
const PARENT_KINDS: Record<PrincipalKind, PrincipalKind[]> = {
  human: [],
  agent: [],
  agent_of_human: ["human"],
  agent_of_agent: ["agent", "agent_of_human", "agent_of_agent"],
  user_token: ["human"],
};

const PRINCIPAL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export class PrincipalParseError extends Error {}

/**
 * Check untrusted input for a principal reference: a known `kind` and a safe `id`.
 * It never defaults a kind. The result holds only `kind` and `id`.
 */
export function parsePrincipal(input: unknown): ChainStep {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new PrincipalParseError("principal must be an object");
  }
  const { kind, id } = input as Record<string, unknown>;
  if (typeof kind !== "string" || !(PRINCIPAL_KINDS as readonly string[]).includes(kind)) {
    throw new PrincipalParseError("principal kind is missing or unknown");
  }
  if (typeof id !== "string" || !PRINCIPAL_ID_PATTERN.test(id)) {
    throw new PrincipalParseError("principal id is missing or has characters outside A-Z a-z 0-9 . _ -");
  }
  return { kind: kind as PrincipalKind, id };
}

/** A stable `kind:id` string for a principal. Kind names hold no colon, so it is unambiguous. */
export function subjectOf(principal: ChainStep): string {
  const { kind, id } = parsePrincipal(principal);
  return `${kind}:${id}`;
}

/** Machine-made content and edits carry this label (EU AI Act transparency). */
export function isMachineMade(kind: PrincipalKind): boolean {
  return kind !== "human";
}

type Lookup = (id: string) => Principal | undefined | Promise<Principal | undefined>;

/**
 * Walk from the acting principal up to its root and return the rights that
 * remain. Each step can only narrow. Any problem gives no rights at all.
 */
export async function resolveChain(
  leafId: string,
  lookup: Lookup,
  options: { now: number; maxDepth?: number },
): Promise<Resolution> {
  const fail = (reason: ChainFailure, at: string): Resolution => ({ ok: false, reason, at });
  // The caller's options are input too. A NaN clock makes every `revokedAt <= now` false.
  const depth = options?.maxDepth === undefined ? MAX_CHAIN_DEPTH : options.maxDepth;
  if (typeof options?.now !== "number" || !Number.isFinite(options.now) || typeof depth !== "number" || !Number.isSafeInteger(depth) || depth < 1) {
    return fail("invalid_options", leafId);
  }
  const maxDepth = depth;
  const walk: Principal[] = [];
  const seen = new Set<string>();
  for (let id: string | null | undefined = leafId; id != null; id = walk[walk.length - 1]?.parentId) {
    if (seen.has(id)) return fail("cycle", id);
    if (walk.length >= maxDepth) return fail("depth_exceeded", id);
    seen.add(id);
    const found = await lookup(id);
    if (!found || found.id !== id) return fail("unknown_principal", id);
    walk.push(found);
  }
  const chain = walk.reverse();

  // The records come from a JSON store, so check every field the rights depend on.
  const timeOk = (t: unknown) => t === undefined || t === null || (typeof t === "number" && Number.isFinite(t));
  for (const [i, p] of chain.entries()) {
    const shapeOk =
      Object.hasOwn(PARENT_KINDS, p.kind) && Array.isArray(p.scopes) && p.scopes.every(isScope) && timeOk(p.revokedAt) && timeOk(p.expiresAt);
    const allowed = PARENT_KINDS[p.kind];
    const parent = chain[i - 1];
    const parentOk = shapeOk && (allowed.length === 0 ? parent === undefined : parent !== undefined && allowed.includes(parent.kind));
    if (!parentOk) return fail("invalid_chain", p.id);
  }
  for (const p of chain) {
    if (p.revokedAt != null && p.revokedAt <= options.now) return fail("revoked", p.id);
    if (p.expiresAt != null && p.expiresAt <= options.now) return fail("expired", p.id);
  }

  const scopes = chain.slice(1).reduce((rights, p) => intersectScopes(rights, p.scopes), chain[0]!.scopes);
  const leaf = chain[chain.length - 1]!;
  return {
    ok: true,
    principalId: leaf.id,
    kind: leaf.kind,
    chain: chain.map(({ id, kind }) => ({ id, kind })),
    scopes,
  };
}

/** One record of an action. It holds ids and kinds only: no emails, no content. */
export interface AuditEntry {
  id: string;
  at: number;
  action: string;
  resourceId?: string;
  outcome: "allowed" | "denied";
  principalId: string;
  /** Kept on every entry so agent actions are labeled. `anonymous` is a share-link visitor. */
  principalKind: PrincipalKind | "anonymous";
  chain: ChainStep[];
  machineMade: boolean;
  /** The root of the chain: the person, or the agent with its own identity. Entries from before 0.5.0 have none. */
  rootId?: string;
  /** What a change touched. Entries of access checks have none. */
  targetKind?: string;
  targetId?: string;
  requestId?: string;
}

export function auditEntry(
  context: PrincipalContext | null,
  event: { id: string; at: number; action: string; resourceId?: string; outcome: "allowed" | "denied"; targetKind?: string; targetId?: string },
): AuditEntry {
  if (context === null) return { ...event, principalId: "anonymous", principalKind: "anonymous", chain: [], machineMade: false, rootId: "anonymous" };
  return {
    ...event,
    principalId: context.principalId,
    principalKind: context.kind,
    chain: context.chain.map(({ id, kind }) => ({ id, kind })),
    machineMade: isMachineMade(context.kind),
    rootId: context.chain[0]?.id ?? context.principalId,
    ...(context.requestId === undefined ? {} : { requestId: context.requestId }),
  };
}
