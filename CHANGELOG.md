# Changelog

## Unreleased

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
