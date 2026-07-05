/**
 * AutomationEngineStore — ENG-188's refinement of the FROZEN core Store seam
 * (@flowlet/core `AutomationStore`, contracts freeze 2026-07-02).
 *
 * Alignment rules:
 *  - The frozen surface (save/get/list/recordRun/listRuns, Principal scoping,
 *    store-owned identity + timestamps, coarse statuses) is inherited, never
 *    redefined. `save()` remains callable with an opaque spec — it validates
 *    against the DSL and delegates to `create()`.
 *  - Engine semantics are ADDITIVE: versions + grants, trigger envelopes with
 *    deterministic firing ids, counters, pending approvals. Richer run states
 *    refine the frozen coarse union via `outcome` (waiting_approval = running,
 *    skipped = succeeded, cancelled = failed); `disabled_error` is the frozen
 *    "paused" plus `disabledReason`.
 *
 * Retention (Yousef ruling 2026-07-01): retain EVERYTHING in v1 — no pruning.
 * Rows stay sane via per-step output truncation. Real retention policy is a
 * deliberate TODO for the cloud phase.
 */
import type {
  AutomationRecord as CoreAutomationRecord,
  AutomationRun as CoreAutomationRun,
  AutomationStore as CoreAutomationStore,
  Principal,
} from "@flowlet/core";
import { automationSpecSchema, type AutomationSpec } from "./schema";

/** Per-step output cap: truncate + flag + record full size (never delete runs). */
export const MAX_STEP_OUTPUT_BYTES = 32_768;
/** Trigger payload cap inside a stored run. */
export const MAX_TRIGGER_PAYLOAD_BYTES = 32_768;

/** Additive refinement of the frozen coarse run status. */
export type RunOutcome = "skipped" | "cancelled" | "waiting_approval";

export type StepStatus =
  | "succeeded"
  | "failed"
  | "skipped"
  | "simulated"
  | "waiting_approval"
  | "parked"; // ENG-193 §4.6: an ungranted/critical gated tool inside a
              // for_each or agent step — the run continues, this one waits.

export type TriggerKind = "schedule" | "host_event" | "composio";

/** Every firing arrives wrapped in this envelope (spec amendment 3). */
export interface TriggerEnvelope {
  /** Producer identity: "poller", "cron", "host", "composio", "test", … */
  source: string;
  /** Producer-supplied id (transaction id, delivery id, cron tick) — dedup key. */
  eventId: string;
  /** The owning subject; fan-out never crosses users. */
  subject: string;
  occurredAt: string;
  payload: unknown;
}

/** A scope-hashed pre-authorization grant (version metadata, never DSL). */
export interface AutomationGrant {
  tool: string;
  /** Hash of the tool descriptor at grant time; drift invalidates the grant. */
  descriptorHash: string;
  /** Hash over trigger + guard + the granting step's input mapping. */
  scopeHash: string;
  grantedAt: string;
}

export interface AutomationVersion {
  automationId: string;
  version: number;
  spec: AutomationSpec;
  dslVersion: number;
  /** Published manifest the spec was compiled against; null until ENG-197/198. */
  manifestHash: string | null;
  grants: AutomationGrant[];
  createdBy: "compiler" | "user_edit";
  createdAt: string;
}

export interface AutomationCounters {
  totalRuns: number;
  totalFailures: number;
  /** Drives the runner's disable threshold; a success resets it. */
  consecutiveFailures: number;
  lastRunAt: string | null;
  lastStatus: string | null;
}

/** Engine record: extends the frozen core record; status union stays frozen. */
export interface AutomationRecord extends CoreAutomationRecord {
  spec: AutomationSpec;
  tenantId: string;
  subject: string;
  currentVersion: number;
  triggerKind: TriggerKind;
  /** host event name or Composio trigger slug; null for schedules. */
  triggerKey: string | null;
  counters: AutomationCounters;
  /** Why a paused automation was parked by the system, if it was. */
  disabledReason?: "consecutive_failures" | "completed_one_shot";
  createdFromThreadId?: string | null;
}

