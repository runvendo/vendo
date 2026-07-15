# @vendoai/mcp

`@vendoai/mcp` is Vendo's door: one fetch-style handler that exposes a host's guard-bound tools to MCP clients, owns the OAuth 2.1 + PKCE flow, and optionally carries saved Vendo apps as MCP Apps.

The umbrella package wires it behind the one-flag setup, `createVendo({ mcp: true })`, so the same tool registry, guard policy, approvals, and audit trail apply to MCP calls as to in-product calls.

The MCP Apps tree renderer is a committed, prebuilt HTML artifact. This keeps `@vendoai/mcp` dependent on core rather than UI at runtime. Regenerate the artifact from its owner with:

```sh
pnpm --filter @vendoai/ui build:mcp-shim
```

The server-card response tracks the provisional SEP-2127 draft and may move with that specification before ratification.

## External authorization servers

By default the door owns the OAuth authorization-server flow. A host that runs
its authorization server separately can instead configure:

```ts
createMcpDoor({
  // tools, guard, oauth, store, ...
  remoteAs: {
    issuer: "https://auth.example.com",
    audience: "https://product.example.com/api/mcp",
    // Optional. Otherwise the door discovers jwks_uri from RFC 8414 metadata.
    jwksUri: "https://auth.example.com/.well-known/jwks.json",
  },
});
```

In this mode the door accepts only ES256 bearer JWTs whose signature, `iss`,
`aud`, `exp`, and `iat` validate against the external server's JWKS. Keys are
cached and a new `kid` triggers a refresh for key rotation. The host's
`oauth.principal(sub)` still runs on every request, so returning `null` remains
the immediate account-level kill switch. The door's local `/authorize`,
`/token`, and `/register` endpoints and RFC 8414 metadata return `404`; RFC 9728
protected-resource metadata advertises the configured external issuer.

## Token revocation

Local authorization-server metadata advertises `{mount}/revoke` and the
supported `read` / `write` scopes. The RFC 7009 endpoint accepts an
`application/x-www-form-urlencoded` POST containing `token`, the public
`client_id`, and an optional `token_type_hint`. Unknown tokens and unknown or
incorrect hints receive the RFC-required empty `200` response.

Access-token revocation invalidates that opaque token. Refresh-token revocation
atomically revokes its authorization-grant family, including access tokens and
rotated successors, without disconnecting a separate authorization for the
same client. Hosts can disconnect all existing authorizations for one
subject/client pair and close their live MCP sessions through the returned door:

```ts
const door = createMcpDoor({ /* ... */ });
await door.revokeClient(subject, clientId);
```

Grant-family and token revocation use the store's guarded atomic claim rather
than a read-then-write update. In `remoteAs` mode, the external authorization
server owns revocation and the door's local `/revoke` path returns `404`.

## Login federation

`federation: { secret }` enables `GET {mount}/federate?request=<compact JWS>` as
a generic login handshake for an external authorization server. Requests are
HS256-signed with the shared secret and carry `iss`, the door resource as `aud`,
an expiration no more than five minutes away, `jti`, `redirect_uri`, `scopes`,
and `client_name`. The redirect URI must have the same origin as `iss`.

The door passes the client name and scopes to `HostOAuthAdapter.authorize`. A
`Response` from the adapter is returned unchanged for the host's login bounce;
after authentication the browser can retry the same signed request. A resolved
host subject is returned to the external server as `assertion=<compact JWS>` on
the redirect URI. That HS256 assertion is audience-bound to the request issuer,
issuer-bound to the canonical door resource, echoes the request `jti`, and
expires after 60 seconds. The endpoint emits redirects or JSON errors only; it
does not render request values into HTML.

## Transport state seam

The door's protocol-lifetime state is isolated behind the package-internal
`McpDoorState` interface. `createMcpDoor` still composes the 2025-11-25
Streamable HTTP transport with `InMemoryMcpDoorState`, so initialization,
`Mcp-Session-Id`, response bytes, and error behavior are unchanged.

The current adapter owns three related lifetimes:

- a TTL-indexed session record keyed by `Mcp-Session-Id`, containing the
  authenticated subject and opaque SDK runtime;
- the authenticated subject/client/grant-family binding used to close every
  matching live runtime on account, per-client, or refresh-family revocation;
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

- **The prebuilt page escapes `client_name`.** DCR and Client ID Metadata
  Documents make that value attacker-controlled. If you replace the page with
  `HostOAuthAdapter.authorize`, your renderer must keep escaping it too.
- **Return from login through `session`'s `returnTo`.** It preserves the complete
  OAuth request and prevents the common login → authorize → login loop.
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

## Prebuilt consent flow

Use `session` instead of hand-building consent in `authorize`. Return the current
host subject, or redirect an unauthenticated browser to login through the exact
`returnTo` the door supplies:

```ts
const oauth: HostOAuthAdapter = {
  async session(req, { returnTo }) {
    const subject = await currentSubject(req);
    if (subject) return { subject };

    const login = new URL("/login", req.url);
    login.searchParams.set("returnTo", returnTo);
    return Response.redirect(login);
  },
  async principal(subject) {
    return resolveUser(subject); // null revokes existing door tokens
  },
};
```

The door renders the consent page, handles approve/deny, CSRF-protects the POST,
rejects replay, and performs the standard authorization-code redirect. Its CSS
uses the UI pipeline's `--vendo-*` tokens, including `--vendo-color-*`,
`--vendo-font-*`, `--vendo-radius-*`, and `--vendo-space-*`. The umbrella passes
the resolved `.vendo/theme.json` automatically; direct `createMcpDoor` users can
pass the same core `VendoTheme` as `theme`.

To replace the whole page without taking ownership of the protocol, also provide
`authorize`. In session mode `ctx.consent` contains the door-owned form state;
post `transaction`, `csrf_token`, and `decision=approve|deny` to its `action`.
The door still handles and validates the decision.
