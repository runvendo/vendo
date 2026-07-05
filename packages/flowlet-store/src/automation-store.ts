/**
 * DrizzleAutomationStore — Postgres-dialect (PGlite default, DATABASE_URL
 * override) port of `InMemoryAutomationStore` (packages/flowlet-runtime/src/
 * automations/store.ts). That class is the BEHAVIORAL SPEC: every method here
 * mirrors its semantics exactly — truncation caps, coarse-status mapping, and
 * the trigger index are reused verbatim via the runtime's exported helpers
 * rather than re-implemented, so the two stores can never silently diverge.
 *
 * Two things can't be ported as plain JS logic because they need the database:
 *  - `claimPendingApproval` — a single capture-then-clear SQL statement (a
 *    plain `UPDATE … RETURNING pending_approval` would return the just-set
 *    NULL, not the value it cleared) using `FOR UPDATE SKIP LOCKED` so exactly
 *    one concurrent caller wins.
 *  - `finalizeRun` — the run write and the automation counters update commit
 *    together in one `db.transaction`.
 *
 * Timestamp round-trip: drizzle's `timestamp(..., { mode: "string" })` gives
 * back Postgres's own text rendering ("2026-07-01 08:00:00+00"), not the ISO
 * string the runtime writes ("2026-07-01T08:00:00.000Z"). Contract tests
 * assert exact ISO equality, so every timestamp column is normalized through
 * `toIso()` at the read boundary. Freshly-created/updated records are
 * returned from the JS values just written (already canonical ISO from the
 * clock) rather than re-read from the DB, so `toIso` only applies where rows
 * come back from a `select`.
 */
import { randomUUID } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import type {
  AutomationRecord as CoreAutomationRecord,
  AutomationRun as CoreAutomationRun,
  Principal,
} from "@flowlet/core";
import {
  DuplicateRunError,
  automationSpecSchema,
  capEnvelope,
  capStep,
  coarseStatus,
  firingRunId,
  triggerIndex,
  type AutomationCounters,
  type AutomationEngineStore,
  type AutomationGrant,
  type AutomationRecord,
  type AutomationRun,
  type AutomationSpec,
  type AutomationVersion,
  type CreateAutomationInput,
  type CreateRunInput,
  type FinalizeRunInput,
  type PendingApproval,
  type StepRecord,
  type TriggerEnvelope,
  type TriggerKind,
  type UpdateAutomationInput,
} from "@flowlet/runtime";
import type { FlowletDb } from "./db.js";
import { automationRuns, automations, automationVersions } from "./schema.js";

/** Postgres text timestamp -> the ISO 8601 string the runtime writes/expects. */
export function toIso(value: string): string {
  return new Date(value).toISOString();
}

/** Loose stand-in for "a drizzle handle that can select/insert/update/delete
 *  against the flowlet schema" — shared by the plain db handle and by a
 *  transaction callback's `tx`. PGlite's and node-postgres's driver types
 *  don't unify cleanly across the `.transaction()` HKT boundary, so this
 *  bridges them at the one place that needs both; every query built through
 *  it is still checked against the real `schema.ts` table types. */
type Db = FlowletDb["db"];

type AutomationRow = typeof automations.$inferSelect;
type AutomationVersionRow = typeof automationVersions.$inferSelect;
type AutomationRunRow = typeof automationRuns.$inferSelect;

function rowToAutomation(row: AutomationRow): AutomationRecord {
  const record: AutomationRecord = {
    id: row.id,
    name: row.name,
    status: row.status as AutomationRecord["status"],
    spec: row.spec as AutomationSpec,
    tenantId: row.tenantId,
    subject: row.subject,
    currentVersion: row.currentVersion,
    triggerKind: row.triggerKind as TriggerKind,
    triggerKey: row.triggerKey,
    counters: row.counters as AutomationCounters,
    createdFromThreadId: row.createdFromThreadId,
    createdAt: toIso(row.createdAt),
    updatedAt: toIso(row.updatedAt),
  };
  if (row.disabledReason != null) {
    record.disabledReason = row.disabledReason as AutomationRecord["disabledReason"];
  }
  return record;
}

function rowToVersion(row: AutomationVersionRow): AutomationVersion {
  return {
    automationId: row.automationId,
    version: row.version,
    spec: row.spec as AutomationSpec,
    dslVersion: row.dslVersion,
    manifestHash: row.manifestHash,
    grants: row.grants as AutomationGrant[],
    createdBy: row.createdBy as AutomationVersion["createdBy"],
    createdAt: toIso(row.createdAt),
  };
}

