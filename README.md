# agentic-identity

[![npm version](https://img.shields.io/npm/v/agentic-identity)](https://www.npmjs.com/package/agentic-identity)
[![MIT license](https://img.shields.io/badge/license-MIT-blue)](https://opensource.org/license/mit)

[Package](https://www.npmjs.com/package/agentic-identity) · [Source](https://github.com/pooriaarab/agentic-identity) · [Support](https://github.com/pooriaarab/agentic-identity/issues)

People, agents, and the access they share: delegation, invites, links, and an audit trail.

> Status: 0.1.0 preview. This release has principals and delegation chains,
> the sharing model (roles, invites, share links, audit), six backend ports
> with in-memory adapters for most, Cloudflare D1 and R2 adapters, and the contract suites.
> OIDC sign-in, the SDK, the CLI, the MCP server, and the HTTP API are not in
> this release.

## Install

```sh
npm install agentic-identity
```

## Features

- Five kinds of principal: a person, an agent for a person, an agent made by an agent, an agent with its own identity, and a token that acts as the user.
- Delegation chains where each step can only narrow scopes.
- Roles per resource: owner, editor, commenter, viewer. A folder role passes down.
- Invites by email for a person, or by handle for an agent.
- Share links with a role, an optional expiry, and a signed-in-only option.
- An audit trail of access checks that shows who acted, and for whom. Each entry keeps the principal kind.
- Storage behind ports (`Store`, `Blobs`, `Auth`, `Realtime`, `Mail`, `Queue`), so you can move from Cloudflare D1 to another store.
- A region claim on every adapter except `Auth`. `assertRegion` fails at start-up when a claim is missing or wrong.

## Not in 0.1.0

- Sign in with any OpenID Connect provider (Keycloak, EU Login, Google).
- API keys and personal access tokens for agents.
- Per-user data export and hard delete.
- The SDK, the CLI (`npx agentic-identity`), the MCP server, and the HTTP API (a Cloudflare Worker).

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
await sharing.grant(ctx, "plan", "ana", "editor");
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

## Ports

App code talks to ports, not to a vendor. Six ports exist: `Store`, `Blobs`,
`Auth`, `Realtime`, `Mail`, and `Queue`. Each has a contract suite. `Store`,
`Blobs`, `Auth`, `Mail`, and `Queue` have memory adapters. `Realtime` has
`createHmacRealtime`, which you can also use in tests.

- `Store` keeps JSON docs in named collections. It has `get`, `put`, `delete`,
  `query`, and `transaction`. A query takes equality filters, one `orderBy`, a
  `limit`, and a `cursor`. There are no joins, so a Firestore adapter fits.
- `Blobs` keeps bytes by key. It has `put`, `get`, `delete`, and `signedUrl`.
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
  not a query, to keep a value unique.

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