export interface StepRecord {
  id: string;
  status: StepStatus;
  startedAt: string;
  finishedAt?: string;
  output?: unknown;
  /** True when the stored output was cut at MAX_STEP_OUTPUT_BYTES. */
  outputTruncated?: boolean;
  /** Full pre-truncation size in bytes, recorded when truncated. */
  outputBytes?: number;
  error?: string;
  attempts?: number;
  /** Human-readable annotation for a non-obvious "skipped" (review
   *  follow-up) — e.g. a sibling skipped because it depended on a step
   *  parked earlier in the SAME for_each iteration. Additive/optional; a
   *  plain guard-false skip leaves it unset. */
  note?: string;
  /** Deterministic: `<run id>/<step id>/<attempt>`. */
  idempotencyKey: string;
}

export interface PendingApproval {
  stepId: string;
  tool: string;
  inputHash?: string;
  requestedAt: string;
  expiresAt: string;
  /** Opaque interpreter checkpoint; resume replays nothing. */
  checkpoint: unknown;
}

/** Engine run: frozen coarse status + additive `outcome` refinement. */
export interface AutomationRun extends CoreAutomationRun {
  outcome?: RunOutcome;
  version: number;
  manifestHash: string | null;
  tenantId: string;
  subject: string;
  trigger: TriggerEnvelope;
  steps: StepRecord[];
  pendingApproval?: PendingApproval;
  isTest: boolean;
  /** ENG-193 §4.6 — count of ParkedAction rows this run's execute() calls
   *  have created (cumulative across resumes). Stamped by the runner in the
   *  SAME call that persists the drafts — see plan deviation #7. */
  parkedCount: number;
}

/** ENG-193 §4.6 — an action a for_each iteration or agent step couldn't run
 *  unattended, parked instead of failing the run. Resolved standalone, later,
 *  by `AutomationRunner.resolveParkedAction` (runner.ts) — never by re-running
 *  the interpreter. */
export type ParkedActionReason = "ungranted" | "critical";
/** Parked actions expire after the SAME 7-day TTL as `PendingApproval`
 *  (interpreter.ts `PENDING_APPROVAL_TTL_MS`) — week-old frozen intent is
 *  never executable. Swept lazily by `listParkedActions` (every surface reads
 *  through list), stamped `resolution: "expired"`. */
export const PARKED_ACTION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export type ParkedActionResolution = "approved" | "declined" | "expired";

export interface ParkedAction {
  id: string;
  tenantId: string;
  subject: string;
  automationId: string;
  runId: string;
  /** The step id, or "agent" for the top-level agentic-mode block. */
  stepId: string;
  tool: string;
  /** Resolved (evaluated) input at park time — FROZEN, never re-resolved. */
  input: unknown;
  /** True when `input` was cut at MAX_STEP_OUTPUT_BYTES (mirrors StepRecord). */
  inputTruncated?: boolean;
  inputBytes?: number;
  /** The step's own `if`, when it had one — reserved for the resolve-time
   *  guard re-check (ENG-193 §4.6/§8.7, "deviation #2" v1 semantics). */
  guardExpr?: string;
  /** Loop bindings in scope when this action parked (as-name -> item, plus
   *  `index`, plus any enclosing loop's own bindings) — the ONLY per-run
   *  context a guard re-check can use without reconstructing full step
   *  history (deviation #2). Absent for a non-looped agent-step park. */
  guardBindings?: Record<string, unknown>;
  reason: ParkedActionReason;
  tier: "act" | "critical";
  /** Stamped at park time; resolve-time drift forces a re-ask (spec §8.8). */
  descriptorHash: string;
  requestedAt: string;
  resolvedAt?: string;
  resolution?: ParkedActionResolution;
  /** True when an existing guard was NOT re-checked at resolve time because
   *  it referenced other steps' outputs (deviation #2) — the WaitingList/
   *  ceremony copy surfaces this ("reviewed Xh after the run"). */
  guardStale?: boolean;
}

export interface CreateParkedActionInput {
  automationId: string;
  runId: string;
  stepId: string;
  tool: string;
  input: unknown;
  guardExpr?: string;
  guardBindings?: Record<string, unknown>;
  reason: ParkedActionReason;
  tier: "act" | "critical";
  descriptorHash: string;
  requestedAt: string;
}

export interface ListParkedActionsFilter {
  automationId?: string;
  runId?: string;
  unresolvedOnly?: boolean;
}

/** Deterministic run identity: redelivered events become duplicate-key no-ops. */
export function firingRunId(automationId: string, source: string, eventId: string): string {
  return `${automationId}::${source}::${eventId}`;
}

