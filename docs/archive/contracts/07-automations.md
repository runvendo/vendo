# @vendoai/automations — apps that run while the user is away

Status: FROZEN (wave-2 gate passed by Yousef, 2026-07-11). Changes now require a major. One job: fire triggers and execute runs. An automation is an app with a `trigger` (core §11) — creation, editing, versioning, rollback, sharing all ride apps; this block owns trigger ingestion, scheduling, the two run models, and run observability. Depends on core + apps (the one chain). Never imports agent: agentic runs go through the `AgentRunner` seam.

## 1. Public API

```ts
import type {
  RunContext, AppId, AppDocument, RunId, ToolRegistry, ToolOutcome, AgentRunner, StoreAdapter,
  Guard, Trigger, TriggerSource, ApprovalRequest, Principal, Json, IsoDateTime,
} from "@vendoai/core";
import type { AppsRuntime } from "@vendoai/apps";

export function createAutomations(config: {
  apps: AppsRuntime;
  tools: ToolRegistry;                 // ALREADY guard-bound by the umbrella (05 §2)
  guard: Guard;                   // core seam: run audit events + approval resumption (onApprovalDecision)
  store: StoreAdapter;
  runner?: AgentRunner;           // absent → agentic runs unavailable, steps still work
  now?: () => Date;               // testability
}): AutomationsEngine;

export interface AutomationsEngine {
  /** Arm/disarm an app's trigger. Enabling runs the grant-capture flow (§3). */
  enable(appId: AppId, ctx: RunContext): Promise<{ enabled: boolean; missing: ApprovalRequest[] }>;
  disable(appId: AppId, ctx: RunContext): Promise<void>;
  list(ctx: RunContext): Promise<Array<{ app: AppDocument; enabled: boolean }>>;   // the user's apps with a trigger

  // trigger ingestion — three kinds
  tick(now?: Date): Promise<RunId[]>;                                   // schedules: call on a timer or from a serverless cron
  start(intervalMs?: number): () => void;                               // convenience auto-timer around tick (long-lived hosts)
  emit(event: string, payload: Json, principal: Principal): Promise<RunId[]>;   // host product events — THE host seam (vendo.emit)
  webhook(req: Request): Promise<Response>;                             // external events (Composio/webhooks), mounted by the umbrella

  // runs
  runs: {
    get(id: RunId, ctx: RunContext): Promise<RunRecord | null>;
    list(filter: { appId?: AppId; status?: RunStatus; cursor?: string }, ctx: RunContext): Promise<{ runs: RunRecord[]; cursor?: string }>;
    stop(id: RunId, ctx: RunContext): Promise<void>;                    // kill switch: best-effort cancel, marks "stopped"
  };
  dryRun(appId: AppId, ctx: RunContext, event?: Json): Promise<RunPlan>;   // preview: what would run, nothing executes
  rehearse(appId: AppId, ctx: RunContext, windowDays?: 7 | 30): Promise<RehearsalReport>;   // preview: replay the schedule's firings over a trailing window (7 or 30 days, default 30) under the guard's rehearsal venue (05-guard §2); nothing persists to run history
}
```

`rehearse()` (additive, v1): enumerates the schedule trigger's would-have-fired instants over the trailing window (`windowDays`, 7 or 30, defaulting to 30 — see the 2026-08-02 amendment; the wire route clamps out-of-range values) (croner, UTC — the same clock `tick` uses), anchoring `every` cadences at the window end since a disabled automation has no enable cursor, and replays each firing's steps through the guard's `rehearsal` venue (05-guard §2) — reads execute for real, writes resolve to simulated cards. The report caps at the 62 most recent firings with an explicit `truncated` flag; a truncated report still windows its first kept firing against the discarded firing immediately before it, not the report's start. A step whose input schema declares string `from`/`to` params and leaves them unset gets those pinned to the firing's window (previous firing → this firing; the very first firing, with no earlier fire time, falls back to the report's window start); a boundless read is labeled `evaluatedOn: "today"`. Nothing persists to run history. v1 scope: schedule triggers and the `steps` run model only — agentic runs and `fn:` app-function steps are not rehearsed.

## 2. Triggers (semantics for core §11 shapes)

