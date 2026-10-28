# agentic-identity

[![npm version](https://img.shields.io/npm/v/agentic-identity)](https://www.npmjs.com/package/agentic-identity)
[![MIT license](https://img.shields.io/badge/license-MIT-blue)](https://opensource.org/license/mit)

[Package](https://www.npmjs.com/package/agentic-identity) · [Source](https://github.com/pooriaarab/agentic-identity) · [Support](https://github.com/pooriaarab/agentic-identity/issues)

People, agents, and the access they share: sign-in, delegation, invites, links, and an audit trail.

> Status: in development. The package exports `VERSION` only. It is not on npm
> yet, and none of the features below work yet.

## Planned features

- Sign in with any OpenID Connect provider (Keycloak, EU Login, Google).
- Five kinds of principal: a person, an agent for a person, an agent made by an agent, an agent with its own identity, and a token that acts as the user.
- Delegation chains where each step can only narrow scopes.
- Roles per resource: owner, editor, commenter, viewer.
- Invites by email and share links with expiry.
- API keys and personal access tokens for agents.
- An audit trail that shows who acted, and for whom. Each entry keeps the principal kind.
- Storage behind ports, so you can move from Cloudflare D1 to another store.
- Region settings on every adapter, so data stays in the EU.
- Per-user data export and hard delete.

## Planned surfaces

- **Library and SDK**: `import { ... } from "agentic-identity"`.
- **CLI**: `npx agentic-identity`.
- **MCP server**: `npx agentic-identity mcp`, for Claude Code and other MCP clients.
- **HTTP API**: a Cloudflare Worker you deploy to your own account.

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

## Ports

App code talks to ports, not to a vendor. Six ports exist: `Store`, `Blobs`,
`Auth`, `Realtime`, `Mail`, and `Queue`. Each has a memory adapter and a
contract suite.

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
- Every adapter takes a `region` option (`"eu"`, `"us"`, or `"unknown"`) and
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
