# agentic-identity

[![npm version](https://img.shields.io/npm/v/agentic-identity)](https://www.npmjs.com/package/agentic-identity)
[![MIT license](https://img.shields.io/badge/license-MIT-blue)](https://opensource.org/license/mit)

[Package](https://www.npmjs.com/package/agentic-identity) · [Source](https://github.com/pooriaarab/agentic-identity) · [Support](https://github.com/pooriaarab/agentic-identity/issues)

People, agents, and the access they share: delegation, invites, links, and an audit trail.

> Status: 0.4.0 preview. This code has principals and delegation chains,
> the sharing model (roles, invites, share links, audit), six backend ports
> with in-memory adapters for most, Cloudflare D1 and R2 adapters, the contract suites,
> and the HTTP API (a Cloudflare Worker) with OIDC sign-in, API keys and personal access tokens,
> personal data export and delete, and the typed SDK. The CLI and the MCP server are not built yet.
>
> Warning: `POST /test/token` signs a new person in with no check. It is off unless you set
> `IDENTITY_UNSAFE_TEST_MINT=1`. Set it for tests only, never in production.

## Install

```sh
npm install agentic-identity
```

## Quick start

### Run the Worker

1. Make `wrangler.jsonc`:

   ```jsonc
   {
     "name": "my-identity",
     "main": "src/index.ts",
     "compatibility_date": "2026-06-01",
     "compatibility_flags": ["nodejs_compat"],
     "d1_databases": [{ "binding": "DB", "database_name": "my-identity", "database_id": "00000000-0000-0000-0000-000000000000" }],
     "vars": { "REGION": "unknown" }
   }
   ```

2. Export the Worker from `src/index.ts`:

   ```ts
   export { default } from "agentic-identity/worker";
   ```

3. Start it:

   ```sh
   npx wrangler dev
   ```

Local D1 reports no region, so keep `REGION` at `unknown`. For production, run
`wrangler d1 create my-identity --location weur`, copy the `database_id` it prints
into `wrangler.jsonc`, set `REGION` to `eu`, and set the OIDC settings in
[Worker API](#worker-api).

To try the API without an identity provider, put `IDENTITY_UNSAFE_TEST_MINT=1` in
`.dev.vars`. Then sign in a test person. The answer is `{ "token": ... }`. Use that token to read the person back. A `userId` works
once per local database, so use a new one each time you start again:

```sh
curl -s -X POST http://localhost:8787/api/v1/test/token -H "content-type: application/json" -d '{"userId":"ana"}'
# {"token":"<token>"}
curl -s http://localhost:8787/api/v1/me -H "Authorization: Bearer <token>"
```

### Use the SDK

```ts
import { createClient } from "agentic-identity/sdk";

const client = createClient({ baseUrl: "http://localhost:8787", token: "<token>" });
const me = await client.me();
await client.createResource({ id: "plan", type: "doc" });
```

## Features

- Five kinds of principal: a person, an agent for a person, an agent made by an agent, an agent with its own identity, and a token that acts as the user.
- Delegation chains where each step can only narrow scopes.
- Roles per resource: owner, editor, commenter, viewer. A folder role passes down.
- Invites by email for a person, or by handle for an agent.
- Share links with a role, an optional expiry, and a signed-in-only option.
- An audit trail of access checks that shows who acted, and for whom. Each entry keeps the principal kind.
- Storage behind ports (`Store`, `Blobs`, `Auth`, `Realtime`, `Mail`, `Queue`), so you can move from Cloudflare D1 to another store.
- Sign in with any OpenID Connect provider (Keycloak, EU Login, Google), and per-user data export and hard delete, served by the HTTP API.
- API keys and personal access tokens for agents, served by the HTTP API (see Worker API).
- A region claim on every adapter except `Auth`. `assertRegion` fails at start-up when a claim is missing or wrong.

## Not built yet

- The CLI (`npx agentic-identity`) and the MCP server.

## Limits

- OIDC discovery and the JWKS load on every sign-in. There is no cache yet. Only RS256 id tokens are accepted.
- The per-IP budgets read `CF-Connecting-IP`. Cloudflare sets that header and replaces any value a client sends. Without Cloudflare in front, a client can send any value, and requests without the header share one budget. Serve the Worker through Cloudflare to count per IP.
- `POST /test/token` is for tests only. Never set `IDENTITY_UNSAFE_TEST_MINT=1` in production.
- A grant, an invite, or a link does not write an audit entry yet.

## Principals and scopes

Every request has one principal and the chain it acts for. A scope is
`<resource>:<action>`, such as `docs:read` or `*:admin`. The actions run from
weak to strong: `read`, `comment`, `write`, `admin`. A stronger action covers a
weaker one. `*` works only as a resource, never as an action.

```ts
import { resolveChain, hasScope, auditEntry } from "agentic-identity";

const result = await resolveChain("agent-2", (id) => principals.get(id), { now: Date.now() });
if (result.ok && hasScope(result.scopes, "docs:write")) {
  const entry = auditEntry(result, { id, at: Date.now(), action: "docs:write", outcome: "allowed" });
}
```

`resolveChain` walks from the acting principal to its root. Each step can only
narrow the rights. It returns no rights when a principal is revoked or expired,
when the chain has a cycle or is deeper than `MAX_CHAIN_DEPTH` (5), when a
parent is missing, or when a kind has the wrong parent kind. Audit entries keep
the principal kind and the whole chain, and hold no email address.

## Sharing

`createSharing(store)` keeps resources, roles, invites, share links, and the
audit log in a `Store`. The roles are `viewer`, `commenter`, `editor`, and
`owner`. A grant on a folder passes down to what is inside. It never passes up.

```ts
const sharing = createSharing(store);
await sharing.createResource(ctx, { id: "plan", type: "doc" }); // the caller owns it
await sharing.grant(ctx, "plan", { kind: "human", id: "ana" }, "editor");
const link = await sharing.createLink(ctx, "plan", { role: "viewer", signedInOnly: true });
const { allowed } = await sharing.can(visitor, "read", "plan", { linkToken: link.token });
```

- `can` joins two checks: the scopes that `resolveChain` left, and the role of
  the chain root. A delegated agent gets its owner's role, cut down by scopes.
- An invite is by email for a person, or by handle for an agent. It never makes
  an owner. The caller passes the verified email or the agent handle to
  `acceptInvite`. A delegated agent cannot accept for its owner.
- A link has a role, an optional expiry, and an optional signed-in-only flag.
  The token is shown once. The store keeps only its hash.
- `can` writes an audit entry for every allow and deny. It keeps the chain and
  a machine label, and holds no email address. Grants, invites, and links do not
  write audit entries yet.
- `listAudit(ctx, resourceId, { limit, cursor })` needs an owner. It returns
  `{ entries, nextCursor }`, newest first. `limit` is a whole number from 1 to 200
  (default 50). `nextCursor` is set only when more entries exist. Pass it as `cursor`
  to read the next page. A bad `limit` or `cursor` throws.

## Worker API

`agentic-identity/worker` is a Hono Worker under `/api/v1`, with data in D1. Create
the database with `--location weur`, and set `REGION` to say so. Send a key as
`Authorization: Bearer <key>`.

- `POST /agents`, `/tokens`, and `/delegations` make an agent key, a personal
  token, and a grant. A key is shown once, and the store keeps only its hash.
  Scopes can only narrow, and a grant can expire.
- `DELETE /principals/:id` revokes it, and every key below it stops at once.
- `/resources`, `/grants`, `/invites`, `/links`, `/access`, and `/audit` expose sharing.
  A grant names its subject by kind (`human` or `agent`) and id: `POST /resources/:id/grants` takes
  `subjectKind` and `subjectId`, and `DELETE /resources/:id/grants/:kind/:subjectId` removes one. `GET /resources/:id/grants?limit=&cursor=` lists them (an owner only).
  `DELETE /resources/:id` erases a resource with its grants, invites, links, and audit entries. It
  answers 409 when the resource has children or too many owners.
  `GET /resources/:id/audit?limit=&cursor=` returns `{ entries, nextCursor }`, newest
  first. The SDK call is `audit(resourceId, { limit, cursor })`.
- `POST /test/token` makes a new person with narrow rights (`doc:admin` unless the body lists other scopes, never `*:admin`). It never changes a person that exists and never marks an email as verified. It answers 404 unless `IDENTITY_UNSAFE_TEST_MINT=1`, and the Worker refuses to run with that flag when `REGION` is not `unknown` or `PUBLIC_URL` is https.
- A write, a sign-in start, and the anonymous `/access` check each have a budget per IP (read from `CF-Connecting-IP`). A write also has a budget per principal, counted at the root of its chain. Over budget is a 429 with `Retry-After`, and the call does nothing. Defaults: 60 writes per principal, 120 calls per IP, and 20 sign-in starts per IP, each per minute. The counter rows hold a hash of the key, never an IP. A limiter that cannot count answers 503.
- `GET /auth/login` and `/auth/callback` sign a person in with OpenID Connect
  (code flow with PKCE, and state and nonce checks). Set `OIDC_ISSUER`,
  `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, and `PUBLIC_URL`. Keycloak, EU Login, and
  Google all work: `issuer` is the only setting that differs. The session cookie is
  `HttpOnly`, `Secure`, and `SameSite=Lax`. An id token must be RS256.
- `GET /me/export` returns the person's data as JSON. `DELETE /me` removes the
  person, their agents, grants, and keys, and each resource that only they own.
  Both need the person's own session or key, not an agent or a token. A resource
  that someone else owns stays, even when it sits in a deleted folder.

## SDK

`agentic-identity/sdk` is a typed client for the Worker API. It needs only `fetch`.

```ts
import { createClient, ApiError } from "agentic-identity/sdk";

const me = createClient({ baseUrl: "https://id.example.org", token: process.env.AGENT_KEY });
await me.createResource({ id: "plan", type: "doc" });
const link = await me.createLink("plan", { role: "viewer", expiresInMs: 3_600_000 });
const visitor = createClient({ baseUrl: "https://id.example.org" });
await visitor.access("plan", "read", { linkToken: link.token });
```

- It refuses a `baseUrl` that is `http` (except localhost), or holds a password, a
  query, or a fragment. It refuses a token that is not a bare token.
- It never follows a redirect, so a redirect cannot carry the token to another host.
- It encodes each path part, refuses `.`, `..`, and an empty id, and checks the role
  and the action before it sends anything.
- A failure is an `ApiError` with `status`, `reason` (`http`, `bad_response`,
  `timeout`, or `network`), and `retryAfterSeconds` for a 429. No error holds the token.
- `withToken(token)` makes a client for another credential, such as an agent key.
- The default time limit is 30 seconds (`timeoutMs`).

## Ports

App code talks to ports, not to a vendor. Six ports exist: `Store`, `Blobs`,
`Auth`, `Realtime`, `Mail`, and `Queue`. Each has a contract suite. `Store`,
`Blobs`, `Auth`, `Mail`, and `Queue` have memory adapters. `Realtime` has
`createHmacRealtime`, which you can also use in tests.

- `Store` keeps JSON docs in named collections. It has `get`, `put`, `delete`,
  `query`, and `transaction`. A query takes equality filters, one `orderBy`, a
  `limit`, and a `cursor`. There are no joins, so a Firestore adapter fits.
- `Blobs` keeps bytes by key. It has `put`, `get`, `head`, `delete`, and `signedUrl`.
  Every object has a version. `put` takes `ifMatch` (a version) or `ifNoneMatch: "*"`
  (create only), checks it and writes in one step, and returns `{ version }`, or `null`
  when the condition failed. A refused put changes nothing. A version is opaque: an R2
  etag, a GCS generation, a counter. `signedUrl` for a GET can sign in
  `responseContentDisposition` and `responseContentType`, so the holder of the link
  cannot change how the bytes are served. A version covers the bytes only, not the
  metadata: an R2 etag is a hash, so a rewrite with the same bytes and another
  `contentType` keeps the version. `Blobs` has no `list`, and no streamed or range read
  or write. `get` and `put` hold the whole object in memory, and a Worker has 128 MB.
  Send large uploads and downloads through `signedUrl`.
- `Auth` reads the credential on a `Request` and returns a principal context, or
  `null`. `Realtime` issues and verifies room tokens. `createHmacRealtime` signs
  with HMAC-SHA256 and takes a list of keys: the first signs, all verify, so you
  can rotate. `Mail` sends one message and refuses a bad address or a header
  injection. `Queue` sends a JSON body to a topic, with a delay. A handler that
  throws gets the message again, up to 3 attempts, and then the message is parked.
- Every adapter except `Auth` takes a `region` option (`"eu"`, `"us"`, or `"unknown"`) and
  exposes it. The default is `"unknown"`. The region is a claim that you make:
  an adapter cannot always see where its data lives. Call
  `assertRegion("eu", store, blobs)` at start-up to fail when a claim is
  missing or says another region.
- A transaction reads first and writes after. A read after a write throws. This
  is the Firestore rule, and every adapter follows it. A transaction runs again
  when a doc it read changed, so keep it free of side effects. Use the doc id,
  not a query, to keep a value unique: write a claim doc such as `names/<folder>:<name>`
  in the same transaction as the item, and two writers cannot both claim it. To edit one
  doc without losing a concurrent edit (a lock in other stores), read it, change it, and
  write it back inside one transaction. Two kinds of backend exist, and both are correct.
  An optimistic backend (memory, D1) lets a rival write land, then runs the transaction
  again. When the rival keeps winning, it throws `StoreConflictError` and writes nothing.
  A pessimistic backend (a Firestore server SDK) locks the docs a transaction read, so a
  rival write waits and lands after the commit. Code that calls `transaction` handles
  both: catch `StoreConflictError`, and never assume a rival write lands first. No backend
  loses an update. The contract suite accepts either ending and fails a lost update.

`createMemoryStore` and `createMemoryBlobs` are for tests and local work. They
lose data on exit. To write an adapter, run the contract suites against it. They
use `vitest`, an optional peer dependency.

```ts
import { runStoreContract } from "agentic-identity/testing";

runStoreContract((options) => new MyStore(options));
```

## Cloudflare adapters

`agentic-identity/cloudflare` has a D1 `Store` and an R2 `Blobs`. Both pass the
contract suites against a real D1 database and R2 bucket under miniflare.

Create the resources in the EU. The adapter cannot move them later. The
`region` option is required. It states where the resources live, and it is a
claim that you make. D1 also reports the region that served each query, and the
store throws when that region disagrees with your claim. R2 reports nothing, so
its claim is not checked.

```sh
wrangler d1 create my-db --location weur
wrangler r2 bucket create my-bucket --jurisdiction eu
```

```ts
import { D1_SCHEMA, createD1Store, createR2Blobs, verifySignedBlobUrl } from "agentic-identity/cloudflare";

await env.DB.prepare(D1_SCHEMA).run(); // once, or put it in a migration
const store = createD1Store(env.DB, { region: "eu" });
const blobs = createR2Blobs(env.BUCKET, { region: "eu", urlBase: "https://files.example.org/blob", urlSecret: env.URL_SECRET });
```

- With `region: "eu"` or `"us"`, the D1 store confirms where D1 served each read (`get`, `query`,
  and the reads in a transaction). It refuses a read when D1 reports no region, or a region
  outside the claim (`eu`: WEUR, EEUR. `us`: WNAM, ENAM. Codes compare without case). Writes go
  to the primary and report nothing, so they are not checked. Local D1 reports no region: use
  `region: "unknown"` there.
- D1 keeps every doc in one table keyed by collection and id. Filters and
  ordering read the JSON body. Add an expression index per filtered field on a
  large collection (see `D1_SCHEMA`).
- D1 has no interactive transactions. A transaction checks the version of each
  doc it read and writes in one atomic batch. It runs again when a doc changed.
  A query inside a transaction guards the docs it returned, not new matches.
- R2 bindings cannot make presigned URLs. `signedUrl` makes an HMAC URL for your
  Worker. Call `verifySignedBlobUrl(url, { secret })` there, then serve the key
  from the bucket. The secret has no default and needs 32 bytes or more. Signing
  and `verifySignedBlobUrl` both throw when it is missing or short. Use one
  secret per bucket.

## Develop

```sh
npm ci
npm run build && npm run typecheck && npm test
```

## License

MIT.
