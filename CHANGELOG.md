# Changelog

## 0.3.0

### Breaking

- `listAudit` now returns `{ entries, nextCursor }`, not an array. Read the entries from `.entries`.
- `listAudit` lists the newest entry first. It returned up to 500 entries, oldest first.
- `listAudit(ctx, resourceId, { limit, cursor })` pages the log. `limit` is a whole number from 1 to 200 (default 50). `nextCursor` is set only when more entries exist. Pass it as `cursor` to read the next page. A bad `limit` or `cursor` throws.
- The SDK `audit(resourceId, { limit, cursor })` and the `GET /api/v1/resources/:id/audit` route take the same `limit` and `cursor` values. A bad `limit` returns 400.

### Added

- The README shows the test token response in the quick start.

### Fixed

- `grant` can no longer demote the last owner of a resource. Two demotions at once cannot both pass in `grant` or `revoke`.
- The root bundle no longer imports `node:module`. Worker apps no longer need `nodejs_compat` to use the root entry.
- Each end-to-end run gets its own inspector port, so two runs at once do not clash.

## 0.2.0

- First preview release. Principals and delegation chains, sharing (roles, invites, links, audit), the ports with memory adapters, Cloudflare D1 and R2 adapters, the port contract suites, the HTTP API, OIDC sign-in, and the typed SDK.
