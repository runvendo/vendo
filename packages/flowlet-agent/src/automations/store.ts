/**
 * AutomationStore — the Store-seam contract for automations, versions, and
 * runs (spec section b, as amended), plus the in-memory implementation used by
 * embedded mode and tests. The cloud Postgres implementation (ENG-198) lands
 * behind the same interface.
 *
 * Retention (Yousef ruling 2026-07-01): retain EVERYTHING in v1 — no pruning.
 * Rows stay sane via per-step output truncation, not deletion. A real
 * retention policy is a deliberate TODO for the cloud phase.
 */
import type { AutomationSpec } from "./schema";

/** Per-step output cap: truncate + flag + record full size (never delete runs). */
export const MAX_STEP_OUTPUT_BYTES = 32_768;
/** Trigger payload cap inside a stored run. */
export const MAX_TRIGGER_PAYLOAD_BYTES = 32_768;

export type AutomationStatus = "enabled" | "paused" | "disabled_error";

export type RunStatus =
  | "running"
  | "succeeded"
  | "failed"
  | "skipped"
  | "waiting_approval"
  | "cancelled";

export type StepStatus =
  | "succeeded"
  | "failed"
  | "skipped"
  | "simulated"
  | "waiting_approval";

export type TriggerKind = "schedule" | "host_event" | "composio";

/** Every firing arrives wrapped in this envelope (spec amendment 3). */
export interface TriggerEnvelope {
  /** Producer identity: "poller", "cron", "webhook", "composio", "test", … */
  source: string;
  /** Producer-supplied id (transaction id, delivery id, cron tick) — dedup key. */
  eventId: string;
  /** The owning user; fan-out never crosses subjects. */
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
  /** Drives disabled_error at the runner's threshold; success resets it. */
  consecutiveFailures: number;
  lastRunAt: string | null;
  lastStatus: RunStatus | null;
}

export interface AutomationRecord {
  id: string;
  tenantId: string;
  userId: string;
  name: string;
  status: AutomationStatus;
  currentVersion: number;
  triggerKind: TriggerKind;
  /** host event name or Composio trigger slug; null for schedules. */
  triggerKey: string | null;
  createdFromThreadId: string | null;
  counters: AutomationCounters;
  createdAt: string;
  updatedAt: string;
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

export interface AutomationRun {
  /** Deterministic firing id — see {@link firingRunId}. */
  id: string;
  automationId: string;
  version: number;
  manifestHash: string | null;
  tenantId: string;
  userId: string;
  status: RunStatus;
  trigger: TriggerEnvelope;
  steps: StepRecord[];
  pendingApproval: PendingApproval | null;
  isTest: boolean;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
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
  tenantId: string;
  userId: string;
  spec: AutomationSpec;
  grants: AutomationGrant[];
  manifestHash?: string | null;
  createdFromThreadId?: string | null;
  createdBy?: "compiler" | "user_edit";
  now: string;
}

export interface UpdateAutomationInput {
  spec: AutomationSpec;
  /** Grants never carry across versions; every update supplies fresh ones. */
  grants: AutomationGrant[];
  manifestHash?: string | null;
  createdBy: "compiler" | "user_edit";
  now: string;
}

export interface CreateRunInput {
  automation: AutomationRecord;
  version: number;
  envelope: TriggerEnvelope;
  isTest: boolean;
  now: string;
}

export interface FinalizeRunInput {
  status: Extract<RunStatus, "succeeded" | "failed" | "skipped" | "cancelled">;
  steps?: StepRecord[];
  error?: string;
  now: string;
}

export interface TriggerLookup {
  tenantId: string;
  userId: string;
  kind: TriggerKind;
  key: string | null;
}

/** The seam. All methods are async so the Postgres impl is a drop-in. */
export interface AutomationStore {
  createAutomation(
    input: CreateAutomationInput,
  ): Promise<{ automation: AutomationRecord; version: AutomationVersion }>;
  updateAutomation(
    id: string,
    input: UpdateAutomationInput,
  ): Promise<{ automation: AutomationRecord; version: AutomationVersion }>;
  getAutomation(id: string): Promise<AutomationRecord | undefined>;
  getVersion(id: string, version: number): Promise<AutomationVersion | undefined>;
  listAutomations(filter?: { tenantId?: string; userId?: string }): Promise<AutomationRecord[]>;
  setStatus(id: string, status: AutomationStatus, now: string): Promise<void>;
  deleteAutomation(id: string): Promise<void>;
  findEnabledByTrigger(lookup: TriggerLookup): Promise<AutomationRecord[]>;

