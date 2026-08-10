/**
 * What a firing actually does: the steps loop, the agentic dispatch, and the
 * launch that mints a run id synchronously and runs the automation on the
 * returned promise — with the §9.9 gate in front of both.
 *
 * Lifted out of `createAutomationsEngine` unchanged.
 */
import {
  VendoError,
  type Json,
  type RunContext,
  type RunId,
  type Step,
  type ToolCall,
  type ToolOutcome,
  type Trigger,
  type TriggerSource,
} from "@vendoai/core";
import type { ConsentAccess } from "./consent.js";
import type { EngineBase } from "./engine-context.js";
import type { GrantsAccess } from "./grants.js";
import { IDENTITY_UNAVAILABLE } from "./messages.js";
import { clone, id, message } from "./rows.js";
import type { RunRowsAccess } from "./run-rows.js";
import type { SponsorshipGateAccess } from "./sponsorship-gate.js";
import type { Sponsorship } from "./sponsorship.js";
import {
  errorForOutcome,
  evaluate,
  stepArgs,
  triggerEvent,
  validateForEachItems,
  validateTrigger,
} from "./steps.js";
import type { AppRow, FiredSchedule, InternalRunRecord } from "./types.js";

export type RunExecutionDeps = {
  base: EngineBase;
  grants: GrantsAccess;
  runRows: RunRowsAccess;
  sponsorship: SponsorshipGateAccess;
  consent: ConsentAccess;
};

