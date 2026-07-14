# @vendoai/mcp

`@vendoai/mcp` is Vendo's door: one fetch-style handler that exposes a host's guard-bound tools to MCP clients, owns the OAuth 2.1 + PKCE flow, and optionally carries saved Vendo apps as MCP Apps.

The umbrella package wires it behind the one-flag setup, `createVendo({ mcp: true })`, so the same tool registry, guard policy, approvals, and audit trail apply to MCP calls as to in-product calls.

The MCP Apps tree renderer is a committed, prebuilt HTML artifact. This keeps `@vendoai/mcp` dependent on core rather than UI at runtime. Regenerate the artifact from its owner with:

```sh
pnpm --filter @vendoai/ui build:mcp-shim
```

The server-card response tracks the provisional SEP-2127 draft and may move with that specification before ratification.

## Transport state seam

The door's protocol-lifetime state is isolated behind the package-internal
`McpDoorState` interface. `createMcpDoor` still composes the 2025-11-25
Streamable HTTP transport with `InMemoryMcpDoorState`, so initialization,
`Mcp-Session-Id`, response bytes, and error behavior are unchanged.

The current adapter owns three related lifetimes:

- a TTL-indexed session record keyed by `Mcp-Session-Id`, containing the
  authenticated subject and opaque SDK runtime;
- the subject-to-session index used to close every live runtime on revocation;
- a bounded approval-replay map keyed by an opaque replay scope plus the
  canonical tool/arguments fingerprint. A pending approval retains its exact
  `ToolCall.id`; any resolved outcome deletes it. Session deletion, revocation,
  and idle expiry also delete the scope's replay records.

A 2026-07-28 adapter would leave OAuth and guard behavior alone and replace the
transport/state composition as follows:

1. Do not mint, accept, or look up `Mcp-Session-Id`, and do not persist an SDK
   transport runtime across requests. Construct the runtime and `McpRunContext`
   for the authenticated request only.
2. Supply a stable opaque replay scope for the logical approval/retry context,
   derived from authenticated request context and never from caller-controlled
   protocol input. Use that value for both the `RunContext.sessionId` context
   key and `McpStateSession.replayScope`.
3. Back `getReplay`, `setReplay`, and `deleteReplay` with the durable store,
   preserving absolute expiry, the per-scope capacity bound, and eviction. The
   stored value includes the authenticated subject and parked `ToolCall.id`, so
   an identical approved retry reuses it, a resolved retry removes it, and
   subject revocation purges it even when there is no live transport runtime.
4. Make the session registry operations request-scoped/no-op for the stateless
   transport, while preserving subject revocation before any tool execution.

The seam is intentionally internal until that protocol adapter exists; the
package-root API remains the frozen `createMcpDoor(config)` surface.

## Operating notes for host integrators

- **`HostOAuthAdapter.authorize` renders consent.** The door passes the client's
  `client_name` (from DCR or a Client ID Metadata Document — attacker-controllable)
  straight to your adapter. **Escape it** before rendering it on a consent screen;
  a client can register a name like `"Google Drive (official)"` for phishing or
  inject markup for XSS on your page. The door deliberately does no rendering.
- **Single-secret redemption is claimed in the database.** Authorization codes and
  refresh tokens use the store's atomic compare-and-claim capability, so one
  redeemer wins across multiple door processes sharing Postgres. A custom
  `StoreAdapter` that omits atomic claims fails closed at the token endpoint.
- **CIMD fetch egress.** The door resolves a Client ID Metadata Document URL server-side
  and rejects private/loopback/link-local resolutions (best-effort, via `node:dns`
  when present). On runtimes without a resolver, or for defense in depth, enforce
  egress at your network layer — the door cannot portably prevent DNS rebinding.
- **`vendo init` must ask before opening the door.** The shipped guard policy blocks
  `venue: "mcp"`; opening the door is a host decision, never a default.
