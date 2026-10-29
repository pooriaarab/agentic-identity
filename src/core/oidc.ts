// The config for one OpenID Connect provider. Keycloak, EU Login, and any
// other standard IdP use `oidcProvider`. Google is one preset.
export interface OidcProviderConfig {
  /** The exact text of the `iss` claim. It has no query or fragment. */
  issuer: string;
  clientId: string;
  clientSecret: string;
  /** Always includes `openid`. */
  scopes: string[];
}

export function oidcProvider(config: { issuer: string; clientId: string; clientSecret: string; scopes?: string[] }): OidcProviderConfig {
  let url: URL;
  try {
    url = new URL(config.issuer);
  } catch {
    throw new Error("issuer must be a URL");
  }
  const local = url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1");
  if (url.protocol !== "https:" && !local) throw new Error("issuer must use https");
  if (url.search !== "" || url.hash !== "" || config.issuer.includes("?") || config.issuer.includes("#")) throw new Error("issuer must have no query or fragment");
  if (config.clientId === "" || config.clientSecret === "") throw new Error("clientId and clientSecret are required");
  const scopes = config.scopes ?? ["openid", "email", "profile"];
  if (!scopes.includes("openid")) throw new Error("scopes must include openid");
  return { issuer: config.issuer, clientId: config.clientId, clientSecret: config.clientSecret, scopes };
}

/** The preset for Google sign-in. Any other provider uses `oidcProvider` with its own issuer. */
export const googleProvider = (clientId: string, clientSecret: string): OidcProviderConfig =>
  oidcProvider({ issuer: "https://accounts.google.com", clientId, clientSecret });

/**
 * Thrown by `beginLogin` and `finishLogin` for a bad discovery document or an unreachable provider, and
 * by `finishLogin` for a refused code or a bad or rejected id token. The message holds no token and no claim. The Worker answers 401 for it.
 */
export class OidcError extends Error {}

type Fetch = typeof fetch;
const b64url = (bytes: ArrayBuffer | Uint8Array) => Buffer.from(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)).toString("base64url");
const randomToken = (bytes: number) => b64url(crypto.getRandomValues(new Uint8Array(bytes)));

async function discover(provider: OidcProviderConfig, fetchImpl: Fetch) {
  // A provider that is down or answers with a page that is not JSON fails like a bad document.
  const res = await fetchImpl(`${provider.issuer}/.well-known/openid-configuration`).catch(() => undefined);
  const doc = (await res?.json().catch(() => undefined)) as Record<string, string> | null | undefined;
  // Each endpoint must be a URL: a number or a bad string would fail later with a raw error.
  const isUrl = (v: unknown) => typeof v === "string" && URL.canParse(v);
  if (!res?.ok || typeof doc !== "object" || doc === null || doc.issuer !== provider.issuer || !isUrl(doc.authorization_endpoint) || !isUrl(doc.token_endpoint) || !isUrl(doc.jwks_uri)) throw new OidcError("bad discovery document");
  return doc as { authorization_endpoint: string; token_endpoint: string; jwks_uri: string };
}

/** Step 1: the URL to send the browser to. Keep `state`, `nonce`, and `verifier` for step 2. */
export async function beginLogin(provider: OidcProviderConfig, redirectUri: string, fetchImpl: Fetch = fetch) {
  const [state, nonce, verifier] = [randomToken(16), randomToken(16), randomToken(32)];
  const challenge = b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  const url = new URL((await discover(provider, fetchImpl)).authorization_endpoint);
  const query = { response_type: "code", client_id: provider.clientId, redirect_uri: redirectUri, scope: provider.scopes.join(" "), state, nonce, code_challenge: challenge, code_challenge_method: "S256" };
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  return { url: url.toString(), state, nonce, verifier };
}

/** Step 2: trade the code for an id token, check it, and return who signed in. Throws `OidcError` on any problem. */
export async function finishLogin(
  provider: OidcProviderConfig,
  input: { redirectUri: string; code: string; nonce: string; verifier: string; now: number },
  fetchImpl: Fetch = fetch,
): Promise<{ subject: string; email?: string; emailVerified: boolean }> {
  const doc = await discover(provider, fetchImpl);
  const form = new URLSearchParams({ grant_type: "authorization_code", code: input.code, redirect_uri: input.redirectUri, client_id: provider.clientId, client_secret: provider.clientSecret, code_verifier: input.verifier });
  const tokenRes = await fetchImpl(doc.token_endpoint, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form }).catch(() => undefined);
  const idToken = ((await tokenRes?.json().catch(() => ({}))) as { id_token?: unknown } | null)?.id_token;
  if (!tokenRes?.ok || typeof idToken !== "string") throw new OidcError("the provider refused the code");
  const parts = idToken.split(".");
  if (parts.length !== 3) throw new OidcError("bad id token");
  try {
    const header = JSON.parse(Buffer.from(parts[0]!, "base64url").toString()) as { alg?: string; kid?: string };
    const keys = ((await (await fetchImpl(doc.jwks_uri)).json()) as { keys: (JsonWebKey & { kid?: string })[] }).keys;
    const jwk = keys.find((k) => k.kid === header.kid);
    if (header.alg !== "RS256" || !jwk) throw new OidcError("bad id token header");
    const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    const signed = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, Buffer.from(parts[2]!, "base64url"), new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
    const c = JSON.parse(Buffer.from(parts[1]!, "base64url").toString()) as Record<string, unknown>;
    const audOk = Array.isArray(c.aud) ? c.aud.includes(provider.clientId) && (c.aud.length === 1 || c.azp === provider.clientId) : c.aud === provider.clientId;
    const live = typeof c.exp === "number" && c.exp * 1000 > input.now;
    if (!signed || c.iss !== provider.issuer || !audOk || !live || c.nonce !== input.nonce || typeof c.sub !== "string" || c.sub === "") throw new OidcError("id token rejected");
    return { subject: c.sub, emailVerified: c.email_verified === true, ...(typeof c.email === "string" ? { email: c.email } : {}) };
  } catch (error) {
    throw error instanceof OidcError ? error : new OidcError("bad id token");
  }
}
