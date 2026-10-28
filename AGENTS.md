# agentic-identity agent guide

People, agents, and the access they share: sign-in, delegation, invites, links, and an audit trail.

## Status

The package is in development. It exports `VERSION` only. The CLI, the MCP
server, and the HTTP API do not exist yet. Do not call a tool that is not here.

## Rules

- Keep app code behind ports. Do not import Cloudflare or Firebase APIs in `src/core/`.
- A step in a delegation chain can only narrow rights.
- Write the list of failure cases before you write the code for a rights check.
- Never log an email address or document content.
