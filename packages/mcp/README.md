# @vendoai/mcp

`@vendoai/mcp` is Vendo's door: one fetch-style handler that exposes a host's guard-bound tools to MCP clients, owns the OAuth 2.1 + PKCE flow, and optionally carries saved Vendo apps as MCP Apps.

The umbrella package wires it behind the one-flag setup, `createVendo({ mcp: true })`, so the same tool registry, guard policy, approvals, and audit trail apply to MCP calls as to in-product calls.

The MCP Apps tree renderer is a committed, prebuilt HTML artifact. This keeps `@vendoai/mcp` dependent on core rather than UI at runtime. Regenerate the artifact from its owner with:

```sh
pnpm --filter @vendoai/ui build:mcp-shim
```

The server-card response tracks the provisional SEP-2127 draft and may move with that specification before ratification.
