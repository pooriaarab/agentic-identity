# Changelog

## Unreleased

### Changed

- `createInvite` refuses a handle that is not in the form of an agent handle (2 to 32 lowercase letters, digits, `-`, `_`), so an invite by handle can hold no address.

### Added

- `createStoreQueue` is a `Queue` adapter that keeps messages in any `Store`, so it runs on D1 and on Firestore. A runner claims a message in a transaction with a lease, so two runners do not both take a message while its lease holds. It passes the `Queue` contract suite on memory, D1, and Firestore. The CI job `firestore-emulator` runs it too.
- `createHttpMail` is a `Mail` adapter that posts JSON to any https mail API through an injected `fetch`. `createCloudflareMail` sends through a Cloudflare Email Workers `send_email` binding. Both pass the `Mail` contract suite, and neither puts an address or a body in an error.
- `createFileBlobs` in `agentic-identity/file` is a `Blobs` adapter on a local folder for Node. It writes each object by temp file and rename, and uses a lock file so two instances on one folder (also in two processes) keep the `ifMatch` and `ifNoneMatch` guarantees. It passes the `Blobs` contract suite. The `createFileStore` API does not change.
- `requirePrincipal` in `agentic-identity/http` is one framework-free bearer check for app Workers. It takes a `Request` and the `Auth` port and returns the principal, or a 401 or 403 `Response`. `kinds` and `scope` options narrow who passes. A write on the session cookie needs an `Origin` listed in `origins`, or it is a 403. An `Auth` that throws gives a 503.
- `parsePrincipal` and `subjectOf` check a principal from outside input. A missing or unknown kind, or an id outside a closed character set, throws `PrincipalParseError`. `subjectOf` gives `kind:id`.
- `agentic-identity/account` has `exportAccount` and `eraseAccount`. Each app gives an `AccountApp` (`exportFor`, `eraseFor`). Export joins every app's files into one deterministic zip with a manifest of sizes and SHA-256 hashes. Erase runs every app, reports each failure, and writes one audit entry per app.
- The README documents `PRINCIPAL_KINDS`, `PrincipalKind`, and `Principal`. Apps import them from `agentic-identity` and keep no local copy.
- The `agentic-identity-mcp` MCP server (also `agentic-identity mcp`) serves each CLI command as a tool over stdio: `identity_whoami`, `identity_principals_list`, `identity_agents_create`, `identity_resources_create`, `identity_grants_*`, `identity_invites_*`, `identity_links_*`, and `identity_audit`.
- The `agentic-identity` CLI works on a local JSON file: `whoami`, `principals list`, `agents create`, `resources create`, `grants set|revoke|list`, `invites create|accept|list`, `links create|revoke|resolve`, and `audit`. It prints JSON. `createFileStore` (`agentic-identity/file`) is a `Store` on a JSON file and passes the `Store` and audit contract suites. `listInvites(ctx, resourceId)` lists the invites on a resource, an owner only, with no email.
- `agentic-identity/netlify` has `createNetlifyStore` and `createNetlifyBlobs` on Netlify Blobs. Both pass the contract suites on a fake of the Netlify Blobs client. The `Store` builds a transaction from a lease lock and a journal, because Netlify Blobs has no write across two keys. A transaction that fails after its journal is stored throws `NetlifyCommitUncertainError`. A test compares the fake with the real `@netlify/blobs` client on its local server. `@netlify/blobs` is a dev dependency only.
- `createFirestoreBlobs` in `agentic-identity/firestore` is a `Blobs` adapter on Firestore docs. It cuts an object into chunk docs and swaps a meta doc in one transaction, so `ifMatch` and `ifNoneMatch` hold. It passes the `Blobs` contract suite.
- The CI job `firestore-emulator` runs the `Store`, audit, and `Blobs` contract suites against the Firestore emulator. It fails when the emulator is not up, so it cannot pass on the fake.
- `verifySignedBlobUrl` is also exported from `agentic-identity/firestore`. Signed URLs share one module with the R2 adapter.

### Fixed

- The Firestore `Store` read a doc inside a transaction with a GET that held the transaction id in the URL. The emulator crashes on that. It now uses `:batchGet` with the id in the body.

## 0.5.0 - 2026-10-29

### Added

- `agentic-identity/firestore` has a Firestore `Store` over the REST API with an injected `fetch`. The `Store` contract suite runs against the emulator when `FIRESTORE_EMULATOR_HOST` is set, and against an in-process fake of the REST surface otherwise (CI uses the fake). The contract has a new case for paging over non-ASCII ids and values.
- Every grant, revoke, invite, accept, link create, link revoke, key create, key rotate, and key revoke writes an audit entry in the same transaction as the change, so a change cannot commit without its entry. An export and an erase write theirs as separate steps (see below). An entry holds the actor (id, kind, chain, root), the target kind and id, the action, the time, and the request id. It holds no email, handle, key, or link token. `CHANGE_ACTIONS` lists the actions.
- The Worker makes a request id for each request, returns it in `x-request-id`, and ignores a value from the caller.
- `POST /principals/:id/keys` rotates the key of an agent (SDK: `rotateKey`). Old keys stop in the same step.
- `listPersonAudit(ctx, { limit, cursor })` and `GET /me/audit` (SDK: `myAudit`) list what a person did, and what the agents and tokens that act for them did, newest first, in pages. An agent with its own identity is not included, and neither are entries from before 0.5.0. Only the person may read it.
- An export holds the entries a person made and the entries that name them. It writes a `person.export` entry first.
- `runAuditContract` in `agentic-identity/testing`. It runs on the memory store and on D1.

