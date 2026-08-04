# @vendoai/core — the shapes everything speaks

> **v2 re-derivation (2026-07-18): `vendo-genui/v1` is REMOVED.** The tree payload format is `vendo-genui/v2` only (JSX-wire compiled to the canonical v2 tree; see docs/superpowers/specs/2026-07-18-vendo-v2-format-spec.md). No coexistence, no migration: the v1 format tag, validator, and v1-specific edit dialects are deleted across the v2 waves. Sections below describing `vendo-genui/v1` are historical.


Status: FROZEN (wave-2 gate passed by Yousef, 2026-07-11). Changes now require a major. One job: contracts only — types, zod schemas, format constants, pure validators and hash helpers. No I/O, no behavior. Dependencies: `zod` only. Runs in any JS runtime.

Everything below is exported from the package root unless noted. Core has one additional entry point: `@vendoai/core/conformance`, which exports the contract-conformance kits and `memoryStoreAdapter` for tests. That subpath is explicitly test-infrastructure behavior and is exempt from the root's "no behavior" rule; the package root remains governed by it. Every type ships a matching zod schema (`<camelCaseName>Schema`) unless marked *type-only*.

The stable root utility surface also includes `canonicalJson`, `sha256Hex`, `safeErrorMessage`, `TOOL_NAME_PATTERN`, the `TREE_MAX_*` constants, `RESERVED_COMPONENT_NAMES`, and `PathBinding` / `StateBinding` with their guards. These are contract utilities shared by sibling blocks, not deep-import implementation details.

## 1. Formats, ids, time

```ts
export const VENDO_APP_FORMAT = "vendo/app@1";
export const VENDO_TREE_FORMAT = "vendo-genui/v1";   // pinned wire name (renaming breaks stored records)
export const VENDO_TOOLS_FORMAT = "vendo/tools@1";
export const VENDO_OVERRIDES_FORMAT = "vendo/overrides@1";
export const VENDO_CAPABILITIES_FORMAT = "vendo/capabilities@1";
export const VENDO_POLICY_FORMAT = "vendo/policy@1";

export type AppId = string;      // "app_..."
export type GrantId = string;    // "grt_..."
export type ApprovalId = string; // "apr_..."
export type RunId = string;      // "run_..."
export type ThreadId = string;   // "thr_..."
export type IsoDateTime = string; // ISO-8601 UTC
export type Json = unknown;       // JSON-serializable
export type JsonSchema = Record<string, unknown>; // JSON Schema draft 2020-12
```

## 2. Principals

