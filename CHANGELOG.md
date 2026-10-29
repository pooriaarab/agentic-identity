# Changelog

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
