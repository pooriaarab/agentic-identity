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

## Develop

```sh
npm ci
npm run build && npm run typecheck && npm test
```

## License

MIT.
