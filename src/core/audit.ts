// The change log. Every change to access writes one entry in the same transaction as the
// change, so a change without its entry cannot commit. An entry holds ids and kinds only.
import type { Doc, StoreOps } from "../ports.js";
import { auditEntry, type AuditEntry, type PrincipalContext } from "./principals.js";

/** What a change did. Reads are not here: `can` writes those. */
export const CHANGE_ACTIONS = [
  "grant.set",
  "grant.revoke",
  "invite.create",
  "invite.accept",
  "invite.revoke",
  "link.create",
  "link.revoke",
  "key.create",
  "key.rotate",
  "key.revoke",
  "person.export",
  "person.erase",
] as const;
export type ChangeAction = (typeof CHANGE_ACTIONS)[number];

export interface Change {
  action: ChangeAction;
  resourceId?: string;
  /** What the change touched, by kind (`human`, `agent`, `invite`, `link`, `principal`, `person`) and id. */
  targetKind: string;
  targetId: string;
}

/** Writes the entry through `ops`. Pass a transaction, so the entry and the change commit together. */
export async function recordChange(ops: Pick<StoreOps, "put">, ctx: PrincipalContext | null, change: Change, at: number): Promise<void> {
  const id = crypto.randomUUID();
  await ops.put("audit", id, auditEntry(ctx, { id, at, outcome: "allowed", ...change }) as unknown as Doc);
}

export type { AuditEntry };
