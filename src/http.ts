// Shared request check for apps. It is framework-free and uses only Request and Response,
// so it runs in a Worker. The `Auth` port reads the credential (a bearer key or a session
// cookie) and does the revoke and expiry checks. This adds the 401 and 403 answers.
import { PRINCIPAL_KINDS, hasScope, isScope, type PrincipalContext, type PrincipalKind, type Scope } from "./core/principals.js";
import type { Auth } from "./ports.js";

export interface RequirePrincipalOptions {
  /** Kinds that may pass. Any other kind gets a 403, and an empty list refuses everyone. Leave it out to allow every kind. */
  kinds?: readonly PrincipalKind[];
  /** A scope the principal must hold, as `<resource>:<action>`. A principal without it gets a 403. */
  scope?: Scope;
  /**
   * Origins (for example `https://app.example.org`) that may send a write with a session cookie.
   * A write (any method but GET, HEAD, OPTIONS) that rides on a cookie needs a matching `Origin`
   * header, or it gets a 403. A bearer key needs no origin. An empty entry never matches.
   */
  origins?: readonly string[];
}

const BEARER = /^Bearer [A-Za-z0-9_-]{1,512}$/;
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

const reply = (status: number, error: string, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify({ error }), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...headers } });

/**
 * Resolve the principal for a request, or answer with a Response to send back.
 * A missing, wrong-scheme, bad, expired, or revoked credential is a 401 with `WWW-Authenticate: Bearer`.
 * A good credential whose kind or scopes fall short is a 403, and so is a cookie write from an origin not in `origins`. The body never holds the credential.
 */
export async function requirePrincipal(request: Request, auth: Auth, options: RequirePrincipalOptions = {}): Promise<PrincipalContext | Response> {
  if (options.kinds?.some((kind) => !PRINCIPAL_KINDS.includes(kind))) throw new RangeError("unknown principal kind");
  if (options.scope !== undefined && !isScope(options.scope)) throw new RangeError("scope must be <resource>:<action>");
  const header = request.headers.get("authorization");
  // A header that is present but not a bearer token is a wrong scheme. A cookie must not rescue it.
  if (header !== null && !BEARER.test(header)) return reply(401, "unauthorized", { "www-authenticate": "Bearer" });
  const origin = request.headers.get("origin");
  let found: PrincipalContext | null = null;
  try {
    found = await auth.authenticate(request);
  } catch {
    return reply(503, "auth unavailable");
  }
  if (!found) return reply(401, "unauthorized", { "www-authenticate": "Bearer" });
  // A page on another site can make the browser send the cookie, but it cannot set Origin to ours.
  if (header === null && !SAFE_METHODS.has(request.method.toUpperCase()) && !(origin && options.origins?.includes(origin))) return reply(403, "bad origin");
  if (options.kinds && !options.kinds.includes(found.kind)) return reply(403, "forbidden");
  if (options.scope !== undefined && !hasScope(found.scopes, options.scope)) return reply(403, "forbidden");
  return found;
}