  createRun(input: CreateRunInput): Promise<AutomationRun>;
  updateRun(
    id: string,
    patch: Partial<Pick<AutomationRun, "status" | "steps" | "pendingApproval" | "error">>,
  ): Promise<AutomationRun>;
  finalizeRun(id: string, input: FinalizeRunInput): Promise<AutomationRun>;
  getRun(id: string): Promise<AutomationRun | undefined>;
  listRuns(automationId: string): Promise<AutomationRun[]>;
  /** waiting_approval runs are cancelled on pause/edit/delete (amendment 7). */
  cancelPendingRuns(automationId: string, now: string): Promise<void>;
}

function triggerIndex(spec: AutomationSpec): { kind: TriggerKind; key: string | null } {
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

function capStep(step: StepRecord): StepRecord {
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

function capEnvelope(envelope: TriggerEnvelope): TriggerEnvelope {
  if (jsonBytes(envelope.payload) <= MAX_TRIGGER_PAYLOAD_BYTES) return envelope;
  return { ...envelope, payload: truncateValue(envelope.payload, MAX_TRIGGER_PAYLOAD_BYTES) };
}

/** In-memory implementation: the embedded seam slot and the test double. */
export class InMemoryAutomationStore implements AutomationStore {
  private automations = new Map<string, AutomationRecord>();
  private versions = new Map<string, AutomationVersion>();
  private runs = new Map<string, AutomationRun>();
  private idCounter = 0;

  private versionKey(id: string, version: number): string {
    return `${id}::v${version}`;
  }

  async createAutomation(
    input: CreateAutomationInput,
  ): Promise<{ automation: AutomationRecord; version: AutomationVersion }> {
    const id = `auto-${++this.idCounter}`;
    const { kind, key } = triggerIndex(input.spec);
    const automation: AutomationRecord = {
      id,
      tenantId: input.tenantId,
      userId: input.userId,
      name: input.spec.name,
      status: "enabled",
      currentVersion: 1,
      triggerKind: kind,
      triggerKey: key,
      createdFromThreadId: input.createdFromThreadId ?? null,
      counters: {
        totalRuns: 0,
        totalFailures: 0,
        consecutiveFailures: 0,
        lastRunAt: null,
        lastStatus: null,
      },
      createdAt: input.now,
      updatedAt: input.now,
    };
    const version: AutomationVersion = {
      automationId: id,
      version: 1,
      spec: input.spec,
      dslVersion: input.spec.dslVersion,
      manifestHash: input.manifestHash ?? null,
      grants: input.grants,
      createdBy: input.createdBy ?? "compiler",
      createdAt: input.now,
    };
    this.automations.set(id, automation);
    this.versions.set(this.versionKey(id, 1), version);
    return { automation, version };
  }

  async updateAutomation(
    id: string,
    input: UpdateAutomationInput,
  ): Promise<{ automation: AutomationRecord; version: AutomationVersion }> {
    const automation = this.mustGet(id);
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
      createdAt: input.now,
    };
    const updated: AutomationRecord = {
      ...automation,
      name: input.spec.name,
      currentVersion: nextVersion,
      triggerKind: kind,
      triggerKey: key,
      updatedAt: input.now,
    };
    this.versions.set(this.versionKey(id, nextVersion), version);
    this.automations.set(id, updated);
    return { automation: updated, version };
  }

  async getAutomation(id: string): Promise<AutomationRecord | undefined> {
    return this.automations.get(id);
  }

  async getVersion(id: string, version: number): Promise<AutomationVersion | undefined> {
    return this.versions.get(this.versionKey(id, version));
  }

  async listAutomations(filter?: {
    tenantId?: string;
    userId?: string;
  }): Promise<AutomationRecord[]> {
    return [...this.automations.values()].filter(
      (a) =>
        (filter?.tenantId === undefined || a.tenantId === filter.tenantId) &&
        (filter?.userId === undefined || a.userId === filter.userId),
    );
  }

  async setStatus(id: string, status: AutomationStatus, now: string): Promise<void> {
    const automation = this.mustGet(id);
    this.automations.set(id, { ...automation, status, updatedAt: now });
  }

  async deleteAutomation(id: string): Promise<void> {
    this.automations.delete(id);
  }

  async findEnabledByTrigger(lookup: TriggerLookup): Promise<AutomationRecord[]> {
    return [...this.automations.values()].filter(
      (a) =>
        a.status === "enabled" &&
        a.tenantId === lookup.tenantId &&
        a.userId === lookup.userId &&
        a.triggerKind === lookup.kind &&
        a.triggerKey === lookup.key,
    );
  }

  async createRun(input: CreateRunInput): Promise<AutomationRun> {
    const id = firingRunId(input.automation.id, input.envelope.source, input.envelope.eventId);
    if (this.runs.has(id)) throw new DuplicateRunError(id);
    const versionRow = this.versions.get(this.versionKey(input.automation.id, input.version));
    const run: AutomationRun = {
      id,
      automationId: input.automation.id,
      version: input.version,
      manifestHash: versionRow?.manifestHash ?? null,
      tenantId: input.automation.tenantId,
      userId: input.automation.userId,
      status: "running",
      trigger: capEnvelope(input.envelope),
      steps: [],
      pendingApproval: null,
      isTest: input.isTest,
      error: null,
      startedAt: input.now,
      finishedAt: null,
    };
    this.runs.set(id, run);
    return run;
  }

  async updateRun(
    id: string,
    patch: Partial<Pick<AutomationRun, "status" | "steps" | "pendingApproval" | "error">>,
  ): Promise<AutomationRun> {
    const run = this.mustGetRun(id);
    const next: AutomationRun = {
      ...run,
      ...patch,
      steps: patch.steps ? patch.steps.map(capStep) : run.steps,
    };
    this.runs.set(id, next);
    return next;
  }

  async finalizeRun(id: string, input: FinalizeRunInput): Promise<AutomationRun> {
    const run = this.mustGetRun(id);
    // Skipped runs stay compact: no steps array is stored for them.
    const steps = input.status === "skipped" ? [] : (input.steps ?? run.steps).map(capStep);
    const finalized: AutomationRun = {
      ...run,
      status: input.status,
      steps,
      pendingApproval: null,
      error: input.error ?? null,
      finishedAt: input.now,
    };
    this.runs.set(id, finalized);

    const automation = this.automations.get(run.automationId);
    if (automation) {
      const failed = input.status === "failed";
      const counted = input.status === "succeeded" || failed;
      const counters: AutomationCounters = {
        totalRuns: automation.counters.totalRuns + 1,
        totalFailures: automation.counters.totalFailures + (failed ? 1 : 0),
        consecutiveFailures: failed
          ? automation.counters.consecutiveFailures + 1
          : counted
            ? 0
            : automation.counters.consecutiveFailures,
        lastRunAt: input.now,
        lastStatus: input.status,
      };
      this.automations.set(automation.id, { ...automation, counters, updatedAt: input.now });
    }
    return finalized;
  }

  async getRun(id: string): Promise<AutomationRun | undefined> {
    return this.runs.get(id);
  }

  async listRuns(automationId: string): Promise<AutomationRun[]> {
    return [...this.runs.values()].filter((r) => r.automationId === automationId);
  }

  async cancelPendingRuns(automationId: string, now: string): Promise<void> {
    for (const run of this.runs.values()) {
      if (run.automationId === automationId && run.status === "waiting_approval") {
        this.runs.set(run.id, {
          ...run,
          status: "cancelled",
          pendingApproval: null,
          finishedAt: now,
        });
      }
    }
  }

  private mustGet(id: string): AutomationRecord {
    const automation = this.automations.get(id);
    if (!automation) throw new Error(`automation "${id}" not found`);
    return automation;
  }

  private mustGetRun(id: string): AutomationRun {
    const run = this.runs.get(id);
    if (!run) throw new Error(`run "${id}" not found`);
    return run;
  }
}
