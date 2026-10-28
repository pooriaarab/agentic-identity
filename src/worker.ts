// The HTTP API, a Cloudflare Worker built on Hono. Routes live under /api/v1.
import { Hono, type Context } from "hono";
import { D1_SCHEMA, createD1Store, type D1Like } from "./adapters/cloudflare.js";
import { ACTIONS, hasScope, parseScope, type Principal, type PrincipalContext, type Scope } from "./core/principals.js";
import { createSharing, type Role } from "./core/sharing.js";
import { createStoreAuth, issueCredential, randomToken } from "./credentials.js";
import { parseRegion, type Store } from "./ports.js";
import { createStoreRateLimiter, type RateLimiter, type RateRule } from "./ratelimit.js";

export interface WorkerConfig {
  /** Turns on `POST /test/token`, which makes a new person with narrow rights. For tests only. */
  unsafeTestMint: boolean;
  /** Requests per window. A principal counts at the root of its chain. */
  rateLimits?: Partial<Record<"principal" | "ip" | "login", RateRule>>;
}

const DEFAULT_LIMITS = {
  principal: { limit: 60, windowMs: 60_000 },
  ip: { limit: 120, windowMs: 60_000 },
  login: { limit: 20, windowMs: 60_000 },
};

class HttpError extends Error {
  constructor(readonly status: 400 | 401 | 403 | 404 | 409 | 429 | 503, message: string, readonly retryAfterSeconds?: number) {
    super(message);
  }
}
const fail = (status: HttpError["status"], message: string): never => {
  throw new HttpError(status, message);
};

