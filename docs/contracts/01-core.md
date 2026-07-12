# @vendoai/core — the shapes everything speaks

Status: FROZEN (wave-2 gate passed by Yousef, 2026-07-11). Changes now require a major. One job: contracts only — types, zod schemas, format constants, pure validators and hash helpers. No I/O, no behavior. Dependencies: `zod` only. Runs in any JS runtime.

Everything below is exported from the package root (single entry point). Every type ships a matching zod schema (`<camelCaseName>Schema`) unless marked *type-only*.

## 1. Formats, ids, time

```ts
export const VENDO_APP_FORMAT = "vendo/app@1";
export const VENDO_TREE_FORMAT = "vendo-genui/v1";   // pinned wire name (renaming breaks stored records)
export const VENDO_TOOLS_FORMAT = "vendo/tools@1";
export const VENDO_OVERRIDES_FORMAT = "vendo/overrides@1";
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

Who the agent is acting as. Host-minted; the host resolves its own session to a principal (09 §2). `kind: "org"` is reserved for Cloud.

```ts
export interface Principal {
  kind: "user";              // "org" reserved (Cloud)
  subject: string;           // host's stable user id — or a generated session id when anonymous
  display?: string;          // for approval UIs and audit
  ephemeral?: boolean;       // anonymous mode: session-scoped, nothing persists past the session
}
```

## 3. Run context

Attached to every tool call, guard decision, and audit event. The two axes the page names — venue (where) and presence (when) — are explicit fields.

```ts
export interface RunContext {
  principal: Principal;
  venue: "chat" | "app" | "automation" | "mcp";   // mcp reserved for the deferred door
  presence: "present" | "away";
  sessionId: string;
  appId?: AppId;        // set when running inside an app
  trigger?: TriggerRef;         // set when fired by a trigger
  requestHeaders?: Record<string, string>; // present-mode: the inbound host request's auth material (04 §4)
}

export interface TriggerRef { runId: RunId; kind: TriggerSource["kind"]; }   // the app is RunContext.appId — never duplicated here
```

## 4. Tools

The one tool shape. Host API, connectors, and Vendo's own capabilities all speak it — same risk labels, same guard treatment.

```ts
export type RiskLabel = "read" | "write" | "destructive";

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

export interface ToolCall {
  id: string;                   // caller-minted, unique per call
  tool: string;
  args: Json;
}

export type ToolOutcome =
  | { status: "ok"; output: Json }
  | { status: "error"; error: { code: string; message: string } }
  | { status: "pending-approval"; approvalId: ApprovalId }   // fail-soft: queued for the user
  | { status: "blocked"; reason: string };

/** The executable tool surface a block hands around. */
export interface ToolRegistry {
  descriptors(): Promise<ToolDescriptor[]>;
  execute(call: ToolCall, ctx: RunContext): Promise<ToolOutcome>;
}
```

Execution discipline (normative): nothing calls `ToolRegistry.execute` directly except a guard binding (05 §2). Chat, app functions, automations, and the future MCP door all reach tools through `guard.bind`.

## 5. Grants and approvals

The grant machinery the app-format spec pins ("exact or constrained scopes, critical tools always ask"). A grant records that this principal said yes to this kind of action within these bounds. Grants and app data belong to each user's **own app**, never to the artifact (§10); approvals never transfer between users.

```ts
export interface GrantConstraint { path: string; op: "eq" | "lte" | "gte" | "matches"; value: string | number | boolean; }

export type GrantScope =
  | { kind: "tool" }                                             // the whole tool
  | { kind: "exact"; inputHash: string; inputPreview: string }   // these args only
  | { kind: "constrained"; constraints: GrantConstraint[] };     // bounded args

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
  source: "chat" | "batch" | "automation";   // the only mint points: ApprovalDecision.remember (chat/batch) and automation enable-capture
  grantedAt: IsoDateTime;
  expiresAt?: IsoDateTime;
  revokedAt?: IsoDateTime;
}

export interface ApprovalRequest {
  id: ApprovalId;
  call: ToolCall;
  descriptor: ToolDescriptor;   // frozen at ask time — what the user actually approved
  inputPreview: string;         // human-readable real inputs (the one-security-rule: ask with the real inputs)
  ctx: { principal: Principal; venue: RunContext["venue"]; presence: RunContext["presence"]; appId?: AppId; trigger?: TriggerRef };
  createdAt: IsoDateTime;
}
// approvals queue until decided — no expiry machinery in v0

