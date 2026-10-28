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
}

export type ChainFailure =
  | "unknown_principal"
  | "revoked"
  | "expired"
  | "cycle"
  | "depth_exceeded"
  | "invalid_chain";

export type Resolution = ({ ok: true } & PrincipalContext) | { ok: false; reason: ChainFailure; at: string };

const SCOPE_PATTERN = /^(\*|[a-z][a-z0-9_-]*):(read|comment|write|admin)$/;

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
  const maxDepth = options.maxDepth ?? MAX_CHAIN_DEPTH;
  const walk: Principal[] = [];
  const seen = new Set<string>();
  for (let id: string | undefined = leafId; id !== undefined; id = walk[walk.length - 1]?.parentId) {
    if (seen.has(id)) return fail("cycle", id);
    if (walk.length >= maxDepth) return fail("depth_exceeded", id);
    seen.add(id);
    const found = await lookup(id);
    if (!found) return fail("unknown_principal", id);
    walk.push(found);
  }
  const chain = walk.reverse();

  for (const [i, p] of chain.entries()) {
    const allowed = PARENT_KINDS[p.kind];
    const parent = chain[i - 1];
    const parentOk = allowed.length === 0 ? parent === undefined : parent !== undefined && allowed.includes(parent.kind);
    if (!parentOk || !p.scopes.every((scope) => SCOPE_PATTERN.test(scope))) return fail("invalid_chain", p.id);
  }
  for (const p of chain) {
    if (p.revokedAt !== undefined && p.revokedAt <= options.now) return fail("revoked", p.id);
    if (p.expiresAt !== undefined && p.expiresAt <= options.now) return fail("expired", p.id);
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
  /** Kept on every entry so agent actions are labeled. */
  principalKind: PrincipalKind;
  chain: ChainStep[];
  machineMade: boolean;
}

export function auditEntry(
  context: PrincipalContext,
  event: { id: string; at: number; action: string; resourceId?: string; outcome: "allowed" | "denied" },
): AuditEntry {
  return {
    ...event,
    principalId: context.principalId,
    principalKind: context.kind,
    chain: context.chain.map(({ id, kind }) => ({ id, kind })),
    machineMade: isMachineMade(context.kind),
  };
}