export class DuplicateRunError extends Error {
  constructor(runId: string) {
    super(`run "${runId}" already exists — duplicate firing dropped`);
    this.name = "DuplicateRunError";
  }
}

export interface CreateAutomationInput {
  spec: AutomationSpec;
  /** Display name; defaults to spec.name (the frozen save() supplies its own). */
  name?: string;
  grants: AutomationGrant[];
  manifestHash?: string | null;
  createdFromThreadId?: string | null;
  createdBy?: "compiler" | "user_edit";
}

export interface UpdateAutomationInput {
  spec: AutomationSpec;
  /** Grants never carry across versions; every update supplies fresh ones. */
  grants: AutomationGrant[];
  manifestHash?: string | null;
  createdBy: "compiler" | "user_edit";
}

export interface CreateRunInput {
  automation: AutomationRecord;
  version: number;
  envelope: TriggerEnvelope;
  isTest: boolean;
}

/** Exactly one of `status` (succeeded|failed) or a refining `outcome`. */
export interface FinalizeRunInput {
  status?: Extract<CoreAutomationRun["status"], "succeeded" | "failed">;
  outcome?: RunOutcome;
  steps?: StepRecord[];
  error?: string;
  /** ENG-193 §4.6 — additive patch to the run's parkedCount (plan deviation #7). */
  parkedCount?: number;
}

/**
 * The engine seam: the frozen core surface plus ENG-188 semantics. The cloud
 * Postgres implementation (ENG-198) lands behind this same interface.
 */
export interface AutomationEngineStore extends CoreAutomationStore {
  get(scope: Principal, id: string): Promise<AutomationRecord | undefined>;
  list(scope: Principal): Promise<AutomationRecord[]>;
  listRuns(scope: Principal, automationId: string): Promise<AutomationRun[]>;

  create(
    scope: Principal,
    input: CreateAutomationInput,
  ): Promise<{ automation: AutomationRecord; version: AutomationVersion }>;
  update(
    scope: Principal,
    id: string,
    input: UpdateAutomationInput,
  ): Promise<{ automation: AutomationRecord; version: AutomationVersion }>;
  getVersion(
    scope: Principal,
    id: string,
    version: number,
  ): Promise<AutomationVersion | undefined>;
  setStatus(
    scope: Principal,
    id: string,
    status: CoreAutomationRecord["status"],
    opts?: { disabledReason?: AutomationRecord["disabledReason"] },
  ): Promise<void>;
  delete(scope: Principal, id: string): Promise<void>;
  findEnabledByTrigger(
    scope: Principal,
    lookup: { kind: TriggerKind; key: string | null },
  ): Promise<AutomationRecord[]>;

  createRun(scope: Principal, input: CreateRunInput): Promise<AutomationRun>;
  updateRun(
    scope: Principal,
    id: string,
    patch: Partial<Pick<AutomationRun, "outcome" | "steps" | "pendingApproval" | "error" | "parkedCount">>,
  ): Promise<AutomationRun>;
  finalizeRun(scope: Principal, id: string, input: FinalizeRunInput): Promise<AutomationRun>;
  getRun(scope: Principal, id: string): Promise<AutomationRun | undefined>;
  /** Atomically take the pending approval off a run. Exactly one caller wins.
   *  Implementations must preserve the invariant that `pendingApproval` exists
   *  only on runs whose outcome is `waiting_approval` — the claim is the sole
   *  authority the runner's resume path checks. */
  claimPendingApproval(scope: Principal, runId: string): Promise<PendingApproval | undefined>;
  /** waiting_approval runs are cancelled on pause/edit/delete (amendment 7). */
  cancelPendingRuns(scope: Principal, automationId: string): Promise<void>;

  createParkedAction(scope: Principal, input: CreateParkedActionInput): Promise<ParkedAction>;
  listParkedActions(scope: Principal, filter: ListParkedActionsFilter): Promise<ParkedAction[]>;
  getParkedAction(scope: Principal, id: string): Promise<ParkedAction | undefined>;
  resolveParkedAction(
    scope: Principal,
    id: string,
    resolution: ParkedActionResolution,
    resolvedAt: string,
  ): Promise<ParkedAction>;

  /** Cross-scope listing used ONLY for boot rehydration of the scheduler. */
  listEnabledSchedules(): Promise<
    Array<{
      automationId: string;
      trigger: Extract<AutomationSpec["trigger"], { type: "schedule" }>;
      principal: Principal;
    }>
  >;
}