function rowToRun(row: AutomationRunRow): AutomationRun {
  const run: AutomationRun = {
    id: row.id,
    automationId: row.automationId,
    version: row.version,
    manifestHash: row.manifestHash,
    tenantId: row.tenantId,
    subject: row.subject,
    status: row.status as CoreAutomationRun["status"],
    trigger: row.trigger as TriggerEnvelope,
    steps: row.steps as StepRecord[],
    isTest: row.isTest,
    startedAt: toIso(row.startedAt),
  };
  if (row.outcome != null) run.outcome = row.outcome as AutomationRun["outcome"];
  if (row.pendingApproval != null) run.pendingApproval = row.pendingApproval as PendingApproval;
  if (row.error != null) run.error = row.error;
  if (row.finishedAt != null) run.finishedAt = toIso(row.finishedAt);
  return run;
}

/** PG unique-violation code; PGlite's thrown shape doesn't always match
 *  node-postgres's (code may be nested under `cause`, or absent — fall back
 *  to matching the driver-agnostic Postgres error text). */
function isUniqueViolation(err: unknown): boolean {
  const code =
    (err as { code?: unknown } | null | undefined)?.code ??
    (err as { cause?: { code?: unknown } } | null | undefined)?.cause?.code;
  if (code === "23505") return true;
  const message = err instanceof Error ? err.message : String(err);
  return /duplicate key value violates unique constraint/i.test(message);
}

/** Durable port of `InMemoryAutomationStore`; see the module doc for the two
 *  methods that genuinely need database semantics. */
export class DrizzleAutomationStore implements AutomationEngineStore {
  private readonly handle: FlowletDb;
  private readonly clock: () => string;

  constructor(handle: FlowletDb, opts: { now?: () => string } = {}) {
    this.handle = handle;
    this.clock = opts.now ?? (() => new Date().toISOString());
  }

  private now(): string {
    return this.clock();
  }

  private get db(): Db {
    return this.handle.db;
  }

