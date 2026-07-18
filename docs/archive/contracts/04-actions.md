# @vendoai/actions — your API becomes agent tools

Status: FROZEN (wave-2 gate passed by Yousef, 2026-07-11). Changes now require a major. One job: own ALL tools. Host API, external connectors (Composio, any MCP server), and Vendo capability tools are one tool shape — same risk labels, same guard treatment, same approval UX. Executes as the signed-in user when present; through the host's `actAs` when away. Depends on core only.

Two halves: sync (a build step) and runtime.

## 1. Sync — extraction as a build step, never a command

"Sync is a build step → tools can't go stale." `vendo init` is the visible, interactive first pass (09 §5); after that, sync runs inside build/dev-start. Missing `.vendo/` → full extract; skipping init never breaks.

The build-step rule is scoped to SYNC — the deterministic extraction pipeline. The agent-layer refine engine (`vendo refine`, the author of `.vendo/capabilities.json` in §6) is explicitly a COMMAND: it runs a BYO model, proposes reviewable diffs (capabilities, overrides, brief), and applies them only on approval — it never runs inside build/dev-start, and it never writes `tools.json`. <!-- amended 2026-07-15: build-step-versus-command language scoped to sync per the approved extraction design (spec §3, ENG-250); refine engine landed in packages/vendo (refine.ts, cli/refine.ts). -->


```ts
export function vendoSync(options: {
  root: string;                          // host app root
  out?: string;                          // default ".vendo"
  strict?: boolean;                      // breaking change → non-zero exit (CI gating); default fail-soft warn
}): Promise<SyncReport>;

export interface SyncReport {
  tools: { added: string[]; removed: string[]; changed: string[] };
  breaking: BreakingChange[];
  pins: { captured: string[]; drifted: string[] };   // remixable component baselines (06 §8)
  catalog: { discovered: number; registered: number }; // additive @1 amendment approved by Yousef, 2026-07-14
}

export interface BreakingChange {
  tool: string;
  change: "removed" | "input-narrowed" | "renamed";
}
// Blast radius ("which saved apps reference this tool") stays a runtime concern — now specified:
// the umbrella serves a dev-gated POST /sync/impact (09 §3) mapping each tool to the saved apps,
// automations, and standing grants that reference it. `vendo sync` queries it when the dev server
// is reachable and prints per-tool impact; unreachable → graceful "impact unknown" fallback.
// --strict exits 2 on breaking extraction, 3 when a breaking tool also has nonzero blast radius;
// --report pushes the report to the Cloud console with a key (fail-soft warn, never fatal). (ENG-261)
```

Extraction tier: **OpenAPI + route-scan + tRPC + GraphQL + server actions** (corpus-proven; tRPC added additively within `vendo/tools@1` 2026-07-15, GraphQL 2026-07-16, server actions 2026-07-16). New extractors change no format below. Extractors sit behind one seam: a registration list of `{ detect, extract }` pairs inside `vendoSync`, run in order (OpenAPI, tRPC, GraphQL, server-actions, route-scan); route tools under a tRPC mount or a GraphQL endpoint are shadowed by the extracted operations (the transport route is not a real API surface). Extraction is fail-closed: a route the scanner can't classify is emitted `disabled: true` with a note, never silently auto-allowed.

tRPC extraction is static — routers are parsed with the TypeScript compiler API, no host code runs. Zod input schemas are statically interpreted into JSON Schema for common patterns; unrecognized validators fail closed to a permissive schema plus a `note`. Risk labeling extends the fail-closed rules: a query earns `read` only with a read-shaped name, mutations default to `write`, the destructive word list applies unchanged, and unclassifiable procedures (subscriptions, dynamic composition) are emitted `disabled: true` with a note.

