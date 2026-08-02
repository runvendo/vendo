/** @vendoai/automations — apps that run on triggers while the user is away
 * (docs/contracts/07-automations.md).
 *
 * The package root exports exactly the 07 §1 public API.
 * Depends on core + apps only (the one chain); agentic runs go through the
 * core `AgentRunner` seam — this package never imports the agent.
 */
import type {
  AgentRunner,
  ApprovalRequest,
  AppDocument,
  AppId,
  Guard,
  IsoDateTime,
  Json,
  Principal,
  RunContext,
  RunId,
  StoreAdapter,
  ToolOutcome,
  ToolRegistry,
  TriggerSource,
} from "@vendoai/core";
import type { AppsRuntime } from "@vendoai/apps";
import { createAutomationsEngine } from "./engine.js";

/** 07 §1 — createAutomations config. */
export interface AutomationsConfig {
  apps: AppsRuntime;
  /** ALREADY guard-bound by the umbrella (05 §2). */
  tools: ToolRegistry;
  /** Core seam: run audit events + approval resumption (onApprovalDecision). */
  guard: Guard;
  store: StoreAdapter;
  /** Absent → agentic runs unavailable, steps still work. */
  runner?: AgentRunner;
  /** Testability. */
  now?: () => Date;
  /** Max automations a single tick executes concurrently (default 4). A small pool keeps
   *  one tenant's fired runs from serializing behind another's while bounding fan-out. */
  tickConcurrency?: number;
  /** Per-run wall-clock budget (ms) the tick waits before moving on. The run is NOT
   *  cancelled (there is no abort seam) — it finishes and persists its terminal state in
   *  the background; the tick just stops blocking on it so a hung run (sandbox wake, LLM
   *  stall) cannot overrun the tick interval or starve other tenants. Absent → wait fully. */
  runTimeoutMs?: number;
  /** Which of {schedule, external} this engine instance fires itself. Absent (default) →
   *  both fire locally, today's behavior. host-event is never listed here: `emit` is called
   *  directly by the host process, not scheduled or delivered, so there is nothing to defer.
   *  A composition sets this to an empty set when some OTHER authority already fires those
   *  kinds for the same data (Vendo Cloud's scheduler + Composio delivery, under the hosted
   *  store — see packages/vendo/src/server.ts) so the two never double-run one automation. */
  localTriggerKinds?: ReadonlySet<"schedule" | "external">;
}

/** 07 §5 */
export type RunStatus = "running" | "ok" | "error" | "stopped" | "pending-approval";

/** 07 §5 */
export interface RunRecord {
  id: RunId;
  appId: AppId;
  trigger: { kind: TriggerSource["kind"]; event?: string };
  status: RunStatus;
  startedAt: IsoDateTime;
  finishedAt?: IsoDateTime;
  /** Agentic runs: the report's toolCalls. */
  steps: Array<{ id: string; tool: string; outcome: ToolOutcome["status"]; at: IsoDateTime; detail?: string }>;
  /** Agentic: model-written; steps: generated. */
  summary?: string;
  error?: { code: string; message: string };
}

/** 07 §5 */
export interface RunPlan {
  steps: Array<{ id: string; tool: string; wouldAsk: boolean }>;
  grantsMissing: string[];
}

/** Additive (rehearse()) — one step row of a rehearsal firing. */
export interface RehearsalStep {
  id: string;
  tool: string;
  /** "simulated" = write/destructive risk; the guard resolved the call to its
   *  simulated card instead of executing. "skipped" = an `if` condition was
   *  false, or the step is an app function call (fn:, not rehearsed in v1). */
  status: "ok" | "simulated" | "skipped" | "blocked" | "error";
  /** The call's fully resolved arguments (JSONata evaluated against the
   *  firing's event and REAL upstream step outputs). */
  args?: Record<string, Json>;
  /** Truncated JSON preview of a real read's output. */
  preview?: string;
  /** A numeric summary of a real read's resolved output, for the timeline's
   *  single-line headline. `totalCents` sums the one numeric field every
   *  element of the output's homogeneous list shares (integer minor units —
   *  this codebase's cents convention); `breakdown` is the per-item split for
   *  the expandable detail. Derived SHAPE-first from the FULL output (before
   *  `preview` truncation), never a per-tool field name, so it stays
   *  host-agnostic; absent when the output has no single unambiguous numeric
   *  field to sum, so the row shows no number rather than an invented one. */
  result?: { totalCents: number; breakdown?: Array<{ label: string; cents: number }> };
  /** The date bounds the call carried (pinned to the firing's window when the
   *  tool accepts `from`/`to` and the step left them unset). */
  window?: { from: IsoDateTime; to: IsoDateTime };
  /** "window" = the read was date-bounded to the firing's window; "today" =
   *  the tool takes no date bounds, so the row reflects today's data. */
  evaluatedOn?: "window" | "today";
  detail?: string;
  /** For a "simulated" write step: the guard's honest verdict for what the
   *  ENABLED automation would actually do with this call (lifted from the
   *  RehearsalSimulation card). `wouldAsk` = it would still need an approval
   *  (no standing grant captured yet, a critical tool, or a policy `ask`);
   *  `grantsMissing` = the tool(s) whose standing grant is absent (mirrors
   *  RunPlan.grantsMissing); `wouldBlock` = a policy BLOCK rule would stop it
   *  outright even after enable. Absent/false ⇒ the write would simply run once
   *  live, so the card reads as a plain simulated action. */
  wouldAsk?: boolean;
  grantsMissing?: string[];
  wouldBlock?: string;
}

