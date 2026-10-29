# agentic-identity

[![npm version](https://img.shields.io/npm/v/agentic-identity)](https://www.npmjs.com/package/agentic-identity)
[![MIT license](https://img.shields.io/badge/license-MIT-blue)](https://opensource.org/license/mit)

[Package](https://www.npmjs.com/package/agentic-identity) · [Source](https://github.com/pooriaarab/agentic-identity) · [Support](https://github.com/pooriaarab/agentic-identity/issues)

People, agents, and the access they share: delegation, invites, links, and an audit trail.

> Status: 0.6.0 preview. This code has principals and delegation chains,
> the sharing model (roles, invites, share links, audit), six backend ports
> with in-memory adapters for most, Cloudflare D1 and R2 adapters, a Firestore Store and Blobs, a Netlify Store and Blobs, a file Store and Blobs, a Store-backed Queue, Mail adapters, the contract suites,
> and the HTTP API (a Cloudflare Worker) with OIDC sign-in, API keys and personal access tokens,
> personal data export and delete, account export and erase across apps, and the typed SDK. The CLI and the MCP server are built. They work on a local file.
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
`.dev.vars`. Then sign in a test person. `POST /test/token` returns `{ "token": ... }`.
Use that token to read the person back. A `userId` works once per local database, so
use a new one each time you start again:

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
- An audit trail that shows who acted, and for whom. It records access checks and every change: a grant, a revoke, an invite, a link, a key, an export, and an erase. Each entry keeps the principal kind.
- Storage behind ports (`Store`, `Blobs`, `Auth`, `Realtime`, `Mail`, `Queue`), so you can move from Cloudflare D1 to another store.
- A CLI (`agentic-identity`) and an MCP server (`agentic-identity-mcp`) for principals, roles, invites, links, and the audit log, on a local JSON file.
- Sign in with any OpenID Connect provider (Keycloak, EU Login, Google), and per-user data export and hard delete, served by the HTTP API.
- API keys and personal access tokens for agents, served by the HTTP API (see Worker API).
- A region claim on every adapter except `Auth`. `assertRegion` fails at start-up when a claim is missing or wrong.

## Not built yet

- A CLI and an MCP server for the Worker API. The ones here work on a local file and do not call the Worker.

## Limits

- OIDC discovery and the JWKS load on every sign-in. There is no cache yet. Only RS256 id tokens are accepted.
- The per-IP budgets read `CF-Connecting-IP`. Cloudflare sets that header and replaces any value a client sends. Without Cloudflare in front, a client can send any value, and requests without the header share one budget. Serve the Worker through Cloudflare to count per IP.
- `POST /test/token` is for tests only. Never set `IDENTITY_UNSAFE_TEST_MINT=1` in production.
- The CLI and the MCP server read the audit log of one resource (`audit`) from a local file. They do not call the Worker.

## CLI

The CLI works on a local JSON file. It does not call the Worker. It prints JSON
on stdout. An error goes to stderr as `error: <message>`. The exit code is 0 for
success, 1 for a refused or failed action, and 2 for a usage error (this includes
an acting principal that is unknown, revoked, or expired).

```sh
npx agentic-identity resources create doc --id plan
npx agentic-identity agents create helper --scopes doc:read
npx agentic-identity grants set plan agent <agent-id> viewer
npx agentic-identity links create plan viewer --expires-in-ms 3600000
npx agentic-identity audit plan
```

Every command has `--help`. The commands are:

| Command | What it does |
|---|---|
| `whoami` | Shows the acting principal, its chain, and its scopes. |
| `principals list` | Lists the principals in the file. |
| `agents create <handle> --scopes a,b` | Makes an agent with its own identity. Only a person can. |
| `resources create <type> [--id] [--parent]` | Makes a resource. The actor owns it. |
| `grants set\|revoke\|list` | Gives, removes, and lists roles on a resource. |
| `invites create\|accept\|list\|revoke` | Invites a person by `--email` or an agent by `--handle`. |
| `links create\|revoke\|resolve` | Makes, revokes, and checks a share link. |
| `audit <resource>` | Reads the audit log, newest first. |

- The file is `~/.agentic-identity/store.json`. Change it with `--store <file>`,
  `AGENTIC_IDENTITY_STORE`, or `AGENTIC_IDENTITY_HOME` (the folder that holds
  `store.json`). The file mode is `0600`.
- The first command makes a person named `local` with all rights. Each command
  acts as `local`. Use `--as <principal-id>` or `AGENTIC_IDENTITY_AS` to act as
  an agent, so its scopes and roles apply.
- `invites accept --email` takes the email as given. The CLI does not verify it,
  because whoever holds the file is trusted. An agent accepts with its own handle.
- `invites list` shows no email. `principals list` needs an actor with all rights (`*:admin`).
- Several processes can use one file. Each command reads the file again when
  another process changed it. A write that another process overtook fails with
  an error such as "the store file changed during the write" and changes
  nothing. Run it again. A crash can leave `store.json.lock`. A command removes it
  when it is 3 seconds old.
- The same file store is available as `createFileStore` from `agentic-identity/file`.

## MCP server

`agentic-identity-mcp` (also `agentic-identity mcp`) serves the CLI commands as
MCP tools over stdio. It speaks JSON-RPC 2.0, one JSON message per line. It
works on the same store file as the CLI, with the same options (`--store`,
`--as`) and the same environment variables.

```json
{ "mcpServers": { "identity": { "command": "npx", "args": ["agentic-identity-mcp", "--as", "<agent-id>"] } } }
```

- There is one tool for each CLI command: `identity_whoami`, `identity_principals_list`,
  `identity_agents_create`, `identity_resources_create`, `identity_grants_set`,
  `identity_grants_revoke`, `identity_grants_list`, `identity_invites_create`,
  `identity_invites_accept`, `identity_invites_list`, `identity_invites_revoke`, `identity_links_create`,
  `identity_links_revoke`, `identity_links_resolve`, and `identity_audit`.
- A tool takes the CLI arguments, with `_` in a name for `-` (`expires_in_ms`).
  A result holds the JSON as text, and as `structuredContent` when it is an object.
- A refused or failed call is a result with `isError: true`. A bad request or an
  unknown tool is a JSON-RPC error.
- The server acts as one principal for its whole run. Start it with `--as` and
  an agent id, so the agent gets only its own rights. Without `--as` it acts as
  `local`, which has all rights.
- Each call reads the file again when another process changed it, so the CLI and
  the server can share one file.
- It handles one message at a time, and it has no batch support.

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

Import the kinds from the package. Do not copy the list into your app.

```ts
import { PRINCIPAL_KINDS, type Principal, type PrincipalKind } from "agentic-identity";

const isKind = (kind: unknown): kind is PrincipalKind => PRINCIPAL_KINDS.includes(kind as PrincipalKind);
const isPrincipal = (p: Principal) => isKind(p.kind);
```

To check a principal that comes from outside, call `parsePrincipal`. It throws
`PrincipalParseError` when `kind` is missing or unknown (it never defaults to
`human`), or when `id` is not 1 to 128 characters of `A-Z a-z 0-9 . _ -` that
start with a letter, digit, `_` or `-`. It returns only `{ kind, id }`.
`subjectOf` gives the stable string `kind:id`.

```ts
import { parsePrincipal, subjectOf } from "agentic-identity";

const who = parsePrincipal(JSON.parse(body)); // { kind: "agent", id: "bot-1" }
subjectOf(who); // "agent:bot-1"
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

- `revokeGrant(ctx, resourceId, subject)` removes one grant. It needs an owner, and it
  refuses to remove the last owner.
- `listGrants(ctx, resourceId, { limit, cursor })` needs an owner. It returns
  `{ grants, nextCursor }`. `limit` is a whole number from 1 to 200 (default 50). Pass
  `nextCursor` as `cursor` to read on.
- `deleteResource(ctx, resourceId)` needs an owner. It erases the resource with its grants,
  invites, links, and audit entries. It refuses a resource with children, or with more than
  100 owners. An audit entry that `can` writes during the erase can stay. Run it again if
  it fails part way.
- `can` joins two checks: the scopes that `resolveChain` left, and the role of
  the chain root. A delegated agent gets its owner's role, cut down by scopes.
- An invite is by email for a person, or by handle for an agent. It never makes
  an owner. The caller passes the verified email or the agent handle to
  `acceptInvite`. A delegated agent cannot accept for its owner.
- A link has a role, an optional expiry, and an optional signed-in-only flag.
  The token is shown once. The store keeps only its hash.
- `can` writes an audit entry for every allow and deny. It keeps the chain and
  a machine label, and holds no email address.
- Each grant, revoke, invite, accept, link create, link revoke, key create, key rotate,
  and key revoke writes one entry in the same transaction as the change. An export writes
  its entry just before it reads the data. An erase writes its tombstone just before it
  removes the person, and a second run of a failed erase writes a second tombstone.
  The entry holds the actor with its kind, the target kind and id, the action, the time,
  and the request id. It holds no email, handle, or key. An erase of a person removes
  their entries and leaves one tombstone with the time and the request id, and no id of the person. It blanks
  the target of entries that named what it erased.
- `listPersonAudit(ctx, { limit, cursor })` lists what a person did, and what the agents
  and tokens that act for them did. An agent with its own identity is not included, and
  neither are entries from before 0.5.0. Only the person may read it.
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
  `POST /principals/:id/keys` rotates the key of an agent: the old keys stop, and the new key is shown once.
- `GET /me/audit?limit=&cursor=` lists the log of the person, newest first. The SDK call is
  `myAudit({ limit, cursor })`. Each response has an `x-request-id` header, which is the
  `requestId` of the entries that the request wrote.
- `/resources` and the paths under `/resources/:id` expose sharing: grants, invites, links, access, and audit.
  `/invites/:id/accept` and `/links/:id` act on one invite or link. A grant names its subject
  by kind (`human` or `agent`) and id. `POST /resources/:id/grants` takes `subjectKind` and
  `subjectId`, and `DELETE /resources/:id/grants/:kind/:subjectId` removes one.
  `GET /resources/:id/grants?limit=&cursor=` lists them (an owner only).
  `GET /resources/:id/invites?limit=&cursor=` lists the invites of a resource, with no email (an owner only).
  `DELETE /invites/:id` revokes an invite, and answers 409 when it was accepted. The SDK calls are
  `listInvites(resourceId, { limit, cursor })` and `revokeInvite(inviteId)`.
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

## HTTP helper

`agentic-identity/http` is one bearer check for every app Worker. It uses only
`Request` and `Response`, so it runs anywhere `fetch` does. The `Auth` port reads the
credential (a bearer key, or the `session` cookie) and decides if it is expired or revoked.

```ts
import { requirePrincipal } from "agentic-identity/http";

const who = await requirePrincipal(request, auth, {
  kinds: ["human", "agent_of_human"],
  scope: "doc:write",
  origins: ["https://app.example.org"],
});
if (who instanceof Response) return who;
// who.kind is one of PRINCIPAL_KINDS, and who.chain holds the delegation chain.
```

- A missing, wrong-scheme, bad, expired, or revoked credential is a 401 with `WWW-Authenticate: Bearer`.
- An `Authorization` header that is not `Bearer <token>` is a 401, even beside a valid cookie.
- A good credential of a kind not in `kinds` (an empty list refuses everyone), or without `scope`, is a 403.
- A write (not GET, HEAD, or OPTIONS) that rides on the session cookie needs an `Origin` listed in `origins`, or it is a 403. A page on another site can make the browser send the cookie, but it cannot set `Origin`. A bearer key needs no origin.
- An `Auth` that throws is a 503. A bad `kinds` or `scope` option throws a `RangeError`.
- The body is `{"error": "..."}` and never holds the credential.

### WebSocket sign-in

A browser cannot set `Authorization` on a WebSocket. It can offer subprotocols, so the token
rides in one. `principalFromWebSocketRequest` reads it and runs `requirePrincipal`.
`acceptWebSocketProtocol` names the subprotocol on the 101 answer, because a browser closes a
socket whose answer does not name an entry that it offered.

```ts
import { acceptWebSocketProtocol, principalFromWebSocketRequest } from "agentic-identity/http";

const who = await principalFromWebSocketRequest(request, auth, { protocol: "agentic-docs", origins: ["https://app.example.org"] });
if (who instanceof Response) return who;
const room = await openRoom(request, who);
return acceptWebSocketProtocol(request, room, "agentic-docs");
// Browser: new WebSocket(url, ["agentic-docs", `agentic-docs.bearer.${base64url(token)}`])
```

- The browser offers `<protocol>` and `<protocol>.bearer.<token>`. The token is base64url of its UTF-8 text. Pass `encoding: "plain"` to send the token as it is.
- A missing, malformed, repeated, or bad token is a 401. A token entry without the bare `<protocol>` is a 401 too.
- A request that is not a WebSocket upgrade, or that has an `Authorization` header, ignores the subprotocol.
- With no token, the session cookie works only from an `Origin` in `origins`. Otherwise it is a 403.
- `acceptWebSocketProtocol` names only `<protocol>`, never the entry that holds the token. It changes only a 101 answer.
- Kinds, scope, and the 503 answer work as in `requirePrincipal`.

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

## Account export and erase

`agentic-identity/account` runs a person's export and erase across many apps. It uses no Node API, so it runs in a Worker. Each app gives one `AccountApp`:

```ts
import { eraseAccount, exportAccount, type AccountApp } from "agentic-identity/account";

const docs: AccountApp = {
  id: "docs", // lower case letters, digits, ".", "_", "-"
  exportFor: async (subject) => [{ path: "docs.json", content: JSON.stringify(await listDocs(subject)) }],
  eraseFor: async (subject) => { await removeDocs(subject); }, // safe to run twice
};

const { zip, manifest } = await exportAccount(userId, [docs, tasks]);
const report = await eraseAccount(userId, [docs, tasks], store, { actor: ctx });
```

- `exportAccount` returns one zip and its manifest. The zip holds `manifest.json` and each app's files under `<app id>/`. The manifest lists each file with its size and SHA-256.
- The zip is deterministic. With the same files and the same `now`, you get the same bytes. Entries are stored without compression, in sorted order, with a fixed date.
- If one exporter throws, `exportAccount` throws an `AccountExportError` that names the app. It makes no zip, because a partial export looks like a full one.
- `eraseAccount` does not check who may erase the subject. It only records the actor. Check that the caller may erase this account before you call it. `actor` is required: pass `null` for an anonymous request, or the call throws.
- `eraseAccount` runs every eraser in order. If one throws, it goes on with the rest and lists the failure in `report.results`. Run it again to retry. `report.ok` is true only when every eraser and every audit write worked.
- Each app gets one audit entry: `person.erase` with `targetKind` `app` and `targetId` the app id, `allowed` or `denied`. The entry holds no subject id. When the actor is the subject, acts for them, or is an agent they own, the entry names no actor either, so `deletePerson` keeps it. `denied` here means the eraser failed. A failed self erase blanks the actor too, so the log of a person who still exists does not point to them. If the actor lookup fails, the actor is blanked.
- Both functions refuse an empty app list: a list that is wired wrong must not look like a finished erase.
- Pass an id as the subject, not an email: the manifest holds it.
- Erase the sign-in last, and only when `report.ok` is true.

Limits: a zip over the size limits throws a plain `Error`. Some names (such as `con`, `aux`, or a name with `:`) do not unzip on Windows, and the module does not check for them. No zip64, so a zip holds at most 65,535 files and 4 GiB. An eraser error message goes in the report, so do not put personal data in it.

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

## Queue adapter

`createStoreQueue(store, { now?, leaseSeconds? })` is a `Queue` that keeps messages in any
`Store`. Use it with D1 on Cloudflare or with Firestore. It is exported from the main entry
point, `agentic-identity/cloudflare`, and `agentic-identity/firestore`. It passes the Queue
contract suite on memory, on D1 (miniflare), and on Firestore (the emulator in CI).

- Nothing delivers by itself. Call `run()` from a cron trigger or a loop. It delivers every
  due message, retries included, and `dead(topic)` lists the parked bodies.
- `run()` claims a message in a transaction with a lease (60 seconds by default). Two runners on
  one Store do not both deliver it. A runner that crashes loses the lease, and another runner
  delivers the message with a higher attempt. Delivery is at-least-once: write handlers that
  cope with a repeat.
- Runner clocks must agree to well within `leaseSeconds`. A runner that is ahead by more
  than the lease sees a live claim as expired and delivers the message again.
- A handler must finish within `leaseSeconds`. After that another runner may deliver the
  message again, and the first runner's result is dropped.
- A retry has the due time of its failure, so it goes behind messages sent after it. The order
  is strict only for messages that succeed the first time.
- A doc in `queue_messages` that is not a valid message is parked, and `run()` goes on. A run
  whose claim loses a race for good (`StoreConflictError`) moves to the next topic.
- Parked messages and parked bad docs stay in the Store. There is no purge yet, so delete them
  from `queue_messages` yourself.
- A Store error that is not a conflict (a network error) ends `run()`, so the fault shows.
  The clock must return whole milliseconds, 0 or more. Any other value ends `send()`, and ends
  `run()` when it is read at claim time, with a `RangeError` before a write. A clock that goes bad
  between a claim and its settle writes nothing, and the message returns when its lease ends.
- On D1 each claim scans the whole `queue_messages` collection, so a run over n messages reads
  about n² rows. For a large queue, add an expression index on `topic`, `state`, and `due`,
  like the `docs_team` example in the D1 schema notes.
- Firestore needs two composite indexes on `queue_messages`: (`topic`, `state`, `due`) and
  (`topic`, `state`, `key`), each ascending. The emulator does not check indexes. Production
  Firestore refuses the queries until you create them.
- It is not Cloudflare Queues. A Cloudflare Queues binding has its own clock and cannot run the
  contract suite, which sets the clock.

## Mail adapters

Two `Mail` adapters send real mail. Both are exported from the main entry point, and from
`agentic-identity/cloudflare`. Both pass the Mail contract suite. Neither logs, and no error
holds an address or a body.

- `createHttpMail({ url, fetch, from, token?, body?, timeoutMs?, region? })` posts JSON to any
  HTTP mail API, so it fits an EU-hosted provider. The URL must use https. The default body is
  `{ from, to, subject, text, html? }`. Pass `body` to shape it for another API. `token` goes
  in the `Authorization: Bearer` header. A reply that is not 2xx throws `MailError` with the
  status. It does not follow a redirect (a 3xx is a `MailError`), so the token never leaves for
  another host. The suite runs it against a Worker that miniflare serves.
- `createCloudflareMail(binding, { from, EmailMessage })` sends through a `send_email` binding
  of Cloudflare Email Workers. Pass the `EmailMessage` class from `cloudflare:email`. It builds
  one MIME message (plain, or plain and HTML) and encodes a non-ASCII subject. The suite runs
  it against a fake binding that keeps the raw message, and parses it back. It does not call
  Cloudflare. Check your sender domain and destination rules in the Cloudflare dashboard.

## Run Blobs on local files

`agentic-identity/file` also has `createFileBlobs`, a `Blobs` that keeps objects in a folder on
disk. Use it for local development and for CLIs on Node. It passes the `Blobs` contract suite,
including the guards for two instances on one folder. For a `Store` on a file, use `createFileStore`.

```ts
import { createFileBlobs } from "agentic-identity/file";

const blobs = createFileBlobs({ dir: "./.data", urlBase: "https://files.example/blob", urlSecret });
```

- A write goes to a temp file, is synced, and is renamed over the target. A reader never sees half
  of a write.
- A file name is the SHA-256 of the key. Keys with slashes, dots, or non-ASCII characters are safe.
- Every write and delete takes a lock file (`blobs/.lock` in `dir`), so instances on one folder, in
  one process or in several, keep the `ifMatch` and `ifNoneMatch` guarantees. The owner touches the
  lock while it works. A lock that nobody touched for 60 seconds is taken as left by a dead process.
  A process that is paused for longer than that can lose its lock.
- Reads take no lock. A crash can leave `.tmp` files behind. They are safe to delete when no process
  is writing.
- A damaged object file makes a read throw. It is never read as a missing object.
- `signedUrl` needs `urlBase` and `urlSecret` (32 bytes or more), as on R2. Without them, it throws.
- Do not use a network file system. The lock and the rename need a local one.
- This is not a production store: there is one writer at a time.

## Run on Firebase

`agentic-identity/firestore` has a Firestore `Store` and a Firestore `Blobs`. They call the
Firestore REST API through a `fetch` you pass in, so they run in Workers, Node, and Cloud
Functions and need no Firebase SDK. They pass the `Store`, audit, and `Blobs` contract suites,
including the transaction guards. The suites run against the Firestore emulator when
`FIRESTORE_EMULATOR_HOST` is set, and against an in-process fake of the REST surface when it
is not. The CI job `firestore-emulator` runs them on the emulator and fails if it is not up.
The fake locks every doc a transaction reads for that transaction alone, which is stricter
than Firestore, so it does not exercise the aborts that two readers of one doc cause on
the real service. On the emulator, twenty writers on one doc need `maxAttempts` of about 40.

```ts
import { createFirestoreBlobs, createFirestoreStore } from "agentic-identity/firestore";

const connection = {
  projectId: "my-project",
  fetch: globalThis.fetch,
  token: () => getAccessToken(), // an OAuth token for the datastore scope
  region: "eu" as const,
};
const store = createFirestoreStore(connection);
const blobs = createFirestoreBlobs({ ...connection, urlBase: "https://files.example/blob", urlSecret });
```

- `Auth`, `Realtime`, and `Mail` have no Firestore adapter. `Queue` runs on it through `createStoreQueue` (see Queue adapter). Mix adapters as you need.
- `createFirestoreBlobs` keeps an object in chunk docs (512 KiB each, `chunkBytes`) and caps it
  at 32 MiB (`maxBytes`). A put writes the chunks, then swaps the meta doc in one transaction
  that checks `ifMatch` or `ifNoneMatch`. A crash in between leaves orphan chunks that no read
  sees. Use a Cloud Storage adapter for big files. `signedUrl` makes an HMAC URL for your
  server, as the R2 adapter does. Call `verifySignedBlobUrl(url, { secret })` there. The secret
  needs 32 bytes or more and has no default.
- Firestore is a pessimistic backend. A transaction locks the docs it reads, and
  Firestore aborts one that cannot get its locks. The adapter runs it again (`maxAttempts`,
  default 8), then throws `StoreConflictError` and writes nothing.
- A query with `orderBy` needs a composite index for each equality filter you combine
  with it. Firestore tells you which when it refuses the query.
- Firestore cannot store an array inside an array, or a field named like `__name__`.
  The adapter refuses such a doc before it sends a request.
- `region` is a claim, as for the other adapters. Create the database in the region
  you claim. For the emulator, pass `baseUrl: "http://" + process.env.FIRESTORE_EMULATOR_HOST`
  and leave `token` out.

## Run on Netlify

`agentic-identity/netlify` has a `Store` and a `Blobs` on Netlify Blobs. It uses a small
structural type for the Netlify `Store`, so pass the result of `getStore(...)` from
`@netlify/blobs`. Install that package yourself. This package does not depend on it.

```ts
import { getStore } from "@netlify/blobs";
import { createNetlifyBlobs, createNetlifyStore } from "agentic-identity/netlify";

const store = createNetlifyStore(getStore({ name: "identity-docs", consistency: "strong" }), { region: "eu", consistency: "strong" });
const blobs = createNetlifyBlobs(getStore("identity-files"), { region: "eu", urlBase, urlSecret });
```

Both pass the contract suites. CI runs them on an in-memory fake of the Netlify Blobs
client (`src/adapters/netlify.fake.ts`), not on a live site. The fake follows the service:
a conditional write checks and writes in one step, and every write makes a new ETag. A test
runs one script on the fake and on the real client against the official local server
(`BlobsServer`), and compares the answers. The local server cannot run the contract suites:
it checks a condition and then writes in two steps, it builds an ETag from the file time, and
it sends no ETag on a read. Run the suites on a live Netlify site before you rely on
this adapter in production. No test proves one thing: that the live service returns, on a
read, the same ETag string that it accepts in `If-Match` (a weak ETag would break every
conditional write). The `Blobs` version and the lock both depend on it.

- Give the `Store` and the `Blobs` each their own Netlify store. The adapter owns every key in it.
- Every read call asks for `consistency: "strong"`. The default of Netlify Blobs is eventual.
  `list` has no such option, so make the `Store`'s Netlify store with `consistency: "strong"`,
  as above. A stale list can miss a doc that was just made, so `tx.query` could miss it.
  `createNetlifyStore` needs the option `consistency: "strong"` as your word that the store is
  strong, and it also throws for a store that says it is not.
- `Blobs` maps to Netlify directly. A conditional `set` (`onlyIfNew`, `onlyIfMatch`) is atomic,
  and the ETag is the version. The size and content type sit in the metadata. A key is hashed,
  so any key works. `signedUrl` makes an HMAC URL for your function, as the R2 adapter does.
  Call `verifySignedBlobUrl(url, { secret })` there. The secret needs 32 bytes or more.
- Netlify Blobs has no write that spans two keys, so the `Store` builds a transaction from a
  lease lock on one key (`leaseMs`, default 30 s) and a journal that sits in the same key. A
  transaction takes the lock, runs, then makes one conditional write that checks the lease and
  stores the journal. It applies the writes, and clears the journal. Before each doc write it
  renews the lease with a check that the lock is still its own, so a holder that stalled past
  its lease stops. A doc key is the hash of the id, so any valid id fits the key limit of
  Netlify (600 bytes). An id must be well-formed Unicode.
- The real client retries a request that failed. When a write landed and its retry gets a 412,
  the client reports `modified: false`. The adapter checks for that: a lock that names the
  holder is the holder's own, and a blob with the write id of the caller is the caller's own.
  The contract suites also run on a fake that does this on every conditional write.
- A holder that stops halfway leaves its journal in the lock key. The next transaction on any
  adapter object applies it first. If a write fails, the holder tries to finish the journal at
  once. When that works, the transaction has committed and its caller gets the result. When it
  does not, the caller gets `NetlifyCommitUncertainError`, and the transaction may still land
  when the next transaction runs. The same error means the lease was lost after the journal was
  sent, or that a journal write ran past the lease and may have landed. Do not retry such a
  transaction as if nothing was written. `StoreConflictError` means that nothing was written: the
  lock was lost before the journal could land. Outside a
  transaction, a `get` or `query` can see part of a transaction while it applies, and until the
  next transaction applies a journal that a crash left. A read-only transaction checks the lease
  once, when `fn` ends.
- A transaction throws `StoreConflictError` when it cannot get its turn and the lock in `waitMs`
  in all (default 35 s, a little over the lease, so it outwaits a crashed holder). A lock that is
  not readable, or that holds a bad journal, counts as held. To recover, find out why, then
  delete the `lock` key by hand. A write made inside a transaction on the same adapter object
  waits for its own transaction, so it throws after `waitMs`. Use `tx`.
- All writes take the same lock, so they run one at a time. A write costs about five requests
  and three more per doc. Each renew sends the journal again, so keep a transaction to a few
  docs. A hot app needs a different `Store`. The lease compares the clocks of the instances, so
  keep them within a few seconds of each other.
- A doc write is conditional on the ETag that the holder read just before it renewed the lease.
  The client retries a request for a long time, and has no timeout. A write that is delayed past
  the lease then fails, because the rival that took over changed the ETag, and the holder gets
  `NetlifyCommitUncertainError`. Each stored body holds a random write id, so two writes never
  give equal bytes, and the fence does not depend on how the service makes an ETag. Netlify has
  no conditional delete, so a delete writes a tombstone (a doc that holds `null`). Tombstones stay, so a `query` still reads them.
- A `Blobs` put that the client retried can report a refusal for a write that landed, if a rival
  overwrites the blob before the adapter checks. The adapter sees its own write id only while
  the blob is still the one it wrote.
- A `query` reads every doc of the collection, then filters in memory. Use it for small
  collections.
- `region` is a claim. Netlify Blobs does not let you pick a region per store. Check where
  your site's functions and blobs run.

## Develop

```sh
npm ci
npm run build && npm run typecheck && npm test
```

## License

MIT.