/** Exported so durable ports derive the trigger index identically. */
export function triggerIndex(spec: AutomationSpec): { kind: TriggerKind; key: string | null } {
  const t = spec.trigger;
  if (t.type === "schedule") return { kind: "schedule", key: null };
  if (t.type === "host_event") return { kind: "host_event", key: t.event };
  return { kind: "composio", key: t.trigger };
}

function jsonBytes(value: unknown): number {
  const text = JSON.stringify(value);
  return text === undefined ? 0 : text.length;
}

/** Truncate an arbitrary JSON value to fit the cap, keeping it inspectable. */
function truncateValue(value: unknown, cap: number): unknown {
  const text = JSON.stringify(value);
  if (text === undefined || text.length <= cap) return value;
  return { truncatedPreview: text.slice(0, cap) };
}

/** Exported so durable ports (e.g. DrizzleAutomationStore) reuse truncation
 *  semantics verbatim instead of forking them. */
export function capStep(step: StepRecord): StepRecord {
  if (step.output === undefined) return step;
  const bytes = jsonBytes(step.output);
  if (bytes <= MAX_STEP_OUTPUT_BYTES) return step;
  return {
    ...step,
    output: truncateValue(step.output, MAX_STEP_OUTPUT_BYTES),
    outputTruncated: true,
    outputBytes: bytes,
  };
}

export function capEnvelope(envelope: TriggerEnvelope): TriggerEnvelope {
  if (jsonBytes(envelope.payload) <= MAX_TRIGGER_PAYLOAD_BYTES) return envelope;
  return { ...envelope, payload: truncateValue(envelope.payload, MAX_TRIGGER_PAYLOAD_BYTES) };
}

function capParkedInput(input: unknown): { input: unknown; truncated?: boolean; bytes?: number } {
  const bytes = jsonBytes(input);
  if (bytes <= MAX_STEP_OUTPUT_BYTES) return { input };
  return { input: truncateValue(input, MAX_STEP_OUTPUT_BYTES), truncated: true, bytes };
}

/** Coarse status for an engine outcome (the frozen union stays exhaustive).
 *  Exported so durable ports reuse the exact mapping. */
export function coarseStatus(input: FinalizeRunInput): CoreAutomationRun["status"] {
  if (input.outcome === "skipped") return "succeeded";
  if (input.outcome === "cancelled") return "failed";
  if (input.outcome === "waiting_approval") return "running";
  return input.status ?? "succeeded";
}

function scopeKey(scope: Principal): string {
  return `${scope.tenantId}::${scope.subject}`;
}

/** In-memory implementation: the embedded seam slot and the test double. */
export class InMemoryAutomationStore implements AutomationEngineStore {
  private automations = new Map<string, AutomationRecord>();
  private versions = new Map<string, AutomationVersion>();
  private runs = new Map<string, AutomationRun>();
  private parkedActions = new Map<string, ParkedAction>();
  private idCounter = 0;
  private parkedIdCounter = 0;
  private readonly clock: () => string;

  constructor(opts: { now?: () => string } = {}) {
    this.clock = opts.now ?? (() => new Date().toISOString());
  }

  private versionKey(id: string, version: number): string {
    return `${id}::v${version}`;
  }

  private owned(scope: Principal, record: AutomationRecord | undefined): AutomationRecord | undefined {
    if (!record) return undefined;
    return scopeKey(scope) === `${record.tenantId}::${record.subject}` ? record : undefined;
  }

  // ---- frozen core surface -------------------------------------------------

  async save(
    scope: Principal,
    automation: Omit<CoreAutomationRecord, "id" | "createdAt" | "updatedAt">,
  ): Promise<AutomationRecord> {
    // The core-facing entry point: spec arrives opaque, the DSL validates it.
    const spec = automationSpecSchema.parse(automation.spec);
    const { automation: record } = await this.create(scope, {
      spec,
      name: automation.name,
      grants: [],
    });
    if (automation.status === "paused") await this.setStatus(scope, record.id, "paused");
    return (await this.get(scope, record.id))!;
  }

  async get(scope: Principal, id: string): Promise<AutomationRecord | undefined> {
    return this.owned(scope, this.automations.get(id));
  }

  async list(scope: Principal): Promise<AutomationRecord[]> {
    return [...this.automations.values()].filter((a) => this.owned(scope, a) !== undefined);
  }

