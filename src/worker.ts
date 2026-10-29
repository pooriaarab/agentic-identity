// The HTTP API, a Cloudflare Worker built on Hono. Routes live under /api/v1.
import { Hono, type Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { D1_SCHEMA, createD1Store, type D1Like } from "./adapters/cloudflare.js";
import { DEFAULT_CALLBACK_PATH, beginLogin, callbackUri, checkCallbackPath, finishLogin, oidcProvider, type OidcProviderConfig } from "./core/oidc.js";
import { ACTIONS, hasScope, isScope, type Principal, type PrincipalContext, type Scope } from "./core/principals.js";
import { recordChange } from "./core/audit.js";
import { EraseRefusedError, createSharing, type Role, type SubjectKind } from "./core/sharing.js";
import { deletePerson, exportPerson } from "./gdpr.js";
import { createStoreAuth, issueCredential, randomToken, revokeCredential, sha256Hex } from "./credentials.js";
import { StoreConflictError, parseRegion, type Store, type StoreOps } from "./ports.js";
import { PrincipalAdminError, revokePrincipal, rotateKey } from "./principal-admin.js";
import { createStoreRateLimiter, type RateLimiter, type RateRule } from "./ratelimit.js";

export interface WorkerConfig {
  /** Sign-in is off (404) when this is missing. `publicUrl` is the origin of this Worker. */
  signIn?: { provider: OidcProviderConfig; publicUrl: string };
  sessionTtlMs?: number;
  /** Turns on `POST /test/token`, which makes a new person with narrow rights. For tests only. */
  unsafeTestMint: boolean;
  /** Requests per window. A principal counts at the root of its chain. */
  rateLimits?: Partial<Record<"principal" | "ip" | "login" | "loginAll", RateRule>>;
}

const DEFAULT_LIMITS = {
  principal: { limit: 60, windowMs: 60_000 },
  ip: { limit: 120, windowMs: 60_000 },
  login: { limit: 20, windowMs: 60_000 },
  /** Sign-in starts for everyone in one flow lifetime. It caps the pending rows. */
  loginAll: { limit: 600, windowMs: 600_000 },
};

const FLOW_TTL_MS = 600_000;
const cookieFlags = { httpOnly: true, secure: true, sameSite: "Lax" } as const;

/**
 * A path on this origin, or `/`. Control characters, spaces, and `\` are refused as given.
 * The authoritative check runs on the parsed result, because URL parsing removes dot
 * segments and can turn a raw input that looks safe into `//host`, which a browser reads
 * as another site.
 */
function safeReturnTo(to: string, origin: string): string {
  if (/[\u0000-\u0020\u007f-\u009f\u2028\u2029\\]/.test(to)) return "/";
  let url: URL;
  try {
    url = new URL(to, origin);
  } catch {
    return "/";
  }
  if (url.origin !== origin || !/^\/(?![/\\])/.test(url.pathname)) return "/";
  return url.pathname + url.search + url.hash;
}

class HttpError extends Error {
  constructor(readonly status: 400 | 401 | 403 | 404 | 409 | 429 | 502 | 503, message: string, readonly retryAfterSeconds?: number) {
    super(message);
  }
}
const MAX_SCOPES = 32;

const fail = (status: HttpError["status"], message: string): never => {
  throw new HttpError(status, message);
};

export function createApp(deps: { store: Store; config: WorkerConfig; now?: () => number; fetch?: typeof fetch; limiter?: RateLimiter }) {
  const { store, config } = deps;
  const now = deps.now ?? Date.now;
  const auth = createStoreAuth(store, { now });
  const app = new Hono().basePath("/api/v1");
  const limiter = deps.limiter ?? createStoreRateLimiter(store, { now });
  const limits = { ...DEFAULT_LIMITS, ...config.rateLimits };
  const given = config.signIn?.provider.callbackPath;
  const customPath = given === DEFAULT_CALLBACK_PATH ? undefined : given;
  if (customPath !== undefined) checkCallbackPath(customPath);
  if (customPath !== undefined && (customPath === "/api/v1" || customPath.startsWith("/api/v1/"))) throw new Error("callbackPath must be outside /api/v1");
  // The flow cookie must reach the callback, so it uses the callback path when that is custom.
  const flowCookiePath = customPath === undefined ? "/api/v1/auth" : customPath;
  // Built on use, so a bad PUBLIC_URL fails the sign-in routes only.
  const redirectUri = () => callbackUri(config.signIn!.provider, config.signIn!.publicUrl);

  app.onError((error, c) => {
    if (error instanceof HttpError) return c.json({ error: error.message }, error.status, error.retryAfterSeconds === undefined ? {} : { "retry-after": String(error.retryAfterSeconds) });
    // A transaction that kept conflicting did nothing. The client can try again.
    if (error instanceof StoreConflictError) return c.json({ error: "try again" }, 409);
    return c.json({ error: error.message === "forbidden" ? "forbidden" : "bad request" }, error.message === "forbidden" ? 403 : 400);
  });

  // A call over its budget does nothing. A limiter that cannot count denies.
  const throttle = async (key: string, rule: RateRule) => {
    const result = await limiter.hit(key, rule).catch(() => fail(503, "try again later"));
    if (!result.allowed) throw new HttpError(429, "too many requests", Math.ceil(result.retryAfterMs / 1000));
  };
  const isWrite = (c: Context) => c.req.method !== "GET" && c.req.method !== "HEAD";

  // Writes, sign-in, and the anonymous access check each cost a row. Count them by IP.
  app.use("*", async (c, next) => {
    const ip = c.req.header("cf-connecting-ip") ?? "unknown";
    const path = c.req.path;
    if (isWrite(c) || path.includes("/auth/") || path.endsWith("/access")) await throttle(`ip:${ip}`, limits.ip);
    if (path.endsWith("/auth/login")) {
      await throttle(`login:${ip}`, limits.login);
      await throttle("login:all", limits.loginAll);
    }
    await next();
  });

  // One id for each request, made here and never taken from the caller. It names the request in the audit log.
  const requestId = (c: Context) => {
    const known = c.get("requestId") as string | undefined;
    if (known) return known;
    const made = crypto.randomUUID();
    c.set("requestId", made);
    c.header("x-request-id", made);
    return made;
  };
  const authed = (handler: (c: Context, ctx: PrincipalContext) => Promise<Response>) => async (c: Context) => {
    const found = await auth.authenticate(c.req.raw);
    if (!found) return fail(401, "unauthorized");
    const ctx = { ...found, requestId: requestId(c) };
    // A page on another site can make the browser send the session cookie. It cannot set Origin
    // to ours, and it cannot add an Authorization header.
    const viaCookie = !/^Bearer [A-Za-z0-9_-]{1,512}$/.test(c.req.header("authorization") ?? "");
    if (isWrite(c) && viaCookie && (!config.signIn || c.req.header("origin") !== new URL(config.signIn.publicUrl).origin)) return fail(403, "bad origin");
    if (isWrite(c)) await throttle(`principal:${ctx.chain[0]!.id}`, limits.principal);
    return handler(c, ctx);
  };
  const body = async (c: Context) => (await c.req.json().catch(() => fail(400, "body must be JSON"))) as Record<string, unknown>;
  const scopesOf = (value: unknown): Scope[] => {
    if (!Array.isArray(value) || value.length > MAX_SCOPES) return fail(400, "scopes must be a short list");
    if (!value.every(isScope)) return fail(400, "scopes must be strings in the scope format");
    return value;
  };
  const expiryOf = (value: unknown): number | undefined =>
    value === undefined ? undefined : Number.isInteger(value) && (value as number) > 0 ? now() + (value as number) : fail(400, "expiresInMs must be a positive integer");
  const id = (c: Context, name = "id") => String(c.req.param(name));
  const isPerson = (ctx: PrincipalContext) => ctx.kind === "human" && ctx.chain.length === 1;

  async function makePrincipal(ops: StoreOps, parent: PrincipalContext, kind: Principal["kind"], scopes: Scope[], expiresAt: number | undefined, extra: object = {}) {
    const principal = { id: `p_${randomToken(12)}`, kind, scopes, ...(kind === "agent" ? {} : { parentId: parent.principalId }), ...(expiresAt === undefined ? {} : { expiresAt }), ...extra };
    await ops.put("principals", principal.id, principal);
    return principal;
  }

  app.get("/auth/login", async (c) => {
    if (!config.signIn) return fail(404, "sign-in is not configured");
    const returnTo = safeReturnTo(c.req.query("returnTo") ?? "/", new URL(config.signIn.publicUrl).origin);
    // Rows nobody finished are removed here, oldest first. The global budget caps how many exist.
    const stale = await store.query("auth_flows", { orderBy: { field: "expiresAt" }, limit: 25 });
    await Promise.all(stale.items.filter((f) => !(typeof f.data.expiresAt === "number" && f.data.expiresAt > now())).map((f) => store.delete("auth_flows", f.id)));
    const login = await beginLogin(config.signIn.provider, redirectUri(), deps.fetch).catch(() => fail(502, "the sign-in provider is not reachable"));
    await store.put("auth_flows", login.state, { nonce: login.nonce, verifier: login.verifier, returnTo, expiresAt: now() + FLOW_TTL_MS });
    setCookie(c, "oidc_flow", login.state, { ...cookieFlags, path: flowCookiePath, maxAge: FLOW_TTL_MS / 1000 });
    return c.redirect(login.url, 302);
  });

  app.get("/auth/callback", async (c) => {
    const state = c.req.query("state");
    const code = c.req.query("code");
    if (!config.signIn || !state || !code || getCookie(c, "oidc_flow") !== state) return fail(400, "bad sign-in state");
    // A flow works once. Reading and deleting it together stops a replay.
    const flow = await store.transaction(async (tx) => {
      const found = await tx.get("auth_flows", state);
      await tx.delete("auth_flows", state);
      return found;
    });
    if (!flow || typeof flow.expiresAt !== "number" || !Number.isFinite(flow.expiresAt) || flow.expiresAt <= now()) return fail(400, "bad sign-in state");
    const { provider } = config.signIn;
    const who = await finishLogin(provider, { redirectUri: redirectUri(), code, nonce: flow.nonce as string, verifier: flow.verifier as string, now: now() }, deps.fetch).catch(() => fail(401, "sign-in failed"));
    const id = `u_${(await sha256Hex(`${provider.issuer}|${who.subject}`)).slice(0, 24)}`;
    if (!(await store.get("principals", id))) await store.put("principals", id, { id, kind: "human", scopes: ["*:admin"] });
    await store.put("users", id, { id, issuer: provider.issuer, subject: who.subject, emailVerified: who.emailVerified, ...(who.email ? { email: who.email } : {}) });
    const ttl = config.sessionTtlMs ?? 28_800_000;
    setCookie(c, "session", await issueCredential(store, { principalId: id, kind: "session", expiresAt: now() + ttl }), { ...cookieFlags, path: "/", maxAge: ttl / 1000 });
    deleteCookie(c, "oidc_flow", { path: flowCookiePath });
    return c.redirect(flow.returnTo as string, 302);
  });

  app.post("/auth/logout", authed(async (c) => {
    const token = getCookie(c, "session") ?? c.req.header("authorization")?.slice(7);
    if (token) await revokeCredential(store, token, now());
    return c.json({ ok: true });
  }));

  app.get("/me", authed(async (c, ctx) => c.json({ principalId: ctx.principalId, kind: ctx.kind, chain: ctx.chain, scopes: ctx.scopes })));

  // The export and the delete need the person at the keyboard, not an agent or a token.
  app.get("/me/export", authed(async (c, ctx) => {
    if (!isPerson(ctx)) return fail(403, "only the person can export");
    // The entry comes first, so the export holds the record of itself.
    await recordChange(store, ctx, { action: "person.export", targetKind: "person", targetId: ctx.principalId }, now());
    return c.json(await exportPerson(store, ctx.principalId));
  }));

  app.delete("/me", authed(async (c, ctx) => {
    if (!isPerson(ctx)) return fail(403, "only the person can delete");
    await deletePerson(store, ctx.principalId, { now, ...(ctx.requestId === undefined ? {} : { requestId: ctx.requestId }) });
    return c.json({ deleted: true });
  }));

  // A new person with narrow rights. It never touches a principal or a user that exists,
  // and it never marks an email as verified.
  app.post("/test/token", async (c) => {
    if (!config.unsafeTestMint) return fail(404, "not found");
    const input = await body(c);
    const userId = String(input.userId ?? "");
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(userId)) return fail(400, "bad userId");
    const scopes = input.scopes === undefined ? ["doc:admin"] : scopesOf(input.scopes);
    if (scopes.length === 0 || scopes.includes("*:admin")) return fail(400, "bad scopes");
    const email = typeof input.email === "string" ? input.email.toLowerCase() : undefined;
    // Only a test asks for this. Without it the mint never marks an email as verified.
    if (input.emailVerified !== undefined && (typeof input.emailVerified !== "boolean" || (input.emailVerified && email === undefined))) return fail(400, "bad emailVerified");
    const token = await store.transaction(async (tx) => {
      if ((await tx.get("principals", userId)) || (await tx.get("users", userId))) return fail(409, "that id exists");
      await tx.put("principals", userId, { id: userId, kind: "human", scopes });
      if (email !== undefined) await tx.put("users", userId, { id: userId, email, emailVerified: input.emailVerified === true });
      return issueCredential(tx, { principalId: userId, kind: "session", expiresAt: now() + 3_600_000 });
    });
    return c.json({ token });
  });

  // An agent with its own identity. Only a person makes one. The key is shown once.
  app.post("/agents", authed(async (c, ctx) => {
    if (!isPerson(ctx)) return fail(403, "only a person makes an agent");
    const input = await body(c);
    const handle = String(input.handle ?? "");
    if (!/^[a-z][a-z0-9_-]{1,31}$/.test(handle)) return fail(400, "bad handle");
    const scopes = scopesOf(input.scopes);
    if (!scopes.every((scope) => hasScope(ctx.scopes, scope))) return fail(403, "scopes exceed your own");
    const agent = await store.transaction(async (tx) => {
      if (await tx.get("handles", handle)) return fail(409, "handle taken");
      const made = { id: `p_${randomToken(12)}`, kind: "agent", scopes, handle, ownerId: ctx.principalId };
      await tx.put("handles", handle, { principalId: made.id });
      await tx.put("principals", made.id, made);
      const apiKey = await issueCredential(tx, { principalId: made.id, kind: "api_key", label: handle });
      await recordChange(tx, ctx, { action: "key.create", targetKind: "principal", targetId: made.id }, now());
      return { id: made.id, apiKey };
    });
    return c.json(agent);
  }));

  // A personal access token. It acts as the person, tagged as a token, with fewer scopes.
  app.post("/tokens", authed(async (c, ctx) => {
    if (!isPerson(ctx)) return fail(403, "only a person makes a token");
    const input = await body(c);
    const scopes = scopesOf(input.scopes);
    const expiresAt = expiryOf(input.expiresInMs);
    const label = String(input.label ?? "");
    return c.json(await store.transaction(async (tx) => {
      const made = await makePrincipal(tx, ctx, "user_token", scopes, expiresAt);
      const token = await issueCredential(tx, { principalId: made.id, kind: "pat", ...(expiresAt === undefined ? {} : { expiresAt }), label });
      await recordChange(tx, ctx, { action: "key.create", targetKind: "principal", targetId: made.id }, now());
      return { id: made.id, token };
    }));
  }));

  // A grant to an agent: a person makes an agent_of_human, an agent makes an agent_of_agent.
  app.post("/delegations", authed(async (c, ctx) => {
    if (ctx.kind === "user_token") return fail(403, "a token cannot delegate");
    const input = await body(c);
    const scopes = scopesOf(input.scopes);
    if (!scopes.every((s) => hasScope(ctx.scopes, s))) return fail(403, "scopes exceed your own");
    const expiresAt = expiryOf(input.expiresInMs);
    const label = String(input.label ?? "");
    return c.json(await store.transaction(async (tx) => {
      const made = await makePrincipal(tx, ctx, ctx.kind === "human" ? "agent_of_human" : "agent_of_agent", scopes, expiresAt);
      const apiKey = await issueCredential(tx, { principalId: made.id, kind: "api_key", label });
      await recordChange(tx, ctx, { action: "key.create", targetKind: "principal", targetId: made.id }, now());
      return { id: made.id, apiKey };
    }));
  }));

  // Revoking a principal stops it and everything below it, because rights are re-read up the chain.
  const adminError = (e: unknown) => (e instanceof PrincipalAdminError ? fail(e.status, e.message) : Promise.reject(e));
  app.delete("/principals/:id", authed(async (c, ctx) => {
    const revoked = await revokePrincipal(store, ctx, id(c), now).catch(adminError);
    return c.json({ revoked });
  }));

  // A new key for an agent. Every key it had stops in the same step. The new key is shown once.
  app.post("/principals/:id/keys", authed(async (c, ctx) => c.json(await rotateKey(store, ctx, id(c), now).catch(adminError))));

  const sharing = createSharing(store, { now });
  const pick = (input: Record<string, unknown>, ...keys: string[]) => Object.fromEntries(keys.filter((k) => typeof input[k] === "string").map((k) => [k, input[k]]));

  app.post("/resources", authed(async (c, ctx) => {
    const input = await body(c);
    return c.json(await sharing.createResource(ctx, { type: String(input.type), ...pick(input, "id", "parentId") }), 201);
  }));

  app.post("/resources/:id/grants", authed(async (c, ctx) => {
    const input = await body(c);
    if (typeof input.subjectId !== "string") return fail(400, "subjectId must be a string");
    await sharing.grant(ctx, id(c), { kind: input.subjectKind as SubjectKind, id: input.subjectId }, input.role as Role);
    return c.json({ ok: true });
  }));

  app.delete("/resources/:id/grants/:kind/:subjectId", authed(async (c, ctx) => {
    await sharing.revokeGrant(ctx, id(c), { kind: c.req.param("kind") as SubjectKind, id: id(c, "subjectId") });
    return c.json({ ok: true });
  }));

  app.get("/resources/:id/grants", authed(async (c, ctx) => {
    const limit = c.req.query("limit");
    const cursor = c.req.query("cursor");
    if (limit !== undefined && !/^[0-9]{1,6}$/.test(limit)) return fail(400, "bad limit");
    return c.json(await sharing.listGrants(ctx, id(c), { ...(limit === undefined ? {} : { limit: Number(limit) }), ...(cursor === undefined ? {} : { cursor }) }));
  }));

  // Erases the resource with its grants, invites, links, and audit entries. 409 when it has children.
  app.delete("/resources/:id", authed(async (c, ctx) => {
    await sharing.deleteResource(ctx, id(c)).catch((e: Error) => (e instanceof EraseRefusedError ? fail(409, e.message) : Promise.reject(e)));
    return c.json({ deleted: true });
  }));

  app.post("/resources/:id/invites", authed(async (c, ctx) => {
    const input = await body(c);
    const expiresInMs = typeof input.expiresInMs === "number" ? { expiresInMs: input.expiresInMs } : {};
    return c.json(await sharing.createInvite(ctx, id(c), { role: input.role as Role, ...pick(input, "email", "handle"), ...expiresInMs }), 201);
  }));

  // Needs an owner. The list holds no email: each invite says whether it is for an email or a handle.
  app.get("/resources/:id/invites", authed(async (c, ctx) => {
    const limit = c.req.query("limit");
    const cursor = c.req.query("cursor");
    if (limit !== undefined && !/^[0-9]{1,6}$/.test(limit)) return fail(400, "bad limit");
    return c.json(await sharing.listInvites(ctx, id(c), { ...(limit === undefined ? {} : { limit: Number(limit) }), ...(cursor === undefined ? {} : { cursor }) }));
  }));

  // Needs an owner. An accepted invite is 409: remove the grant instead.
  app.delete("/invites/:id", authed(async (c, ctx) => {
    await sharing.revokeInvite(ctx, id(c)).catch((e: Error) => (e.message === "invite already accepted" ? fail(409, e.message) : Promise.reject(e)));
    return c.json({ ok: true });
  }));

  // The email comes from a verified sign-in. The handle comes from the agent's own record.
  app.post("/invites/:id/accept", authed(async (c, ctx) => {
    const user = await store.get("users", ctx.principalId);
    const agent = await store.get("principals", ctx.principalId);
    await sharing.acceptInvite(ctx, id(c), { ...(user?.emailVerified === true ? pick(user, "email") : {}), ...pick(agent ?? {}, "handle") });
    return c.json({ ok: true });
  }));

  // The live invites for the caller's verified email or own handle, a page per call. An invitee never sees an invite id.
  app.post("/me/invites/accept", authed(async (c, ctx) => {
    const user = await store.get("users", ctx.principalId);
    const agent = await store.get("principals", ctx.principalId);
    const cursor = c.req.query("cursor");
    return c.json(await sharing.acceptPendingInvites(ctx, { ...(user?.emailVerified === true ? pick(user, "email") : {}), ...pick(agent ?? {}, "handle") }, cursor === undefined ? {} : { cursor }));
  }));

  app.post("/resources/:id/links", authed(async (c, ctx) => {
    const input = await body(c);
    const expiresAt = expiryOf(input.expiresInMs);
    return c.json(await sharing.createLink(ctx, id(c), { role: input.role as Role, signedInOnly: input.signedInOnly === true, ...(expiresAt === undefined ? {} : { expiresAt }) }), 201);
  }));

  app.delete("/links/:id", authed(async (c, ctx) => {
    await sharing.revokeLink(ctx, id(c));
    return c.json({ ok: true });
  }));

  // Anyone may ask. A visitor with a link token sends it in `x-link-token`. A bad credential is a 401, not a visitor.
  app.get("/resources/:id/access", async (c) => {
    const action = c.req.query("action");
    if (!ACTIONS.includes(action as never)) return fail(400, "bad action");
    const ctx = await auth.authenticate(c.req.raw);
    if (!ctx && (c.req.header("authorization") || c.req.header("cookie"))) return fail(401, "unauthorized");
    const linkToken = c.req.header("x-link-token");
    return c.json(await sharing.can(ctx, action as (typeof ACTIONS)[number], id(c), linkToken ? { linkToken } : {}));
  });

  // Newest first. `limit` and `cursor` page through it, and `nextCursor` shows when more entries exist.
  app.get("/resources/:id/audit", authed(async (c, ctx) => {
    const limit = c.req.query("limit");
    const cursor = c.req.query("cursor");
    if (limit !== undefined && !/^[0-9]{1,6}$/.test(limit)) return fail(400, "bad limit");
    return c.json(await sharing.listAudit(ctx, id(c), { ...(limit === undefined ? {} : { limit: Number(limit) }), ...(cursor === undefined ? {} : { cursor }) }));
  }));

  // Everything the person did, and what their agents and tokens did for them. Newest first.
  app.get("/me/audit", authed(async (c, ctx) => {
    const limit = c.req.query("limit");
    const cursor = c.req.query("cursor");
    if (limit !== undefined && !/^[0-9]{1,6}$/.test(limit)) return fail(400, "bad limit");
    return c.json(await sharing.listPersonAudit(ctx, { ...(limit === undefined ? {} : { limit: Number(limit) }), ...(cursor === undefined ? {} : { cursor }) }));
  }));

  if (customPath === undefined) return app;
  // The provider sends the person to the custom path. It answers as the standard callback, with the same checks and budgets.
  const root = new Hono();
  root.get(customPath, (c) => {
    const url = new URL(c.req.url);
    url.pathname = "/api/v1/auth/callback";
    return app.fetch(new Request(url, c.req.raw));
  });
  root.route("/", app);
  return root;
}