export interface ApprovalDecision {
  approve: boolean;
  remember?: { scope: GrantScope; duration: GrantDuration };  // mint a grant from this answer
}
```

## 6. Guard seam

The choke point interface. guard implements it (05); every other block only consumes it.

```ts
export type GuardDecision =
  | { action: "run"; decidedBy: "grant" | "rule" | "judge" | "default"; grantId?: GrantId }
  | { action: "ask"; approval: ApprovalRequest; decidedBy: "critical" | "rule" | "judge" | "breaker" | "default" }
  | { action: "block"; reason: string; decidedBy: "rule" | "judge" | "scanner" | "breaker" };

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
  kind: "tool-call" | "approval" | "policy-decision" | "run" | "app-lifecycle" | "share";
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

**Actions**: an interactive node dispatches a named action `{ action: string, payload? }` through the renderer's dispatch chokepoint (08 §5). The action name is a tool name or an `fn:` reference; guard checks it like any call.

**`fn:` references** (v0 addition, Yousef-approved): anywhere a tree names a callable — `TreeQuery.tool` or an action name — the form `fn:<name>` (`<name>` matching `/^[A-Za-z_][A-Za-z0-9_-]*$/`) targets a function of the app's own machine instead of a tool. Resolution: `POST /fn/<name>` on the app's server (06 §4). Trees without a machine must not contain `fn:` references (validation error).

**Limits and reserved names** (pinned): max 5000 nodes, 16 queries, 16 generated components, 64 KB per component source / 256 KB total; generated component names are PascalCase and may not shadow the prewired primitives (`Stack`, `Row`, `Grid`, `Text`, `Skeleton`, `Surface`, `Divider`).

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
}

export interface RecordQuery { refs?: Record<string, string>; ids?: string[]; limit?: number; cursor?: string; }

export interface RecordStore {
  get(id: string): Promise<VendoRecord | null>;
  put(record: Pick<VendoRecord, "id" | "data" | "refs">): Promise<VendoRecord>;
  delete(id: string): Promise<void>;
  list(q?: RecordQuery): Promise<{ records: VendoRecord[]; cursor?: string }>;
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

/** Secret values by name. Default implementation reads env (02 §1). App code never sees values (06 §4.3). */
export interface SecretsProvider { get(name: string): Promise<string | undefined>; }

/** Agentic execution seam — how automations run an agent without importing it.
 *  agent exports an implementation (03 §1 `asRunner`); the umbrella wires it. */
export type AgentRunner = (
  task: { prompt: string; tools: ToolRegistry; budget?: { maxToolCalls?: number } },
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
  propsSchema: StandardSchema;     // type-only (not zod-serializable)
  remixable?: boolean;             // opt-in: source captured at sync, eligible for pins
}
// the catalog holds host registrations; prewired primitives are the fixed reserved-name set (§8), not entries

export type ComponentCatalog = ReadonlyArray<RegisteredComponent>;

/** Brand tokens. Flat map of CSS-variable-ready values; the enumerated keys are the contract. */
export interface VendoTheme {
  colors: { background: string; surface: string; text: string; muted: string; accent: string; accentText: string; danger: string; border: string };
  typography: { fontFamily: string; headingFamily?: string; baseSize: string };
  radius: { small: string; medium: string; large: string };
  density: "compact" | "comfortable";
  motion: "full" | "reduced";
}
```

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
```

Forward compatibility (normative): clients treat an unknown error code as a generic error, and renderers/consumers ignore unknown stream-part types, unknown `OpenSurface` kinds, and unknown discriminated-union variants they don't recognize — new codes, parts, trigger kinds, and run models are additive within the version train.

## 16. Vendo stream parts

Typed `data-*` parts riding the ai-SDK UI message stream (03 §4). Live here — not in agent — because ui renders them and may only import core.

```ts
export interface VendoViewPart { type: "data-vendo-view"; appId: AppId; payload: UIPayload }                    // a rendered app surface in-thread
export interface VendoApprovalPart { type: "data-vendo-approval"; toolCallId: string; risk: RiskLabel; approvalId?: ApprovalId }  // receipt/approval metadata beside native tool parts
```