  async recordRun(scope: Principal, run: CoreAutomationRun): Promise<void> {
    // Core-shaped upsert: merge onto the engine row when it exists AND the
    // caller owns it. Run ids are globally unique, so an existing id owned by
    // another principal can neither be merged (cross-scope write) nor
    // re-inserted (id collision): it's a no-op. Durable ports
    // (DrizzleAutomationStore) pin the same semantics.
    const existing = this.runs.get(run.id);
    if (existing) {
      if (existing.tenantId !== scope.tenantId || existing.subject !== scope.subject) return;
      this.runs.set(run.id, { ...existing, ...run });
      return;
    }
    this.runs.set(run.id, {
      ...run,
      version: 0,
      manifestHash: null,
      tenantId: scope.tenantId,
      subject: scope.subject,
      trigger: {
        source: "external",
        eventId: run.id,
        subject: scope.subject,
        occurredAt: run.startedAt,
        payload: undefined,
      },
      steps: [],
      isTest: false,
      parkedCount: 0,
    });
  }

  async listRuns(scope: Principal, automationId: string): Promise<AutomationRun[]> {
    return [...this.runs.values()].filter(
      (r) => r.automationId === automationId && r.tenantId === scope.tenantId && r.subject === scope.subject,
    );
  }

  // ---- engine surface ------------------------------------------------------

  async create(
    scope: Principal,
    input: CreateAutomationInput,
  ): Promise<{ automation: AutomationRecord; version: AutomationVersion }> {
    const id = `auto-${++this.idCounter}`;
    const now = this.clock();
    const { kind, key } = triggerIndex(input.spec);
    const automation: AutomationRecord = {
      id,
      name: input.name ?? input.spec.name,
      status: "enabled",
      spec: input.spec,
      tenantId: scope.tenantId,
      subject: scope.subject,
      currentVersion: 1,
      triggerKind: kind,
      triggerKey: key,
      counters: {
        totalRuns: 0,
        totalFailures: 0,
        consecutiveFailures: 0,
        lastRunAt: null,
        lastStatus: null,
      },
      createdFromThreadId: input.createdFromThreadId ?? null,
      createdAt: now,
      updatedAt: now,
    };
    const version: AutomationVersion = {
      automationId: id,
      version: 1,
      spec: input.spec,
      dslVersion: input.spec.dslVersion,
      manifestHash: input.manifestHash ?? null,
      grants: input.grants,
      createdBy: input.createdBy ?? "compiler",
      createdAt: now,
    };
    this.automations.set(id, automation);
    this.versions.set(this.versionKey(id, 1), version);
    return { automation, version };
  }

  async update(
    scope: Principal,
    id: string,
    input: UpdateAutomationInput,
  ): Promise<{ automation: AutomationRecord; version: AutomationVersion }> {
    const automation = this.mustGet(scope, id);
    const now = this.clock();
    const nextVersion = automation.currentVersion + 1;
    const { kind, key } = triggerIndex(input.spec);
    const version: AutomationVersion = {
      automationId: id,
      version: nextVersion,
      spec: input.spec,
      dslVersion: input.spec.dslVersion,
      manifestHash: input.manifestHash ?? null,
      grants: input.grants,
      createdBy: input.createdBy,
      createdAt: now,
    };
    const updated: AutomationRecord = {
      ...automation,
      name: input.spec.name,
      spec: input.spec,
      currentVersion: nextVersion,
      triggerKind: kind,
      triggerKey: key,
      updatedAt: now,
    };
    this.versions.set(this.versionKey(id, nextVersion), version);
    this.automations.set(id, updated);
    return { automation: updated, version };
  }

  async getVersion(
    scope: Principal,
    id: string,
    version: number,
  ): Promise<AutomationVersion | undefined> {
    if (!this.owned(scope, this.automations.get(id))) return undefined;
    return this.versions.get(this.versionKey(id, version));
  }

  async setStatus(
    scope: Principal,
    id: string,
    status: CoreAutomationRecord["status"],
    opts?: { disabledReason?: AutomationRecord["disabledReason"] },
  ): Promise<void> {
    const automation = this.mustGet(scope, id);
    const next: AutomationRecord = {
      ...automation,
      status,
      updatedAt: this.clock(),
    };
    if (opts?.disabledReason !== undefined) next.disabledReason = opts.disabledReason;
    else delete next.disabledReason;
    this.automations.set(id, next);
  }

