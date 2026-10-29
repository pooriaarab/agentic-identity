// Revoke a principal and rotate an agent's key. The Worker, the CLI, and the MCP server all call
// these, so one rights check decides for all three.
import { recordChange } from "./core/audit.js";
import type { Principal, PrincipalContext } from "./core/principals.js";
import { issueCredential } from "./credentials.js";
import type { Doc, Store, StoreOps } from "./ports.js";

/** `status` is the HTTP status the Worker answers with. The message holds no id. */
export class PrincipalAdminError extends Error {
  constructor(readonly status: 400 | 403 | 404 | 409, message: string) {
    super(message);
    this.name = "PrincipalAdminError";
  }
}

type Target = Principal & { ownerId?: string };

/** The owner of an agent, or any principal above the target in its chain, may manage it. */
async function mayManage(ops: StoreOps, ctx: PrincipalContext, target: Target): Promise<boolean> {
  let allowed = target.ownerId === ctx.principalId;
  for (let up = target.parentId, i = 0; up && i < 8 && !allowed; i++) {
    allowed = up === ctx.principalId;
    up = ((await ops.get("principals", up)) as Principal | null)?.parentId;
  }
  return allowed;
}

async function managed(ops: StoreOps, ctx: PrincipalContext, id: string): Promise<Target> {
  const target = (await ops.get("principals", id)) as Target | null;
  if (!target) throw new PrincipalAdminError(404, "not found");
  if (!(await mayManage(ops, ctx, target))) throw new PrincipalAdminError(403, "forbidden");
  return target;
}

/** Stops the principal and everything below it, because rights are re-read up the chain. Returns its id. */
export async function revokePrincipal(store: Store, ctx: PrincipalContext, id: string, now: () => number): Promise<string> {
  return store.transaction(async (tx) => {
    const target = await managed(tx, ctx, id);
    await tx.put("principals", target.id, { ...target, revokedAt: now() } as unknown as Doc);
    await recordChange(tx, ctx, { action: "key.revoke", targetKind: "principal", targetId: target.id }, now());
    return target.id;
  });
}

/** A new key for an agent. Every key it had stops in the same step. The key is shown once. */
export async function rotateKey(store: Store, ctx: PrincipalContext, id: string, now: () => number): Promise<{ id: string; apiKey: string }> {
  return store.transaction(async (tx) => {
    const target = await managed(tx, ctx, id);
    if (target.revokedAt != null || !["agent", "agent_of_human", "agent_of_agent"].includes(target.kind)) throw new PrincipalAdminError(400, "bad principal");
    // Revoked keys stay as rows, so read every page. A guarded read that is too long gives up.
    const old: { id: string; data: Doc }[] = [];
    for (let cursor: string | undefined, pages = 0; ; pages++) {
      if (pages >= 20) throw new PrincipalAdminError(409, "try again");
      const page = await tx.query("credentials", { where: { principalId: target.id, kind: "api_key" }, limit: 100, ...(cursor === undefined ? {} : { cursor }) });
      old.push(...page.items);
      if ((cursor = page.nextCursor) === undefined) break;
    }
    for (const key of old) if (key.data.revokedAt == null) await tx.put("credentials", key.id, { ...key.data, revokedAt: now() });
    const apiKey = await issueCredential(tx, { principalId: target.id, kind: "api_key", label: String(old[0]?.data.label ?? "") });
    await recordChange(tx, ctx, { action: "key.rotate", targetKind: "principal", targetId: target.id }, now());
    return { id: target.id, apiKey };
  });
}
