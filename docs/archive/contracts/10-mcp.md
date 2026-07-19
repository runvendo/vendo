# @vendoai/mcp — the door: serve your product's tools to outside agents

Status: LANDED 2026-07-13 (wave 6 — added after the v0 freeze on Yousef's directive; this document is ADDITIVE and changes nothing frozen). <!-- amended 2026-07-14: Status was DRAFT while the body already read "LANDED 2026-07-13"; reconciled to LANDED. The package ships published `@vendoai/mcp` v0.3.0 (door + OAuth + MCP Apps shim + tests), an umbrella dependency (PR #139). --> Umbrella hookup + `venue: "mcp"` host-call auth LANDED 2026-07-13 (this wave): §2.1 is the auth model, and the former handoff note `10-mcp-umbrella-hookup.md` is now the landed record. One job: make the host product installable in Claude, ChatGPT, Cursor, and any MCP client — OAuth, tool serving, and MCP Apps rendering handled behind one flag. Same guard, same audit: door calls get identical treatment to chat — no second, weaker perimeter. Depends on core only; the umbrella wires everything else in through seams.

Derived from the page's `@vendoai/mcp` block against the frozen contract set, then corrected against the live specs (MCP 2025-11-25 revision; MCP Apps 2026-01-26; dual review round applied — see §8). The hooks were already reserved: `venue: "mcp"` in core §3, provider-safe tool names (decision 15, MCP-compatible by construction), `guard.bind` as the one execution path (decision 6).

## 1. Public API

```ts
import type { ToolRegistry, Guard, StoreAdapter, Principal, RunContext, AppDocument, AppId, UIPayload, Json, VendoTheme } from "@vendoai/core";

export function createMcpDoor(config: {
  tools: ToolRegistry;                  // ALREADY guard-bound by the umbrella (05 §2) — the door never sees an unbound registry
  guard: Guard;                         // audit reporting for auth events (§3); tool decisions happen inside the bound registry
  oauth: HostOAuthAdapter;              // §3 — two functions; the host owns identity + consent, the door owns the protocol
  store: StoreAdapter;                  // door-owned protocol state (clients, codes, refresh grants) — wired like every other block
  apps?: AppsPort;                      // §4 — saved apps ride along as MCP Apps; absent → tools-only door
  baseUrl?: string;                     // §5 — canonical PUBLIC base URL (origin only); behind a reverse proxy the
                                        // request URL carries the proxy-internal origin, so discovery, issuer,
                                        // resource, and RFC 8707 audience derive from THIS when set (the umbrella
                                        // defaults it from VENDO_BASE_URL); unset → request-URL derived. Forwarded
                                        // headers are never trusted.
  theme?: VendoTheme;                   // §4 — optional host brand; the umbrella forwards .vendo/theme.json automatically
  remoteAs?: {                          // §3.1 — trust an external authorization server instead of serving the local AS
    issuer: string;
    jwksUri?: string;                   // absent → discover jwks_uri from the issuer's RFC 8414 metadata
    audience: string;
  };
  federation?: { secret: string };      // §3.2 — generic signed login handshake for an external AS
}): McpDoor;

export interface McpDoor {
  /** One fetch-style handler serving: MCP Streamable HTTP transport, the OAuth endpoints (§3),
   *  and the discovery documents (§5). The umbrella mounts it. */
  handler: (req: Request) => Promise<Response>;
}
```

The umbrella exposes it as the page's one flag — literally `createVendo({ mcp: true, oauth })` (⚑ additive boolean key + the `oauth` seam, allowed within the version train). `oauth` is a top-level `HostOAuthAdapter` (§3); `mcp: true` REQUIRES an adapter — supplied directly, or as the oauth half of the umbrella's unified `auth` preset (09 §2.1) — the door cannot mint principals without one. <!-- amended 2026-07-18: the adapter may arrive via the `auth` preset (server-wiring DX, 09 §2.1); `mcp: true` with no adapter from either channel still throws. --> ⚑ **LANDED** in the umbrella this wave (2026-07-13): `createVendo` constructs the door from the already-composed blocks (the same guard-bound registry, guard, store, and an `AppsPort` adapter over `vendo.apps`), mounts `door.handler` on the wire plus the origin-root well-known families (§5), and surfaces `blocks.mcp` in `/status` and `vendo doctor` checks. Server identity in the MCP initialize handshake derives from the host's package.json.

## 2. Door semantics (normative)

- **Same perimeter**: every door tool call becomes a `ToolCall` executed through the guard-bound registry with `RunContext{ venue: "mcp", presence: "present", principal }` — risk labels, grants, approvals, audit, breakers all apply identically. A `pending-approval` outcome returns as a **tool result with `isError: true`** whose content names the approval and says to resolve it in-product (MCP tool *execution* errors are in-band, never JSON-RPC protocol errors — the model must see the message); `blocked` likewise with the guard's reason. A `connect-required` outcome (01 §4, ENG-262) maps the same way: the door has no browser surface to run an OAuth redirect through, so the in-band error tells the user to connect the named toolkit account in the product and retry. Nothing is auto-elevated for being "just MCP".
- **Principal**: minted by the OAuth layer (§3) — the door never trusts client-supplied identity. Anonymous/ephemeral principals are not served: an unauthenticated request gets `401` with the challenge header (§3), never a session.
- **Tool surface**: `tools/list` = the bound registry's descriptors verbatim (names are already MCP-safe, `inputSchema` is already the MCP field). No door-specific renames, no second catalog.
- **Default policy posture**: unchanged from guard's — but the shipped policy example (05 §3) blocks `venue: "mcp"`; `vendo init` asks before opening the door. Opening it is a host decision, never a default.

## 2.1 Host-call auth over the door (normative)

A door tool call reaches the same actions `executeHost` path as chat (§2), but the present-execution assumption from 04 §4 does not hold: an MCP client has **no host browser session**, so there is no cookie or `Authorization` header to forward. `ctx.requestHeaders` here would carry the *inbound MCP request's* bearer — a door credential scoped to the door, never a host session — and is therefore **never forwarded** to the host route (fail-closed even if a forged `RunContext` smuggles headers in). Host-call auth for `venue: "mcp"` rides the **existing `ActAs` seam** (01 §13, 04 §4) — the same seam away automations use. No new seam, no new host function.

- **The door mints consent, not authority.** On success, `HostOAuthAdapter.authorize` (§3) records the user's standing door-session consent — `{ clientId, scopes }` — as door state (`vendo_mcp_grants`) plus a `door-auth` audit event. This is *not* a `PermissionGrant` and never suppresses a guard decision. The door attaches it to every `RunContext` it mints, as `ctx.mcpConsent`.
- **Sourcing the `actAs` grant.** In `executeHost` for `venue: "mcp"`, actions hands `actAs(principal, grant)` one of two values:
  - the **guard-attached real grant** (`ctx.grant`) when the run was grant-decided — e.g. a post-approval retry, or a `remember`-minted standing grant (01 §5). Ordinary grants flow through unchanged.
  - otherwise, a **per-call consent projection**: a `PermissionGrant`-shaped value `{ scope: { kind: "tool" }, duration: "session", contextKey: sessionId, source: "mcp" }`, minted **only** when `ctx.mcpConsent` is present. It is never stored and never consulted by guard — it exists solely to carry the OAuth'd principal into `actAs` so the host can vend that user's auth material.
- **Fail-closed.** No consent record and no grant → the call errors, closed; nothing executes anonymously. `actAs` absent → clean `not-implemented` tool error ("away execution isn't set up for this product", 04 §4) — the door degrades exactly like an away automation on a host that never wired the seam. `actAs → null` → the host declined this principal/tool; tool error.
- **The additive `source: "mcp"` variant.** `PermissionGrant.source` (01 §5) gains `"mcp"` as an additive union member, under the same forward-compat mechanism (01 §15) that admits the door wave's `AuditEvent.kind: "door-auth"` (§3). Its **only** documented mint point is the consent projection above; because that projection is never persisted, no stored grant ever carries it.
- **One security rule, kept honest.** The projection carries the *OAuth-authenticated user* as principal and nothing more: `scope: { kind: "tool" }` grants no bounded authority, `duration: "session"` outlives nothing, and the value never reaches guard — guard still asks per-call for anything risky, with the real inputs (01 §5). The authority is the USER the OAuth flow authenticated; the token, the client id, and the consent record hold **none** of it. A stolen token resolves to a principal whose every risky action still stops at an in-product approval (§2).
- **Scopes are evidence, not enforcement.** `mcpConsent.scopes` (the OAuth scopes the user consented the client to) rides along as audit/consent evidence but is **not** enforced per-tool: the guard is the sole authority (one-security-rule), so OAuth scope narrowing does not gate tool execution — a risky tool still stops at a per-call guard decision regardless of the token's scopes. Scope-granular consent is deferred (§7).

**Non-goals (normative).** This model changes nothing frozen. `ActAs`'s signature and semantics are untouched (01 §13). No new seam is introduced. The door captures no host credential and forwards no bearer — the inbound MCP token authenticates the door request and dies there; 04 §4 is untouched, 10-mcp is its additive home.

## 3. OAuth — the host's auth becomes the MCP OAuth server

OSS: host-side OAuth, self-hostable, per the MCP authorization spec (OAuth 2.1 + PKCE; Client ID Metadata Documents with dynamic client registration as fallback; resource indicators). Cloud: optional hosted broker behind the same adapter.

```ts
/** The two-function seam. The door owns ALL protocol mechanics (PKCE, resource binding, token
 *  issuance/rotation, client registration, metadata documents, its own state via `store`);
 *  the host owns exactly: who is this user, and did they consent. */
export interface HostOAuthAdapter {
  /** The interactive consent step: authenticate the user with the HOST's existing session
   *  machinery and confirm scope consent. Returns the host subject on success. */
  authorize(req: Request, ctx: { clientName: string; scopes: string[] }): Promise<Response | { subject: string }>;
  /** Resolve a host subject to the Principal the door executes as (same shape as 09 §2).
   *  Resolved on EVERY door request; `null` → 401, token dead — this IS revocation. */
  principal(subject: string): Promise<Principal | null>;
}
```

Normative:
- **Audience binding (RFC 8707)**: the `resource` parameter is accepted and enforced on both authorization and token requests; access tokens are bound to `(subject, clientId, scopes, resource)` and rejected when the resource is not the door's canonical URI — token-passthrough is structurally impossible.
- **Challenge**: every `401` carries `WWW-Authenticate` naming the protected-resource metadata URL (RFC 9728 §5.1) — this is the discovery entry point compliant clients start from.
- **Clients**: HTTPS-URL client ids (Client ID Metadata Documents) are accepted and advertised; RFC 7591 dynamic registration stays as the fallback (registered clients live in door state).
- **Tokens**: opaque (never host-verifiable JWTs), checked on every request, refresh rotates, PKCE required, redirect URIs exact-match. Authorization-code consumption and refresh rotation use the store's database-level atomic claim; an adapter without that additive capability fails closed at the token endpoint. Lifetimes: access 1h, refresh 30d (per-request `principal()` resolution is the real kill switch).
- **Audit**: token issuance and revocation are `AuditEvent`s (`kind: "door-auth"`, additive variant per 01 §15) — the SIEM export (05 §1) sees the door's auth lifecycle, same as everything else.
- Door state lands in `vendo_mcp_clients` / `vendo_mcp_grants` (additive to the 02 §2 table map; typed helpers are block-internal, same status as guard's).

### 3.1 External authorization-server trust mode

`remoteAs` switches bearer authentication from the door's local grant store to
external JWT validation. The door accepts ES256 only, resolves keys from the
configured `jwksUri` or the issuer's
`{issuer}/.well-known/oauth-authorization-server` `jwks_uri`, caches keys, and
refreshes the JWKS when a new `kid` appears. A bearer is valid only when its
signature and `iss`, `aud`, `exp`, and `iat` claims validate against the
configured issuer and audience. The JWT `sub` is then resolved through
`HostOAuthAdapter.principal` on every door request exactly like a local grant;
the host kill switch, session ownership, replay, guard, and audit behavior do
not change.

In this mode the local `/authorize`, `/token`, and `/register` endpoints return
`404`, the door returns `404` for its RFC 8414 authorization-server metadata,
and RFC 9728 protected-resource metadata advertises
`authorization_servers: [remoteAs.issuer]`. The external server owns its OAuth
protocol surface.

### 3.2 Login federation

`federation: { secret }` adds `GET {mount}/federate?request=<compact JWS>` as a
generic handshake for an external authorization server. The request is HS256
verified with `secret` and must contain `{ iss, aud, exp, jti, redirect_uri,
scopes, client_name }`, where `aud` is the canonical door resource, `exp` is in
the future but no more than five minutes away, `scopes` is a string array, and
the redirect URI origin equals the `iss` origin.

After validation the door calls `HostOAuthAdapter.authorize(req, { clientName:
claims.client_name, scopes: claims.scopes })`. An adapter `Response` is returned
unchanged so host login can bounce and the browser can retry the same request.
For `{ subject }`, the door redirects to `redirect_uri` with an HS256
`assertion` carrying `{ iss: resource, aud: request.iss, sub: subject, jti:
request.jti, iat, exp: iat + 60s }`. The endpoint renders no HTML.

## 4. Apps ride along — MCP Apps

The user's saved layer, not just raw tools — delivered the way the MCP Apps spec (2026-01-26) actually works:

- The door ships **one static HTML shim resource** — the tree renderer (`@vendoai/ui/tree`, which already ships as a library per 08 §1) — at a `ui://` URI with mimeType `text/html;profile=mcp-app`, negotiated via the `io.modelcontextprotocol/ui` extension.
- The generated shim stays generic. When `theme` is present, the door specializes the resource it serves by injecting the canonical `--vendo-*` variables; the shim wraps every rendered surface in `VendoProvider`, so the same resolved theme reaches prewired primitives, notices/link-out chrome, and generated-component jail frames. The current `VendoTheme` contract carries one palette, so the shim declares the same light color-scheme as the in-product chrome rather than inventing an uncontracted dark palette.
- App access is **ordinary door tools** (`vendo_apps_list`, `vendo_apps_open`) carrying `_meta: { ui: { resourceUri } }`; the host client renders the shim when the tool is called, and the tool result carries the `UIPayload` for the shim to render. Format dispatch inside the shim follows core §8 (unknown tags render a contained notice).
- `AppsRuntime.open()` has already resolved v0 tree queries into `tree.data` (06 §1), so the MCP projection omits `tree.queries` from that resolved payload. The static shim retains query resolution only as a compatibility fallback for unresolved payloads from non-door hosts; a door open executes each query exactly once.
- A rung-4 `{ kind: "http", url }` open is never embedded in the MCP client. The door projects it as the MCP-only structured envelope `{ kind: "vendo/open-in-product@1", url, productName, appName? }`; the shim renders a branded link-out card, and the tool's text content includes the same URL for clients that do not render MCP Apps. `appName` is best-effort; `productName` is the door's server identity.
- Interactions inside the rendered app go back over the shim's `postMessage` JSON-RPC bridge as `tools/call` — which lands in the guard-bound path like every other door call. An app run from ChatGPT has exactly the authority it has in-product: the running user's, asked in context.

```ts
/** Structural subset of AppsRuntime (06 §1) — the umbrella passes `vendo.apps` essentially verbatim. */
export interface AppsPort {
  list(ctx: RunContext): Promise<AppDocument[]>;
  open(appId: AppId, ctx: RunContext): Promise<{ kind: "tree"; payload: UIPayload } | { kind: "http"; url: string }>;
  call(appId: AppId, ref: string, args: Json, ctx: RunContext): Promise<unknown>;   // guard-bound inside apps
}
```

⚑ Creation/editing stay in-product for v0; the door is a viewer + runner.

## 5. Discovery — agents find the host's server

- Protected-resource metadata at the **path-inserted** well-known URL (RFC 9728 §3): a door mounted at `/api/vendo/mcp` serves `/.well-known/oauth-protected-resource/api/vendo/mcp`. Authorization-server metadata (RFC 8414) likewise.
- **Origin derivation (ENG-333)**: every advertised origin — the issuer, endpoint URLs, the protected-resource `resource`, the `401` challenge's metadata URL — and RFC 8707 audience validation derive from the configured `baseUrl` (origin only) when set; unset, they derive from each request's own URL. `X-Forwarded-*`/`Host` headers are never consulted (Host-header injection). The umbrella defaults `baseUrl` from `VENDO_BASE_URL`; the additive `createVendo({ mcp: { baseUrl } })` form overrides it for compositions whose door origin differs from the route-binding origin.
- With `remoteAs`, protected-resource metadata names the external issuer and the door does not serve RFC 8414 authorization-server metadata; the external server owns it (§3.1).
- Server card at `/.well-known/mcp-server-card` — ⚑ **provisional**, tracking SEP-2127 (Draft); the path moves with the SEP if it changes before ratification. Registry listings are a publishing step, not code. The door accepts an optional `mount` (e.g. `/api/vendo/mcp`): when set it is authoritative for the card's advertised transport URL, so a **cold** composed umbrella advertises the right mount before any request arrives, and learned request paths never override it (the umbrella passes its fixed `MCP_MOUNT`). Unset, the card falls back to `/mcp` until an authenticated request teaches it a mount.
- `vendo doctor` validates both metadata documents resolve and the card parses.

## 6. Testing doctrine (binding, e2e-first)

The harness is a REAL MCP client: e2e drives the door with an actual MCP SDK client — `401` → `WWW-Authenticate` → metadata discovery at the path-inserted URL → OAuth round-trip against the fixture host app's auth (with `resource` sent and a wrong-resource token request rejected) → initialize → `tools/list` → `tools/call` — asserting: descriptors match the bound registry verbatim; a `destructive` call parks and the client sees the in-band `isError` result naming the approval; audit rows land with `venue='mcp'` and `kind='door-auth'` (SQL asserts); `principal() → null` kills an existing session. Apps-ride-along e2e: `vendo_apps_open` returns the fixture app's payload with `_meta.ui.resourceUri` set, and the shim resource serves with the MCP Apps mimeType and fixture `--vendo-*` theme variables. Live leg (env-gated): connect Claude Code itself via `claude mcp add` against a local door and run one tool call.

External-AS coverage uses an in-test authorization server with a jose-generated
ES256 keypair: valid JWTs cross the real MCP transport, claim/signature failures
are rejected, unknown keys fail closed, and a rotated `kid` refreshes cached
JWKS. Federation coverage signs requests and verifies returned assertions
against a fake `HostOAuthAdapter`, including signature, expiry, audience, and
redirect-origin failures.

## 7. Deferred

Hosted broker (Cloud), registry submission automation, MCP Apps write-back beyond `call`, scope-granular consent UI (v0: one consent per client covering the tool surface; guard still asks per-call for anything risky — the one security rule does the real work).

## 8. Review round (recorded)

Dual review applied before any build: **standards** (verified against MCP 2025-11-25, MCP Apps 2026-01-26, RFC 8707/9728/8414/7591, CIMD draft) — all 6 findings applied, the big two being resource/audience binding and the MCP Apps shim delivery model. **Simplification** — 5 of 7 applied (`HostOAuthAdapter` shrunk to two functions, door owns its own state via `StoreAdapter`, `isRevoked`/`ttl`/`serverInfo` deleted, `AppsPort` = structural subset of `AppsRuntime`); 2 declined with rationale: the server card stays (the page mandates discovery — "agent-reachability becomes distribution" — path corrected + marked provisional instead), and `guard` stays in config (the page mandates "same audit"; auth events belong in the SIEM export, not only in SQL).

## 9. Additive amendments

### 2026-07-14 — RFC 7009 token revocation

- **Changed:** Added local `{mount}/revoke` handling for access and refresh
  tokens, advertised `revocation_endpoint` and `scopes_supported` in RFC 8414
  metadata, and added `McpDoor.revokeClient(subject, clientId)` as the
  host-authorized per-client disconnect surface.
- **Semantics:** Access-token revocation invalidates that token. Refresh-token
  revocation atomically kills the token's authorization-grant family, including
  its access tokens and rotated successors. The host API revokes every existing
  family for the subject/client and closes matching live MCP sessions. Unknown
  tokens return an empty `200` as required by RFC 7009.
- **Compatibility:** Grant-family fields and the `McpDoor` method are additive.
  Pre-family grants remain readable during rolling deployment and are revoked
  through guarded token updates. External authorization-server mode continues
  to delegate the complete OAuth surface, including revocation, to `remoteAs`.
- **Approved by:** Yousef, 2026-07-14 (ENG-269).

### 2026-07-15 — broker-frontable umbrella seams (ENG-286)

- **Changed:** §3.2's login-federation handshake accepts a prebuilt-flow
  adapter: when `HostOAuthAdapter.authorize` is absent, the door authenticates
  through `session(req, { returnTo: <the federate request URL> })` — federation
  delegates consent to the external authorization server, so the host only has
  to answer identity. A returned login `Response` still passes through
  unchanged. Adapters that implement `authorize` keep their original semantics.
- **Changed:** the umbrella's additive object form `createVendo({ mcp: {…} })`
  now carries `remoteAs` and `federation` through to the door, so a composed
  host can be fronted by an external authorization server (e.g. the hosted
  broker at `{tenant}.mcp.vendo.run`) without dropping to `createMcpDoor`.
- **Compatibility:** both changes are additive; `mcp: true`, `mcp: { baseUrl }`,
  and `authorize`-bearing adapters behave exactly as before.
- **Approved by:** pending Yousef review (ENG-286 — flagged in the PR).

### 2026-07-15 — connect-required over the door (ENG-262, parent ENG-264)

- **Changed:** §2 maps the additive `connect-required` tool outcome to the door's in-band `isError` result, directing the user to connect the account in-product — same doctrine as `pending-approval`.
- **Why:** Per-user connected accounts (04 §3.1) landed; an MCP client cannot host the broker's OAuth redirect.
- **Authorized by:** the Yousef-approved block-actions design spec (`docs/superpowers/specs/2026-07-14-block-actions-design.md`).
