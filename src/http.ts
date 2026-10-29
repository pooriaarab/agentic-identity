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

export interface WebSocketAuthOptions extends RequirePrincipalOptions {
  /**
   * The subprotocol name of the app, for example `agentic-docs`. A browser offers two entries:
   * `<protocol>` and `<protocol>.bearer.<token>`. The server answers with `<protocol>` only.
   */
  protocol: string;
  /** How the token sits in the entry. `base64url` (the default) holds the UTF-8 token in base64url. `plain` holds the token as it is. */
  encoding?: "base64url" | "plain";
}

const PROTOCOL_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,128}$/;
const BEARER_TOKEN = /^[A-Za-z0-9_-]{1,512}$/;

function offeredProtocols(request: Request): string[] {
  return (request.headers.get("sec-websocket-protocol") ?? "").split(",").map((p) => p.trim()).filter(Boolean);
}

function decodeToken(value: string, encoding: "base64url" | "plain"): string | undefined {
  if (encoding === "plain") return BEARER_TOKEN.test(value) ? value : undefined;
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return undefined;
  try {
    const bytes = Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/")), (ch) => ch.charCodeAt(0));
    const token = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return BEARER_TOKEN.test(token) ? token : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolve the principal for a WebSocket upgrade, or answer with a Response to send back.
 * A browser cannot set `Authorization` on a WebSocket, so the token comes in the subprotocol entry
 * `<protocol>.bearer.<token>`. The bare `<protocol>` must be offered too, because the answer can only
 * name an entry that the browser offered, and it must never name the one that holds the token.
 * Then the request goes through `requirePrincipal` with the token as a bearer key.
 *
 * - A request that is not a WebSocket upgrade, or that has an `Authorization` header, ignores the subprotocol.
 * - A missing, malformed, repeated, or bad token is a 401. A bare `<protocol>` offered alone gives no token.
 * - With no token and no header, the session cookie may sign the socket in, but only from an `Origin` in
 *   `origins`. Without it, a page on another site could open the socket with the cookie. That is a 403.
 * Send the 101 answer through `acceptWebSocketProtocol`.
 */
export async function principalFromWebSocketRequest(request: Request, auth: Auth, options: WebSocketAuthOptions): Promise<PrincipalContext | Response> {
  if (!PROTOCOL_NAME.test(options.protocol)) throw new RangeError("protocol must be a token with no comma or space");
  const encoding = options.encoding ?? "base64url";
  if (encoding !== "base64url" && encoding !== "plain") throw new RangeError("encoding must be base64url or plain");
  const { protocol, encoding: _encoding, ...rest } = options;
  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket" || request.headers.has("authorization")) return requirePrincipal(request, auth, rest);
  const offered = offeredProtocols(request);
  const prefix = `${protocol}.bearer.`;
  const entries = offered.filter((p) => p.startsWith(prefix));
  if (entries.length === 0) {
    const origin = request.headers.get("origin");
    // No token: only the cookie is left. Treat the upgrade like a cookie write, so it needs a listed origin.
    if (request.headers.has("cookie") && !(origin && options.origins?.includes(origin))) return reply(403, "bad origin");
    return requirePrincipal(request, auth, rest);
  }
  const token = entries.length === 1 && offered.includes(protocol) ? decodeToken(entries[0]!.slice(prefix.length), encoding) : undefined;
  if (token === undefined) return reply(401, "unauthorized", { "www-authenticate": "Bearer" });
  const headers = new Headers(request.headers);
  headers.delete("cookie");
  headers.delete("sec-websocket-protocol");
  headers.set("authorization", `Bearer ${token}`);
  return requirePrincipal(new Request(request.url, { method: request.method, headers }), auth, rest);
}

/**
 * Name the subprotocol on the 101 answer of a socket, so the browser keeps it open. It names `protocol`
 * and never the entry that holds the token. Any other answer, and a request that did not offer `protocol`,
 * come back as they are.
 */
export function acceptWebSocketProtocol(request: Request, response: Response, protocol: string): Response {
  if (response.status !== 101 || !offeredProtocols(request).includes(protocol)) return response;
  try {
    response.headers.set("sec-websocket-protocol", protocol);
    return response;
  } catch {
    // The headers of an answer from a Durable Object stub are read-only, so build a new answer around the socket.
    const headers = new Headers(response.headers);
    headers.set("sec-websocket-protocol", protocol);
    return new Response(null, { status: 101, headers, webSocket: (response as Response & { webSocket?: unknown }).webSocket } as ResponseInit);
  }
}
