/**
 * 07 §5's `runs` namespace: the run history anyone who can edit the app reads,
 * the kill switch, and "run it again" — the remedy a fail-loud run leaves behind.
 *
 * Lifted out of `createAutomationsEngine` unchanged.
 */
import { VendoError, type RunId } from "@vendoai/core";
import type { AppRowsAccess } from "./app-rows.js";
import type { ArmedAccess } from "./armed.js";
import type { EngineBase } from "./engine-context.js";
import type { AutomationsEngine, RunRecord } from "./index.js";
import { parseRunRecord, publicRun } from "./rows.js";
import type { RunExecutionAccess } from "./run-execution.js";
import type { RunRowsAccess } from "./run-rows.js";
import type { SponsorshipGateAccess } from "./sponsorship-gate.js";
import { triggerOf } from "./sponsorship.js";
import { RUNS, RUNS_PAGE_LIMIT } from "./types.js";

export type RunsSurfaceDeps = {
  base: EngineBase;
  appRows: AppRowsAccess;
  armed: ArmedAccess;
  runRows: RunRowsAccess;
  sponsorship: SponsorshipGateAccess;
  execution: RunExecutionAccess;
};

/** The run history anyone who can edit the app reads. */
const createRunReadDoors = (
  deps: Pick<RunsSurfaceDeps, "base" | "appRows">,
): Pick<AutomationsEngine["runs"], "get" | "list"> => {
  const { base: { engine }, appRows } = deps;
  const runsGet: AutomationsEngine["runs"]["get"] = async (runId, ctx) => {
    const stored = await engine.get(RUNS, runId);
    if (stored === null) return null;
    const run = parseRunRecord(stored);
    // §8 editor = edit: the person the automation RUNS AS sees its history, not
    // only the app's owner. Ownership-only when no access seam is configured.
    return await appRows.editableAppOrNull(run.appId, ctx) === null ? null : publicRun(run);
  };

  const runsList: AutomationsEngine["runs"]["list"] = async (filter, ctx) => {
    // Scope BEFORE paginating: filtering after the page both under-fills pages
    // and leaks a cursor (an existence oracle) to non-viewers.
    if (filter.appId !== undefined && await appRows.editableAppOrNull(filter.appId, ctx) === null) {
      return { runs: [] };
    }
    const refs = {
      ...(filter.appId === undefined ? {} : { app_id: filter.appId }),
      ...(filter.status === undefined ? {} : { status: filter.status }),
    };
    const runs: RunRecord[] = [];
    const visible = new Map<string, boolean>();
    let cursor = filter.cursor;
    // Without an appId scope, walk store pages until a page is filled with the
    // caller's runs — bounded so a foreign-heavy table cannot be scanned
    // unboundedly. Each fetch asks for exactly the remaining page budget, so
    // the store cursor always sits at the consumption boundary: pages never
    // overfill and the returned cursor never skips rows.
    for (let pages = 0; pages < 20 && runs.length < RUNS_PAGE_LIMIT; pages += 1) {
      const page = await engine.list(RUNS, {
        refs,
        limit: RUNS_PAGE_LIMIT - runs.length,
        ...(cursor === undefined ? {} : { cursor }),
      });
      for (const stored of page.records) {
        const run = parseRunRecord(stored);
        // The trigger filter is applied HERE rather than as a store ref: runs are
        // indexed by app and status, and a run row's trigger id lives inside its
        // record. The page walk below already tolerates an under-filled page.
        if (filter.triggerId !== undefined && run.triggerId !== filter.triggerId) continue;
        let mine = visible.get(run.appId);
        if (mine === undefined) {
          mine = await appRows.editableAppOrNull(run.appId, ctx) !== null;
          visible.set(run.appId, mine);
        }
        if (mine) runs.push(publicRun(run));
      }
      cursor = page.cursor;
      if (cursor === undefined) break;
    }
    return { runs, ...(cursor === undefined ? {} : { cursor }) };
  };

  return { get: runsGet, list: runsList };
};

