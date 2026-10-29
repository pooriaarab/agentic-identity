// Shared request check for apps. It is framework-free and uses only Request and Response,
// so it runs in a Worker. The `Auth` port reads the credential (a bearer key or a session
// cookie) and does the revoke and expiry checks. This adds the 401 and 403 answers.
import { PRINCIPAL_KINDS, hasScope, isScope, type PrincipalContext, type PrincipalKind, type Scope } from "./core/principals.js";
import type { Auth } from "./ports.js";

export interface RequirePrincipalOptions {
  /** Kinds that may pass. Any other kind gets a 403. Leave it out to allow every kind. */
  kinds?: readonly PrincipalKind[];
  /** A scope the principal must hold, as `<resource>:<action>`. A principal without it gets a 403. */
  scope?: Scope;
}

const reply = (status: number, error: string, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify({ error }), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...headers } });

/**
 * Resolve the principal for a request, or answer with a Response to send back.
 * A missing, wrong-scheme, bad, expired, or revoked credential is a 401 with `WWW-Authenticate: Bearer`.
 * A good credential whose kind or scopes fall short is a 403. The body never holds the credential.
 */
export async function requirePrincipal(request: Request, auth: Auth, options: RequirePrincipalOptions = {}): Promise<PrincipalContext | Response> {
  if (options.kinds?.some((kind) => !PRINCIPAL_KINDS.includes(kind))) throw new RangeError("unknown principal kind");
  if (options.scope !== undefined && !isScope(options.scope)) throw new RangeError("scope must be <resource>:<action>");
  let found: PrincipalContext | null = null;
  try {
    found = await auth.authenticate(request);
  } catch {
    return reply(503, "auth unavailable");
  }
  if (!found) return reply(401, "unauthorized", { "www-authenticate": "Bearer" });
  if (options.kinds && !options.kinds.includes(found.kind)) return reply(403, "forbidden");
  if (options.scope !== undefined && !hasScope(found.scopes, options.scope)) return reply(403, "forbidden");
  return found;
}
