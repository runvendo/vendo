# @vendoai/mcp — the door: serve your product's tools to outside agents

Status: DRAFT (wave 6 — added after the v0 freeze on Yousef's directive; this document is ADDITIVE and changes nothing frozen). One job: make the host product installable in Claude, ChatGPT, Cursor, and any MCP client — OAuth, tool serving, and MCP Apps rendering handled behind one flag. Same guard, same audit: door calls get identical treatment to chat — no second, weaker perimeter. Depends on core only; the umbrella wires everything else in through seams.

Derived from the page's `@vendoai/mcp` block against the frozen contract set. The hooks were already reserved: `venue: "mcp"` in core §3, provider-safe tool names (decision 15, MCP-compatible by construction), `guard.bind` as the one execution path (decision 6).

## 1. Public API

```ts
import type { ToolRegistry, Guard, Principal, AppId, UIPayload, RunContext } from "@vendoai/core";

export function createMcpDoor(config: {
  tools: ToolRegistry;                  // ALREADY guard-bound by the umbrella (05 §2) — the door never sees an unbound registry
  guard: Guard;                         // audit reporting; decisions happen inside the bound registry
  oauth: HostOAuthAdapter;              // §3 — the host's existing auth becomes the MCP OAuth server
  apps?: AppsPort;                      // §4 — saved apps ride along as MCP Apps; absent → tools-only door
  serverInfo?: { name?: string; version?: string };   // MCP initialize handshake identity; defaults from package
}): McpDoor;

export interface McpDoor {
  /** One fetch-style handler serving: MCP Streamable HTTP transport, the OAuth endpoints (§3),
   *  and the discovery documents (§5). The umbrella mounts it (09 §3 note below). */
  handler: (req: Request) => Promise<Response>;
}
```

The umbrella exposes it as the page's one flag: `createVendo({ mcp: true })` wires `createMcpDoor` from the composition and mounts the handler under the same base (`/api/vendo/mcp` + the `/.well-known/*` paths at the host root). ⚑ `mcp?: boolean | { serverInfo? }` is an ADDITIVE key on `createVendo` config — allowed within the version train (00 "How this set evolves").

## 2. Door semantics (normative)

- **Same perimeter**: every door tool call becomes a `ToolCall` executed through the guard-bound registry with `RunContext{ venue: "mcp", presence: "present", principal }` — risk labels, grants, approvals, audit, breakers all apply identically. A `pending-approval` outcome is returned to the MCP client as a tool error naming the approval (the user resolves it in-product); `blocked` returns the guard's reason. Nothing is auto-elevated for being "just MCP".
- **Principal**: minted by the OAuth layer (§3) — the door never trusts client-supplied identity. Anonymous/ephemeral principals are not served: an unauthenticated MCP request gets the OAuth challenge, never a session.
- **Tool surface**: `tools/list` = the bound registry's descriptors verbatim (names are already MCP-safe, `inputSchema` is already the MCP field). No door-specific renames, no second catalog.
- **Default policy posture**: unchanged from guard's — but the shipped policy example (05 §3) blocks `venue: "mcp"`; `vendo init` asks before opening the door. Opening it is a host decision, never a default.

## 3. OAuth — the host's auth becomes the MCP OAuth server

OSS: host-side OAuth, self-hostable, per the MCP authorization spec (OAuth 2.1 + PKCE, dynamic client registration, resource-server metadata). Cloud: optional hosted broker behind the same adapter.

```ts
/** The five-function seam. The door owns ALL protocol mechanics (PKCE, token issuance/refresh,
 *  registration, metadata documents); the host owns exactly: who is this user, and did they consent. */
export interface HostOAuthAdapter {
  /** Render/handle the interactive consent step: authenticate the user with the HOST's existing
   *  session machinery and confirm scope consent. Returns the host subject on success. */
  authorize(req: Request, ctx: { clientName: string; scopes: string[] }): Promise<Response | { subject: string }>;
  /** Resolve a host subject to the Principal the door executes as (same shape the wire uses, 09 §2). */
  principal(subject: string): Promise<Principal | null>;
  /** Persist/lookup door state (registered clients, auth codes, refresh grants) — StoreAdapter-backed helper provided in-box. */
  store: McpAuthStore;
  /** Revocation check: a host that kills a user session can kill door access with it. */
  isRevoked?(subject: string): Promise<boolean>;
  /** Token lifetime overrides; defaults: access 1h, refresh 30d. */
  ttl?: { accessSeconds?: number; refreshSeconds?: number };
}

export function mcpAuthStore(store: StoreAdapter): McpAuthStore;   // vendo_mcp_clients / vendo_mcp_grants tables (additive to 02 §2)
```

Normative: access tokens are opaque (not JWTs the host must verify), bound to `(subject, clientId, scopes)`, checked on every request; refresh rotates; PKCE required; redirect URIs exact-match against registration. Everything auditable: token issuance and revocation are `AuditEvent`s (`kind: "door-auth"` — additive enum variant, tolerated by 01 §15 forward-compat).

## 4. Apps ride along — MCP Apps

The user's saved layer, not just raw tools: their apps appear in the MCP client via the MCP Apps standard (an MCP App is just one view of a Vendo app — theirs are ephemeral chat UI; ours stay saved, stateful, and can run code).

```ts
/** Seam the umbrella implements over AppsRuntime — the door depends on core only. */
export interface AppsPort {
  list(principal: Principal): Promise<Array<{ appId: AppId; name: string; description?: string }>>;
  open(appId: AppId, principal: Principal): Promise<{ payload: UIPayload } | { url: string }>;   // tree plane | http plane
  call(appId: AppId, ref: string, args: unknown, ctx: RunContext): Promise<unknown>;             // guard-bound inside apps
}
```

- The user's apps are listed as MCP Apps resources; opening one renders its instant-path payload through MCP Apps rendering (tree plane) or links out (http plane).
- Actions from a rendered app dispatch back through `AppsPort.call` — which is apps' own guard-bound path (06 §1) — so an app run from ChatGPT has exactly the authority it has in-product: the running user's, asked in context.
- ⚑ `AppsPort` lives in this contract, implemented by the umbrella. It is deliberately minimal — creation/editing stay in-product for v0; the door is a *viewer + runner*.

## 5. Discovery — agents find the host's server

- `/.well-known/oauth-protected-resource` + `/.well-known/oauth-authorization-server`: the MCP-spec metadata documents (the door generates both).
- `/.well-known/mcp.json`: server card (name, endpoint, capabilities) so registries and crawling agents can find the door — agent-reachability as distribution.
- Registry listings are a publishing step, not code: `vendo doctor` prints the card URL and validates the documents resolve.

## 6. Testing doctrine (binding, e2e-first)

The harness is a REAL MCP client: e2e drives the door with an actual MCP SDK client (initialize → OAuth round-trip against the fixture host app's auth → tools/list → tools/call), asserting: descriptors match the bound registry verbatim; a `destructive` call parks as an approval and the MCP client sees the approval-pending error; audit rows land with `venue='mcp'` (SQL assert); revocation kills the session; both `.well-known` documents validate against the MCP authorization spec. Apps-ride-along e2e: list → open returns the fixture app's tree payload. Live leg (env-gated): connect Claude Code itself as the client via `claude mcp add` against a local door and run one tool call.

## 7. Deferred

Hosted broker (Cloud), registry submission automation, MCP Apps write-back beyond `call`, scope-granular consent UI (v0: one consent per client covering the tool surface; guard still asks per-call for anything risky — the one security rule does the real work).