/** The two doors that CHANGE a run: the kill switch, and "run it again". */
const createRunControlDoors = (
  deps: RunsSurfaceDeps,
): Pick<AutomationsEngine["runs"], "stop" | "rerun"> => {
  const { base: { engine, stopped, active, abortControllers }, appRows } = deps;
  const { armed, runRows, sponsorship, execution } = deps;
  const runsStop: AutomationsEngine["runs"]["stop"] = async (runId, ctx) => {
    const stored = await engine.get(RUNS, runId);
    if (stored === null) throw new VendoError("not-found", `run not found: ${runId}`);
    const run = parseRunRecord(stored);
    const app = await appRows.editableAppOrNull(run.appId, ctx);
    if (app === null) throw new VendoError("not-found", `run not found: ${runId}`);
    if (run.status !== "running") {
      throw new VendoError("conflict", `run cannot be stopped from status ${run.status}`);
    }
    stopped.add(runId);
    abortControllers.get(runId)?.abort();
    const runCtx = await sponsorship.runContext(app.row.doc, run, app.row.subject);
    await runRows.terminal(run, runCtx, "stopped", "stopped by user");
    if (!active.has(runId)) stopped.delete(runId);
  };

  /** Run it again. The remedy a fail-loud run leaves behind: whoever granted the
   *  missing permission taps this and the automation fires again from the top,
   *  on the same event, against LIVE data.
   *
   *  It is a FRESH run and not a continuation on purpose — nothing mid-run is
   *  restored, nothing is replayed. Safety for the work the first attempt did
   *  land is the guard's effect ledger's job (build contract §7), not a
   *  bookkeeping layer here.
   *
   *  Gated exactly like `stop`: anyone who can edit the app, existence-masked
   *  for anyone who cannot. A trigger nobody has armed is refused rather than
   *  fired — "run it again" may not be a way to run something switched off. */
  const runsRerun: AutomationsEngine["runs"]["rerun"] = async (runId, ctx) => {
    const stored = await engine.get(RUNS, runId);
    if (stored === null) throw new VendoError("not-found", `run not found: ${runId}`);
    const run = parseRunRecord(stored);
    const app = await appRows.editableAppOrNull(run.appId, ctx);
    if (app === null) throw new VendoError("not-found", `run not found: ${runId}`);
    const declared = triggerOf(app.row.doc, run.triggerId);
    if (declared === undefined) {
      throw new VendoError("conflict", `app has no trigger "${run.triggerId}" any more`);
    }
    if (!await armed.isArmed(app.row, run.triggerId)) {
      throw new VendoError("conflict", "this automation is off — turn it on to run it again");
    }
    // A run row from before the event was persisted has nothing to re-fire.
    // Refused rather than fired on an invented empty event: the steps' own
    // JSONata reads `event.*`, so an empty payload is a different run.
    if (run.__event === undefined) {
      throw new VendoError("conflict", "this run is from before re-runs were possible");
    }
    // The ROOT of the firing, so re-running a re-run keeps one lineage instead of
    // a chain: every run of this firing then shares one effect ledger, and the
    // second re-run still sees what the first already completed.
    // The definition that FIRED, not the one declared now: `declared` above is
    // what proves the trigger still exists and is armed, but firing an edited
    // step list under the original lineage would move a completed call's
    // positional id off its own receipt and run it a second time.
    const { runId: freshId, done } = execution.launchRun(
      app.row,
      run.__trigger ?? declared,
      run.trigger.kind,
      run.__event,
      (run.__lineage ?? run.id) as RunId,
    );
    await done;
    return freshId;
  };

  return { stop: runsStop, rerun: runsRerun };
};

export const createRunsSurface = (deps: RunsSurfaceDeps): AutomationsEngine["runs"] =>
  ({ ...createRunReadDoors(deps), ...createRunControlDoors(deps) });
