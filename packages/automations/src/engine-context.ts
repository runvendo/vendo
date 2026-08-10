/**
 * The slice of `createAutomationsEngine`' closure its modules read.
 *
 * `createAutomationsEngine` is an ASSEMBLER: every door it returns, and every
 * helper those doors lean on, lives in a module beside its contract and is
 * handed the pieces of the closure it needs. Every one of them names its
 * dependencies as a `Pick` of this one type, and returns a `Pick` of it too,
 * which keeps a single description of what the closure offers and lets
 * `createEngineContext` below wire them in dependency order.
 *
 * Internal — not exported from the package root.
 */
import type {
  AppDocument,
  ApprovalRequest,
  Json,
  PermissionGrant,
  RecordStore,
  RunContext,
  RunId,
  Step,
  ToolDescriptor,
  ToolOutcome,
  Trigger,
  TriggerSource,
  VendoRecord,
} from "@vendoai/core";
import { createAppRows } from "./app-rows.js";
import { createArmed } from "./armed.js";
import { createConsent } from "./consent.js";
import { createGrants } from "./grants.js";
import { createRunExecution } from "./run-execution.js";
import { createRunRows } from "./run-rows.js";
import { createSponsorshipGate } from "./sponsorship-gate.js";
import type { AutomationsConfig, RunRecord, RunStatus } from "./index.js";
import type { Sponsorship } from "./sponsorship.js";
import type {
  AppRow,
  Capture,
  ConsentItem,
  FiredSchedule,
  InternalRunRecord,
} from "./types.js";

export interface AutomationsEngineContext {
  config: AutomationsConfig;
  /** The clock, through the testability seam. */
  now(): Date;
  /** The same clock, as the ISO string every row and event is stamped with. */
  iso(): string;
  /** Run ids `runs.stop` has claimed, so an in-flight copy lands as stopped. */
  stopped: Set<string>;
  /** Run ids currently executing in THIS process. */
  active: Set<string>;
  /** The agentic runs `runs.stop` can still cancel in this process. */
  abortControllers: Map<string, AbortController>;
  /** Whether THIS engine instance fires this trigger kind itself (07 §1). */
  firesLocally(kind: "schedule" | "external"): boolean;

  // ── app-rows.ts ────────────────────────────────────────────────────────────
  /** The app row and its record, or null when there is none. */
  appRecord(appId: string): Promise<{ record: VendoRecord; row: AppRow } | null>;
  /** The app, for a caller allowed to CHANGE it — null when absent OR refused. */
  editableAppOrNull(appId: string, ctx: RunContext): Promise<{ record: VendoRecord; row: AppRow } | null>;
  /** The same door, existence-masked, for callers that must refuse. */
  editableApp(appId: string, ctx: RunContext): Promise<{ record: VendoRecord; row: AppRow }>;
  /** The named trigger of an app, validated. */
  declaredTrigger(doc: AppDocument, triggerId: string): Trigger;
  /** The app row write that re-derives the per-kind trigger refs. */
  writeApp(record: VendoRecord, row: AppRow): Promise<void>;
  /** §9.3's `can(editor)`, through the config seam. */
  canEdit(ctx: RunContext, row: AppRow, appId: string): Promise<boolean>;
  /** The app rows that fire on this trigger kind, by its per-kind ref. */
  appsFiringOn(kind: TriggerSource["kind"], refs?: Record<string, string>): Promise<VendoRecord[]>;

  // ── armed.ts ───────────────────────────────────────────────────────────────
  /** Turn ONE (app, trigger) arm row on or off. */
  setArmed(appId: string, triggerId: string, armed: boolean): Promise<void>;
  /** This app's armed triggers, given the armed keys already fetched. */
  armedTriggers(row: AppRow, armed: ReadonlySet<string>): Trigger[];
  /** The armed set for these app rows. */
  armedFor(rows: readonly AppRow[]): Promise<Set<string>>;
  /** The same question for one trigger. */
  isArmed(row: AppRow, triggerId: string): Promise<boolean>;
  /** Turn ONE trigger off, leaving the app's others exactly as they were. */
  disarmTrigger(record: VendoRecord, row: AppRow, triggerId: string): Promise<void>;

  // ── grants.ts ──────────────────────────────────────────────────────────────
  /** The bound tool surface, by name, for a present-time ceremony. */
  descriptors(ctx: RunContext): Promise<Map<string, ToolDescriptor>>;
  /** Every LIVE standing grant this (app, trigger) holds for the subject. */
  liveAutomationGrants(
    subject: string,
    appId: string,
    triggerId: string,
    tool?: string,
  ): Promise<PermissionGrant[]>;
  /** Whether this exact descriptor (and service action) is already granted. */
  liveGrant(
    subject: string,
    appId: string,
    triggerId: string,
    descriptor: ToolDescriptor,
    slug?: string,
  ): Promise<boolean>;
  /** The service-action slugs THIS firing holds a live grant for. */
  grantedServiceSlugs(subject: string, appId: string, triggerId: string): Promise<string[]>;
  /** Whether the TRIGGER holds ANY live automation-source standing grant. */
  anyLiveAutomationGrant(subject: string, appId: string, triggerId: string): Promise<boolean>;
  /** The standing grant a decided approval mints, scoped to its slug. */
  mintGrant(request: ApprovalRequest, triggerId: string | undefined): Promise<string>;

