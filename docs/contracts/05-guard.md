# @vendoai/guard — policy, approvals, audit, safety

Status: FROZEN (wave-2 gate passed by Yousef, 2026-07-11). Changes now require a major. One job: the deterministic policy core at one choke point that binds every path equally — chat, apps, automations, and the future MCP door. Owns approvals, grants, the audit trail, Vendo Auto (the LLM judge), deterministic breakers, the scanner hook, and company directions. Depends on core only (judge takes an ai-SDK `LanguageModel` as config, type-imported).

## 1. Public API

```ts
import type {
  Guard, GuardDecision, ToolRegistry, ToolCall, ToolDescriptor, StoreAdapter, RunContext, Principal, RiskLabel,
  AuditEvent, PermissionGrant, GrantId, ApprovalRequest, ApprovalDecision, ApprovalId, AppId, IsoDateTime,
} from "@vendoai/core";
import type { LanguageModel } from "ai";

export function createGuard(config: {
  store: StoreAdapter;
  policy?: PolicyConfig;                   // data file + optional code escape hatch; absent → default posture
  judge?: Judge;                           // Vendo Auto; absent → rules/defaults only
  breakers?: { maxCallsPerMinute?: number; maxWritesPerRun?: number };   // defaults: 60, 20
  scanners?: Scanner[];
}): VendoGuard;

export interface VendoGuard extends Guard {
  bind(tools: ToolRegistry): ToolRegistry;           // THE choke point (see §2)

  approvals: {
    pending(principal: Principal): Promise<ApprovalRequest[]>;
    decide(ids: ApprovalId | ApprovalId[], decision: ApprovalDecision, principal: Principal): Promise<void>;  // arrays = batch approvals
  };
  // resumption is the core seam: Guard.onApprovalDecision (core §6) — implemented here, consumed by agent/apps/automations

  grants: {
    list(principal: Principal): Promise<PermissionGrant[]>;
    revoke(id: GrantId, principal: Principal): Promise<void>;
  };

  audit: {
    query(filter: { principal?: Principal; appId?: AppId; kind?: AuditEvent["kind"]; from?: IsoDateTime; to?: IsoDateTime; cursor?: string; limit?: number }): Promise<{ events: AuditEvent[]; cursor?: string }>;
    export(filter?: { from?: IsoDateTime; to?: IsoDateTime }): AsyncIterable<string>;   // NDJSON lines, SIEM-friendly
  };
  // user-facing "what has the agent done as me" = query({ principal }) self-scoped at the wire route (09 §3) — not a second method

  status(): { posture: "unconfigured" | "rules" | "judge" | "rules+judge" };  // "unconfigured" backs the loud no-policy notice (08 §6)
}
```

## 2. The choke point: `guard.bind(tools)` ⚑

The one sanctioned path from a `ToolRegistry` to execution. `bind` wraps every `execute` with: decide → (maybe park) → execute → report. The report step performs audit enrichment (block-actions wave): a connector execution's `ConnectorAccountIdentity` passthrough (04 §3) is lifted into the audit event's `detail.connectorAccount` and **stripped from the outcome** — the model and UI never see it; the SIEM export does. Chat (03), app function/tool proxying (06 §4), automation steps (07 §4), and the future MCP door all receive **bound** tool sets from the umbrella; nothing else in the system calls `ToolRegistry.execute`. This is how "binds every path equally" is made structural instead of aspirational.

Decision pipeline (normative order):

