# agentic-identity

[![npm version](https://img.shields.io/npm/v/agentic-identity)](https://www.npmjs.com/package/agentic-identity)
[![MIT license](https://img.shields.io/badge/license-MIT-blue)](https://opensource.org/license/mit)

[Package](https://www.npmjs.com/package/agentic-identity) · [Source](https://github.com/pooriaarab/agentic-identity) · [Support](https://github.com/pooriaarab/agentic-identity/issues)

People, agents, and the access they share: sign-in, delegation, invites, links, and an audit trail.

> Status: scaffold. This repository holds the starter code only. It is not on npm
> yet, and none of the features below work yet.

## Planned features

- Sign in with Google.
- Five kinds of principal: a person, an agent for a person, an agent made by an agent, an agent with its own identity, and a token that acts as the user.
- Delegation chains where each step can only narrow scopes.
- Roles per resource: owner, editor, commenter, viewer.
- Invites by email and share links with expiry.
- API keys, OAuth, and personal access tokens for agents.
- An audit trail that shows who acted, and for whom.
- Storage behind ports, so you can move from Cloudflare D1 to another store.

## Surfaces

One package gives you each way in:

- **Library and SDK**: `import { ... } from "agentic-identity"`.
- **CLI**: `npx agentic-identity --help`.
- **MCP server**: `npx agentic-identity mcp`, for Claude Code and other MCP clients.
- **HTTP API**: a Cloudflare Worker you deploy to your own account.
- **Web UI**: a small app served by the same Worker.

## Develop

```sh
npm ci
npm run build && npm run typecheck && npm test
```

## License

MIT.