interface Env {
  DB: D1Like;
  /** `eu`, `us`, or `unknown`. A claim about where the database lives. */
  REGION: string;
  PUBLIC_URL?: string;
  IDENTITY_UNSAFE_TEST_MINT?: string;
  OIDC_ISSUER?: string;
  OIDC_CLIENT_ID?: string;
  OIDC_CLIENT_SECRET?: string;
  OIDC_CALLBACK_PATH?: string;
}

/** The test mint signs people in with no check. A config that names a region or an https URL is a real one. */
export function unsafeMintEnvError(env: Pick<Env, "REGION" | "PUBLIC_URL" | "IDENTITY_UNSAFE_TEST_MINT">): string | null {
  if (env.IDENTITY_UNSAFE_TEST_MINT !== "1") return null;
  const refuse = (why: string) => `IDENTITY_UNSAFE_TEST_MINT=1 is for tests only and ${why}`;
  if (env.REGION !== "unknown") return refuse("needs REGION=unknown");
  try {
    if (env.PUBLIC_URL && new URL(env.PUBLIC_URL).protocol === "https:") return refuse("cannot run with an https PUBLIC_URL");
  } catch {
    return refuse("needs a valid PUBLIC_URL, or none");
  }
  return null;
}

let schema: Promise<unknown> | undefined;
let warned = false;