Who the agent is acting as. Host-minted for users; the host resolves its own session to a principal (09 §2). `kind: "org"` is kept as a reserved principal shape — the OSS org storage layer (membership roles, minting/parsing helpers, `02 §2`'s org tables) that made it real under ENG-263 was cut under the simplify-v2 kill-list (§A5): orgs live on the Vendo-hosted side, where vendo-web already owns the full management surface (members, roles, invites, keys, usage). Whether and how v2 core re-derives org principals is an open contract decision, not settled here; until then, host principal resolvers mint `kind: "user"` only.

**Reserved subjects (normative, ENG-263):** the `vendo:` subject prefix belongs to Vendo-synthetic principals — webhook firings run as `vendo:webhook:<source>`, and the namespace remains reserved for org principals (`vendo:org:<id>`) should v2 re-derive them — and a host principal resolver returning a `vendo:`-prefixed subject is a validation error, never honored. This closes the collision between synthetic subjects and real users.

```ts
export interface Principal {
  kind: "user" | "org";      // "org": real since ENG-263 — key-gated activation, Vendo-minted only
  subject: string;           // host's stable user id — or a generated session id when anonymous
  display?: string;          // for approval UIs and audit
  ephemeral?: boolean;       // anonymous mode: session-scoped; on sign-in, threads/apps/state migrate to the real subject (02 §4) — grants/approvals never do
}
```

## 3. Run context

Attached to every tool call, guard decision, and audit event. The two axes the page names — venue (where) and presence (when) — are explicit fields.

```ts
export interface RunContext {
  principal: Principal;
  actor?: Principal;             // the human behind an org request (ENG-263): principal is the org (vendo:org:<id>), actor is the member who initiated it — audit records both
  venue: "chat" | "app" | "automation" | "mcp";   // "mcp" is live — the door (10-mcp.md)  <!-- amended 2026-07-14: MCP door landed (PR #139); original froze pre-door and read "mcp reserved for the deferred door". The value is now live in code (run-context.ts:21,32). -->

  presence: "present" | "away";
  sessionId: string;
  appId?: AppId;        // set when running inside an app
  trigger?: TriggerRef;         // set when fired by a trigger
  requestHeaders?: Record<string, string>; // present-mode: the inbound host request's auth material (04 §4)
  grant?: PermissionGrant;      // the exact grant captured by the guard binding
  mcpConsent?: { clientId: string; scopes: string[] }; // door OAuth consent evidence (10-mcp §2.1)
}

export interface TriggerRef { runId: RunId; kind: TriggerSource["kind"]; }   // the app is RunContext.appId — never duplicated here
```

`grant` and `mcpConsent` are contracted here and implemented in Wave 5. Until then, they ride through `RunContext`'s schema passthrough; the structural twins in actions and mcp remain temporary.

## 4. Tools

The one tool shape. Host API, connectors, and Vendo's own capabilities all speak it — same risk labels, same guard treatment.

```ts
export type RiskLabel = "read" | "write" | "destructive";
export const TOOL_NAME_PATTERN: RegExp; // /^[a-zA-Z0-9_-]{1,64}$/

export interface ToolDescriptor {
  name: string;                 // matches /^[a-zA-Z0-9_-]{1,64}$/ — the charset OpenAI, Anthropic, and MCP all enforce.
                                // Namespaced by underscore: "host_invoices_list", "gmail_send", "vendo_apps_create"
  description: string;
  inputSchema: JsonSchema;      // the MCP/Anthropic field name; "input" would collide with TreeQuery.input (values)
  risk: RiskLabel;
  critical?: boolean;           // always asks the running user; no grant, rule, or judge may suppress
}
// provenance is carried by the name prefix (host_*, <connector>_*, vendo_*) — no separate source field

/** Canonical descriptor fingerprint, algorithm-prefixed like every other ref in the system
 *  ("sha256:<hex>", cf. Pin.base and snapshot refs): SHA-256 over the RFC 8785 (JCS) canonicalization
 *  of { name, description, inputSchema, risk, critical }, absent optional fields omitted — so independent
 *  implementations always agree, and the algorithm can rotate without a flag-day. */
export function descriptorHash(d: ToolDescriptor): string;   // "sha256:ab12..."
export function canonicalJson(value: unknown): string;        // RFC 8785 canonical JSON
export function sha256Hex(input: string): string;              // lowercase 64-character hex

export interface ToolCall {
  id: string;                   // caller-minted, unique per call
  tool: string;
  args: Json;
}

/** A connector call needs a per-user connected account (04 §3.1). */
export interface ConnectRequired { connector: string; toolkit: string; message: string }

export type ToolOutcome =
  | { status: "ok"; output: Json }
  | { status: "error"; error: { code: string; message: string } }
  | { status: "pending-approval"; approvalId: ApprovalId }   // fail-soft: queued for the user
  | { status: "blocked"; reason: string }
  | { status: "connect-required"; connect: ConnectRequired };  // fail-soft: the UI renders an inline connect card, then retries (08 §4)

/** The executable tool surface a block hands around. */
export interface ToolRegistry {
  descriptors(): Promise<ToolDescriptor[]>;
  execute(call: ToolCall, ctx: RunContext): Promise<ToolOutcome>;
}
```

Execution discipline (normative): nothing calls `ToolRegistry.execute` directly except a guard binding (05 §2). Chat, app functions, automations, and the MCP door all reach tools through `guard.bind`.

## 5. Grants and approvals

The grant machinery the app-format spec pins ("exact or tool-wide scopes, critical tools always ask"). A grant records that this principal said yes to this kind of action within these bounds. Grants and app data belong to each user's **own app**, never to the artifact (§10); approvals never transfer between users.

```ts
export type GrantScope =
  | { kind: "tool" }                                             // the whole tool
  | { kind: "exact"; inputHash: string; inputPreview: string };  // these args only; inputHash = `sha256:${sha256Hex(canonicalJson(args))}`

export type GrantDuration = "standing" | "session" | "task";

export interface PermissionGrant {
  id: GrantId;
  subject: string;              // principal subject — grants are per-user, always
  tool: string;
  descriptorHash: string;       // drift lapses the grant
  scope: GrantScope;
  duration: GrantDuration;
  contextKey?: string;          // binds session/task grants to their context
  appId?: AppId;        // set when granted to a specific app (incl. automation pre-approval)
  source: "chat" | "batch" | "automation" | "mcp";   // mint points: ApprovalDecision.remember (chat/batch), automation enable-capture, and the door's per-call actAs authority (venue="mcp"); "mcp" grants are never persisted and never consulted by guard  <!-- amended 2026-07-14: "mcp" added — MCP door landed (PR #139), code grants.ts:74,90. -->

  grantedAt: IsoDateTime;
  expiresAt?: IsoDateTime;
  revokedAt?: IsoDateTime;
}

export interface ApprovalRequest {
  id: ApprovalId;
  call: ToolCall;
  descriptor: ToolDescriptor;   // frozen at ask time — what the user actually approved
  inputPreview: string;         // human-readable real inputs (the one-security-rule: ask with the real inputs)
  invalidatedGrant?: { id: GrantId; grantedAt: IsoDateTime };  // set when descriptor drift lapsed a grant that would have covered this call — loud, never silent (05 §2)
  ctx: { principal: Principal; venue: RunContext["venue"]; presence: RunContext["presence"]; appId?: AppId; trigger?: TriggerRef };
  createdAt: IsoDateTime;
}
// approvals queue until decided — no expiry machinery in v0

export interface ApprovalDecision {
  approve: boolean;
  remember?: { scope: GrantScope; duration: GrantDuration };  // mint a grant from this answer
}
```

The additive `source: "mcp"` member originates in 10-mcp §2.1. Its only mint point is the door's per-call consent projection; that projection is never stored and never consulted by guard.

## 6. Guard seam

The choke point interface. guard implements it (05); every other block only consumes it.

```ts
export type GuardDecision =
  | { action: "run"; decidedBy: "grant" | "rule" | "judge" | "default"; grantId?: GrantId }
  | { action: "ask"; approval: ApprovalRequest; decidedBy: "critical" | "rule" | "judge" | "breaker" | "default" }
  | { action: "block"; reason: string; decidedBy: "rule" | "judge" | "breaker" };

export interface Guard {
  check(call: ToolCall, descriptor: ToolDescriptor, ctx: RunContext): Promise<GuardDecision>;
  report(event: AuditEvent): Promise<void>;
  /** Host-written steering ("company directions") the agent folds into its system prompt. */
  directions(ctx: RunContext): Promise<string[]>;
  /** Resumption seam: whoever parked a call on `pending-approval` subscribes here; fires when the approval is decided. */
  onApprovalDecision(cb: (id: ApprovalId, approved: boolean) => void): () => void;
}
```

## 7. Audit

Every tool call, approval, and policy decision — recorded with principal + app + trigger, queryable and exportable.

```ts
export interface AuditEvent {
  id: string;                    // "aud_..."
  at: IsoDateTime;
  kind: "tool-call" | "approval" | "policy-decision" | "run" | "app-lifecycle" | "share" | "door-auth" | "principal";  // "door-auth": MCP-door OAuth/principal-mint; "principal": principal-lifecycle event — anon→signed-in migration, org membership change (ENG-263)  <!-- amended 2026-07-14: "door-auth" added — MCP door landed (PR #139), code audit.ts:12,29. -->

  principal: Principal;
  venue: RunContext["venue"];
  presence: RunContext["presence"];
  appId?: AppId;
  trigger?: TriggerRef;
  tool?: string;
  inputPreview?: string;          // human-readable, PII-conscious preview — never raw secrets
  outcome?: ToolOutcome["status"];
  decidedBy?: GuardDecision["decidedBy"];
  detail?: Json;
}
```

The additive `door-auth` event originates in 10-mcp §3 and records successful door authorization.

**Enriched `detail` (block-actions wave, normative):** `detail` stays `Json`, but five enrichments are contracted for it — exactly what guard console and insights consume (block-actions spec, cross-cutting). Connector executions carry `detail.connectorAccount: ConnectorAccountIdentity` (04 §3) — the binding lifts it off the outcome and strips it before the outcome reaches the model or UI. Grant invalidation emits a `policy-decision` event with `detail.reason: "grant-invalidated"` plus `grantIds`, `staleHash`, `currentHash` (05 §2). Present execution that forwards no credentials despite inbound auth headers emits `detail.warning: { code: "present-credentials-not-forwarded", reason, action }` once per process (04 §4). Every actAs call records its disposition as `detail.actAs` (mint / declined / subject-mismatch); org-owned executions carry `detail.org: { subject, actor }` — the org principal plus the human member behind the request (`RunContext.actor`, §3) (ENG-263).

## 8. The instant-path UI payload (format-tagged; v0 format: the tree, `vendo-genui/v1`)

The instant path renders a **format-tagged document**, not "the tree" by fiat (Yousef, 2026-07-11 round 2):

```ts
/** Any instant-path UI payload. Everything past the tag is owned by the format. */
export interface UIPayload { formatVersion: string; [key: string]: unknown }
```

Validators, renderers, and edit dialects dispatch on `formatVersion`; v0 registers exactly **one** format — the tree below. A v2, the reserved compact profile, or a future non-tree format slots in behind the tag without touching the app document shape, the wire routes, or `fn:` references. An unregistered tag is a contained failure (render a notice, never break), and a runtime keeps rendering every format it ever registered — stored records stay alive.

⚑ Lives in core (not apps) because ui renders payloads and may only import core; the page also lists "apps" among core's typed shapes. The tree wire format is **pinned** — field names and semantics below match what stored records already contain; the only v0 addition is the `fn:` reference scheme, which is additive.

```ts
export interface Tree {
  formatVersion: "vendo-genui/v1";
  root: string;                                  // node id
  nodes: TreeNode[];
  data?: Record<string, Json>;
  queries?: TreeQuery[];
  components?: Record<string, string>;           // wire-level only; lifted to the app document at rest (§9)
}

export interface TreeNode {
  id: string;
  component: string;                             // prewired primitive, host catalog name, or generated component
  source?: "prewired" | "host" | "generated";
  props?: Record<string, Json>;                  // values may be bindings (below)
  children?: string[];                           // dangling ids allowed: render as streaming skeletons
}

export interface TreeQuery {
  path: string;                                  // RFC 6901 JSON Pointer into data ("" = whole model)
  tool: string;                                  // a tool name — or an "fn:" reference (below)
  input?: Record<string, Json>;
}
```

**Prop bindings** (pinned): `{ "$path": "/invoices/0/total" }` binds a prop to the data model by JSON Pointer; `{ "$state": "draft" }` binds to client-side view state.

```ts
export interface PathBinding { $path: string; }
export interface StateBinding { $state: string; }
export function isPathBinding(value: unknown): value is PathBinding;
export function isStateBinding(value: unknown): value is StateBinding;
```

**Actions**: an interactive node dispatches a named action `{ action: string, payload? }` through the renderer's dispatch chokepoint (08 §5). The action name is a tool name or an `fn:` reference; guard checks it like any call.

**`fn:` references** (v0 addition, Yousef-approved): anywhere a tree names a callable — `TreeQuery.tool` or an action name — the form `fn:<name>` (`<name>` matching `/^[A-Za-z_][A-Za-z0-9_-]*$/`) targets a function of the app's own machine instead of a tool. Resolution: `POST /fn/<name>` on the app's server (06 §4). Trees without a machine must not contain `fn:` references (validation error).

**Limits and reserved names** (pinned): max 5000 nodes, 16 queries, 16 generated components, 64 KB per component source / 256 KB total; generated component names are PascalCase and may not shadow the prewired primitives (`Stack`, `Row`, `Grid`, `Text`, `Skeleton`, `Surface`, `Divider`).

Core deliberately does not bound the size of `Tree.data` or `TreeNode.props`. Hosts must enforce request-body limits before tree validation; the core DoS conformance test records this delegation.

```ts
export function validateTree(input: unknown): { ok: true; tree: Tree } | { ok: false; error: { code: "version" | "provision"; message: string } };
```

Named-now, designed-later (encoding commitments from the app-format spec §7): a token-compact wire profile, valid-while-partial streaming semantics, catalog-aware autofix. Reserved; not part of v0 contracts.

## 9. The app document (`vendo/app@1`)

The one artifact (app-format spec §1–2). Fields absent until grown.

```ts
export interface AppDocument {
  format: "vendo/app@1";
  id: AppId;
  name: string;
  description?: string;
  ui?: "tree" | "http";                          // the PLANE: instant/jailed vs machine-served. Default "tree"; "http" keeps the last payload as fallback/cover
  tree?: UIPayload;                              // the instant-path payload (field name spec-locked); v0 format: Omit<Tree, "components"> — components live one level up, at rest
  components?: Record<string, string>;           // name → ESM React source, compiled in ms, run in the jail
  storage?: Record<string, StorageDecl>;         // named record collections; "state" is reserved (built-in singleton)
  server?: string;                               // sandbox snapshot ref, provider-prefixed: "e2b:snap_x91"
  trigger?: Trigger;                             // set = the app is an automation
  egress?: string[];                             // domain allowlist the machine's network enforces
  secrets?: string[];                            // names of secrets injected as handles (06 §4.3)
  pins?: Pin[];
  forkedFrom?: AppId;
}

export interface StorageDecl {
  about: string;                                 // one line, human-written
  kind?: "records" | "files";                    // default "records"
  refs?: Record<string, string>;                 // field → "host.<entity>" — the ONLY typed part
}

export interface Pin {
  slot: string;                                  // host component slot name
  base: string;                                  // "sha256:..." of the host baseline the fork edits
}

export function validateAppDocument(input: unknown): { ok: true; app: AppDocument } | { ok: false; error: { code: string; message: string } };
```

`.vendoapp` export = this document plus the app's directory pulled from the snapshot (no data, no caches, no grants, no snapshots) — semantics in 06 §7.

## 10. Ownership — no installs, just apps

Every user has their own app; there is no separate install object (Yousef, 2026-07-11 round 2). The app row a user owns (store 02 §2: `subject`, `enabled` columns) IS their copy — their data and their grants key off its `AppId`. The one-security-rule anchor survives intact: sharing, publishing, and import hand over a **copy**, and the runtime always mints a **fresh `AppId`** for the recipient — an id found inside an artifact is never trusted — so artifacts and exports still carry zero authority. (Same property the app-format spec §4 words as "grants and data belong to each user's install"; one concept fewer. Provenance lives in the document itself when it matters: `forkedFrom`.)

## 11. Triggers and run models (shapes only — semantics in 07)

```ts
export type TriggerSource =
  | { kind: "schedule"; cron?: string; every?: string; at?: IsoDateTime }   // exactly one of the three
  | { kind: "host-event"; event: string }                                   // fed by vendo.emit / webhook (07 §2)
  | { kind: "external"; connector: string; event: string; config?: Json };

export type RunModel =
  | { kind: "agentic"; prompt: string; budget?: { maxToolCalls?: number } }
  | { kind: "steps"; steps: Step[] };

export interface Step {
  id: string;
  tool: string;                  // tool name or "fn:" reference
  args?: Record<string, string>; // values are JSONata expressions over { event, steps, item }
  if?: string;                   // JSONata predicate
  forEach?: string;              // JSONata expression yielding an array; binds `item`
}

export interface Trigger { on: TriggerSource; run: RunModel; }
```

## 12. Store seam

How things save. store implements it (02); blocks consume it. Collection names are opaque to the adapter; composition conventions live with the callers (06 §6).

```ts
export interface VendoRecord {
  id: string;
  data: Json;
  refs?: Record<string, string>;   // host-entity refs — queryable, joinable
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
  revision?: string;               // opaque token when RecordStore.atomic is present
}

export interface RecordQuery { refs?: Record<string, string>; ids?: string[]; limit?: number; cursor?: string; }

export interface RecordStore {
  get(id: string): Promise<VendoRecord | null>;
  put(record: Pick<VendoRecord, "id" | "data" | "refs">): Promise<VendoRecord>;
  // Optional additive capability: one compare-and-claim statement. Exact data
  // + refs match; replacement omitted means delete. Exactly one caller gets true.
  claim?(expected: Pick<VendoRecord, "id" | "data" | "refs">,
         replacement?: Pick<VendoRecord, "data" | "refs">): Promise<boolean>;
  delete(id: string): Promise<void>;
  list(q?: RecordQuery): Promise<{ records: VendoRecord[]; cursor?: string }>;
  atomic?: {
    insertIfAbsent(record: Pick<VendoRecord, "id" | "data" | "refs">): Promise<VendoRecord | null>;
    compareAndSwap(
      record: Pick<VendoRecord, "id" | "data" | "refs">,
      expectedRevision: string,
    ): Promise<VendoRecord | null>;
  };
}

export interface BlobStore {
  put(key: string, bytes: Uint8Array, meta?: { contentType?: string }): Promise<void>;
  get(key: string): Promise<{ bytes: Uint8Array; contentType?: string } | null>;
  delete(key: string): Promise<void>;
  list(prefix?: string): Promise<string[]>;
}

export interface StoreAdapter {
  records(collection: string): RecordStore;
  blobs(namespace: string): BlobStore;
  ensureSchema(): Promise<void>;
}
```

## 13. Host seams

```ts
/** Away execution — one host-implemented function (page: actions block).
 *  Returns scoped auth material for this principal within this grant, or null if the host
 *  chooses not to support this principal/tool. Not implemented at all → away features are
 *  cleanly unavailable and the agent says so. */
export type ActAs = (principal: Principal, grant: PermissionGrant) => Promise<AuthMaterial | null>;

export interface AuthMaterial { headers: Record<string, string>; }   // one channel — a bearer token is headers.Authorization; caching/expiry is the host's business

// Impersonation guard (normative, block-actions wave): the actions runtime asserts
// grant.subject === principal.subject BEFORE invoking actAs — a mismatch is the error
// "act-as-subject-mismatch", never a mint (04 §4). Away re-verification rides this seam:
// the host returning null declines the principal and the run fails closed — there is no
// second verification seam (ENG-263). Shipped implementations: @vendoai/actions/presets (04 §2.1).

/** Secret values by name. Default implementation reads env (02 §1). App code never sees values (06 §4.3). */
export interface SecretsProvider { get(name: string): Promise<string | undefined>; }

/** Agentic execution seam — how automations run an agent without importing it.
 *  agent exports an implementation (03 §1 `asRunner`); the umbrella wires it. */
export type AgentRunner = (
  task: {
    prompt: string;
    tools: ToolRegistry;
    budget?: { maxToolCalls?: number };
    abortSignal?: AbortSignal;     // additive, best-effort in-process cancellation
  },
  ctx: RunContext,
) => Promise<AgentRunReport>;

export interface AgentRunReport {
  status: "ok" | "error" | "stopped";
  summary: string;                 // model-written account of what happened
  toolCalls: Array<{ call: ToolCall; outcome: ToolOutcome["status"] }>;
}
```

## 14. Catalog and theme

```ts
/** Structural typing of the Standard Schema interface — no dependency. */
export interface StandardSchema { "~standard": { validate(value: unknown): unknown } }

export interface RegisteredComponent {
  name: string;                    // PascalCase, unique
  description: string;             // what the generator reads
  propsSchema?: StandardSchema;    // the ONE optional props schema (standard-schema; in practice zod) — the derived JSON Schema (below) maps to catalog@1 propsSchema  <!-- amended 2026-07-18: optional; propsJsonSchema removed — server-wiring DX -->
  examples?: string[];             // usage snippets shown to the generator; maps to catalog@1 examples
  remixable?: boolean;             // opt-in: source captured at sync, eligible for pins
}
// the catalog holds host registrations; prewired primitives are the fixed reserved-name set (§8), not entries

export type ComponentCatalog = ReadonlyArray<RegisteredComponent>;

/** Name-keyed registry form (2026-07-18 amendment) — the same object serves both sides:
 *  the server reads the data fields, <VendoRoot> reads the component references (08 §2).
 *  Accepted anywhere the array form is (09 §2); the composition normalizes registry →
 *  catalog entry by entry: key → `name`, `props` → `propsSchema`, `component` dropped.
 *  The array form remains valid. */
export interface ComponentRegistryEntry {
  component: unknown;              // host component reference — the SERVER MUST IGNORE this field (React types stay out of core); it exists so one object serves the client too
  description: string;             // what the generator reads
  props?: StandardSchema;          // the ONE optional props schema — named `props` here vs `propsSchema` on RegisteredComponent; same StandardSchema type, same derivation (normalized as above)
  examples?: string[];
  remixable?: boolean;
}
export type ComponentRegistry = Record<string, ComponentRegistryEntry>;   // keys are component names

/** Brand tokens. Flat map of CSS-variable-ready values; the enumerated keys are the contract. */
export interface VendoTheme {
  colors: { background: string; surface: string; text: string; muted: string; accent: string; accentText: string; danger: string; border: string };
  typography: { fontFamily: string; headingFamily?: string; baseSize: string };
  radius: { small: string; medium: string; large: string };
  density: "compact" | "comfortable";
  motion: "full" | "reduced";
}
```

**Props schemas (normative, 2026-07-18 amendment):** a component entry carries at most ONE props schema. The model-facing JSON Schema is DERIVED internally by the composition (implementation-defined; currently the AI SDK's zod conversion) — never hand-written; `propsJsonSchema` is removed from this contract, and `catalog@1`'s disk `propsSchema` field carries the derived output (04 §1). Schema-less entries are legal: name + description only — the model infers props, and generated-props validation is permissive for those entries. For schema-bearing entries the derived JSON Schema is the one document driving both the generation prompt and generated-props validation — which also closes the old disk-catalog permissive-validation gap (04 §1's former "known runtime limit"): a `propsSchema` loaded from disk validates the same way a derived one does.

## 15. Errors

```ts
export type VendoErrorCode =
  | "validation"          // malformed document / tree / call
  | "blocked"             // guard said no (away-ungranted is not an error — it's the pending-approval OUTCOME)
  | "not-implemented"     // optional seam absent (e.g. actAs)
  | "sandbox-unavailable" // no SandboxAdapter configured / machine unreachable
  | "cloud-required"      // feature is Cloud-gated and no VENDO_API_KEY
  | "not-found"
  | "conflict";

export class VendoError extends Error { code: VendoErrorCode; detail?: Json; }
export function safeErrorMessage(error: unknown): string; // never throws, including for hostile error objects
```

Forward compatibility (normative): renderers/consumers ignore unknown stream-part types and unknown `OpenSurface` kinds they don't recognize — those stay additive within the version train. Error codes, trigger kinds, and run models are **closed** enums as of the 2026-07-17 amendment (kill-list §A6): an unknown variant fails validation rather than parsing as a generic case.

## 16. Vendo stream parts

Typed `data-*` parts riding the ai-SDK UI message stream (03 §4). Live here — not in agent — because ui renders them and may only import core.

```ts
export interface VendoViewPart { type: "data-vendo-view"; appId: AppId; payload: UIPayload }                    // a rendered app surface in-thread
export interface VendoApprovalPart {
  type: "data-vendo-approval"; toolCallId: string; risk: RiskLabel; approvalId?: ApprovalId;
  invalidatedGrant?: { id: GrantId; grantedAt: IsoDateTime };   // surfaces loud grant invalidation on the approval card (05 §2)
}  // receipt/approval metadata beside native tool parts
export interface VendoConnectPart { type: "data-vendo-connect"; toolCallId: string; connector: string; toolkit: string; message: string }  // rides beside the tool part when its outcome is connect-required; the UI renders the inline connect card (08 §4)
```

## 17. Capability-miss event (`vendo/capability-miss@1`)

The embedded agent emits exactly one capability-miss event when it cannot fulfill a user ask for one of three reasons: no matching tool exists, tool use has failed repeatedly, or the agent explicitly gives up. The agent decides that a miss occurred; the umbrella composition owns persistence and optional transport so core remains shape-only and agent does not acquire filesystem or cloud dependencies.

```ts
export const VENDO_CAPABILITY_MISS_FORMAT = "vendo/capability-miss@1";

export interface CapabilityMissToolFailure {
  tool: string;
  attempt: number;                 // 1-based attempt order within this miss
  failure: { code?: string; message: string };
}

export interface CapabilityMissEvent {
  format: "vendo/capability-miss@1";
  id: string;                      // globally unique, "mis_..."
  at: IsoDateTime;
  hostId: string;                  // stable host-installation identity within its Cloud tenant
  appId?: AppId;                   // set when the ask occurred inside a Vendo app
  sessionId: string;
  threadId?: ThreadId;
  intent: string;                  // privacy-scrubbed user ask, preserving refinement intent
  surface: {
    format: "vendo/tools@1";
    hash: string;                  // sha256:<hex> of canonicalJson(parsed .vendo/tools.json)
  };
  trigger:
    | { kind: "no-matching-tool"; toolsConsidered: string[] }
    | {
        kind: "repeated-tool-failure";
        toolsConsidered: string[];
        attempts: [CapabilityMissToolFailure, CapabilityMissToolFailure, ...CapabilityMissToolFailure[]];
      }
    | { kind: "agent-give-up"; toolsConsidered: string[]; toolsAttempted: string[] };
}
```

**Normative identity:** `hostId` MUST be the `TelemetryConfig.anonymousId` returned by `@vendoai/telemetry`'s `loadConfig()` (normally persisted in `~/.vendo/telemetry.json`; no `createVendo` override exists), while Cloud MUST derive the tenant from the organization authenticated by `VENDO_API_KEY` and use `hostId` only as the host-installation identity within that tenant.

Trigger semantics are closed for `@1`:

- `no-matching-tool`: the available/searchable surface contains no tool capable of the ask; no tool attempt is implied.
- `repeated-tool-failure`: two or more failed attempts prevented fulfillment. `attempts` is ordered and carries each attempted tool name plus a scrubbed failure code/message.
- `agent-give-up`: the agent makes an explicit terminal decision that it cannot fulfill the ask, whether or not it attempted a tool. This is not a catch-all for an unclassified exception.

`surface.hash` identifies the exact extracted surface that existed at miss time; formatting-only changes do not alter it. The gap dashboard clusters by `intent` within `hostId`, resolves that surface snapshot by `(surface.format, surface.hash)`, and diffs the miss against its tools. Dashboard export and the refine feed consumed by `vendo refine` carry this same event shape unchanged.

Persistence and transport are normative:

- OSS always appends each event as one JSON object plus a newline to `.vendo/data/misses.jsonl`. This local append is not consent-gated, happens independently of upload, and remains the source of truth if upload fails.
- Cloud upload is allowed when and only when `VENDO_API_KEY` is non-empty **and** `envOptOut(env) === false`, using the exported helper in `packages/vendo-telemetry/src/consent.ts`. `envOptOut` blocks upload when `VENDO_TELEMETRY_DISABLED` or `DO_NOT_TRACK` is `"1"` or `"true"`, or when `CI` is set to any value other than `""`, `"0"`, or `"false"`. The `NODE_ENV` development/test fail-close and the persisted telemetry config's `optedOut` flag do not gate miss upload; they remain product-telemetry-only, and production upload is allowed because non-empty `VENDO_API_KEY` is the host's explicit opt-in. Otherwise no miss data leaves the machine.
- `intent` is user-authored content and may contain confidential or personal data. Emitters must remove credentials and secrets and minimize unrelated personal data while preserving the ask's intent; failure messages receive the same treatment. Events must never include raw tool arguments or outputs. Hosts must treat both the plaintext local JSONL and any Cloud copy as confidential user data.

## Amendments

### 2026-07-14 — Capability-miss event shape (ENG-253)

- **Changed:** Added the additive `vendo/capability-miss@1` persisted/wire shape, with the three locked emission triggers, exact extracted-surface identity, host/session context, and tool-attempt detail.
- **Changed:** Contracted unconditional local JSONL persistence, API-key-plus-opt-out-gated Cloud upload, privacy handling, and reuse of the same event by the gap dashboard and refine feed.
- **Why:** Miss capture needs one stable handoff between the embedded agent, OSS history, Cloud gap analysis, and `vendo refine` before ENG-253 implementation begins.
- **Approved by:** Yousef, 2026-07-14 (consent semantics ruled: key + envOptOut kill switches; production allowed).

### 2026-07-14 — MCP additions, RunContext promotion, and shipped export surface

- **Changed:** Made `PermissionGrant.source: "mcp"` and `AuditEvent.kind: "door-auth"` normative, with their origin in 10-mcp; removed the stale reservation note.
- **Changed:** Contracted optional `RunContext.grant` and `RunContext.mcpConsent` fields. They ship in Wave 5 and ride through schema passthrough until then.
- **Changed:** Documented the shipped `@vendoai/core/conformance` test-infrastructure subpath and the stable root utilities already consumed by sibling blocks, including the exact-grant input hash algorithm.
- **Changed:** Recorded that `Tree.data` and `TreeNode.props` size limits are delegated to host request-body enforcement.
- **Why:** Post-freeze MCP work and sibling usage had expanded the real surface without updating this contract, and the host-side tree size responsibility was only pinned in a test.
- **Approved by:** Yousef, 2026-07-14.

### 2026-07-14 — Atomic record claims

- **Changed:** Added optional `RecordStore.claim(expected, replacement?)` as the core seam for one-statement compare-and-replace or compare-and-delete adapters.
- **Why:** Store consumers that require single-use state need an additive capability they can require without importing the concrete store block.
- **Approved by:** Yousef, 2026-07-14.

### 2026-07-15 — Block-actions wave (ENG-260/261/262/263, parent ENG-264)

- **Changed:** `ToolOutcome` gains the additive `connect-required` variant with its `ConnectRequired` shape; `VendoConnectPart` (`data-vendo-connect`) joins the stream parts (ENG-262, landed).
- **Changed:** `ApprovalRequest` and `VendoApprovalPart` gain optional `invalidatedGrant` — descriptor-drift grant lapse is loud, never a bare re-prompt (ENG-261, landed).
- **Changed:** §7 contracts the enriched audit `detail` fields: `connectorAccount`, `reason: "grant-invalidated"`, and the `present-credentials-not-forwarded` warning (landed); org context follows with ENG-263.
- **Changed:** §13 records the impersonation guard at the actAs seam (`act-as-subject-mismatch`) and away re-verification failing closed on a null mint (ENG-260 landed; re-verification semantics ENG-263).
- **Changed:** §2 makes `kind: "org"` principals real (subjects `vendo:org:<id>`, key-gated activation, Vendo-minted only) and reserves the `vendo:` subject namespace against host resolvers; §3 adds optional `RunContext.actor` (the human member behind an org request); §7 adds `AuditEvent.kind: "principal"` (anon-migration + membership-change lifecycle events); the anonymous→signed-in migration note points at 02 §4. **Ships with ENG-263 (PR #277) — merge of this amendment waits for that PR.**
- **Why:** The block-actions project implements execute-as-the-user beyond extraction: per-user connected accounts, loud invalidation, real principals. All additive within the version train (discriminated unions, optional fields — §15).
- **Authorized by:** the Yousef-approved block-actions design spec (`docs/superpowers/specs/2026-07-14-block-actions-design.md`).

### 2026-07-17 — Cut org-subject core helpers (kill-list §A5)

- **Changed:** Removed `orgSubject`, `isOrgSubject`, `orgIdFromSubject`, `orgPrincipal`, and `ORG_SUBJECT_PREFIX` from `principal.ts` — their only consumers repo-wide were core's own tests, and every other org-related consumer (the store's org tables/helpers, the wire's org routes, the org-principal branches in guard and automations) was already cut in the same kill-list wave. §2's prose no longer claims the full org machinery "ships OSS"; it now describes `kind: "org"` as a reserved-but-inert principal shape pending a v2 contract decision.
- **Changed:** §2's normative reserved-subjects paragraph keeps the `vendo:` prefix reserved for `vendo:org:<id>` should v2 re-derive org principals, but no longer implies the minting/parsing helpers exist today.
- **Kept, deliberately:** `kind: "org"` in the `Principal` type and `principalSchema`, and the `vendo:` reserved-namespace mechanism (`RESERVED_SUBJECT_PREFIX`, `isReservedSubject`) — collision-proofing the namespace against host resolvers has a live consumer (`vendo/src/server.ts`'s principal-resolver validation) independent of whether org principals are ever re-derived; that decision is explicitly deferred to the v2 contract re-derivation, not made by this cut.
- **Why:** The org storage layer that made org principals real was a Cloud-residency mistake (data layer in OSS for a Vendo-hosted feature); removing its now-dead core-side vocabulary follows the same cut without touching the still-open principal-shape question.
- **Authorized by:** the Yousef-approved kill-list spec (`docs/superpowers/specs/2026-07-16-simplify-v2-kill-list-design.md` §A5).

### 2026-07-17 — Cut constrained grant scopes (kill-list §A4)

- **Changed:** Removed the `GrantConstraint` interface, `grantConstraintSchema`, and the `{ kind: "constrained"; constraints: GrantConstraint[] }` variant of `GrantScope`. `GrantScope` is now `{ kind: "tool" } | { kind: "exact"; inputHash; inputPreview }` only; §5's prose now describes the grant machinery as "exact or tool-wide scopes."
- **Why:** No product surface ever minted a `constrained` grant — the only mint path (`ApprovalDecision.remember`) is a caller-supplied shape guard validated but nothing in the shipped product offered a UI or code path to construct one. It carried a JSON-pointer resolver and a bespoke ReDoS guard in guard's match evaluator purely to support a scope variant with zero real callers.
- **Authorized by:** the Yousef-approved kill-list spec (`docs/superpowers/specs/2026-07-16-simplify-v2-kill-list-design.md` §A4).

### 2026-07-17 — Cut open-enum forward-compat casts (kill-list §A6)

- **Changed:** Deleted `open-enum.ts` (`openEnum`/`openKindVariant`). `vendoErrorCodeSchema` (§15) is now a plain `z.enum` of the seven named codes; `triggerSourceSchema`, `runModelSchema`, and `triggerRefSchema`'s `kind` field (§11/§3) are now plain `z.enum`/plain discriminated unions with no open tail. §15's forward-compatibility paragraph is rewritten: error codes, trigger kinds, and run models are closed enums — an unknown variant now fails validation instead of parsing as a generic/tolerated case. Stream-part types and `OpenSurface` kinds are unaffected (they never went through `open-enum.ts`) and stay additive.
- **Why:** Three call sites (`errors.ts`, `triggers.ts` ×2) carried a `z.ZodType<Value> as unknown as z.ZodType<Value>` cast to keep the TypeScript union closed while the runtime schema stayed open — solving a forward-compatibility problem the shipped product doesn't have (no external client parses these unions against an older contract version). Closing the schemas removes the casts and makes the runtime type match the static type exactly.
- **Authorized by:** the Yousef-approved kill-list spec (`docs/superpowers/specs/2026-07-16-simplify-v2-kill-list-design.md` §A6).

### 2026-07-17 — Cut dead `scanner` decidedBy member (kill-list §A6 follow-on)

- **Changed:** Removed `"scanner"` from `GuardDecision`'s `block` variant and from `AuditEvent.decidedBy`'s zod enum (§6/§7). `decidedBy` on a block decision is now `"rule" | "judge" | "breaker"`.
- **Why:** The scanner hook itself was already cut from guard (05 §5, 2026-07-17, kill-list §A6); this `decidedBy` value was the leftover vocabulary for a decision source guard has never produced (guard's decision pipeline has not called a scanner stage since commit `4b56fe5c`).
- **Authorized by:** the Yousef-approved kill-list spec (`docs/superpowers/specs/2026-07-16-simplify-v2-kill-list-design.md` §A6).

### 2026-07-18 — One props schema per component entry; name-keyed registry form (server-wiring DX)

- **Changed:** §14's `RegisteredComponent.propsSchema` becomes optional and is the entry's ONE schema (standard-schema; in practice zod); `propsJsonSchema` is removed — the model-facing JSON Schema is derived internally by the composition (implementation-defined; currently the AI SDK's zod conversion), and `catalog@1`'s disk `propsSchema` field carries that derived output (04 §1). Schema-less entries are legal (name + description only; the model infers props; validation is permissive for them).
- **Changed:** §14 adds the name-keyed `ComponentRegistry` form (`ComponentRegistryEntry`): keys are component names; each value holds `component` (a host component reference the server MUST IGNORE — it exists so the same object serves the client), `description`, optional `props` (the single schema), optional `examples`, optional `remixable`. Accepted anywhere the array form is (09 §2); the array form remains valid.
- **Why:** the server-wiring DX brainstorm (decision 2): `propsJsonSchema` was one schema hand-expressed twice, and name-keying kills the mirror-two-maps catalog discipline. Deriving one JSON Schema that drives both the prompt and generated-props validation also closes 04 §1's disk-catalog permissive-validation gap for schema-bearing entries.
- **Approved by:** Yousef, 2026-07-18 (server-wiring DX brainstorm, `docs/brainstorms/server-wiring-dx.md`, converged).
