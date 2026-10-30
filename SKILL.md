---
name: agentic-identity
description: "People, agents, and the access they share: delegation, invites, links, and an audit trail. 0.12.0 preview: principals, sharing, ports, memory, Cloudflare, Firestore, Netlify and file adapters, contract suites, HTTP API, OIDC and email magic-link sign-in, typed SDK, CLI, MCP server, account export, erase, and registry."
---

# agentic-identity

People, agents, and the access they share: delegation, invites, links, and an audit trail.

Release 0.12.0 is a preview. It has principals and delegation chains, the sharing
model (roles, invites, links, audit), six ports, memory, Cloudflare (D1, R2),
Firestore, Netlify and file adapters, and contract suites. It has the HTTP API (`agentic-identity/worker`),
OIDC sign-in, and the typed SDK (`agentic-identity/sdk`). It has account export
and erase across apps, plus the account registry (`createAccountRegistry`,
`AccountPackage`) (`agentic-identity/account`), a CLI
(`agentic-identity`) and an MCP server (`agentic-identity-mcp`) on a local
JSON file. Host resource claims use `claimResource` and `releaseResourceClaim`
with a host reference mutation in one Store transaction. Reservations alone do
not grant access. Trusted hosts can call `ClaimSharingOps.ensureOwner(type)` in
the callback to create a root resource and owner grant in that transaction.
Callback failure rolls back ownership and the reference. The last release removes
untouched claim-created ownership; existing resources, later shares, and allowed
audit history stay. Read `README.md` for the current status before you use it.
