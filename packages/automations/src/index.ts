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
  Membership,
  Principal,
  RiskResolver,
  RunContext,
  RunId,
  StoreAdapter,
  ToolOutcome,
  ToolRegistry,
  ToolSemantics,
  TriggerSource,
} from "@vendoai/core";
import type { AppsRuntime } from "@vendoai/apps";
import { createAutomationsEngine } from "./engine.js";

import type { AdoptionCard } from "./adoption.js";

export type { AdoptionCard, AdoptionNeed } from "./adoption.js";
export { appIntentOf, SPONSORSHIPS, type Sponsorship } from "./sponsorship.js";

/** Build contract §9.3's `can()`, as much of it as the engine needs — taken as
 *  config so this package never reaches sideways into the store. Lane G's
 *  `appAccess(store)` satisfies it as-is; absent, `can(editor)` degenerates to
 *  ownership, which is exactly the rule before app-access grants existed. */
export interface AppAccessSeam {
  can(
    ctx: RunContext,
    level: "viewer" | "editor" | "owner",
    thing: { app: AppId },
  ): Promise<boolean>;
  /** The app's grant rows. Only their COUNT is read here (the window label's
   *  wider editor set), so the row shape stays lane G's to define. */
  list?(ctx: RunContext, appId: AppId): Promise<readonly unknown[]>;
}

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
  /** W3 — the merged `.vendo` field semantics, rehearse()'s ONLY money source:
   *  no synced semantic, no `result` headline. Provider form re-reads per call. */
  semantics?: Readonly<Record<string, ToolSemantics>> | (() => Readonly<Record<string, ToolSemantics>> | undefined);
  /** The SAME per-call risk resolver the composition gave the guard. Arm-time
   *  capture grades a declared connector call with it, so the consent card
   *  states the grade the call will really run under and the grant it mints
   *  carries the descriptor hash the guard recomputes at fire time. Absent →
   *  every declared call is graded exactly as its descriptor says, which is
   *  what host tools have always done. */
  resolveRisk?: RiskResolver;
  /** Testability. */
  now?: () => Date;
  /** Max automations a single tick executes concurrently (default 4). A small pool keeps
   *  one tenant's fired runs from serializing behind another's while bounding fan-out. */
  tickConcurrency?: number;
  /** Per-run wall-clock budget (ms) the tick waits before moving on. This timeout does NOT
   *  cancel the run (only `runs.stop` aborts one) — it finishes and persists its terminal
   *  state in the background; the tick just stops blocking on it so a hung run (sandbox
   *  wake, LLM stall) cannot overrun the tick interval or starve other tenants.
   *  Absent → wait fully. */
  runTimeoutMs?: number;
  /** Which of {schedule, external} this engine instance fires itself. Absent (default) →
   *  both fire locally, today's behavior. host-event is never listed here: `emit` is called
   *  directly by the host process, not scheduled or delivered, so there is nothing to defer.
   *  A composition sets this to an empty set when some OTHER authority already fires those
   *  kinds for the same data (Vendo Cloud's scheduler + Composio delivery, under the hosted
   *  store — see packages/vendo/src/server.ts) so the two never double-run one automation. */
  localTriggerKinds?: ReadonlySet<"schedule" | "external">;
  /** Build contract §9.3 — the access seam the fire-time sponsorship check and
   *  the adoption card ask `can(editor)` through. Absent → ownership only. */
  appAccess?: AppAccessSeam;
  /** Build contract §9.1 — the SAME host org query the wire resolves per
   *  request, resolved here per fire. Keyed on Principal (never on a Request)
   *  precisely so an UNATTENDED run can call it with no session. Ridden onto
   *  the RunContext for `can()`, never persisted; unset → no orgs asserted →
   *  `can()` degenerates to ownership, which is today's behavior exactly. */
  memberships?: (principal: Principal) => Promise<Membership[]>;
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

/** What a rehearsal of this automation could actually show, resolved from the
 *  trigger plus the bound descriptors — using the SAME predicates rehearse()
 *  itself applies, so a surface can never advertise a preview the report will
 *  not contain.
 *
 *  It exists because the two useful facts are knowable WITHOUT replaying
 *  anything, and replaying to discover them is the expensive way round: a
 *  read-only automation costs a full round of real host reads to tell you
 *  there was nothing to consent to. */