  // ── run-rows.ts ────────────────────────────────────────────────────────────
  /** A `run`-kind audit event under the run's own away context. */
  audit(ctx: RunContext, status: string, extra?: Record<string, Json>): Promise<void>;
  /** The run row write that never overwrites a terminal row. */
  writeRun(record: InternalRunRecord): Promise<boolean>;
  /** The terminal landing every door ends on. */
  terminal(
    run: InternalRunRecord,
    ctx: RunContext,
    status: Extract<RunStatus, "ok" | "error" | "stopped">,
    summary: string,
    error?: NonNullable<RunRecord["error"]>,
  ): Promise<void>;
  /** Append one step outcome to the in-flight run. */
  appendOutcome(run: InternalRunRecord, step: Step, outcome: ToolOutcome): void;
  /** Land the run on the failure a step's own expressions produced. */
  failStep(run: InternalRunRecord, ctx: RunContext, step: Step, error: unknown): Promise<void>;
  /** Whether this run has already ended — stopped here, or terminal on disk. */
  finishStoppedIfNeeded(run: InternalRunRecord): Promise<boolean>;

  // ── sponsorship-gate.ts ────────────────────────────────────────────────────
  /** The sponsorship collection. */
  sponsorships(): RecordStore;
  /** The era markers that outlive an erase of the sponsor. */
  sponsoredEra(): RecordStore;
  /** The ONE sponsorship read every gate goes through. */
  sponsorshipState(
    doc: AppDocument,
    triggerId: string,
  ): Promise<{ kind: "none" } | { kind: "erased" } | { kind: "row"; row: Sponsorship; revision?: string }>;
  /** Every sponsorship row for these apps' triggers, in ONE query. */
  sponsorshipsFor(rows: readonly AppRow[]): Promise<Map<string, Sponsorship>>;
  /** The run's context before any seam is consulted. */
  baseRunContext(run: InternalRunRecord, subject: string): RunContext;
  /** §9.9 — the run's identity is its SPONSOR. */
  runContext(doc: AppDocument, run: InternalRunRecord, subject: string): Promise<RunContext>;
  /** §9.9's fire-time gate, in ONE place. */
  sponsorshipRefusal(
    app: AppRow,
    trigger: Trigger,
    ctx: RunContext,
  ): Promise<{ reason: NonNullable<Sponsorship["reason"]>; summary: string } | undefined>;

  // ── consent.ts ─────────────────────────────────────────────────────────────
  /** A capture row, keyed by the approval it is the ask for. */
  writeCapture(approvalId: string, capture: Capture): Promise<void>;
  /** Is this approval still an open question? */
  isPendingAsk(approvalId: string): Promise<boolean>;
  /** Every still-pending capture for the subject, parsed. */
  pendingCaptures(subject: string): Promise<Array<{ id: string; data: Capture }>>;
  /** Claim the approval's one-time transition before granting anything. */
  spendApproval(record: VendoRecord): Promise<boolean>;
  /** The guard's decision subscriber: mint, clear, and disarm on a bare no. */
  handleDecision(approvalId: string, approved: boolean): Promise<void>;
  /** The tools a consent moment covers. */
  consentSurface(trigger: Trigger, byName: Map<string, ToolDescriptor>): Promise<ConsentItem[]>;
  /** 07 §3 — the asks arming has to raise for this subject. */
  captureGrants(
    doc: AppDocument,
    trigger: Trigger,
    byName: Map<string, ToolDescriptor>,
    ctx: RunContext,
  ): Promise<{ missing: ApprovalRequest[]; grantSetId: string }>;
  /** A step met a permission nobody has granted. The run ends HERE, loudly. */
  needsPermission(
    run: InternalRunRecord,
    ctx: RunContext,
    step: Step,
    approvalId: string,
  ): Promise<void>;

  // ── run-execution.ts ───────────────────────────────────────────────────────
  /** Mint the run id synchronously; run the automation on the returned promise. */
  launchRun(
    app: AppRow,
    declared: Trigger,
    kind: TriggerSource["kind"],
    event: Json,
    lineage?: RunId,
  ): { runId: RunId; done: Promise<void> };
  /** The same launch, awaited — for the doors that fire one run at a time. */
  startRun(app: AppRow, trigger: Trigger, kind: TriggerSource["kind"], event: Json): Promise<RunId>;
  /** Fired schedules, with bounded parallelism and an optional per-run timeout. */
  runFiredSchedules(fired: readonly FiredSchedule[]): Promise<RunId[]>;
}

/** 07 §1 — `createAutomationsEngine`' closure, wired in dependency order. */
export const createEngineContext = (config: AutomationsConfig): AutomationsEngineContext => {
  const now = (): Date => config.now?.() ?? new Date();
  const iso = (): string => now().toISOString();
  const stopped = new Set<string>();
  const active = new Set<string>();
  const abortControllers = new Map<string, AbortController>();
  // Absent localTriggerKinds → every kind fires locally (today's behavior, unchanged).
  const firesLocally = (kind: "schedule" | "external"): boolean =>
    config.localTriggerKinds === undefined || config.localTriggerKinds.has(kind);

  const base = { config, now, iso, stopped, active, abortControllers, firesLocally };
  const appRows = createAppRows(base);
  const armed = createArmed({ ...base, ...appRows });
  const grants = createGrants(base);
  const runRows = createRunRows(base);
  const sponsorship = createSponsorshipGate({ ...base, ...appRows });
  const consent = createConsent({ ...base, ...appRows, ...armed, ...grants, ...runRows });
  const execution = createRunExecution({ ...base, ...grants, ...runRows, ...sponsorship, ...consent });
  return { ...base, ...appRows, ...armed, ...grants, ...runRows, ...sponsorship, ...consent, ...execution };
};
