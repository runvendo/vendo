/**
 * The run row and its audit event: the write that never overwrites a terminal
 * row, the terminal landing every door ends on, and the stopped check an
 * in-flight run interleaves with.
 *
 * Lifted out of `createAutomationsEngine` unchanged.
 */
import {
  auditContext,
  type AuditEvent,
  type Json,
  type RunContext,
  type Step,
  type ToolOutcome,
} from "@vendoai/core";
import type { AutomationsEngineContext } from "./engine-context.js";
import type { RunRecord, RunStatus } from "./index.js";
import { id, message, parseRunRecord, syncRun, terminalStatus } from "./rows.js";
import { outcomeDetail } from "./steps.js";
import { RUNS, type InternalRunRecord } from "./types.js";

export type RunRowsDeps = Pick<AutomationsEngineContext, "config" | "iso" | "stopped">;

export type RunRowsAccess = Pick<
  AutomationsEngineContext,
  "audit" | "writeRun" | "terminal" | "appendOutcome" | "failStep" | "finishStoppedIfNeeded"
>;

export const createRunRows = ({ config, iso, stopped }: RunRowsDeps): RunRowsAccess => {
  const audit = async (ctx: RunContext, status: string, extra: Record<string, Json> = {}): Promise<void> => {
    const event: AuditEvent = {
      id: id("aud_"),
      at: iso(),
      kind: "run",
      ...auditContext(ctx),
      // An automation run is away by definition, whatever the ctx says.
      venue: "automation",
      presence: "away",
      detail: { status, ...extra },
    };
    await config.guard.report(event);
  };

  const writeRun = async (record: InternalRunRecord): Promise<boolean> => {
    const stored = await config.store.records(RUNS).get(record.id);
    if (stored !== null) {
      const current = parseRunRecord(stored);
      if (terminalStatus(current.status)) {
        syncRun(record, current);
        return false;
      }
    }
    await config.store.records(RUNS).put({
      id: record.id,
      data: {
        appId: record.appId,
        trigger: record.trigger,
        status: record.status,
        record,
        startedAt: record.startedAt,
        ...(record.finishedAt === undefined ? {} : { finishedAt: record.finishedAt }),
      },
      refs: { app_id: record.appId, status: record.status },
    });
    return true;
  };

  const terminal = async (
    run: InternalRunRecord,
    ctx: RunContext,
    status: Extract<RunStatus, "ok" | "error" | "stopped">,
    summary: string,
    error?: NonNullable<RunRecord["error"]>,
  ): Promise<void> => {
    run.status = status;
    run.finishedAt = iso();
    run.summary = summary;
    if (error === undefined) delete run.error;
    else run.error = error;
    if (await writeRun(run)) await audit(ctx, status);
  };

  const appendOutcome = (run: InternalRunRecord, step: Step, outcome: ToolOutcome): void => {
    const detail = outcomeDetail(outcome);
    run.steps.push({
      id: step.id,
      tool: step.tool,
      outcome: outcome.status,
      at: iso(),
      ...(detail === undefined ? {} : { detail }),
    });
  };

  const finishStoppedIfNeeded = async (run: InternalRunRecord): Promise<boolean> => {
    if (stopped.has(run.id)) {
      // runs.stop persisted and audited the authoritative stopped row; this is a stale in-flight copy.
      run.status = "stopped";
      return true;
    }
    const stored = await config.store.records(RUNS).get(run.id);
    if (stored !== null) {
      const current = parseRunRecord(stored);
      if (terminalStatus(current.status)) {
        syncRun(run, current);
        return true;
      }
    }
    if (terminalStatus(run.status)) return true;
    return false;
  };

  const failStep = async (
    run: InternalRunRecord,
    ctx: RunContext,
    step: Step,
    error: unknown,
  ): Promise<void> => {
    const failed: ToolOutcome = { status: "error", error: { code: "validation", message: message(error) } };
    appendOutcome(run, step, failed);
    await terminal(run, ctx, "error", `stopped at ${step.id}: ${message(error)}`, failed.error);
  };

  return { audit, writeRun, terminal, appendOutcome, failStep, finishStoppedIfNeeded };
};