1. **Critical** — `descriptor.critical` → `ask`, unsuppressible by grant, rule, or judge.
2. **Scanners (input)** — a `block` finding blocks with the finding recorded.
3. **Grant match** — an unrevoked, unexpired grant with matching `descriptorHash` and scope → `run`. `session`/`task` grants match only when their `contextKey` equals the current `ctx.sessionId` (task grants: the task's id) — that binding is what the durations mean. Grants never match across subjects: `grant.subject === ctx.principal.subject` is asserted here and again at the actAs seam (04 §4). **Loud invalidation (ENG-261):** when descriptor drift is the only reason a grant fails to match, the resulting `ask` is never silent — the `ApprovalRequest` (and its stream part) carries `invalidatedGrant` (01 §5), and one `policy-decision` audit event fires with `detail: { reason: "grant-invalidated", grantIds, tool, staleHash, currentHash }`.
4. **Policy rules** — first matching rule in the data file → its action.
5. **Code escape hatch** — if configured, may override with a decision or pass.
6. **Judge** — if configured, decides `run | ask | block` with rationale. Judge errors/timeouts fail closed to `ask`.
7. **Default posture** — auto-run + audit everything (+ the loud "no policy" notice via `status()`).

Breakers wrap the pipeline: exceeding `maxCallsPerMinute` (per principal) or `maxWritesPerRun` (per run, `write`+`destructive` calls) turns would-be `run` into `ask` until the window clears. Deterministic, always on, the backstop under the judge.

`ask` semantics by presence: present → interactive approval (the agent turn pauses); away → the call parks as `pending-approval`, the step fails soft, the approval queues for the user's return. An approval with `remember` mints a grant (source `"chat"` or `"batch"`), scoped per `ApprovalDecision`.

## 3. Policy — data file + code escape hatch

Deploy-only in OSS (ships with the host's code); console hot-edit is Cloud.

### `.vendo/policy.json`

```jsonc
{
  "format": "vendo/policy@1",
  "directions": [ "Never advise on tax matters; refer to an accountant." ],
  "rules": [
    { "match": { "tool": "host_invoices_delete" },              "action": "ask" },
    { "match": { "risk": "destructive" },                        "action": "ask" },
    { "match": { "tool": "gmail_*", "presence": "away" },        "action": "ask", "note": "no unattended email" },
    { "match": { "venue": "mcp" },                               "action": "block" },
    { "match": { "risk": "read" },                               "action": "run" }
  ]
}
```

```ts
export interface PolicyRule { match: { tool?: string /* glob */; risk?: RiskLabel; venue?: RunContext["venue"]; presence?: RunContext["presence"] }; action: "run" | "ask" | "block"; note?: string; }
export type PolicyConfig = { file?: string /* default ".vendo/policy.json" */; rules?: PolicyRule[]; directions?: string[]; code?: PolicyFn };
// directions are policy data — one channel (the file, or inline here), no merge rule
export type PolicyFn = (call: ToolCall, descriptor: ToolDescriptor, ctx: RunContext) => GuardDecision | undefined;  // undefined = pass to next stage
```

First-match-wins; no match falls through to the judge/default. ⚑ The dialect is deliberately minimal for v0; Invariant-Guardrails-style semantics are the study target for v1, not reinvented here.

## 4. Vendo Auto — the judge

```ts
export interface Judge {
  decide(input: {
    call: ToolCall; descriptor: ToolDescriptor; ctx: RunContext;
    recent: AuditEvent[];            // the run's recent activity — context for volume/pattern judgment
    directions: string[];
  }): Promise<{ action: "run" | "ask" | "block"; rationale: string }>;
}

/** The shipped judge: any ai-SDK model — Claude, local Llama Guard, anything. BYO model; safety is never paywalled. */
export function vendoAutoJudge(config: { model: LanguageModel; instructions?: string }): Judge;
```

The judge decides contextually instead of static rules or per-call prompts; rationale lands in the audit event (`decidedBy: "judge"`). Deterministic breakers and the critical tier stay above it — the judge can never unlock what they lock.

## 5. Scanner hook — integrate, don't rebuild

```ts
export interface Scanner {
  name: string;
  on: "input" | "output";
  scan(payload: { text: string; call?: ToolCall; ctx: RunContext }): Promise<{ verdict: "ok" | "flag" | "block"; findings?: string[] }>;
}
```

Adapter surface for LLM Guard-style content scanners (prompt injection on inputs, PII on outputs). `flag` records an audit event and continues; `block` stops the call/response. Zero scanners ship in-box.

## 6. One-security-rule consequences (restated as guard requirements)

- An approval shows the **real inputs** (`inputPreview`) at the moment of the call — a shared app's hidden or dormant calls can do nothing without the running user seeing them.
- Approvals and grants never transfer between users; grants key off `(subject, tool)` plus optional `appId` — never artifact contents (import mints fresh app ids, core §10).
- Away runs hold only grants captured while the user was present **and bound to the running app** (`appId` match, 07 §3); chat-minted grants never authorize away execution. Everything else parks as `pending-approval`.
- Artifacts and exports carry zero authority; there is no tools/permissions field anywhere in the app format.

## Amendments

### 2026-07-15 — Block-actions wave (ENG-261/262, parent ENG-264)

- **Changed:** §2 contracts loud grant invalidation — descriptor-drift lapse attaches `invalidatedGrant` to the `ApprovalRequest` and emits a `policy-decision` audit event with `detail.reason: "grant-invalidated"` (ENG-261, landed) — and makes the cross-subject grant assertion explicit.
- **Changed:** §2 contracts connector-account audit enrichment: `detail.connectorAccount` lifted at report time and stripped from the outcome (ENG-262, landed).
- **Why:** Silent re-prompts hid policy-relevant drift, and guard console/insights need connector identity on every connector execution.
- **Authorized by:** the Yousef-approved block-actions design spec (`docs/superpowers/specs/2026-07-14-block-actions-design.md`).
