# agentic-identity agent guide

People, agents, and the access they share: delegation, invites, links, and an audit trail.

## Status

Release 0.5.0 is a preview. It has principals and delegation chains, the
sharing model (roles, invites, links, audit), the `Store`, `Blobs`, `Auth`,
`Realtime`, `Mail`, and `Queue` ports with memory adapters (and an HMAC
`Realtime`), Cloudflare D1 and R2 adapters, and the port contract suites
(`agentic-identity/testing`). It has the HTTP API (`agentic-identity/worker`),
OIDC sign-in, and the typed SDK (`agentic-identity/sdk`). The CLI (`agentic-identity`)
exists. The MCP server does not exist yet. Do not call a tool that is not here.

## Rules

- Keep app code behind ports. Do not import Cloudflare or Firebase APIs in `src/core/`.
- A step in a delegation chain can only narrow rights.
- Write the list of failure cases before you write the code for a rights check.
- Never log an email address or document content.