GraphQL extraction is static — the schema is read from SDL files (parsed with the host's own graphql package) and from code-first sources (`@nestjs/graphql` / `type-graphql` resolver classes, parsed with the TypeScript compiler API); no host code runs and no LLM is in the path. One tool per query and per mutation; `inputSchema` is derived deterministically from GraphQL argument types; each binding carries a full executable `document` whose variable declarations come from the schema's argument types and whose default selection set is depth-limited (objects two levels deep, parameterized fields skipped, `{ __typename }` when nothing else is selectable). Risk labeling applies the same fail-closed rules: a query earns `read` only with a read-shaped name, mutations default to `write`, the destructive word list applies unchanged. Unclassifiable surfaces are emitted `disabled: true` with a note, never silently auto-allowed: subscriptions (not invokable over a single HTTP request), operations whose argument or return types cannot be statically named (the `document` is then absent), and every operation of a multi-endpoint host (several GraphQL schemas — the Twenty shape — defeat static operation-to-endpoint attribution; overrides.json re-enables after review).

Server-action extraction is static — `"use server"` modules and inline directives are parsed with the TypeScript compiler API, no host code runs. Every exported action of a module-level `"use server"` file becomes a tool bound `{ kind: "server-action", module, exportName, params }` (root-relative module path, export name, ordered parameter names); recognized wrappers whose export is still an importable callable (react `cache(fn)`, `createSafeAction(schema, handler)`) are unwrapped. Input schemas come from validators where statically interpretable — zod schemas referenced through `z.infer<typeof X>` annotations or safe-action wrappers, plus primitive/object-literal type annotations; anything else fails closed to a permissive parameter with a `note`. Risk labeling extends the fail-closed rules: actions default to `write` (a read-shaped name never earns `read` — an action is a POST-shaped mutation surface), the destructive word list applies unchanged, and unclassifiable exports are emitted `disabled: true` (risk `destructive`) with a note. Inline actions (a directive inside a component-scoped function) are real surface but not importable, so they are emitted `disabled: true` with a hoist-to-module note.

Server actions execute by **direct in-process registration through the generated wiring file** — never Next action-id bindings. `vendo init` emits a registration map module (`vendo-actions.ts` beside the generated route) that imports each detected action module and passes the map into `createVendo({ serverActions })`, keyed `"<module>#<exportName>"`; re-init regenerates it idempotently as the detected surface changes. Execution maps the args object onto positional arguments per the binding's `params`. When the registration map lacks an action — never generated, hand-removed, or a disabled tool force-enabled — execution fails closed: a clear `not-implemented` error, no work performed.

Tool identity is binding-kind-aware: HTTP-shaped bindings (route, openapi) are identified by method + path; tRPC bindings by mount + procedure dot-path (the same procedure name under two mounts is two tools); GraphQL bindings by endpoint + operation, with the operation's kind in the key (GraphQL allows a query and a mutation to share one field name across the two root types); server-action bindings by module path + export name. `SyncReport` breaking-change detection and corpus expectations key on this identity, never on the renamed tool slug (01-core §4).

### `.vendo/tools.json` (generated, host-committed)

```jsonc
{
  "format": "vendo/tools@1",
  "tools": [
    {
      // ToolDescriptor fields (core §4) ...
      "name": "host_invoices_list",
      "description": "List invoices",
      "inputSchema": { /* JSON Schema */ },
      "risk": "read",
      // plus the execution binding:
      "binding": { "kind": "route", "method": "GET", "path": "/api/invoices", "argsIn": "query" }
      // | { "kind": "openapi", "operationId": "listInvoices", "baseUrl": "..." }
      // | { "kind": "trpc", "procedure": "polls.list", "type": "query", "mount": "/api/trpc", "transformer": "superjson"? }
      // | { "kind": "graphql", "operation": "createInvoice", "type": "mutation", "endpoint": "/graphql", "document": "mutation createInvoice($input: CreateInvoiceInput!) { ... }"? }
      // | { "kind": "server-action", "module": "app/actions/invoices.ts", "exportName": "createInvoice", "params": ["input"] }
    }
  ]
}
```

### Component catalog extraction — additive within @1 (approved 2026-07-14)

Sync also owns `.vendo/catalog.json`. It is a deterministic, machine-generated, host-committed
review artifact: every sync regenerates it, and a missing `.vendo/` at build
causes the same regeneration. Init asks no catalog questions and prints exactly
`catalog.json: N discovered, M registered` after its silent sync.

The TypeScript compiler API is the inventory and props-schema source of truth;
regex extraction and model-authored inventory are forbidden. A component is
discoverable only with exported-map registration evidence from a
`<VendoRoot components={...}>` JSX use, a callable JSX implementation, a stable
module/export path, and a representable props type. Unrepresentable exotic prop
types produce a permissive schema plus a tool-authored explanatory `note`, or
the entry is omitted. Statically serializable `createVendo({ catalog })` code
registrations are merged by name and win over scanned entries.

```jsonc
{
  "format": "vendo/catalog@1",
  "entries": [{
    "name": "InvoiceCard",
    "exportPath": "./src/vendo/host-components.tsx#hostComponents.InvoiceCard",
    "propsSchema": { "type": "object", "properties": {} },
    "description": "Use when reviewing one invoice.",
    "examples": ["<InvoiceCard invoice={invoice} />"],
    "source": "registered", // or "scanned"
    "disabled": false,
    "note": "optional tool-authored explanation"
  }]
}
```

The catalog and every entry use strict Zod validation so stale or misspelled
fields fail sync loudly. Rescans replace all deterministic fields and all
tool-owned fields; only previously accepted `description`/`examples` on a
still-scanned entry persist, keeping unchanged reruns byte-identical. Scanned
entries carry no authored copy of their own — a human hand-edits
`description`/`examples` directly in `catalog.json`, and rescans preserve that
copy on a still-scanned entry. Registered copy lives in code and is
regenerated from code on every sync. (No seam authors catalog copy today —
`description`/`examples` are hand-edited, full stop.)

`disabled` remains in the strict `catalog@1` entry schema for forward
conformance, but is reserved for the extraction-M5 curation workflow and the
install-DX correction-path design. Until that human-owned persistence exists,
sync does not preserve hand-authored disabled flags and runtime does not filter
catalog entries by this field; do not use it as a curation control.

Known runtime limit: `propsSchema` from disk is JSON Schema prompt guidance,
not an executable validator. Disk-loaded entries use a pass-through
`StandardSchema` at runtime, while explicit code registrations retain their
real `StandardSchema` validators. Strong runtime prop validation therefore
requires code registration until a JSON-Schema validation seam is added.

### `.vendo/overrides.json` (human-written, respected forever)

Re-extraction never touches it; answers from the init interview land here.

```jsonc
{
  "format": "vendo/overrides@1",
  "tools": {
    "host_invoices_delete": { "risk": "destructive", "critical": true },
    "host_internal_debug": { "disabled": true },
    "host_invoices_send": { "description": "Send an invoice email to the customer" }
  }
}
```

Merge rule: descriptor = extracted ∪ overrides, overrides win field-wise; `descriptorHash` is computed post-merge (an override that changes risk lapses old grants — correct and intended).

### `.vendo/capabilities.json` (agent-authored, reviewed diffs)

```jsonc
// .vendo/capabilities.json — agent-authored (refine engine), human-reviewed diffs, host-committed
{
  "format": "vendo/capabilities@1",
  "tools": [
    {
      // ToolDescriptor fields (01-core §4)
      "name": "host_invoice_send_flow",
      "description": "Create an invoice and email it to the customer",
      "inputSchema": { /* JSON Schema for the compound's own args */ },
      "risk": "write",                    // MUST equal max of step risks post-merge
      "critical": false,                  // optional, as any descriptor
      "binding": {
        "kind": "compound",
        "steps": [                        // core Step shape (01-core §11), 1..50 steps
          { "id": "create", "tool": "host_invoices_create", "args": { "amount": "args.amount" } },
          { "id": "send", "tool": "host_invoices_send", "if": "args.email != null",
            "args": { "id": "steps.create.id", "to": "args.email" } }
        ]
      },
      "disabled": false,                  // optional
      "note": "authored by vendo refine"  // optional
    }
  ],
  "briefs": [
    { "name": "bulk-paste", "text": "To paste a range, call host_cells_update per row…", "tools": ["host_cells_update"] }
  ]
}
```

Loaded alongside overrides, compounds are additional tools. A name collision with `tools.json` or a connector is a `conflict` error. `overrides.json` applies field-wise to compounds by name. Semantic-validation failures quarantine the entry: it is disabled, never executes, and boot never degrades. `tools.json` stays deterministic and never carries compounds.

## 2. Runtime

```ts
import type { ToolRegistry, ToolCall, ToolDescriptor, RunContext, ActAs, ToolOutcome } from "@vendoai/core";

export function createActions(config: {
  dir?: string;                          // read .vendo/{tools,overrides,capabilities}.json; or:
  tools?: ExtractedTool[];               // inject directly (tests, non-file hosts); ExtractedTool = ToolDescriptor & { binding: RouteBinding | OpenApiBinding | TrpcBinding | GraphqlBinding | ServerActionBinding }
  capabilities?: CapabilitiesFile;       // inject directly (tests, non-file hosts)
  connectors?: Connector[];
  actAs?: ActAs;                         // host seam; absent → away execution cleanly unavailable
  serverActions?: Record<string, ServerActionHandler>; // wiring-generated registration map, keyed "<module>#<exportName>"; missing key → fail closed
  baseUrl?: string;                      // host origin for server-side route execution
  fetch?: typeof fetch;
  invokeTool?: ToolRegistry["execute"];
}): ActionsRegistry;

export interface ActionsRegistry extends ToolRegistry {
  /** Register Vendo capability tools (apps hands its create/edit tools in via the umbrella). */
  add(tools: ToolRegistry): void;
}
```

The umbrella wires `invokeTool` to the guard binding (09 §2).

## 2.1 actAs presets — `@vendoai/actions/presets` (ENG-260)

The `ActAs` seam ships implementations, both tiers: preset code for the four first-class providers plus a generic JWT preset, and documented copy-paste recipes for the long tail. Provider SDKs are optional peer deps of the subpath only; dependency-guard layering holds. Token caching lives inside the preset closures until expiry; `AuthMaterial` stays `{ headers }` — no contract change.

```ts
export function authJsPreset(options?: { secret?: SecretSource; cookieName?: string; secureCookie?: boolean; claims?: ClaimsOption; expiresInSeconds?: number; cacheSafetySeconds?: number }): ActAs;   // mints an Auth.js v5 encrypted-session JWE; returns { headers: { cookie } }
export function supabasePreset(options?: { secret?: SecretSource; audience?: string; role?: string; claims?: ClaimsOption; expiresInSeconds?: number; cacheSafetySeconds?: number }): ActAs;           // HS256 native access token (project JWT secret)
export function genericJwtPreset(options: { secret?: SecretSource; claims?: ClaimsOption; jwtHeader?: Record<string, Json>; headers?: (token: string) => Record<string, string>; expiresInSeconds?: number; cacheSafetySeconds?: number }): ActAs;

/** Where offline minting is impossible (Clerk, Auth0 — RS256, provider-held keys), the preset ships BOTH halves:
 *  an actAs producer signing a short-lived Vendo away-token, plus a small verify-middleware the host mounts on its API. */
export function clerkPreset(options?: AwayTokenPresetOptions): AwayTokenPreset;
export function auth0Preset(options?: AwayTokenPresetOptions): AwayTokenPreset;

export interface AwayTokenPreset {
  actAs: ActAs;                                              // producer half: authorization: VendoAway <token>, JWT typ "vendo-away+jwt"
  verify(tokenOrAuthorization: string): Promise<AwayTokenClaims>;
  nextMiddleware(request: Request): Promise<Response>;       // verify half, Next.js flavor
  expressMiddleware: ExpressAwayTokenMiddleware;             // verify half, Express flavor
}
export interface AwayTokenClaims { iss: string; aud: string; sub: string; provider: "clerk" | "auth0"; grantId: string; tool: string; iat: number; exp: number }
```

The away-token secret defaults to `VENDO_AWAY_TOKEN_SECRET`; the verifier stamps the trusted `x-vendo-away-subject/-provider/-grant/-tool` headers for the host route. A `ClaimsResolver` returning `null` declines the mint — actAs answers `null` and the run fails closed (01 §13).

## 3. Connectors — lean, we build zero

```ts
export interface Connector {
  name: string;
  descriptors(): Promise<ToolDescriptor[]>;
  execute(call: ToolCall, ctx: RunContext): Promise<ToolOutcome>;
  connections?: ConnectorConnections;    // per-user connected accounts (ENG-262) — subject-scoped, optional
}

/** Per-user connected accounts. Every operation is scoped to one subject —
 *  the umbrella passes only the resolved principal's subject, never caller input (09 §3). */
export interface ConnectorConnections {
  list(subject: string): Promise<ConnectorAccount[]>;
  initiate(subject: string, toolkit: string, options?: { callbackUrl?: string }): Promise<{ id: string; redirectUrl: string }>;
  status(subject: string, connectionId: string): Promise<ConnectorAccount | null>;   // null → not this subject's account (no oracle)
  disconnect(subject: string, connectionId: string): Promise<void>;                  // ownership-checked before any delete leaves the process
}
export interface ConnectorAccount { id: string; connector: string; toolkit: string; status: "initiated" | "active" | "expired" | "failed"; createdAt?: IsoDateTime }

/** Audit identity a connector execution attaches to its outcome; the guard binding lifts it
 *  into AuditEvent.detail.connectorAccount and strips it from the outcome (01 §7, 05 §2). */
export interface ConnectorAccountIdentity { connector: string; toolkit?: string; entityId?: string; accountId?: string; credential?: "per-principal" | "shared" }

export function composioConnector(config: { apiKey: string; entityId?: (ctx: RunContext) => string; apps?: string[] }): Connector;   // entityId default: the principal's subject — Composio connected accounts are per-user; every read is subject-filtered
export function mcpConnector(config: { url: string; headers?: Record<string, string> | McpHeadersResolver; name?: string }): Connector;

/** Per-principal connector identity (ENG-262): static shared headers stay the simple default;
 *  a resolver receives presence/grant context and vends per-user credentials. With a resolver,
 *  MCP sessions are per-subject (LRU-bounded; evicted sessions re-initialize on next call). */
export type McpHeadersResolver = (auth: { principal?: Principal; presence?: RunContext["presence"]; grant?: PermissionGrant }) => Record<string, string> | Promise<Record<string, string>>;
```

Normalization rules: connector tool names are underscore-prefixed inside the provider-safe charset (core §4): `gmail_send`, `mcp_<server>_<tool>` (truncated + suffix-hashed past 64 chars); MCP tools are re-described through the same descriptor shape so guard sees no difference. Risk labels (ENG-262, replacing the hardcoded conservative default that never let destructive ops hit the forced-ask gate): connector annotations win when present — Composio's `destructiveHint` tag or any destructive verb token (delete/remove/destroy/purge/…) anywhere in the slug → `destructive`; `readOnlyHint` or a leading read verb (get/list/search/…) → `read`; everything else defaults **`write`** (conservative). `overrides.json` still wins field-wise.

### 3.1 connect-required — the missing-connection outcome (ENG-262)

A connector call failing on a missing per-user connection produces the typed `connect-required` outcome (01 §4), never a bare error: the UI renders an inline connect card beside the tool part (`data-vendo-connect`, 01 §16; chrome 08 §4), the user completes the broker's OAuth redirect, and the call retries. Composio is the sole broker — no home-grown OAuth flows. Cloud: with `VENDO_API_KEY` and no BYO connector, connections ride the Vendo Cloud broker endpoints (bearer-authed against `VENDO_CLOUD_URL`) using Vendo's Composio credentials — cloud users bring zero keys; BYO always wins; posture is reported as `blocks.connections: "byo" | "cloud" | false` (09 §3). Ephemeral and synthetic (`webhook:`/`vendo:`) subjects are refused at initiate.

## 4. Execution semantics (normative)

- **Present** (`presence: "present"`): the call rides the user's real session. Server-side route execution forwards the inbound request's auth material (`ctx.requestHeaders` — cookies/authorization captured by the umbrella handler) on a same-origin fetch to `binding.path`. **Forwarding requires a trusted base URL** (ENG-260, closing the silent trap): the umbrella trusts `VENDO_BASE_URL` (or an explicit `baseUrl`); a learned wire origin is untrusted and forwards nothing. When present execution forwards nothing despite inbound auth headers, the runtime fires `onPresentCredentialsNotForwarded` (reason `untrusted-host-origin` | `cross-origin-binding`) and the umbrella emits one structured audit warning per process (`detail.warning.code: "present-credentials-not-forwarded"`, 01 §7). `vendo init` writes `VENDO_BASE_URL`; `vendo doctor` live-probes that credentials actually arrive (`/doctor/present`) and that actAs mint+verify round-trips (`/doctor/act-as`) (09 §5).
- **tRPC bindings** execute over the tRPC HTTP envelope against the host mount: queries `GET {mount}/{procedure}?input=<json>`, mutations `POST {mount}/{procedure}` with the input as the JSON body; `{ result: { data } }` is unwrapped on success. Calls are always single-procedure — HTTP batching (`/p1,p2?batch=1`) is a client optimization the runtime never uses. When `transformer: "superjson"` is present (detected per mount) the input/output ride superjson's `{ json: ... }` wrapping. Auth semantics (present-forward, away/actAs, venue=mcp) are identical to route bindings.
- **GraphQL bindings** execute over the GraphQL HTTP transport: every operation — query or mutation — is a `POST {endpoint}` of `{ query: document, variables: args }`; each tool argument rides as a same-named variable declared in the binding's static `document`. On success the single root field's value is unwrapped as the output; a 200 carrying a non-empty `errors` array is still a failed call and surfaces as an http-error outcome with the server's message. A binding without a `document` (fail-closed extraction) refuses execution with a validation outcome. Auth semantics (present-forward, away/actAs, venue=mcp) are identical to route bindings.
- **Server-action bindings** dispatch in-process through the `createVendo({ serverActions })` registration map — no HTTP hop, no Next action-id. The call's args object maps onto positional arguments per the binding's `params`; the return value is projected onto the JSON wire (Dates → ISO strings). Present-only: the in-process call rides the present user's ambient request context, and because there is no HTTP seam to attach ActAs `AuthMaterial` to, away and venue="mcp" execution fail closed (`not-implemented`, no work performed). A missing or non-function registration also fails closed with a clear error.
- **Away** (`presence: "away"`): requires a captured grant (the only authority) and the host's `actAs(principal, grant)` → `AuthMaterial` attached to the request. **The away-needs-present-grant rule is normative**: away runs hold only grants captured while the user was present and bound to the running app (05 §6) — there is no other away authority. **Impersonation guard**: the runtime asserts `grant.subject === ctx.principal.subject` before invoking `actAs`; a mismatch is the error `act-as-subject-mismatch`, never a mint. `actAs` not implemented → `ToolOutcome{status:"error", code:"not-implemented"}` with agent-readable messaging ("away execution isn't set up for this product") — features degrade cleanly. `actAs` → `null` → the host declined this principal; the run fails closed (away re-verification rides this seam — no second seam, ENG-263). Shipped presets cover the first-class providers (§2.1); the long tail uses documented recipes. <!-- amended 2026-07-15: "no stack detection, no adapter framework" dropped — presets now exist (ENG-260); the disclaimer described the pre-preset world. -->
- **MCP as actAs**: `venue: "mcp"` host-call auth rides this same seam — the door never forwards its inbound bearer; it hands `actAs` the guard-attached real grant or a per-call consent projection (10-mcp §2.1). One seam, three consumers: away automations, the doctor probe, the door.
- Connector calls use the connector's own auth (Composio per-user entity, MCP per-principal or shared session — §3) but identical guard treatment; the account identity used is auditable via `detail.connectorAccount` (01 §7).
- actions itself never checks policy: it executes what a guard binding lets through (05 §2). It stamps nothing on the audit trail directly; the binding does.

## 5. Principals

`kind: "user"` everywhere, plus real `kind: "org"` principals (ENG-263): org-wide automations, admin actions, and org-shared surfaces run as an org subject (`vendo:org:<id>`), with the initiating member carried as `RunContext.actor` (01 §3). The machinery ships OSS in full (01 §2, 02 §2); **activation stays paid** — key-gated via the console's `/keys/validate` `orgs` capability (the `CAPABILITY_KEYS` set); without an entitled key, org APIs return a posture error (`cloud-required`). Host principal resolvers still mint `kind: "user"` only and may never produce `vendo:`-prefixed subjects (01 §2). <!-- amended 2026-07-15: was "OSS: user only; org is Cloud" — the block-actions spec locks full org semantics in Vendo-owned tables with key-gated activation. -->

## 6. Compound tools (normative)

A `compound` binding contains ordered steps that reuse core §11 `Step`. Its expressions see `{ args, steps, item }`, where `args` is the compound call's arguments. The compound descriptor's risk MUST equal the maximum risk of its steps after overrides are merged.

Steps reference primitive host or connector tools only: no `fn:` references, compounds, or capability tools. Execution routes every step through the guard-bound registry via the umbrella-wired `invokeTool` seam. Grants, approvals, breakers, and audit see every real call. There is no second execution path. When the seam is absent, execution returns `not-implemented` and performs no work.

Approvals are per-step in v1. A step's parked outcome becomes the compound's outcome; re-executing the same logical call resumes without re-running completed steps. Batch approval is an explicit follow-up.

## Amendments

### 2026-07-15 — Block-actions wave (ENG-260/261/262/263, parent ENG-264)

- **Changed:** §2.1 contracts the shipped `@vendoai/actions/presets` subpath — both tiers, four first-class providers plus generic JWT, away-token producer+verify halves for Clerk/Auth0 (ENG-260, landed).
- **Changed:** §4 documents the trust model that was previously silent: `VENDO_BASE_URL` gates credential forwarding with a loud structured warning, the away-needs-present-grant rule is normative, the impersonation guard (`act-as-subject-mismatch`) is asserted at the seam, doctor live-probes both paths, and the "no adapter framework" disclaimer is dropped. MCP-as-actAs is cross-referenced (10-mcp §2.1).
- **Changed:** §3 gains optional `Connector.connections` (subject-scoped connected accounts), `ConnectorAccountIdentity` audit enrichment, `McpHeadersResolver` per-principal identity, and hint-tag + curated-verb risk derivation replacing the hardcoded `write`; §3.1 contracts the `connect-required` flow and the Cloud zero-key broker posture (ENG-262, landed).
- **Changed:** §1's blast-radius note now points at the shipped dev-gated `/sync/impact` endpoint, `--strict` exit codes 2/3, and `--report` (ENG-261, landed).
- **Changed:** §5 makes org principals real with key-gated activation. **Ships with ENG-263 — merge of this amendment waits for that PR.**
- **Why:** The actions block now implements its vision beyond extraction; the frozen text described the pre-wave world. All changes are additive within the version train.
- **Authorized by:** the Yousef-approved block-actions design spec (`docs/superpowers/specs/2026-07-14-block-actions-design.md`).

### 2026-07-17 — Catalog-copy LLM seam removed (kill-list §A6)

- **Changed:** §1 drops the catalog-copy-AI seam — `proposeCatalogCopy`, `acceptCatalogProposals`, the injected `CatalogCopyGenerator` request/response types, and `vendoSync`'s `catalogCopyGenerator` knob. `vendo/catalog-proposals@1` (`CatalogProposalsFile`, `catalogProposalsFileSchema`) and the copy-fields types it depended on are gone from the format surface; `catalog.json` and the deterministic scan/registration flow it wraps are unaffected.
- **Why:** kill-list A6 — the knob had no caller; the refine engine in `vendo` owns catalog copy authoring, so this was a speculative sub-feature with zero in-repo consumers.
- **Authorized by:** the Yousef-approved simplify-v2 kill-list (`docs/superpowers/specs/2026-07-16-simplify-v2-kill-list-design.md`, §A6).
