# Changelog

## Unreleased

### Added

- `listGrants(ctx, resourceId, { limit, cursor })` lists the honored grants on a resource, an owner only. It has the SDK call `listGrants` and the route `GET /resources/:id/grants`.
- `deleteResource(ctx, resourceId)` erases a resource with its grants, invites, links, and audit entries, so an erase of a resource leaves no grant behind. An owner only. It is not one step: a failed erase leaves fewer shares, and a second run finishes it. A grant, link, invite, or child that races it is refused or erased. A resource with children is refused (409 over HTTP). It has the SDK call `deleteResource` and the route `DELETE /resources/:id`. Each grant, link, invite, and child now rewrites its resource doc, so two such writes on one resource at the same moment conflict and one runs again. The tests run it on the memory store and on D1.

### Breaking

- A grant now names its subject by kind and id. A person and an agent with the same id no longer share a role. `grant(ctx, resourceId, { kind, id }, role)` and `revokeGrant(ctx, resourceId, { kind, id })` take a `Subject`. `kind` is `human` or `agent`, and there is no default.
- The SDK `grant(resourceId, { kind, id }, role)` and `revokeGrant(resourceId, { kind, id })` take a subject too. `POST /resources/:id/grants` needs `subjectKind`. The revoke route is now `DELETE /resources/:id/grants/:kind/:subjectId`.
- Grants are stored with the key `<resource>:<kind>:<id>` and a `subjectKind` field. A grant stored by an earlier version is not honored until you run `migrateGrants(store)`. It gives each grant the kind of the principal with its id, and lists in `unresolved` the grants it cannot place. Run it once per database before you serve requests.
- An erase of a person removes the grants of that person and their agents, and no longer touches a grant of the other kind with the same id.

### Fixed

- A `prepack` script now builds `dist/` before `npm pack` and `npm publish`.

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
