// Credentials: bearer keys and session cookies. A credential doc is keyed by the
// SHA-256 of the token, so the store never holds a usable token. The token only
// names a principal. `resolveChain` then decides the rights, so revoking or
// expiring any principal above it stops the credential.
import { resolveChain, type Principal } from "./core/principals.js";
import type { Auth, Store, StoreOps } from "./ports.js";

export const randomToken = (bytes = 32) => Buffer.from(crypto.getRandomValues(new Uint8Array(bytes))).toString("base64url");

export type CredentialKind = "session" | "api_key" | "pat";

export const sha256Hex = async (text: string) =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))].map((b) => b.toString(16).padStart(2, "0")).join("");

const timeOk = (t: unknown) => t === undefined || t === null || (typeof t === "number" && Number.isFinite(t));

/** Returns the token. This is the only time it exists in plain text. */
export async function issueCredential(store: StoreOps, input: { principalId: string; kind: CredentialKind; expiresAt?: number; label?: string }): Promise<string> {
  const token = `aid_${randomToken()}`;
  await store.put("credentials", await sha256Hex(token), { ...input });
  return token;
}

export async function revokeCredential(store: Store, token: string, now: number): Promise<void> {
  const id = await sha256Hex(token);
  const doc = await store.get("credentials", id);
  if (doc) await store.put("credentials", id, { ...doc, revokedAt: now });
}

/** Reads `Authorization: Bearer <token>`, or the `session` cookie. Any problem gives null. */
export function createStoreAuth(store: Store, options: { now?: () => number } = {}): Auth {
  const now = options.now ?? Date.now;
  return {
    async authenticate(request) {
      const bearer = /^Bearer ([A-Za-z0-9_-]{1,512})$/.exec(request.headers.get("authorization") ?? "")?.[1];
      const token = bearer ?? /(?:^|;\s*)session=([A-Za-z0-9_-]{1,512})(?:;|$)/.exec(request.headers.get("cookie") ?? "")?.[1];
      const doc = token ? await store.get("credentials", await sha256Hex(token)) : null;
      if (!doc || typeof doc.principalId !== "string" || !timeOk(doc.expiresAt) || !timeOk(doc.revokedAt)) return null;
      if ((doc.revokedAt != null && (doc.revokedAt as number) <= now()) || (doc.expiresAt != null && (doc.expiresAt as number) <= now())) return null;
      const result = await resolveChain(doc.principalId, async (id) => ((await store.get("principals", id)) as Principal | null) ?? undefined, { now: now() });
      return result.ok ? { principalId: result.principalId, kind: result.kind, chain: result.chain, scopes: result.scopes } : null;
    },
  };
}