/** The Worker config from the env. A bad OIDC setting throws, so the Worker does not start. */
export function workerConfig(env: Pick<Env, "IDENTITY_UNSAFE_TEST_MINT" | "OIDC_ISSUER" | "OIDC_CLIENT_ID" | "OIDC_CLIENT_SECRET" | "OIDC_CALLBACK_PATH" | "PUBLIC_URL">): WorkerConfig {
  if (env.OIDC_CALLBACK_PATH !== undefined && !(env.OIDC_ISSUER && env.PUBLIC_URL)) throw new Error("OIDC_CALLBACK_PATH needs OIDC_ISSUER and PUBLIC_URL");
  const provider = env.OIDC_ISSUER ? oidcProvider({ issuer: env.OIDC_ISSUER, clientId: env.OIDC_CLIENT_ID ?? "", clientSecret: env.OIDC_CLIENT_SECRET ?? "", ...(env.OIDC_CALLBACK_PATH !== undefined ? { callbackPath: env.OIDC_CALLBACK_PATH } : {}) }) : undefined;
  return { unsafeTestMint: env.IDENTITY_UNSAFE_TEST_MINT === "1", ...(provider && env.PUBLIC_URL ? { signIn: { provider, publicUrl: env.PUBLIC_URL } } : {}) };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const unsafe = unsafeMintEnvError(env);
    if (unsafe) throw new Error(unsafe);
    if (env.IDENTITY_UNSAFE_TEST_MINT === "1" && !warned) {
      warned = true;
      console.warn("IDENTITY_UNSAFE_TEST_MINT=1: POST /test/token signs in a new person with no check. Use it for tests only.");
    }
    schema ??= env.DB.prepare(D1_SCHEMA).run().catch((error) => {
      schema = undefined;
      throw error;
    });
    await schema;
    const config = workerConfig(env);
    return createApp({ store: createD1Store(env.DB, { region: parseRegion(env.REGION) }), config }).fetch(request);
  },
};
