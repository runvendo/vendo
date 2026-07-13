# @vendoai/mcp

`@vendoai/mcp` is Vendo's door: one fetch-style handler that exposes a host's guard-bound tools to MCP clients, owns the OAuth 2.1 + PKCE flow, and optionally carries saved Vendo apps as MCP Apps.

The umbrella package wires it behind the one-flag setup, `createVendo({ mcp: true })`, so the same tool registry, guard policy, approvals, and audit trail apply to MCP calls as to in-product calls.

The MCP Apps tree renderer is a committed, prebuilt HTML artifact. This keeps `@vendoai/mcp` dependent on core rather than UI at runtime. Regenerate the artifact from its owner with:

```sh
pnpm --filter @vendoai/ui build:mcp-shim
```

The server-card response tracks the provisional SEP-2127 draft and may move with that specification before ratification.

## Operating notes for host integrators

- **`HostOAuthAdapter.authorize` renders consent.** The door passes the client's
  `client_name` (from DCR or a Client ID Metadata Document — attacker-controllable)
  straight to your adapter. **Escape it** before rendering it on a consent screen;
  a client can register a name like `"Google Drive (official)"` for phishing or
  inject markup for XSS on your page. The door deliberately does no rendering.
- **Single-secret redemption is serialized in-process.** Concurrent redemptions of
  the same authorization code or refresh token are locked within one process, so a
  refresh cannot fork. A **multi-instance** deployment (several door processes
  behind a load balancer) needs sticky routing by token, or a shared-store atomic
  claim, to keep that guarantee — the store exposes no atomic claim today.
- **CIMD fetch egress.** The door resolves a Client ID Metadata Document URL server-side
  and rejects private/loopback/link-local resolutions (best-effort, via `node:dns`
  when present). On runtimes without a resolver, or for defense in depth, enforce
  egress at your network layer — the door cannot portably prevent DNS rebinding.
- **`vendo init` must ask before opening the door.** The shipped guard policy blocks
  `venue: "mcp"`; opening the door is a host decision, never a default.
