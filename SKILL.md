---
name: agentic-identity
description: People, agents, and the access they share: sign-in, delegation, invites, links, and an audit trail. Keywords: identity,agents,delegation,permissions,sharing,invites,oauth,api-keys,audit-log,mcp,cloudflare.
---

# agentic-identity

People, agents, and the access they share: sign-in, delegation, invites, links, and an audit trail.

## Use the SDK

```js
import { summarizeText, dispatchText } from "agentic-identity";

summarizeText("some text");
await dispatchText("some text", { dryRun: true });
```

## Use the CLI

```sh
agentic-identity summary --text "some text"
agentic-identity dispatch --text "some text" --dry-run
```

## Use the MCP server

Start the server with `agentic-identity mcp`. Call `summarize_text`
for stats, `dispatch_text` for routes, `get_cost_report` for costs.

## Rules

- Preview each route with dry run first.
- Report guard denials and adapter errors as failures.
- Read the cost report at the end.