export function createApp(deps: { store: Store; config: WorkerConfig; now?: () => number; limiter?: RateLimiter }) {
  const { store, config } = deps;
  const now = deps.now ?? Date.now;
  const auth = createStoreAuth(store, { now });
  const app = new Hono().basePath("/api/v1");
  const limiter = deps.limiter ?? createStoreRateLimiter(store, { now });
  const limits = { ...DEFAULT_LIMITS, ...config.rateLimits };

  app.onError((error, c) => {
    if (error instanceof HttpError) return c.json({ error: error.message }, error.status, error.retryAfterSeconds === undefined ? {} : { "retry-after": String(error.retryAfterSeconds) });
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
    if (path.endsWith("/auth/login")) await throttle(`login:${ip}`, limits.login);
    await next();
  });

  const authed = (handler: (c: Context, ctx: PrincipalContext) => Promise<Response>) => async (c: Context) => {
    const ctx = await auth.authenticate(c.req.raw);
    if (!ctx) return fail(401, "unauthorized");
    if (isWrite(c)) await throttle(`principal:${ctx.chain[0]!.id}`, limits.principal);
    return handler(c, ctx);
  };
  const body = async (c: Context) => (await c.req.json().catch(() => fail(400, "body must be JSON"))) as Record<string, unknown>;
  const scopesOf = (value: unknown): Scope[] => {
    if (!Array.isArray(value)) return fail(400, "scopes must be a list");
    for (const scope of value) parseScope(String(scope));
    return value as Scope[];
  };
  const expiryOf = (value: unknown): number | undefined =>
    value === undefined ? undefined : Number.isInteger(value) && (value as number) > 0 ? now() + (value as number) : fail(400, "expiresInMs must be a positive integer");
  const id = (c: Context, name = "id") => String(c.req.param(name));
  const isPerson = (ctx: PrincipalContext) => ctx.kind === "human" && ctx.chain.length === 1;

  async function makePrincipal(parent: PrincipalContext, kind: Principal["kind"], scopes: Scope[], expiresAt: number | undefined, extra: object = {}) {
    const principal = { id: `p_${randomToken(12)}`, kind, scopes, ...(kind === "agent" ? {} : { parentId: parent.principalId }), ...(expiresAt === undefined ? {} : { expiresAt }), ...extra };
    await store.put("principals", principal.id, principal);
    return principal;
  }

  app.get("/me", authed(async (c, ctx) => c.json({ principalId: ctx.principalId, kind: ctx.kind, chain: ctx.chain, scopes: ctx.scopes })));

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
    const token = await store.transaction(async (tx) => {
      if ((await tx.get("principals", userId)) || (await tx.get("users", userId))) return fail(409, "that id exists");
      await tx.put("principals", userId, { id: userId, kind: "human", scopes });
      if (email !== undefined) await tx.put("users", userId, { id: userId, email, emailVerified: false });
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
      return made;
    });
    return c.json({ id: agent.id, apiKey: await issueCredential(store, { principalId: agent.id, kind: "api_key", label: handle }) });
  }));

  // A personal access token. It acts as the person, tagged as a token, with fewer scopes.
  app.post("/tokens", authed(async (c, ctx) => {
    if (!isPerson(ctx)) return fail(403, "only a person makes a token");
    const input = await body(c);
    const scopes = scopesOf(input.scopes);
    const expiresAt = expiryOf(input.expiresInMs);
    const made = await makePrincipal(ctx, "user_token", scopes, expiresAt);
    return c.json({ id: made.id, token: await issueCredential(store, { principalId: made.id, kind: "pat", ...(expiresAt === undefined ? {} : { expiresAt }), label: String(input.label ?? "") }) });
  }));

  // A grant to an agent: a person makes an agent_of_human, an agent makes an agent_of_agent.
  app.post("/delegations", authed(async (c, ctx) => {
    if (ctx.kind === "user_token") return fail(403, "a token cannot delegate");
    const input = await body(c);
    const scopes = scopesOf(input.scopes);
    if (!scopes.every((s) => hasScope(ctx.scopes, s))) return fail(403, "scopes exceed your own");
    const expiresAt = expiryOf(input.expiresInMs);
    const made = await makePrincipal(ctx, ctx.kind === "human" ? "agent_of_human" : "agent_of_agent", scopes, expiresAt);
    return c.json({ id: made.id, apiKey: await issueCredential(store, { principalId: made.id, kind: "api_key", label: String(input.label ?? "") }) });
  }));

  // Revoking a principal stops it and everything below it, because rights are re-read up the chain.
  app.delete("/principals/:id", authed(async (c, ctx) => {
    const target = (await store.get("principals", id(c))) as (Principal & { ownerId?: string }) | null;
    if (!target) return fail(404, "not found");
    let allowed = target.ownerId === ctx.principalId;
    for (let up = target.parentId, i = 0; up && i < 8 && !allowed; i++) {
      allowed = up === ctx.principalId;
      up = ((await store.get("principals", up!)) as Principal | null)?.parentId;
    }
    if (!allowed) return fail(403, "forbidden");
    await store.put("principals", target.id, { ...target, revokedAt: now() });
    return c.json({ revoked: target.id });
  }));

  const sharing = createSharing(store, { now });
  const pick = (input: Record<string, unknown>, ...keys: string[]) => Object.fromEntries(keys.filter((k) => typeof input[k] === "string").map((k) => [k, input[k]]));

  app.post("/resources", authed(async (c, ctx) => {
    const input = await body(c);
    return c.json(await sharing.createResource(ctx, { type: String(input.type), ...pick(input, "id", "parentId") }), 201);
  }));

  app.post("/resources/:id/grants", authed(async (c, ctx) => {
    const input = await body(c);
    await sharing.grant(ctx, id(c), String(input.subjectId), input.role as Role);
    return c.json({ ok: true });
  }));

  app.delete("/resources/:id/grants/:subjectId", authed(async (c, ctx) => {
    await sharing.revokeGrant(ctx, id(c), id(c, "subjectId"));
    return c.json({ ok: true });
  }));

  app.post("/resources/:id/invites", authed(async (c, ctx) => {
    const input = await body(c);
    const expiresInMs = typeof input.expiresInMs === "number" ? { expiresInMs: input.expiresInMs } : {};
    return c.json(await sharing.createInvite(ctx, id(c), { role: input.role as Role, ...pick(input, "email", "handle"), ...expiresInMs }), 201);
  }));

  // The email comes from a verified sign-in. The handle comes from the agent's own record.
  app.post("/invites/:id/accept", authed(async (c, ctx) => {
    const user = await store.get("users", ctx.principalId);
    const agent = await store.get("principals", ctx.principalId);
    await sharing.acceptInvite(ctx, id(c), { ...(user?.emailVerified === true ? pick(user, "email") : {}), ...pick(agent ?? {}, "handle") });
    return c.json({ ok: true });
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

  app.get("/resources/:id/audit", authed(async (c, ctx) => c.json({ entries: await sharing.listAudit(ctx, id(c)) })));

  return app;
}

interface Env {
  DB: D1Like;
  /** `eu`, `us`, or `unknown`. A claim about where the database lives. */
  REGION: string;
  PUBLIC_URL?: string;
  IDENTITY_UNSAFE_TEST_MINT?: string;
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
    const config = { unsafeTestMint: env.IDENTITY_UNSAFE_TEST_MINT === "1" };
    return createApp({ store: createD1Store(env.DB, { region: parseRegion(env.REGION) }), config }).fetch(request);
  },
};
