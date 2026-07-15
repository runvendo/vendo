# Umbrella hookup for @vendoai/mcp — landed record

Status: LANDED 2026-07-13 (this wave). The door (`@vendoai/mcp`) shipped its own
PR (#122) without umbrella wiring because `packages/vendo` was not yet on `main`.
This wave wires it in. The normative content lives in `10-mcp` (auth model in
§2.1); this note records what the umbrella now does.

## What shipped

- **One flag + one seam.** `createVendo({ mcp: true, oauth })` (10-mcp §1). `mcp`
  is an additive boolean; `oauth` is a top-level `HostOAuthAdapter` (10-mcp §3),
  REQUIRED when `mcp` is true — the door cannot mint principals without it.
- **Door construction.** When `config.mcp` is true, the umbrella builds
  `createMcpDoor` from parts it already assembled: the SAME guard-bound registry
  chat/apps/automations use, the `VendoGuard`, the store, `config.oauth`, and an
  **AppsPort adapter** over `vendo.apps` (`AppsRuntime.open` carries an extra
  `"resuming"` variant that `AppsPort` — `tree | http` only — does not; the
  adapter maps it for the door's viewer role).
- **Mount families.** `door.handler` is routed three path families (10-mcp §5):
  the door path itself (e.g. `/api/vendo/mcp`, POST/GET/DELETE);
  `/.well-known/oauth-protected-resource/*` and
  `/.well-known/oauth-authorization-server/*`; and
  `/.well-known/mcp/server-card.json` + `/.well-known/mcp-server-card`. Door
  paths bypass the wire's CSRF JSON gate (OAuth token/register are
  form-encoded).
- **`/status` + doctor.** `blocks.mcp` appears in `/status`; `vendo doctor` checks
  both metadata documents resolve and the server card parses.
- **`venue: "mcp"` host-call auth.** Authenticated over the existing `ActAs`
  seam, not cookies — MCP users have no host browser session. The door attaches
  its OAuth-consent record (`{ clientId, scopes }`) to every `RunContext` as
  `mcpConsent`; actions sources `actAs` with either the guard-attached real grant
  or a per-call consent projection (`source: "mcp"`), and fails closed otherwise.
  Full model and non-goals: **10-mcp §2.1**.

## Base URL note

Route-binding host execution needs a base origin. With no `VENDO_BASE_URL` the
umbrella learns the wire's own origin from the first request that addresses a
real wire route — but **door requests deliberately do not teach that same-origin
default** (they are the door's paths, not wire routes, 04 §4). A host whose MCP
traffic may arrive before any in-product wire request therefore has no learned
base when a door tool call resolves its route binding; such hosts should set
`VENDO_BASE_URL` explicitly (it is also the trusted origin credentials forward
to, so setting it is the right move regardless).

`VENDO_BASE_URL` is also the door's canonical public base (ENG-333): the
umbrella passes it to `createMcpDoor` as `baseUrl`, so behind a reverse proxy
the discovery documents, issuer/endpoint URLs, `resource`, and RFC 8707
audience binding advertise the PUBLIC origin instead of the proxy-internal
request origin. The additive `mcp: { baseUrl }` form of the flag overrides the
env default for compositions whose door origin differs from the route-binding
origin (`mcp: true` is unchanged). Forwarded headers are never trusted.

## Next.js note

The `/api/vendo/[...]` catch-all cannot see origin-root paths, so
`/.well-known/*` needs its **own** route forwarding to the same `door.handler`.
The umbrella's route glue owns `/api/vendo/*`; hosts add a sibling well-known
route (see the quickstart snippet). All three families resolve to one handler.

## Verified

Umbrella e2e drives `createVendo({ mcp: true })` end to end: real MCP SDK client
→ 401 → discovery → OAuth → initialize → `tools/call` a host WRITE tool →
executes AS the OAuth'd user via `actAs` → asserted side effect; wrong/
unauthenticated principal rejected; no-cookie-forwarding and clean degradation
locked by regression tests. Door-only proofs: PR #122.