export interface RunExecutionAccess {
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

type StepsRunner = {
  continueSteps(
    app: AppRow,
    trigger: Trigger,
    run: InternalRunRecord,
    ctx: RunContext,
    event: Json,
  ): Promise<void>;
};

type AgenticRunner = {
  runAgentic(
    trigger: Trigger,
    run: InternalRunRecord,
    ctx: RunContext,
    abortSignal: AbortSignal,
  ): Promise<void>;
};

/** A steps run: the tool calls a trigger DECLARES, in order. */
const createStepsRunner = (
  deps: Pick<RunExecutionDeps, "base" | "runRows" | "consent">,
): StepsRunner => {
  const { base: { config }, runRows, consent } = deps;
  const executeCall = async (
    appId: string,
    step: Step,
    call: ToolCall,
    ctx: RunContext,
  ): Promise<ToolOutcome> => step.tool.startsWith("fn:")
    ? await config.apps.call(appId, step.tool, call.args, ctx)
    : await config.tools.execute(call, ctx);

  /** A steps run, always from the top. There is no mid-run resume: a run that
   *  meets a permission it does not hold fails LOUDLY and `runs.rerun` starts a
   *  FRESH run of the same firing (07 §5), so the only state carried between
   *  steps is the outputs they have produced. */
  const continueSteps = async (
    app: AppRow,
    trigger: Trigger,
    run: InternalRunRecord,
    ctx: RunContext,
    event: Json,
  ): Promise<void> => {
    if (trigger.run.kind !== "steps") throw new VendoError("validation", "steps run expected");
    const steps = trigger.run.steps;
    const stepOutputs: Record<string, Json> = {};
    for (let stepIndex = 0; stepIndex < steps.length; stepIndex += 1) {
      if (await runRows.finishStoppedIfNeeded(run)) return;
      const step = steps[stepIndex] as Step;
      let items: Json[] | undefined;
      const outputs: Json[] = [];
      try {
        if (step.if !== undefined && !await evaluate(step.if, { event, steps: stepOutputs, item: undefined })) {
          continue;
        }
        if (step.forEach !== undefined) {
          const evaluated = await evaluate(step.forEach, { event, steps: stepOutputs, item: undefined });
          items = validateForEachItems(step, evaluated);
        }
      } catch (error) {
        await runRows.failStep(run, ctx, step, error);
        return;
      }

      const iterations: Array<{ item?: Json; index?: number }> = items === undefined
        ? [{}]
        : items.map((item, index) => ({ item, index }));
      for (const iteration of iterations) {
        if (await runRows.finishStoppedIfNeeded(run)) return;
        let args: Record<string, Json>;
        try {
          args = await stepArgs(step, event, stepOutputs, iteration.item);
        } catch (error) {
          await runRows.failStep(run, ctx, step, error);
          return;
        }
        // Derived, not random: the guard's effect ledger tells "this call again"
        // apart from "another call just like it" by CALL ID, so the same step of
        // the same firing has to present the same id every time it runs. A random
        // id made a re-run look like a second, separately-intended call, and the
        // receipt for work that had already landed was never consulted.
        //
        // Positional, not by step id: nothing validates that step ids are unique
        // within a list, and two steps sharing one would then share a call id —
        // turning a document's own sloppiness into a SKIPPED mutation. The index
        // is unique by construction and just as stable across a re-run, since the
        // re-run reads the same step list. The id rides along so the value is
        // still readable in a log, and the iteration index is in it because one
        // forEach step is many calls that are genuinely different ones.
        const call: ToolCall = {
          id: `call_${run.__lineage ?? run.id}_${stepIndex}_${step.id}`
            + (iteration.index === undefined ? "" : `_${iteration.index}`),
          tool: step.tool,
          args,
        };
        const outcome = await executeCall(app.doc.id, step, call, ctx);
        if (await runRows.finishStoppedIfNeeded(run)) return;
        runRows.appendOutcome(run, step, outcome);
        if (outcome.status === "pending-approval") {
          await consent.needsPermission(run, ctx, step, outcome.approvalId);
          return;
        }
        if (outcome.status !== "ok") {
          const error = errorForOutcome(outcome);
          await runRows.terminal(run, ctx, "error", `stopped at ${step.id}: ${error.message}`, error);
          return;
        }
        if (items === undefined) stepOutputs[step.id] = outcome.output;
        else outputs.push(outcome.output);
      }
      if (items !== undefined) stepOutputs[step.id] = outputs;
    }
    const okCount = run.steps.filter((entry) => entry.outcome === "ok").length;
    await runRows.terminal(run, ctx, "ok", `${okCount} ${okCount === 1 ? "step" : "steps"} ok`);
  };

  return { continueSteps };
};

/** An agentic run: one dispatch through the core `AgentRunner` seam. */
const createAgenticRunner = (
  deps: Pick<RunExecutionDeps, "base" | "runRows" | "grants">,
): AgenticRunner => {
  const { base: { config, iso }, runRows, grants } = deps;
  const runAgentic = async (
    trigger: Trigger,
    run: InternalRunRecord,
    ctx: RunContext,
    abortSignal: AbortSignal,
  ): Promise<void> => {
    if (trigger.run.kind !== "agentic") throw new VendoError("validation", "agentic run expected");
    if (config.runner === undefined) {
      await runRows.terminal(
        run,
        ctx,
        "error",
        "agentic runs unavailable",
        { code: "not-implemented", message: "agentic runs unavailable" },
      );
      return;
    }
    try {
      // At 2am the run sees the dispatcher, but caged: only the slugs this
      // (app, trigger) was actually granted are worth offering it for, so the
      // firing's own grants ride the ctx and §12's projection reads them. Every
      // other withheld tool stays withheld, and which slug may RUN is still the
      // guard's decision at call time.
      const listingCtx: RunContext = {
        ...ctx,
        grantedServiceSlugs: await grants.grantedServiceSlugs(
          ctx.principal.subject,
          run.appId,
          run.triggerId,
        ),
      };
      const report = await config.runner({
        prompt: trigger.run.prompt,
        // The whole registry, and §12's projection is what narrows it: an away ctx
        // withholds every destructive AND every `ungraded` descriptor. The one
        // exemption is the connector dispatcher, and only for a firing that holds
        // a live per-slug service grant (`grantedServiceSlugs` above).
        tools: config.tools,
        budget: { maxToolCalls: trigger.run.budget?.maxToolCalls ?? 50 },
        abortSignal,
      }, listingCtx);
      // Cross-instance stops cannot reach this process's controller, so the persisted
      // terminal-row check remains the best-effort fallback for a late result.
      if (await runRows.finishStoppedIfNeeded(run)) return;
      run.steps = report.toolCalls.map(({ call, outcome }) => ({
        id: call.id,
        tool: call.tool,
        outcome,
        at: iso(),
      }));
      await runRows.terminal(run, ctx, report.status, report.summary);
    } catch (error) {
      if (await runRows.finishStoppedIfNeeded(run)) return;
      // "error", not "not-implemented": that code means "no runner configured"
      // (above); a runner that crashed is an outage, not a missing feature.
      await runRows.terminal(run, ctx, "error", message(error), { code: "error", message: message(error) });
    }
  };

  return { runAgentic };
};

/** The launch every firing goes through: the §9.9 gate, then one of the two
 *  runners above. */
const createRunLauncher = (
  deps: Pick<RunExecutionDeps, "base" | "runRows" | "sponsorship"> & StepsRunner & AgenticRunner,
): Pick<RunExecutionAccess, "launchRun"> => {
  const { base: { iso, stopped, active, abortControllers }, runRows, sponsorship } = deps;
  const { continueSteps, runAgentic } = deps;
  // Mint the run and its record synchronously (so the id is known immediately), then
  // execute the whole automation on the returned `done` promise. Splitting the id from the
  // completion lets the tick collect runIds without blocking on each run to finish, and lets
  // it bound how long it waits on any single run (see runFiredSchedules).
  const launchRun = (
    app: AppRow,
    declared: Trigger,
    kind: TriggerSource["kind"],
    event: Json,
    /** The firing this run continues, when it is a re-run of one. */
    lineage?: RunId,
  ): { runId: RunId; done: Promise<void> } => {
    const trigger = validateTrigger(declared);
    const runId = id("run_");
    const eventName = triggerEvent(trigger.on);
    const record: InternalRunRecord = {
      id: runId,
      appId: app.doc.id,
      triggerId: trigger.id,
      trigger: { kind, ...(eventName === undefined ? {} : { event: eventName }) },
      status: "running",
      startedAt: iso(),
      steps: [],
      // What fired it, so `runs.rerun` can fire the same trigger on the same
      // event without the caller having to keep the payload.
      __event: clone(event),
      // The definition that fired, so a re-run cannot be renumbered by an edit
      // that landed after the failure.
      __trigger: clone(trigger),
      ...(lineage === undefined ? {} : { __lineage: lineage }),
    };
    const agentController = trigger.run.kind === "agentic" ? new AbortController() : undefined;
    if (agentController !== undefined) abortControllers.set(runId, agentController);
    const done = (async (): Promise<void> => {
      // Build contract §9.1 — asserting the owner's orgs is an I/O call (the
      // host's own query), so it happens INSIDE the run, not while minting its
      // id: `launchRun` stays synchronous so the tick can collect run ids
      // without blocking on any single automation. It is also fallible, which
      // is why the resolution sits inside the guarded block below and never
      // above it — a throw out here has no run row to attach itself to.
      try {
        // §9.9's gate runs BEFORE any step or agentic dispatch, and its two
        // outcomes both end the run LOUDLY — a persisted error row plus its own
        // audit event — because an automation that quietly stops firing is
        // indistinguishable from one nobody needs:
        //  - a lapsed sponsorship (the gate said no), and
        //  - a gate that could not ANSWER, because the host's memberships
        //    callback or access seam threw. That throw used to escape here, and
        //    the schedule path swallows a rejected run, so the whole firing
        //    vanished: no row, no audit, nothing to look at.
        let ctx = sponsorship.baseRunContext(record, app.subject);
        let stop:
          | { reason?: NonNullable<Sponsorship["reason"]>; summary: string; detail?: string }
          | undefined;
        try {
          ctx = await sponsorship.runContext(app.doc, record, app.subject);
          stop = await sponsorship.sponsorshipRefusal(app, trigger, ctx);
        } catch (error) {
          // The consumer sentence and the operator's detail part ways here:
          // `summary` is rendered verbatim in the automations panel, so
          // the host's raw throw rides the audit row below instead.
          stop = { summary: IDENTITY_UNAVAILABLE(app.doc.name), detail: message(error) };
        }
        if (stop !== undefined) {
          await runRows.writeRun(record);
          await runRows.audit(
            ctx,
            stop.reason === undefined ? "sponsorship-check-failed" : "sponsorship-invalidated",
            {
              ...(stop.reason === undefined ? {} : { reason: stop.reason }),
              summary: stop.summary,
              ...(stop.detail === undefined ? {} : { detail: stop.detail }),
            },
          );
          await runRows.terminal(record, ctx, "error", stop.summary, {
            code: stop.reason === undefined ? "error" : "blocked",
            message: stop.summary,
          });
          return;
        }
        await runRows.writeRun(record);
        await runRows.audit(ctx, "running");
        active.add(runId);
        try {
          if (trigger.run.kind === "steps") {
            await continueSteps(app, trigger, record, ctx, event);
          } else {
            await runAgentic(trigger, record, ctx, agentController!.signal);
          }
        } finally {
          active.delete(runId);
          stopped.delete(runId);
        }
      } finally {
        if (agentController !== undefined) abortControllers.delete(runId);
      }
    })();
    return { runId, done };
  };

  return { launchRun };
};

/** How a launched run is WAITED on: one at a time for the doors that need the
 *  id back, and bounded parallelism with an optional per-run timeout for a tick. */
const createRunPacing = (
  deps: Pick<RunExecutionDeps, "base"> & Pick<RunExecutionAccess, "launchRun">,
): Pick<RunExecutionAccess, "startRun" | "runFiredSchedules"> => {
  const { base: { config }, launchRun } = deps;
  const startRun = async (
    app: AppRow,
    trigger: Trigger,
    kind: TriggerSource["kind"],
    event: Json,
  ): Promise<RunId> => {
    const { runId, done } = launchRun(app, trigger, kind, event);
    await done;
    return runId;
  };
  const delay = (ms: number): Promise<void> => new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    // Never keep the event loop alive just for the tick's timeout.
    (timer as unknown as { unref?: () => void }).unref?.();
  });

  // Execute fired automations with bounded parallelism and an optional per-run timeout, so
  // one hung/slow run cannot block other tenants or overrun the tick interval. All runIds are
  // returned regardless of whether their run finished within the timeout (a timed-out run keeps
  // running detached and persists its own terminal state).
  const runFiredSchedules = async (fired: readonly FiredSchedule[]): Promise<RunId[]> => {
    const concurrency = Math.max(1, Math.floor(config.tickConcurrency ?? 4));
    const timeoutMs = config.runTimeoutMs;
    const ids: Array<RunId | undefined> = new Array(fired.length);
    let next = 0;
    const worker = async (): Promise<void> => {
      while (true) {
        const index = next;
        next += 1;
        if (index >= fired.length) return;
        const entry = fired[index] as FiredSchedule;
        let launched: { runId: RunId; done: Promise<void> };
        try {
          launched = launchRun(entry.row, entry.trigger, "schedule", {
            scheduledFor: entry.scheduledFor,
            firedAt: entry.firedAt,
          });
        } catch {
          // A run that cannot even start (e.g. an invalid trigger) is skipped so other
          // tenants' fired runs still proceed.
          continue;
        }
        ids[index] = launched.runId;
        // A detached (timed-out) run must never surface as an unhandled rejection.
        const settled = launched.done.catch(() => undefined);
        if (timeoutMs === undefined) await settled;
        else await Promise.race([settled, delay(timeoutMs)]);
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(concurrency, fired.length) }, () => worker()),
    );
    return ids.filter((value): value is RunId => value !== undefined);
  };

  return { startRun, runFiredSchedules };
};

export const createRunExecution = (deps: RunExecutionDeps): RunExecutionAccess => {
  const runners = { ...createStepsRunner(deps), ...createAgenticRunner(deps) };
  const launcher = createRunLauncher({ ...deps, ...runners });
  return { ...launcher, ...createRunPacing({ ...deps, ...launcher }) };
};
