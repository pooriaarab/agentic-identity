# agentic-identity rules

1. A step in a delegation chain only narrows rights. It never widens them.
2. A revoked or expired ancestor removes all rights below it.
3. Every audit entry keeps the principal kind and the full chain.
4. A denied call stays denied. Do not retry it with changed input.
5. Report a failed call as a failure. Never report it as success.