### Changed

- An erase of a person leaves a `person.erase` tombstone (time and request id, no id of the person), written just before the person is removed. A second run of a failed erase writes a second one. It also blanks `targetId` to `(erased)` in entries that named what it removed.
- `revokeGrant` now reads and writes its resource doc, like `grant`, so an erase and a revoke at the same moment cannot leave an entry. A revoke of a grant that does not exist writes no entry.
- `deleteResource` sweeps the audit entries once more after its transaction. `createResource` refuses an id that still has an allowed audit entry, which an erase that stopped halfway can leave.
- `AuditEntry` has the new fields `rootId`, `targetKind`, `targetId`, and `requestId`. `rootId` is missing on entries from before 0.5.0. `PrincipalContext` has an optional `requestId`.

### Not yet

- The CLI and the MCP server do not exist, so they cannot list the audit log.

## 0.4.0 - 2026-10-29

### Changed

- The Worker answers 409 `try again` when a transaction kept conflicting, not 400.

### Added

- `listGrants(ctx, resourceId, { limit, cursor })` lists the honored grants on a resource, an owner only. It has the SDK call `listGrants` and the route `GET /resources/:id/grants`.
- `deleteResource(ctx, resourceId)` erases a resource with its grants, invites, links, and audit entries, so an erase of a resource leaves no grant behind. An owner only. It is not one step: a failed erase leaves fewer shares, and a second run finishes it. A grant, link, invite, or child that races it is refused or erased. A resource with children, or with more than 100 owners, is refused (`EraseRefusedError`, 409 over HTTP). An audit entry that `can` writes while the erase runs can stay. It has the SDK call `deleteResource` and the route `DELETE /resources/:id`. Each grant, link, invite, and child now rewrites its resource doc, so two such writes on one resource at the same moment conflict and one runs again. The tests run it on the memory store and on D1.

### Breaking

- A grant now names its subject by kind and id. A person and an agent with the same id no longer share a role. `grant(ctx, resourceId, { kind, id }, role)` and `revokeGrant(ctx, resourceId, { kind, id })` take a `Subject`. `kind` is `human` or `agent`, and there is no default.
- The SDK `grant(resourceId, { kind, id }, role)` and `revokeGrant(resourceId, { kind, id })` take a subject too. `POST /resources/:id/grants` needs `subjectKind`. The revoke route is now `DELETE /resources/:id/grants/:kind/:subjectId`.
- Grants are stored with the key `<resource>:<kind>:<id>` and a `subjectKind` field. A grant stored by an earlier version is not honored until you run `migrateGrants(store)`. It gives each grant the kind of the principal with its id, and lists in `unresolved` the grants it cannot place. Run it once per database before you serve requests.
- An erase of a person removes the grants of that person and their agents, and no longer touches a grant of the other kind with the same id.

### Fixed

- A `prepack` script now builds `dist/` before `npm pack` and `npm publish`.

### Tests

- The Store contract suite now tests that a transaction guards the docs a query returned. An adapter that skips this guard fails the suite.

## 0.3.0

### Breaking

- `listAudit` now returns `{ entries, nextCursor }`, not an array. Read the entries from `.entries`.
- `listAudit` lists the newest entry first. It returned up to 500 entries, oldest first.
- `listAudit(ctx, resourceId, { limit, cursor })` pages the log. `limit` is a whole number from 1 to 200 (default 50). `nextCursor` is set only when more entries exist. Pass it as `cursor` to read the next page. A bad `limit` or `cursor` throws.
- The SDK `audit(resourceId)` now returns the newest 50 entries, not up to 500 oldest first. Pass `limit` and `cursor` in `audit(resourceId, { limit, cursor })` to change the page size and read on.
- The `GET /api/v1/resources/:id/audit` route now returns the newest 50 entries, not up to 500 oldest first, and the response has `nextCursor`. It takes `limit` and `cursor` query values. A bad `limit` or `cursor` returns 400.

### Docs

- The README shows the test token response in the quick start.

### Fixed

- `grant` can no longer demote the last owner of a resource. Two demotions at once cannot both pass in `grant` or `revokeGrant`.
- The root bundle no longer imports `node:module`. Worker apps no longer need `nodejs_compat` to use the root entry.

## 0.2.0

- Preview release. Principals and delegation chains, sharing (roles, invites, links, audit), the ports with memory adapters, Cloudflare D1 and R2 adapters, the port contract suites, the HTTP API, OIDC sign-in, and the typed SDK.
