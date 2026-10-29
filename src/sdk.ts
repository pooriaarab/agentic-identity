// A typed client for the Worker API. It needs only `fetch`, so it runs on Node, Workers, Deno,
// and the browser. It keeps the token safe: it refuses a base URL that would send it in the
// clear, refuses a token that could split a header, never follows a redirect, encodes every
// path part, and puts the token in no error.
import { ACTIONS, type Action, type AuditEntry, type ChainStep, type PrincipalKind, type Scope } from "./core/principals.js";
import { ROLES, SUBJECT_KINDS, type Decision, type Grant, type Resource, type Role, type Subject } from "./core/sharing.js";

export type { Action, AuditEntry, ChainStep, Decision, Grant, PrincipalKind, Resource, Role, Scope, Subject };

export interface ClientOptions {
  /** The origin of the Worker, with an optional path prefix. `https`, or `http` on localhost only. */
  baseUrl: string;
  /** A session, an agent key, or a personal token. Leave it out to call as a visitor. */
  token?: string;
  /** Defaults to the global `fetch`. */
  fetch?: typeof fetch;
  /** A whole number of milliseconds. Defaults to 30000. */
  timeoutMs?: number;
}

/** `http` is an answer with an error status. The others have status 0, or no usable body. */
export type ApiErrorReason = "http" | "bad_response" | "timeout" | "network";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly reason: ApiErrorReason,
    /** From the `Retry-After` of a 429, when it is a whole number of seconds up to a day. */
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export interface Me {
  principalId: string;
  kind: PrincipalKind;
  chain: ChainStep[];
  scopes: Scope[];
}
export interface NewAgent {
  id: string;
  /** Shown once. */
  apiKey: string;
}
export interface NewToken {
  id: string;
  /** Shown once. */
  token: string;
}
export interface NewLink {
  id: string;
  /** Shown once. */
  token: string;
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const TOKEN = /^[A-Za-z0-9_-]{1,512}$/;
const MAX_ERROR_LENGTH = 200;

function apiRoot(baseUrl: unknown): string {
  let url: URL;
  try {
    url = new URL(String(baseUrl));
  } catch {
    throw new TypeError("baseUrl must be a URL");
  }
  const local = url.protocol === "http:" && LOCAL_HOSTS.has(url.hostname);
  if (url.protocol !== "https:" && !local) throw new TypeError("baseUrl must be https, or http on localhost");
  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") throw new TypeError("baseUrl must have no password, query, or fragment");
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}/api/v1`;
}

/** An id. It cannot be empty, `.`, or `..`. */
function id(value: unknown, name: string): string {
  if (typeof value !== "string" || value === "" || value === "." || value === ".." || value.length > 256) throw new TypeError(`${name} must be an id`);
  return value;
}

/** One path part: an id with `/`, `?`, and `#` encoded. */
const part = (value: unknown, name: string) => encodeURIComponent(id(value, name));

function oneOf<T extends string>(value: unknown, list: readonly T[], name: string): T {
  if (!list.includes(value as T)) throw new RangeError(`${name} must be one of: ${list.join(", ")}`);
  return value as T;
}

export interface AuditPage {
  entries: AuditEntry[];
  nextCursor?: string;
}

function paging(input: { limit?: number; cursor?: string }): string {
  const query = new URLSearchParams();
  if (input.limit !== undefined) query.set("limit", String(input.limit));
  if (input.cursor !== undefined) query.set("cursor", input.cursor);
  const text = query.toString();
  return text ? `?${text}` : "";
}

const retryAfter = (header: string | null) => (header !== null && /^\d{1,5}$/.test(header) && Number(header) <= 86_400 ? Number(header) : undefined);

export function createClient(options: ClientOptions) {
  const root = apiRoot(options.baseUrl);
  const { token } = options;
  if (token !== undefined && !(typeof token === "string" && TOKEN.test(token))) throw new TypeError("token must be a bare token");
  const timeoutMs = options.timeoutMs ?? 30_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new TypeError("timeoutMs must be a whole number above 0");

  async function request<T>(method: string, path: string, body?: object, extra: Record<string, string> = {}): Promise<T> {
    const headers: Record<string, string> = { accept: "application/json", ...extra, ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) };
    let res: Response;
    try {
      // `redirect: "error"` keeps the token from leaving for another host.
      res = await (options.fetch ?? fetch)(`${root}${path}`, { method, headers, redirect: "error", signal: AbortSignal.timeout(timeoutMs), ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    } catch (error) {
      const timedOut = error instanceof Error && error.name === "TimeoutError";
      throw new ApiError(0, timedOut ? "the request timed out" : "the server could not be reached", timedOut ? "timeout" : "network");
    }
    if (res.redirected || (res.status >= 300 && res.status < 400)) throw new ApiError(res.status, "the server answered with a redirect", "network");
    const parsed: unknown = await res.json().catch(() => undefined);
    if (parsed === null || typeof parsed !== "object") throw new ApiError(res.status, "the server sent a response that is not JSON", "bad_response");
    if (!res.ok) {
      const message = (parsed as { error?: unknown }).error;
      // A server could echo the header it got. The token stays out of the error.
      const text = typeof message === "string" ? (token ? message.split(token).join("[redacted]") : message) : "the request failed";
      throw new ApiError(res.status, text.slice(0, MAX_ERROR_LENGTH), "http", res.status === 429 ? retryAfter(res.headers.get("retry-after")) : undefined);
    }
    return parsed as T;
  }

  const drop = (input: Record<string, unknown>) => Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined));