  async delete(scope: Principal, id: string): Promise<void> {
    if (this.owned(scope, this.automations.get(id))) this.automations.delete(id);
  }

  async findEnabledByTrigger(
    scope: Principal,
    lookup: { kind: TriggerKind; key: string | null },
  ): Promise<AutomationRecord[]> {
    return (await this.list(scope)).filter(
      (a) => a.status === "enabled" && a.triggerKind === lookup.kind && a.triggerKey === lookup.key,
    );
  }

  async createRun(scope: Principal, input: CreateRunInput): Promise<AutomationRun> {
    const id = firingRunId(input.automation.id, input.envelope.source, input.envelope.eventId);
    if (this.runs.has(id)) throw new DuplicateRunError(id);
    const versionRow = this.versions.get(this.versionKey(input.automation.id, input.version));
    const run: AutomationRun = {
      id,
      automationId: input.automation.id,
      version: input.version,
      manifestHash: versionRow?.manifestHash ?? null,
      tenantId: scope.tenantId,
      subject: scope.subject,
      status: "running",
      trigger: capEnvelope(input.envelope),
      steps: [],
      isTest: input.isTest,
      startedAt: this.clock(),
      parkedCount: 0,
    };
    this.runs.set(id, run);
    return run;
  }

  async updateRun(
    scope: Principal,
    id: string,
    patch: Partial<Pick<AutomationRun, "outcome" | "steps" | "pendingApproval" | "error" | "parkedCount">>,
  ): Promise<AutomationRun> {
    const run = this.mustGetRun(scope, id);
    const next: AutomationRun = {
      ...run,
      ...patch,
      status: patch.outcome === "waiting_approval" ? "running" : run.status,
      steps: patch.steps ? patch.steps.map(capStep) : run.steps,
    };
    this.runs.set(id, next);
    return next;
  }

  async finalizeRun(scope: Principal, id: string, input: FinalizeRunInput): Promise<AutomationRun> {
    const run = this.mustGetRun(scope, id);
    const now = this.clock();
    const status = coarseStatus(input);
    // Skipped runs stay compact: no steps array is stored for them.
    const steps = input.outcome === "skipped" ? [] : (input.steps ?? run.steps).map(capStep);
    const finalized: AutomationRun = {
      ...run,
      status,
      outcome: input.outcome,
      steps,
      error: input.error,
      finishedAt: now,
      parkedCount: input.parkedCount ?? run.parkedCount,
    };
    delete finalized.pendingApproval;
    this.runs.set(id, finalized);

    const automation = this.automations.get(run.automationId);
    if (automation) {
      // Only clean successes and real failures move the streak; refined
      // outcomes (skipped/cancelled) never count as failures.
      const failed = status === "failed" && input.outcome === undefined;
      const succeeded = status === "succeeded" && input.outcome === undefined;
      const counters: AutomationCounters = {
        totalRuns: automation.counters.totalRuns + 1,
        totalFailures: automation.counters.totalFailures + (failed ? 1 : 0),
        consecutiveFailures: failed
          ? automation.counters.consecutiveFailures + 1
          : succeeded
            ? 0
            : automation.counters.consecutiveFailures,
        lastRunAt: now,
        lastStatus: input.outcome ?? status,
      };
      this.automations.set(automation.id, { ...automation, counters, updatedAt: now });
    }
    return finalized;
  }

  async getRun(scope: Principal, id: string): Promise<AutomationRun | undefined> {
    const run = this.runs.get(id);
    if (!run) return undefined;
    return run.tenantId === scope.tenantId && run.subject === scope.subject ? run : undefined;
  }

  async claimPendingApproval(scope: Principal, runId: string): Promise<PendingApproval | undefined> {
    // mustGetRun's scoping, but wrong scope / missing run loses the claim
    // instead of throwing — callers treat both as "nothing to resume".
    const run = this.runs.get(runId);
    if (!run || run.tenantId !== scope.tenantId || run.subject !== scope.subject) return undefined;
    if (!run.pendingApproval) return undefined;
    const claimed = { ...run.pendingApproval };
    const next: AutomationRun = { ...run };
    delete next.pendingApproval;
    this.runs.set(runId, next);
    return claimed;
  }