export interface RehearsalOutlook {
  /** rehearse() takes schedule triggers driving a `steps` run model, and
   *  nothing else — an agentic run, or a step naming a non-`fn:` tool the guard
   *  cannot resolve, is rejected outright, so offering the action at all is a
   *  mistake when this is false. */
  supported: boolean;
  /** Steps bound to a write/destructive tool: the ones that resolve to
   *  simulated cards. ZERO is the load-bearing case — reads execute and
   *  preview, but there is no action to approve, so the report tells the user
   *  little that the automation's own description did not.
   *
   *  Steps, not actions: a `forEach` fans one step out over as many items as
   *  the read returns, and that count is only knowable by running it. */
  actingSteps: number;
  readSteps: number;
  /** Reads whose per-firing window rehearse() will actually pin: `acceptsDateBounds`
   *  AND at least one of `from`/`to` left unset by the step (a step that
   *  hard-codes BOTH bounds re-reads the same fixed range every firing, so it is
   *  not counted here). Short of readSteps, some firings re-read today's data and
   *  repeat each other rather than replaying genuinely different history. */
  historicalReads: number;
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
   *  false, a `forEach` matched no items, or the step is an app function call
   *  (fn:, not rehearsed in v1). */
  status: "ok" | "simulated" | "skipped" | "blocked" | "error";
  /** The call's fully resolved arguments (JSONata evaluated against the
   *  firing's event and REAL upstream step outputs). */
  args?: Record<string, Json>;
  /** Truncated JSON preview of a real read's output. */
  preview?: string;
  /** A numeric summary of a real read's resolved output, for the timeline's
   *  single-line headline. `totalCents` sums the one MONEY field every element
   *  of the output's homogeneous list shares, always in integer minor units (a
   *  `money.dollars` field is scaled on the way in); `breakdown` is the
   *  per-item split for the expandable detail. Derived SHAPE-first from the
   *  FULL output (before `preview` truncation); the money field is named by the
   *  host's synced `semantics` and nothing else, so this stays host-agnostic.
   *  Absent when the output has no single unambiguous money field — including
   *  every tool the host has not synced semantics for — so the row shows no
   *  number rather than an invented one. */
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
  /** "skipped" = no tool call ran for this firing: e.g. every step's `if` was
   *  false, a `forEach` matched no items, or every step was an `fn:` app call. */
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
  list(ctx: RunContext): Promise<Array<{
    app: AppDocument;
    enabled: boolean;
    pendingGrants?: number;
    grantSetId?: string;
    rehearsal?: RehearsalOutlook;
    /** §13 — who the automation runs as, for its window label ("runs with
     *  Dana's access"). `display` rides the sponsorship row, captured from the
     *  sponsor's own Principal when they took the automation on, so it reads the
     *  same for everyone: Vendo still holds no directory and invents no name. */
    sponsor?: { subject: string; display?: string };
    /** §9.9 — set exactly while the automation is STOPPED and waiting to be
     *  adopted. `summary` is the same consumer sentence the adoption card and
     *  the stopped run row carry, so the list is a route back to a paused
     *  automation instead of the one place it vanished from (E8-F2). It never
     *  names the sponsor: this string is read by anyone who can edit the app. */
    stopped?: { reason: "edit" | "departure" | "grants"; summary: string };
    /** How many principals hold a grant on the app, when an access seam is
     *  configured — the "wider editor set" the label names when one exists. */
    editors?: number;
  }>>;

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

  /** Build contract §9.9 — the apps runtime's `onDocumentEdit` hook, from this
   *  side: an edit by anyone other than the sponsor invalidates sponsorship;
   *  the sponsor's own edit re-binds the intent instead. */
  onDocumentEdit(previous: AppDocument, next: AppDocument, editor: string): Promise<void>;

  /** Build contract §9.9 — the adoption card as additive venue state on the
   *  app's open payload. `undefined` when nothing is waiting or the caller
   *  cannot edit the app: nothing is pushed, the card waits IN the app.
   *
   *  THE COMPOSITION CONTRACT, stated here because two packages have to agree on
   *  it: the card rides the open payload under the key **`adoption`** —
   *  `payload.adoption` — which is exactly what `@vendoai/ui`'s tree renderer
   *  reads (`ADOPTION_VENUE_KEY` in `chrome/adoption-card.tsx`, asserted by its
   *  own test). The venue-state provider the apps runtime calls is therefore:
   *
   *  ```ts
   *  async (app, ctx) => {
   *    const card = await automations.adoption(app.id, ctx);
   *    return card === undefined ? undefined : { adoption: card };
   *  }
   *  ```
   *
   *  Any other key attaches a card nobody ever sees. */
  adoption(appId: AppId, ctx: RunContext): Promise<AdoptionCard | undefined>;

  /** Take a stopped automation on: approve its reads and writes as YOURSELF
   *  (approvals stay strictly self-subject) and become its sponsor. The first
   *  editor+ to complete wins; the loser hears `already-adopted`. */
  adopt(appId: AppId, ctx: RunContext): Promise<{
    adopted: boolean;
    missing: ApprovalRequest[];
    grantSetId?: string;
    reason?: "already-adopted";
  }>;
}

/** 07 §1 — the engine. */
export function createAutomations(config: AutomationsConfig): AutomationsEngine {
  return createAutomationsEngine(config);
}
