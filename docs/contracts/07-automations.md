# @vendoai/automations — apps that run while the user is away

Status: DRAFT (wave 2). One job: fire triggers and execute runs. An automation is an app with a `trigger` (core §11) — creation, editing, versioning, rollback, sharing all ride apps; this block owns trigger ingestion, scheduling, the two run models, and run observability. Depends on core + apps (the one chain). Never imports agent: agentic runs go through the `AgentRunner` seam.

## 1. Public API

```ts
import type { RunContext, InstallId, RunId, ToolSet, AgentRunner, StoreAdapter, Trigger } from "@vendoai/core";
import type { AppsRuntime } from "@vendoai/apps";

export function createAutomations(config: {
  apps: AppsRuntime;
  tools: ToolSet;                 // ALREADY guard-bound by the umbrella (05 §2)
  guard: Guard;                   // core seam: run audit events + approval resumption (onApprovalDecision)
  store: StoreAdapter;
  runner?: AgentRunner;           // absent → agentic runs unavailable, steps still work
  now?: () => Date;               // testability
}): AutomationsEngine;

export interface AutomationsEngine {
  /** Arm/disarm an installed app's trigger. Enabling runs the grant-capture flow (§3). */
  enable(installId: InstallId, ctx: RunContext): Promise<{ enabled: boolean; missing: ApprovalRequest[] }>;
  disable(installId: InstallId, ctx: RunContext): Promise<void>;
  list(ctx: RunContext): Promise<Array<{ install: InstallRecord; trigger: Trigger; enabled: boolean }>>;

  // trigger ingestion — three kinds
  tick(now?: Date): Promise<RunId[]>;                                   // schedules: call on a timer or from a serverless cron
  start(intervalMs?: number): () => void;                               // convenience auto-timer around tick (long-lived hosts)
  emit(event: string, payload: Json, principal: Principal): Promise<RunId[]>;   // host product events — THE host seam (vendo.emit)
  webhook(req: Request): Promise<Response>;                             // external events (Composio/webhooks), mounted by the umbrella

  // runs
  runs: {
    get(id: RunId, ctx: RunContext): Promise<RunRecord | null>;
    list(filter: { installId?: InstallId; status?: RunStatus; cursor?: string }, ctx: RunContext): Promise<{ runs: RunRecord[]; cursor?: string }>;
    stop(id: RunId, ctx: RunContext): Promise<void>;                    // kill switch: best-effort cancel, marks "stopped"
  };
  dryRun(installId: InstallId, event?: Json, ctx: RunContext): Promise<RunPlan>;   // preview: what would run, nothing executes
}
```

## 2. Triggers (semantics for core §11 shapes)

- **`schedule`** — exactly one of `cron` (5-field), `every` (duration: `"15m"`, `"1d"`), `at` (one-shot). Evaluated by `tick`; a missed window (host asleep) fires once on the next tick, never back-fills.
- **`host-event`** — the honest one-seam cost: the host calls `engine.emit(event, payload, principal)` in its own code path (or points a webhook at the umbrella's `/webhooks/host` route). Fires every enabled automation of that principal whose `trigger.on.event` matches.
- **`external`** — connector deliveries (Composio webhooks, plain webhooks) arrive at `webhook(req)`; `config` carries connector-specific subscription detail. Delivery → principal resolution comes from the install (an automation always runs as its installing user).

## 3. Away identity and grant capture

Away runs hold only grants captured while the user was present — the only authority (one security rule). `enable()` is the capture moment: it computes the tool surface the run model references (steps: static analysis of `steps[].tool`; agentic: the model's declared toolset = everything granted + anything already granted), previews it to the user, and the approvals minted there become grants with `source: "automation"`, `installId` bound, `duration: "standing"`. At run time every call still goes through the guard binding with `presence: "away"`: grant match → run; anything else → the call parks `pending-approval`, the step fails soft, and the run record says so. Revoking a grant silently disarms nothing — the next run simply parks and the user sees it.

## 4. Run models

**Steps** (deterministic, auditable, cheap, no LLM at runtime): sequential; each step's `args` values are JSONata expressions evaluated against `{ event, steps: { <id>: <output> }, item }`; `if` skips, `forEach` fans out binding `item`. A step's `tool` may be an `fn:` reference — delivered as `POST /fn/<name>` to the app's machine (06 §4) — or a tool name through the guard-bound set. First hard failure stops the run (`status: "error"`); a `pending-approval` outcome parks the run (`status: "waiting-approval"`) and resumes on decision (core §6 `onApprovalDecision`).

**Agentic** (fuzzy work within pre-approved grants): `runner({ prompt, tools, budget }, ctx)` with `presence: "away"` — reasoning happens, authority doesn't change: the same grants gate every call. `budget.maxToolCalls` defaults to 50.

Apps with a `server` may also receive the raw firing (`POST /trigger`, 06 §4.1) when the run model is `steps` containing an `fn:` step or when the trigger's app declares no steps at all — ⚑ v0 rule: `RunModel` is required; "just wake my machine" is expressed as a single-step `steps` pipeline calling `fn:main`.

## 5. Observability

```ts
export type RunStatus = "running" | "ok" | "error" | "stopped" | "waiting-approval";

export interface RunRecord {
  id: RunId; installId: InstallId;
  trigger: { kind: TriggerSource["kind"]; event?: string };
  status: RunStatus;
  startedAt: IsoDateTime; finishedAt?: IsoDateTime;
  steps: Array<{ id: string; tool: string; outcome: ToolOutcome["status"]; at: IsoDateTime; detail?: string }>;  // agentic runs: the report's toolCalls
  summary?: string;               // agentic: model-written; steps: generated
  error?: { code: string; message: string };
}

export interface RunPlan { steps: Array<{ id: string; tool: string; wouldAsk: boolean }>; grantsMissing: string[] }
```

Users can see, preview, and stop what runs as them: `runs.list` + `dryRun` + `runs.stop` are the OSS surface (backing ui's automations views, 08 §4). Digest emails and rate caps: deferred by the page ("details deferred") — not contracted in v0.