  return {
    /** A client for another credential on the same server. This one stays as it is. */
    withToken: (next: string) => createClient({ ...options, token: next }),

    me: () => request<Me>("GET", "/me"),
    logout: () => request<{ ok: true }>("POST", "/auth/logout"),
    /** The person's own data as JSON. Needs the person, not an agent or a token. */
    exportMe: () => request<Record<string, unknown>>("GET", "/me/export"),
    /** Removes the person and what only they own. Needs the person. */
    deleteMe: () => request<{ deleted: true }>("DELETE", "/me"),

    createAgent: (input: { handle: string; scopes: Scope[] }) => request<NewAgent>("POST", "/agents", drop({ handle: input.handle, scopes: input.scopes })),
    createToken: (input: { scopes: Scope[]; expiresInMs?: number; label?: string }) => request<NewToken>("POST", "/tokens", drop(input)),
    delegate: (input: { scopes: Scope[]; expiresInMs?: number; label?: string }) => request<NewAgent>("POST", "/delegations", drop(input)),
    revokePrincipal: (id: string) => request<{ revoked: string }>("DELETE", `/principals/${part(id, "id")}`),
    /** A new key for an agent. Its old keys stop. The new key is shown once. */
    rotateKey: (id: string) => request<NewAgent>("POST", `/principals/${part(id, "id")}/keys`),

    createResource: (input: { type: string; id?: string; parentId?: string }) => request<Resource>("POST", "/resources", drop(input)),
    /** The subject is a person (`human`) or an agent with its own identity (`agent`). The same id of the other kind holds no role. */
    grant: (resourceId: string, subject: Subject, role: Role) =>
      request<{ ok: true }>("POST", `/resources/${part(resourceId, "resourceId")}/grants`, { subjectKind: oneOf(subject?.kind, SUBJECT_KINDS, "subject.kind"), subjectId: id(subject?.id, "subjectId"), role: oneOf(role, ROLES, "role") }),
    revokeGrant: (resourceId: string, subject: Subject) =>
      request<{ ok: true }>("DELETE", `/resources/${part(resourceId, "resourceId")}/grants/${oneOf(subject?.kind, SUBJECT_KINDS, "subject.kind")}/${part(subject?.id, "subjectId")}`),
    /** The grants on a resource that are honored. Needs an owner. */
    listGrants: (resourceId: string, input: { limit?: number; cursor?: string } = {}) => {
      const query = new URLSearchParams();
      if (input.limit !== undefined) query.set("limit", String(input.limit));
      if (input.cursor !== undefined) query.set("cursor", input.cursor);
      const text = query.toString();
      return request<{ grants: Grant[]; nextCursor?: string }>("GET", `/resources/${part(resourceId, "resourceId")}/grants${text ? `?${text}` : ""}`);
    },
    /** Erases the resource with its grants, invites, links, and audit entries. Needs an owner. A resource with children is refused. */
    deleteResource: (resourceId: string) => request<{ deleted: true }>("DELETE", `/resources/${part(resourceId, "resourceId")}`),
    createInvite: (resourceId: string, input: { role: Role; email?: string; handle?: string; expiresInMs?: number }) =>
      request<{ id: string }>("POST", `/resources/${part(resourceId, "resourceId")}/invites`, drop({ ...input, role: oneOf(input.role, ROLES, "role") })),
    acceptInvite: (inviteId: string) => request<{ ok: true }>("POST", `/invites/${part(inviteId, "inviteId")}/accept`),
    createLink: (resourceId: string, input: { role: Role; expiresInMs?: number; signedInOnly?: boolean }) =>
      request<NewLink>("POST", `/resources/${part(resourceId, "resourceId")}/links`, drop({ ...input, role: oneOf(input.role, ROLES, "role") })),
    revokeLink: (linkId: string) => request<{ ok: true }>("DELETE", `/links/${part(linkId, "linkId")}`),
    /** Anyone may ask. A visitor passes the link token. A bad token on the client is a 401. */
    access: (resourceId: string, action: Action, input: { linkToken?: string } = {}) => {
      const path = `/resources/${part(resourceId, "resourceId")}/access?action=${oneOf(action, ACTIONS, "action")}`;
      return request<Decision>("GET", path, undefined, input.linkToken === undefined ? {} : { "x-link-token": input.linkToken });
    },
    /** The log of one resource, newest first. Needs an owner. Pass `nextCursor` as `cursor` to read the next page. */
    audit: (resourceId: string, input: { limit?: number; cursor?: string } = {}) => request<AuditPage>("GET", `/resources/${part(resourceId, "resourceId")}/audit${paging(input)}`),
    /** What the person did, and what their agents and tokens did for them, newest first. Needs the person. */
    myAudit: (input: { limit?: number; cursor?: string } = {}) => request<AuditPage>("GET", `/me/audit${paging(input)}`),
  };
}

export type IdentityClient = ReturnType<typeof createClient>;
