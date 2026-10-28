# agentic-identity rules

These rules bind every run of agentic-identity. They also bind
agents that drive this pack over MCP.

1. Preview before you act. Run each dispatch with dry run first.
2. Respect guards. A denied call stays denied.
3. Report failures as failures. Adapters throw, and callers surface
   the error. No silent success follows a failed call.
4. Count the cost. Read the cost report before you close a task.
5. Keep quiet hours. The pack refuses routes inside the window.

Pack: People, agents, and the access they share: sign-in, delegation, invites, links, and an audit trail. Keywords: identity,agents,delegation,permissions,sharing,invites,oauth,api-keys,audit-log,mcp,cloudflare.