  async cancelPendingRuns(scope: Principal, automationId: string): Promise<void> {
    for (const run of this.runs.values()) {
      if (
        run.automationId === automationId &&
        run.tenantId === scope.tenantId &&
        run.subject === scope.subject &&
        run.outcome === "waiting_approval"
      ) {
        const cancelled: AutomationRun = {
          ...run,
          status: "failed",
          outcome: "cancelled",
          finishedAt: this.clock(),
        };
        delete cancelled.pendingApproval;
        this.runs.set(run.id, cancelled);
      }
    }
  }

  async createParkedAction(scope: Principal, input: CreateParkedActionInput): Promise<ParkedAction> {
    const id = `parked-${++this.parkedIdCounter}`;
    const { input: cappedInput, truncated, bytes } = capParkedInput(input.input);
    const action: ParkedAction = {
      id,
      tenantId: scope.tenantId,
      subject: scope.subject,
      automationId: input.automationId,
      runId: input.runId,
      stepId: input.stepId,
      tool: input.tool,
      input: cappedInput,
      ...(truncated ? { inputTruncated: true, inputBytes: bytes } : {}),
      ...(input.guardExpr !== undefined ? { guardExpr: input.guardExpr } : {}),
      ...(input.guardBindings !== undefined ? { guardBindings: input.guardBindings } : {}),
      reason: input.reason,
      tier: input.tier,
      descriptorHash: input.descriptorHash,
      requestedAt: input.requestedAt,
    };
    this.parkedActions.set(id, action);
    return action;
  }

  async listParkedActions(scope: Principal, filter: ListParkedActionsFilter): Promise<ParkedAction[]> {
    // Lazy expiry sweep (review follow-up): stale parked intent must never
    // surface as approvable — 7-day TTL matching PendingApproval's.
    const nowMs = Date.parse(this.clock());
    for (const [id, action] of this.parkedActions) {
      if (
        action.resolution === undefined &&
        Date.parse(action.requestedAt) + PARKED_ACTION_TTL_MS <= nowMs
      ) {
        this.parkedActions.set(id, { ...action, resolution: "expired", resolvedAt: this.clock() });
      }
    }
    return [...this.parkedActions.values()].filter(
      (a) =>
        a.tenantId === scope.tenantId &&
        a.subject === scope.subject &&
        (filter.automationId === undefined || a.automationId === filter.automationId) &&
        (filter.runId === undefined || a.runId === filter.runId) &&
        (filter.unresolvedOnly !== true || a.resolution === undefined),
    );
  }

  async getParkedAction(scope: Principal, id: string): Promise<ParkedAction | undefined> {
    const action = this.parkedActions.get(id);
    if (!action || action.tenantId !== scope.tenantId || action.subject !== scope.subject) return undefined;
    return action;
  }

  async resolveParkedAction(
    scope: Principal,
    id: string,
    resolution: ParkedActionResolution,
    resolvedAt: string,
  ): Promise<ParkedAction> {
    const action = await this.getParkedAction(scope, id);
    if (!action) throw new Error(`parked action "${id}" not found`);
    if (action.resolution !== undefined) {
      throw new Error(`parked action "${id}" is already resolved (${action.resolution})`);
    }
    const next: ParkedAction = { ...action, resolution, resolvedAt };
    this.parkedActions.set(id, next);
    return next;
  }

  async listEnabledSchedules(): Promise<
    Array<{
      automationId: string;
      trigger: Extract<AutomationSpec["trigger"], { type: "schedule" }>;
      principal: Principal;
    }>
  > {
    const entries: Array<{
      automationId: string;
      trigger: Extract<AutomationSpec["trigger"], { type: "schedule" }>;
      principal: Principal;
    }> = [];
    for (const a of this.automations.values()) {
      if (a.status !== "enabled" || a.spec.trigger.type !== "schedule") continue;
      entries.push({
        automationId: a.id,
        trigger: a.spec.trigger,
        principal: { tenantId: a.tenantId, subject: a.subject },
      });
    }
    return entries;
  }

  private mustGet(scope: Principal, id: string): AutomationRecord {
    const automation = this.owned(scope, this.automations.get(id));
    if (!automation) throw new Error(`automation "${id}" not found`);
    return automation;
  }

  private mustGetRun(scope: Principal, id: string): AutomationRun {
    const run = this.runs.get(id);
    if (!run || run.tenantId !== scope.tenantId || run.subject !== scope.subject) {
      throw new Error(`run "${id}" not found`);
    }
    return run;
  }
}