/** Additive (rehearse()) — one historical firing of the trigger. */
export interface RehearsalFiring {
  scheduledFor: IsoDateTime;
  /** "skipped" = every step's `if` condition was false, nothing evaluated. */
  status: "fired" | "skipped" | "error";
  /** Count of simulated write/destructive actions in this firing. */
  simulatedActions: number;
  steps: RehearsalStep[];
}

/** Additive (rehearse()) — what `POST /automations/:id/rehearse` returns. */
export interface RehearsalReport {
  appId: AppId;
  /** The resolved trailing window this report replays (07 §1 amendment):
   *  exactly 7 or 30 days. The UI renders "last N days" from this rather than
   *  tracking its own copy of what was requested. */
  windowDays: 7 | 30;
  from: IsoDateTime;
  to: IsoDateTime;
  firings: RehearsalFiring[];
  /** True when the schedule fired more often than the report keeps; the MOST
   *  RECENT firings are kept (never a silent cap). */
  truncated?: boolean;
}

/** 07 §1 */
export interface AutomationsEngine {
  /** Arm/disarm an app's trigger. Enabling runs the grant-capture flow (07 §3).
   *  `grantSetId` (additive — 07 §1 amendment parked) names the ONE grant set
   *  the `missing` asks belong to, so a single decision can settle them all;
   *  present exactly when `missing` is non-empty. */
  enable(appId: AppId, ctx: RunContext): Promise<{ enabled: boolean; missing: ApprovalRequest[]; grantSetId?: string }>;
  disable(appId: AppId, ctx: RunContext): Promise<void>;
  /** The user's apps with a trigger. `pendingGrants`/`grantSetId` (additive —
   *  07 §1 amendment parked) project the app's still-undecided standing-grant
   *  asks, so surfaces can show "waiting on N permissions" after a reload
   *  instead of trusting an enable() result held in memory. */
  list(ctx: RunContext): Promise<Array<{ app: AppDocument; enabled: boolean; pendingGrants?: number; grantSetId?: string }>>;

  // trigger ingestion — three kinds
  /** Schedules: call on a timer or from a serverless cron. */
  tick(now?: Date): Promise<RunId[]>;
  /** Convenience auto-timer around tick (long-lived hosts). */
  start(intervalMs?: number): () => void;
  /** Host product events — THE host seam (vendo.emit). */
  emit(event: string, payload: Json, principal: Principal): Promise<RunId[]>;
  /** External events (Composio/webhooks), mounted by the umbrella. */
  webhook(req: Request): Promise<Response>;

  runs: {
    get(id: RunId, ctx: RunContext): Promise<RunRecord | null>;
    list(
      filter: { appId?: AppId; status?: RunStatus; cursor?: string },
      ctx: RunContext,
    ): Promise<{ runs: RunRecord[]; cursor?: string }>;
    /** Kill switch: best-effort cancel, marks "stopped". */
    stop(id: RunId, ctx: RunContext): Promise<void>;
  };
  /** Preview: what would run, nothing executes. */
  dryRun(appId: AppId, ctx: RunContext, event?: Json): Promise<RunPlan>;
  /** Rehearsal (additive): replay the schedule's firings over a trailing
   *  window (`windowDays`, 7 or 30, defaulting to 30) through the steps
   *  executor under the guard's `rehearsal` venue — reads execute for real on
   *  the live interactive session, writes resolve to simulated cards, no
   *  grants are required and nothing persists to run history. v1: steps
   *  automations on schedule triggers only. */
  rehearse(appId: AppId, ctx: RunContext, windowDays?: 7 | 30): Promise<RehearsalReport>;
}

/** 07 §1 — the engine. */
export function createAutomations(config: AutomationsConfig): AutomationsEngine {
  return createAutomationsEngine(config);
}