- **`schedule`** — exactly one of `cron` (5-field, evaluated in UTC), `every` (duration: `"15m"`, `"1d"`), `at` (one-shot). Evaluated by `tick`; a missed window (host asleep) fires once on the next tick, never back-fills.
- **`host-event`** — the honest one-seam cost: the host calls `engine.emit(event, payload, principal)` in its own code path (or points a webhook at the umbrella's `/webhooks/host` route). Fires every enabled automation of that principal whose `trigger.on.event` matches.
- **`external`** — connector deliveries (Composio webhooks, plain webhooks) arrive at `webhook(req)`; `config` carries connector-specific subscription detail, including its verification material (the connector's own signature scheme, or the HMAC secret minted at enable — signing rules in 09 §3). Unverified deliveries are rejected before any dispatch; deliveries are deduped by delivery id so at-least-once retries never double-fire. Delivery → principal resolution comes from the app row (an automation always runs as its owner).

Additive implementation note: when `store.records(...).atomic` is available, schedule cursor advances use revision CAS and webhook/resume delivery claims use atomic insert-if-absent. Multiple engine instances therefore do not double-fire those races. Adapters without the optional capability retain the original single-instance read/put fallback.

## 3. Away identity and grant capture

Away runs hold only grants captured while the user was present **and bound to this app** — the only authority (one security rule: grants belong to each user's own app). `enable()` is the capture moment: it computes the tool surface the run model references (steps: static analysis of `steps[].tool`; agentic: the tools the prompt plausibly needs, model-proposed and shown to the user), previews it with scopes, and the approvals minted there become grants with `source: "automation"`, `appId` = this app, `duration: "standing"`. At run time every call goes through the guard binding with `presence: "away"`, and **only grants whose `appId` matches this app can authorize it** — a standing grant the user minted in chat, or for another automation, never transfers. Anything unauthorized parks `pending-approval`, the step fails soft, and the run record says so; approvals decided from a parked run mint app-bound grants the same way. Revoking a grant silently disarms nothing — the next run simply parks and the user sees it.

## 4. Run models

**Steps** (deterministic, auditable, cheap, no LLM at runtime): sequential; each step's `args` values are JSONata expressions evaluated against `{ event, steps: { <id>: <output> }, item }`; `if` skips, `forEach` fans out binding `item`. A step's `tool` may be an `fn:` reference — delivered as `POST /fn/<name>` to the app's machine (06 §4) — or a tool name through the guard-bound set. First hard failure stops the run (`status: "error"`); a `pending-approval` outcome parks the run (`status: "pending-approval"`) and resumes on decision (core §6 `onApprovalDecision`).

**Agentic** (fuzzy work within pre-approved grants): `runner({ prompt, tools, budget }, ctx)` with `presence: "away"` — reasoning happens, authority doesn't change: the same grants gate every call. `budget.maxToolCalls` defaults to 50.

The engine supplies the additive runner-task `abortSignal` and keeps one controller per in-process agentic run. `runs.stop()` aborts that generation and persists `"stopped"`, not `"error"`; a stop issued by another process remains best-effort through the persisted terminal-row discard path.

The machine is reached only through the `fn:` steps the run model declares — there is no separate trigger endpoint (06 §4.1). ⚑ v0 rule: `RunModel` is required; "just wake my machine" is a single-step `steps` pipeline calling `fn:main` with the event as its args.

## 5. Observability

```ts
export type RunStatus = "running" | "ok" | "error" | "stopped" | "pending-approval";

export interface RunRecord {
  id: RunId; appId: AppId;
  trigger: { kind: TriggerSource["kind"]; event?: string };
  status: RunStatus;
  startedAt: IsoDateTime; finishedAt?: IsoDateTime;
  steps: Array<{ id: string; tool: string; outcome: ToolOutcome["status"]; at: IsoDateTime; detail?: string }>;  // agentic runs: the report's toolCalls
  summary?: string;               // agentic: model-written; steps: generated
  error?: { code: string; message: string };
}

export interface RunPlan { steps: Array<{ id: string; tool: string; wouldAsk: boolean }>; grantsMissing: string[] }
```

Users can see, preview, and stop what runs as them: `runs.list` + `dryRun` + `rehearse` + `runs.stop` are the OSS surface (backing ui's automations views, 08 §4). Digest emails and rate caps: deferred by the page ("details deferred") — not contracted in v0.

## Amendments

### 2026-07-17 — Org-owned automations removed

- **Changed:** the run models' (§4) `runContext` no longer branches on `isOrgSubject(subject)`; every run's principal is `{ kind: "user", subject }`. Org-owned automations (org principal, admin approval) never shipped a store/wire surface in OSS and are gone.
- **Why:** simplify-v2 kill-list A5 — orgs are a Vendo-Cloud-side feature; the OSS repo keeps no org-principal code paths.
- **Authorized by:** the Yousef-approved simplify-v2 kill-list (`docs/superpowers/specs/2026-07-16-simplify-v2-kill-list-design.md`, §A5).

### 2026-08-01 — Automation Rehearsal v1 (`rehearse()`)

- **Changed:** §1 adds `rehearse(appId, ctx): Promise<RehearsalReport>` beside `dryRun`: a trailing-7-day replay of a schedule trigger's would-have-fired instants through the guard's rehearsal venue (05-guard §2), reads live and writes simulated, capped at the 62 most recent firings (explicit `truncated` flag, preceding-firing windowing), with `from`/`to` read params pinned per firing and nothing persisted to run history. v1: schedule triggers and the `steps` run model only.
- **Why:** the approved Automation Rehearsal v1 pitch — one click previews a standing automation's real effect before the user arms it, closing the trust cliff of enabling with no preview.
- **Approved by:** Ayush Amawate (@Ayush2k02).

### 2026-08-02 — Rehearsal window selectable (7 / 30 days, 30-day default)

- **Changed:** `rehearse` gains a trailing-window parameter — `rehearse(appId, ctx, windowDays?: 7 | 30)` — replacing the fixed 7-day constant; omitting it defaults to **30 days**. `RehearsalReport` gains `windowDays: 7 | 30` (the resolved window) so surfaces render "last N days" from the report itself. The wire route `POST /automations/:id/rehearse` accepts `windowDays` in the request body and clamps it server-side to `{7, 30}`, defaulting to 30 for anything else (an out-of-range value falls back, never errors or passes through raw).
- **Why:** 30 days is the more useful default preview horizon for most schedules, but a 7-day view stays one click away; making the window a report field lets the UI put the choice in the results panel after the first rehearsal rather than on the trigger. Supersedes the fixed "trailing 7 days" of the 2026-08-01 v1 entry above (kept as historical record).
- **Approved by:** Ayush Amawate (@Ayush2k02).

### 2026-08-02 — Rehearsal review fixes: honest write verdicts, money-only headlines, rehearse throttle

- **Changed:** three refinements to `rehearse()`, none altering its "reads live, writes simulated, nothing persisted, schedule + `steps` only" contract. (1) A simulated write card now carries the **enabled automation's would-be decision**: `RehearsalSimulation` (01-core §4) gains `wouldAsk` / `grantsMissing` / `wouldBlock`, resolved through the guard's policy pipeline under the automation's own run context (venue `automation`, presence `away`, with the 05 §6 away downgrade applied) — never executing, parking an approval, or spending a grant — mirroring `dryRun`'s `grantsMissing` shape. `RehearsalStep` threads them, so a write that would actually be blocked (no standing away grant yet, a critical tool, or a policy `block`) reads "would have been blocked — missing grant: X" instead of a clean "would have done this" card. (2) The list-read headline (`RehearsalStep.result`) now sums only a conventionally-money field name (a small allowlist covering the demos' `x-vendo-formats: cents` fields plus common cents synonyms), never "whichever numeric field the rows happen to share", so a plain `count` no longer renders as a dollar amount. (3) `rehearse()` is throttled server-side: a short in-memory cooldown (3 seconds) keyed per subject + app + window rejects a repeat replay in quick succession with a `conflict` (HTTP 409), bounding the up-to-62×steps real host reads a click burst / second tab / reload could otherwise fan out; keyed by window so a legitimate 7/30-day toggle is never rejected.
- **Why:** a code review found the simulated card looked clean even for a write the live automation would block, a raw count could display as money ($1.20 for `count: 120`), and nothing bounded repeated Rehearse clicks (the UI's in-flight disable is client-only and resets on reload). Captain: "fix all of these." Additive to the 2026-08-01 v1 and 2026-08-02 window-selectable entries above (kept as historical record).
- **Approved by:** Ayush Amawate (@Ayush2k02).