  private async withTransaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
    if (this.handle.kind === "pglite") {
      const handle = this.handle;
      return handle.db.transaction((tx) => fn(tx as unknown as Db));
    }
    const handle = this.handle;
    return handle.db.transaction((tx) => fn(tx as unknown as Db));
  }

  // ---- frozen core surface -------------------------------------------------

  async save(
    scope: Principal,
    automation: Omit<CoreAutomationRecord, "id" | "createdAt" | "updatedAt">,
  ): Promise<AutomationRecord> {
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
    const rows = await this.db
      .select()
      .from(automations)
      .where(and(eq(automations.id, id), eq(automations.tenantId, scope.tenantId), eq(automations.subject, scope.subject)));
    return rows[0] ? rowToAutomation(rows[0]) : undefined;
  }

  async list(scope: Principal): Promise<AutomationRecord[]> {
    const rows = await this.db
      .select()
      .from(automations)
      .where(and(eq(automations.tenantId, scope.tenantId), eq(automations.subject, scope.subject)));
    return rows.map(rowToAutomation);
  }

  async recordRun(scope: Principal, run: CoreAutomationRun): Promise<void> {
    // Core-shaped upsert: merge onto the engine row when it exists AND the
    // caller owns it (mirrors InMemoryAutomationStore.recordRun's
    // `{ ...existing, ...run }` preserve-merge). Run ids are globally unique
    // (the PK), so an existing id owned by ANOTHER principal can neither be
    // merged (cross-tenant write) nor re-inserted (PK collision): it's a
    // no-op, same as the in-memory reference.
    const existingRows = await this.db.select().from(automationRuns).where(eq(automationRuns.id, run.id));
    const existing = existingRows[0];
    if (existing) {
      if (existing.tenantId !== scope.tenantId || existing.subject !== scope.subject) return;
      // Preserve-merge: absent optional fields keep their stored values,
      // matching the in-memory spread.
      const set: Partial<typeof automationRuns.$inferInsert> = {
        automationId: run.automationId,
        status: run.status,
        startedAt: run.startedAt,
      };
      if (run.error !== undefined) set.error = run.error;
      if (run.finishedAt !== undefined) set.finishedAt = run.finishedAt;
      await this.db
        .update(automationRuns)
        .set(set)
        .where(
          and(
            eq(automationRuns.id, run.id),
            eq(automationRuns.tenantId, scope.tenantId),
            eq(automationRuns.subject, scope.subject),
          ),
        );
      return;
    }
    await this.db.insert(automationRuns).values({
      id: run.id,
      automationId: run.automationId,
      tenantId: scope.tenantId,
      subject: scope.subject,
      version: 0,
      manifestHash: null,
      status: run.status,
      outcome: null,
      trigger: {
        source: "external",
        eventId: run.id,
        subject: scope.subject,
        occurredAt: run.startedAt,
        payload: undefined,
      },
      steps: [],
      pendingApproval: null,
      error: run.error ?? null,
      isTest: false,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt ?? null,
    });
  }

  async listRuns(scope: Principal, automationId: string): Promise<AutomationRun[]> {
    const rows = await this.db
      .select()
      .from(automationRuns)
      .where(
        and(
          eq(automationRuns.automationId, automationId),
          eq(automationRuns.tenantId, scope.tenantId),
          eq(automationRuns.subject, scope.subject),
        ),
      );
    return rows.map(rowToRun);
  }

  // ---- engine surface ------------------------------------------------------

  async create(
    scope: Principal,
    input: CreateAutomationInput,
  ): Promise<{ automation: AutomationRecord; version: AutomationVersion }> {
    const id = `auto-${randomUUID()}`;
    const now = this.now();
    const { kind, key } = triggerIndex(input.spec);
    const counters: AutomationCounters = {
      totalRuns: 0,
      totalFailures: 0,
      consecutiveFailures: 0,
      lastRunAt: null,
      lastStatus: null,
    };
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
      counters,
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
    // Record + version row commit together: a crash between them must never
    // leave an automation without its version 1.
    await this.withTransaction(async (tx) => {
      await tx.insert(automations).values({
        id,
        tenantId: scope.tenantId,
        subject: scope.subject,
        name: automation.name,
        status: "enabled",
        spec: input.spec,
        currentVersion: 1,
        triggerKind: kind,
        triggerKey: key,
        counters,
        createdFromThreadId: automation.createdFromThreadId ?? null,
        createdAt: now,
        updatedAt: now,
      });
      await tx.insert(automationVersions).values({
        automationId: id,
        version: 1,
        spec: input.spec,
        dslVersion: input.spec.dslVersion,
        manifestHash: version.manifestHash,
        grants: input.grants,
        createdBy: version.createdBy,
        createdAt: now,
      });
    });
    return { automation, version };
  }

  async update(
    scope: Principal,
    id: string,
    input: UpdateAutomationInput,
  ): Promise<{ automation: AutomationRecord; version: AutomationVersion }> {
    const now = this.now();
    const { kind, key } = triggerIndex(input.spec);
    // currentVersion is read and bumped in ONE transaction with the version
    // insert: a crash between the insert and the pointer bump would otherwise
    // wedge every later update on the (automation_id, version) PK forever.
    return this.withTransaction(async (tx) => {
      // `FOR UPDATE` row-locks this automation for the rest of the
      // transaction: two concurrent update() calls both reading
      // currentVersion before either commits would otherwise compute the
      // SAME nextVersion and race on the (automation_id, version) PK — one
      // throws a 23505 instead of correctly serializing to versions N+1 and
      // N+2. The second concurrent caller now blocks here until the first
      // commits, then reads the POST-update currentVersion. PGlite runs every
      // `.transaction()` under an internal exclusive lock (one connection),
      // so this is a no-op there — real concurrent Postgres is what the lock
      // is for; a true concurrent-PG test isn't runnable in this test
      // environment (see thread-store.ts's analogous note).
      const rows = await tx
        .select()
        .from(automations)
        .where(and(eq(automations.id, id), eq(automations.tenantId, scope.tenantId), eq(automations.subject, scope.subject)))
        .for("update");
      if (!rows[0]) throw new Error(`automation "${id}" not found`);
      const automation = rowToAutomation(rows[0]);
      const nextVersion = automation.currentVersion + 1;
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
      await tx.insert(automationVersions).values({
        automationId: id,
        version: nextVersion,
        spec: input.spec,
        dslVersion: input.spec.dslVersion,
        manifestHash: version.manifestHash,
        grants: input.grants,
        createdBy: input.createdBy,
        createdAt: now,
      });
      await tx
        .update(automations)
        .set({
          name: updated.name,
          spec: input.spec,
          currentVersion: nextVersion,
          triggerKind: kind,
          triggerKey: key,
          updatedAt: now,
        })
        .where(and(eq(automations.id, id), eq(automations.tenantId, scope.tenantId), eq(automations.subject, scope.subject)));
      return { automation: updated, version };
    });
  }

  async getVersion(scope: Principal, id: string, version: number): Promise<AutomationVersion | undefined> {
    const owned = await this.get(scope, id);
    if (!owned) return undefined;
    const rows = await this.db
      .select()
      .from(automationVersions)
      .where(and(eq(automationVersions.automationId, id), eq(automationVersions.version, version)));
    return rows[0] ? rowToVersion(rows[0]) : undefined;
  }

  async setStatus(
    scope: Principal,
    id: string,
    status: CoreAutomationRecord["status"],
    opts?: { disabledReason?: AutomationRecord["disabledReason"] },
  ): Promise<void> {
    await this.mustGet(scope, id);
    const now = this.now();
    await this.db
      .update(automations)
      .set({
        status,
        disabledReason: opts?.disabledReason !== undefined ? opts.disabledReason : null,
        updatedAt: now,
      })
      .where(and(eq(automations.id, id), eq(automations.tenantId, scope.tenantId), eq(automations.subject, scope.subject)));
  }

  async delete(scope: Principal, id: string): Promise<void> {
    const owned = await this.get(scope, id);
    if (!owned) return;
    await this.db
      .delete(automations)
      .where(and(eq(automations.id, id), eq(automations.tenantId, scope.tenantId), eq(automations.subject, scope.subject)));
  }

  async findEnabledByTrigger(
    scope: Principal,
    lookup: { kind: TriggerKind; key: string | null },
  ): Promise<AutomationRecord[]> {
    const rows = await this.db
      .select()
      .from(automations)
      .where(
        and(
          eq(automations.tenantId, scope.tenantId),
          eq(automations.subject, scope.subject),
          eq(automations.status, "enabled"),
          eq(automations.triggerKind, lookup.kind),
          lookup.key === null ? isNull(automations.triggerKey) : eq(automations.triggerKey, lookup.key),
        ),
      );
    return rows.map(rowToAutomation);
  }

  async createRun(scope: Principal, input: CreateRunInput): Promise<AutomationRun> {
    const id = firingRunId(input.automation.id, input.envelope.source, input.envelope.eventId);
    const versionRow = await this.getVersion(scope, input.automation.id, input.version);
    const now = this.now();
    const trigger = capEnvelope(input.envelope);
    const run: AutomationRun = {
      id,
      automationId: input.automation.id,
      version: input.version,
      manifestHash: versionRow?.manifestHash ?? null,
      tenantId: scope.tenantId,
      subject: scope.subject,
      status: "running",
      trigger,
      steps: [],
      isTest: input.isTest,
      startedAt: now,
    };
    try {
      await this.db.insert(automationRuns).values({
        id: run.id,
        automationId: run.automationId,
        tenantId: run.tenantId,
        subject: run.subject,
        version: run.version,
        manifestHash: run.manifestHash,
        status: run.status,
        outcome: null,
        trigger: run.trigger,
        steps: run.steps,
        pendingApproval: null,
        error: null,
        isTest: run.isTest,
        startedAt: now,
        finishedAt: null,
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw new DuplicateRunError(id);
      throw err;
    }
    return run;
  }

  async updateRun(
    scope: Principal,
    id: string,
    patch: Partial<Pick<AutomationRun, "outcome" | "steps" | "pendingApproval" | "error">>,
  ): Promise<AutomationRun> {
    const run = await this.mustGetRun(scope, id);
    const steps = patch.steps ? patch.steps.map(capStep) : run.steps;
    const status = patch.outcome === "waiting_approval" ? "running" : run.status;
    const next: AutomationRun = { ...run, ...patch, status, steps };
    await this.db
      .update(automationRuns)
      .set({
        status: next.status,
        outcome: next.outcome ?? null,
        steps: next.steps,
        pendingApproval: next.pendingApproval ?? null,
        error: next.error ?? null,
      })
      .where(and(eq(automationRuns.id, id), eq(automationRuns.tenantId, scope.tenantId), eq(automationRuns.subject, scope.subject)));
    return next;
  }

  async finalizeRun(scope: Principal, id: string, input: FinalizeRunInput): Promise<AutomationRun> {
    const now = this.now();
    return this.withTransaction(async (tx) => {
      const runRows = await tx
        .select()
        .from(automationRuns)
        .where(and(eq(automationRuns.id, id), eq(automationRuns.tenantId, scope.tenantId), eq(automationRuns.subject, scope.subject)));
      const existing = runRows[0];
      if (!existing) throw new Error(`run "${id}" not found`);
      const run = rowToRun(existing);

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
      };
      delete finalized.pendingApproval;

      await tx
        .update(automationRuns)
        .set({
          status,
          outcome: input.outcome ?? null,
          steps,
          error: input.error ?? null,
          pendingApproval: null,
          finishedAt: now,
        })
        .where(eq(automationRuns.id, id));

      // Counters update commits in the SAME transaction as the run write.
      const automationRows = await tx
        .select()
        .from(automations)
        .where(
          and(
            eq(automations.id, run.automationId),
            eq(automations.tenantId, scope.tenantId),
            eq(automations.subject, scope.subject),
          ),
        );
      const automationRow = automationRows[0];
      if (automationRow) {
        const automation = rowToAutomation(automationRow);
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
        await tx.update(automations).set({ counters, updatedAt: now }).where(eq(automations.id, automation.id));
      }

      return finalized;
    });
  }

  async getRun(scope: Principal, id: string): Promise<AutomationRun | undefined> {
    const rows = await this.db
      .select()
      .from(automationRuns)
      .where(and(eq(automationRuns.id, id), eq(automationRuns.tenantId, scope.tenantId), eq(automationRuns.subject, scope.subject)));
    return rows[0] ? rowToRun(rows[0]) : undefined;
  }

  /** Capture-then-clear in ONE statement (a plain `RETURNING pending_approval`
   *  after an `UPDATE … SET pending_approval = NULL` returns the new NULL,
   *  not the value it cleared) — `FOR UPDATE SKIP LOCKED` makes exactly one
   *  concurrent caller win. */
  async claimPendingApproval(scope: Principal, runId: string): Promise<PendingApproval | undefined> {
    const result = await this.db.execute(sql`
      WITH claimed AS (
        SELECT id, pending_approval FROM flowlet.automation_runs
        WHERE id = ${runId} AND tenant_id = ${scope.tenantId} AND subject = ${scope.subject}
          AND pending_approval IS NOT NULL
        FOR UPDATE SKIP LOCKED
      )
      UPDATE flowlet.automation_runs r
      SET pending_approval = NULL
      FROM claimed
      WHERE r.id = claimed.id
      RETURNING claimed.pending_approval AS claimed_approval
    `);
    const rows = (result as unknown as { rows: Array<{ claimed_approval: PendingApproval | null }> }).rows;
    const row = rows[0];
    if (!row || row.claimed_approval == null) return undefined;
    return row.claimed_approval;
  }

  async cancelPendingRuns(scope: Principal, automationId: string): Promise<void> {
    const now = this.now();
    await this.db
      .update(automationRuns)
      .set({
        status: "failed",
        outcome: "cancelled",
        pendingApproval: null,
        finishedAt: now,
      })
      .where(
        and(
          eq(automationRuns.automationId, automationId),
          eq(automationRuns.tenantId, scope.tenantId),
          eq(automationRuns.subject, scope.subject),
          eq(automationRuns.outcome, "waiting_approval"),
        ),
      );
  }

  async listEnabledSchedules(): Promise<
    Array<{
      automationId: string;
      trigger: Extract<AutomationSpec["trigger"], { type: "schedule" }>;
      principal: Principal;
    }>
  > {
    const rows = await this.db
      .select()
      .from(automations)
      .where(and(eq(automations.status, "enabled"), eq(automations.triggerKind, "schedule")));
    return rows.map((row) => {
      const automation = rowToAutomation(row);
      return {
        automationId: automation.id,
        trigger: automation.spec.trigger as Extract<AutomationSpec["trigger"], { type: "schedule" }>,
        principal: { tenantId: automation.tenantId, subject: automation.subject },
      };
    });
  }

  private async mustGet(scope: Principal, id: string): Promise<AutomationRecord> {
    const automation = await this.get(scope, id);
    if (!automation) throw new Error(`automation "${id}" not found`);
    return automation;
  }

  private async mustGetRun(scope: Principal, id: string): Promise<AutomationRun> {
    const run = await this.getRun(scope, id);
    if (!run) throw new Error(`run "${id}" not found`);
    return run;
  }
}
