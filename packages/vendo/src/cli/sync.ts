import { join, resolve } from "node:path";
import { stdin, stdout } from "node:process";
import { vendoSync, type SyncReportWithWarnings } from "@vendoai/actions/sync";
import type { ToolImpact } from "../sync-impact.js";
import { pushSyncReport } from "./cloud/services.js";
import type { JudgmentPassOptions } from "./judge/pass.js";
import { createPrettyOutput, usePrettyOutput, type PrettyOutput } from "./pretty.js";
import { rendererFlowOptions, runSyncFlow, type SyncFlowResult } from "./sync-flow.js";
import { applyThemeDraft, toVendoTheme } from "./theme/extract-theme.js";
import { consoleOutput, invokedByPackageScript, withCommandRun, writeText, type Output, type TelemetryOptions } from "./shared.js";

export interface SyncReportPayload {
  report: SyncReportWithWarnings;
  impact?: ToolImpact[];
  at: string;
}

export interface SyncOptions {
  targetDir: string;
  strict?: boolean;
  output?: Output;
  sync?: typeof vendoSync;
  url?: string;
  fetchImpl?: typeof fetch;
  report?: boolean;
  push?: (report: SyncReportPayload) => Promise<void>;
  apiKey?: string;
  apiUrl?: string;
  json?: boolean;
  /** Injectable telemetry deps (matches init/doctor). */
  telemetry?: TelemetryOptions;
  /** --review: render the pending + new loosenings and ask before writing. */
  review?: boolean;
  /** --full: judge the whole catalog instead of only what moved. */
  full?: boolean;
  /** --ai / --no-ai (`--no-watermark` is the legacy spelling of `--no-ai`):
   *  `true` runs the judgment pass with no prompt, `false` forces it off, and
   *  `undefined` asks in an interactive run and skips otherwise. Identical to
   *  init's rule; no answer is ever persisted. */
  ai?: boolean;
  /** --yes: this run cannot ask (never prompt, take the flags as given). */
  yes?: boolean;
  /** --theme-refresh: take the deterministic theme scan's values even for
   *  slots a human hand-edited. */
  themeRefresh?: boolean;
  /** --engine: pin the judgment engine family (claude | codex | npx). */
  engine?: string;
  /** Test seam: interactivity override for the AI question (default: TTY),
   *  mirroring init's. */
  interactive?: boolean;
  /** Test seam: the wall-clock budget for each Cloud reconcile (pin baselines,
   *  registered components). */
  baselineBudgetMs?: number;
  /** --push-components / --no-push-components: send the registered-component
   *  source corpus to Vendo Cloud. `undefined` reads the project's saved answer
   *  (`.vendo/cloud.json`) and, with none, ASKS once in an interactive run. */
  pushComponents?: boolean;
  /** askYesNo seam for the component-upload question (tests inject an answer). */
  confirm?: (question: string, defaultYes?: boolean) => Promise<boolean>;
  /** Judgment-pass seams (tests / init's chosen harness). */
  judge?: Pick<JudgmentPassOptions,
    "harness" | "harnesses" | "resolveCredential" | "confirm" | "onProgress">;
}

/** `sync --json` — the one machine-readable object printed on stdout. */
export interface SyncJsonResult {
  ok: boolean;                       // exitCode === 0
  /** 1 = the run could not do what was asked (`--report` with no Cloud key);
   *  2 = uncapturable `<Remixable>` wrapper, or breaking changes under
   *  --strict; 3 = breaking changes with saved references. */
  exitCode: 0 | 1 | 2 | 3;
  report: SyncReportWithWarnings;
  /** [] = nothing referenced the changed tools; null = impact unknown (dev server unreachable). */
  impact: ToolImpact[] | null;
  /** CLI-level events not carried by the report (unreachable impact endpoint, report-push problems). */
  notes: string[];
  /** The theme re-scan: which slots this run took from the host, and which
   *  the host disagrees with but a human owns. null = no `.vendo/theme.json`
   *  to reconcile (run `vendo init`). */
  theme: { updated: string[]; pinned: string[] } | null;
  /** The pin baselines reconciled with Vendo Cloud. null = keyless/BYO — the
   *  baselines stayed on disk and no request was made. */
  baselines: { pushed: string[]; pruned: string[] } | null;
  /** The registered-component corpus reconciled with Vendo Cloud. null =
   *  keyless/BYO, or the project has not said yes — nothing left the machine. */
  components: { pushed: string[]; pruned: string[]; modules: { uploaded: number; deleted: number } } | null;
  error?: string;                    // present when extraction itself failed soft
}

function nonzero(entry: ToolImpact): boolean {
  return entry.apps.length > 0 || entry.automations.length > 0 || entry.grants > 0;
}

/** 04-actions §1 / 09-vendo §5 — fail-soft extraction, strict CI gate. */
export async function runSync(options: SyncOptions): Promise<number> {
  return withCommandRun(
    {
      command: "sync",
      root: options.targetDir,
      ...(options.telemetry === undefined ? {} : { telemetry: options.telemetry }),
    },
    () => sync(options),
  );
}

/** The `--report` push. Returns whether the run asked to report and could not
 *  — a `--report` that never reported is a failed run (self-serve audit B6:
 *  this used to complain and exit 0, so a CI reporting lane stayed green for
 *  as long as it never reported). */
async function pushReport(
  flow: SyncFlowResult,
  options: SyncOptions,
  noteError: (message: string) => void,
): Promise<boolean> {
  // The same resolved key the baseline push uses — a `--report` that saw a
  // different env from the reconcile beside it was a trap (#567's fix
  // applies to every keyed leg of a sync, not just the judgment pass).
  const apiKey = flow.cloudKey;
  if (!apiKey) {
    noteError("vendo sync: --report needs a Vendo Cloud key — run `vendo login`, set VENDO_API_KEY, or pass --key.");
    return true;
  }
  // `impact` rides along only when the check actually ran: nothing
  // changed means nothing could be impacted, and an empty array would
  // read to the console as a checked, clean blast radius.
  const report = flow.report;
  const checked = report.breaking.length > 0 || report.tools.changed.length > 0;
  const payload: SyncReportPayload = {
    report,
    ...(checked && flow.impact !== null ? { impact: flow.impact } : {}),
    at: new Date().toISOString(),
  };
  try {
    if (options.push !== undefined) await options.push(payload);
    else await pushSyncReport(payload, {
      apiKey,
      ...(options.apiUrl === undefined ? {} : { apiUrl: options.apiUrl }),
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    });
  } catch (error) {
    noteError(`warning: failed to push sync report: ${error instanceof Error ? error.message : "unknown error"}`);
  }
  return false;
}

/**
 * The theme fill `sync --full` used to pay for and throw away: full mode runs
 * the prose stages, waits on the model to fill the still-open brand slots, and
 * hands them back as `themeDraft`. `vendo init` consumes it (finalizeTheme);
 * `vendo sync` never read it — computed, never written, never printed. Same
 * two exports and the same merge law init uses, so there is one theme path.
 */
async function writeThemeDraft(root: string, flow: SyncFlowResult, output: Output): Promise<void> {
  if (flow.themeSummary === null || flow.themeDraft === null) return;
  const summary = applyThemeDraft(flow.themeSummary, flow.themeDraft);
  // `(model)` is the provenance assembleTheme stamps on a slot the draft
  // filled — an exact read is never overwritten, so this is exactly what the
  // tokens bought.
  const filled = Object.keys(summary.matched).filter((slot) => summary.matched[slot] === "(model)");
  if (filled.length === 0) return;
  await writeText(join(root, ".vendo", "theme.json"), `${JSON.stringify(toVendoTheme(summary.slots), null, 2)}\n`);
  output.log(`theme: ${filled.length} slot${filled.length === 1 ? "" : "s"} filled by the AI pass (${filled.join(", ")}) → .vendo/theme.json`);
}

/** The footer's "what moved", read off the report this run just printed. The
 *  footer REPORTS the outcome; it never decides it. */
function whatMoved(flow: SyncFlowResult): string | undefined {
  const moved: string[] = [];
  const { added, removed, changed } = flow.report.tools;
  if (added.length > 0) moved.push(`+${added.length} tool${added.length === 1 ? "" : "s"}`);
  if (removed.length > 0) moved.push(`-${removed.length} tool${removed.length === 1 ? "" : "s"}`);
  if (changed.length > 0) moved.push(`~${changed.length} changed`);
  if ((flow.baselines?.pushed.length ?? 0) + (flow.components?.pushed.length ?? 0) > 0) {
    moved.push("pushed to Cloud");
  }
  return moved.length === 0 ? undefined : moved.join(" · ");
}

/**
 * sync = the shared flow (sync-flow.ts) in "incremental" mode, plus the two
 * things that are the COMMAND's and not the flow's: the `--report` push and
 * the exit codes. Fail-soft on purpose — a sync problem must never break a
 * build — where `vendo init` runs the same flow in "full" mode and fails loud.
 */
async function sync(options: SyncOptions): Promise<number> {
  const json = options.json === true;
  // The same renderer `vendo init` uses, over the same Output seam and the
  // same gate: it restyles the exact plain strings below, and is selected only
  // for a human terminal. `--json` owns its stdout byte-for-byte, an injected
  // output is the caller's, and a package-script run (predev/prebuild) keeps
  // today's output — that one is the most-seen sync output there is.
  const pretty: PrettyOutput | null =
    options.output === undefined && !json && !invokedByPackageScript() && usePrettyOutput()
      ? createPrettyOutput({ command: "vendo sync" })
      : null;
  const output = options.output ?? pretty ?? consoleOutput;
  const started = Date.now();
  // In --json mode, human lines that duplicate report fields are dropped and
  // CLI-level events collect into `notes`; stdout carries exactly one object.
  const notes: string[] = [];
  const note = (message: string): void => { if (json) notes.push(message); else output.log(message); };
  const noteError = (message: string): void => { if (json) notes.push(message); else output.error(message); };
  try {
    const root = resolve(options.targetDir);
    // `--json` and `--yes` are non-interactive by construction, and so is a run
    // started by a package script: the `predev` hook an older init wrote has a
    // TTY, but the human asked for a dev server, not a question.
    const interactive = options.interactive
      ?? (options.yes !== true && !json && !invokedByPackageScript()
        && Boolean(stdin.isTTY) && Boolean(stdout.isTTY));
    const flow = await runSyncFlow({
      root,
      output: json ? { log() {}, error() {} } : output,
      mode: options.full === true ? "full" : "incremental",
      interactive,
      yes: options.yes === true,
      ...(options.ai === undefined ? {} : { ai: options.ai }),
      ...(options.engine === undefined ? {} : { engine: options.engine }),
      ...(options.review === undefined ? {} : { review: options.review }),
      ...(options.themeRefresh === undefined ? {} : { themeRefresh: options.themeRefresh }),
      ...(options.apiKey === undefined ? {} : { apiKey: options.apiKey }),
      ...(options.apiUrl === undefined ? {} : { apiUrl: options.apiUrl }),
      ...(options.url === undefined ? {} : { url: options.url }),
      ...(options.sync === undefined ? {} : { sync: options.sync }),
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
      ...rendererFlowOptions(pretty),
      ...(options.confirm === undefined ? {} : { confirm: options.confirm }),
      ...(options.judge === undefined ? {} : { judge: options.judge }),
      ...(options.pushComponents === undefined ? {} : { pushComponents: options.pushComponents }),
      ...(options.baselineBudgetMs === undefined ? {} : { baselineBudgetMs: options.baselineBudgetMs }),
    });
    notes.push(...flow.notes);
    await writeThemeDraft(root, flow, { log: note, error: noteError });
    const report = flow.report;

    const reportUnkeyed = options.report !== true
      ? false
      : await pushReport(flow, options, noteError);

    let exitCode: SyncJsonResult["exitCode"] = report.remixableErrors.length > 0 ? 2 : 0;
    if (options.strict === true && report.breaking.length > 0) {
      if (!json) for (const breaking of report.breaking) output.error(`breaking: ${breaking.tool} ${breaking.change}`);
      const breakingTools = new Set(report.breaking.map((breaking) => breaking.tool));
      exitCode = flow.impact?.some((entry) => breakingTools.has(entry.tool) && nonzero(entry)) === true ? 3 : 2;
    }
    // A --report that never reported is a failed run, whatever the catalog
    // said; the --strict codes are more specific, so they keep their meaning.
    if (reportUnkeyed && exitCode === 0) exitCode = 1;
    if (json) {
      const result: SyncJsonResult = {
        ok: exitCode === 0,
        exitCode,
        report,
        impact: flow.impact,
        notes,
        theme: flow.theme,
        baselines: flow.baselines,
        components: flow.components,
      };
      output.log(JSON.stringify(result, null, 2));
    }
    pretty?.done(Date.now() - started, exitCode === 0, whatMoved(flow));
    return exitCode;
  } catch (error) {
    const message = `sync failed soft: ${error instanceof Error ? error.message : "unknown error"}`;
    const exitCode = options.strict === true ? 2 : 0;
    if (json) {
      const result: SyncJsonResult = {
        ok: exitCode === 0,
        exitCode,
        report: { tools: { added: [], removed: [], changed: [] }, breaking: [], toolSchemas: { total: 0, inputs: { known: 0, unknown: [] }, outputs: { known: 0, unknown: [] } }, pins: { captured: [], drifted: [] }, remixableErrors: [], catalog: { discovered: 0, registered: 0 }, components: { captured: [], drifted: [] }, warnings: [] },
        impact: null,
        notes,
        theme: null,
        baselines: null,
        components: null,
        error: message,
      };
      output.log(JSON.stringify(result, null, 2));
    } else {
      output.error(`warning: ${message}`);
    }
    pretty?.done(Date.now() - started, exitCode === 0);
    return exitCode;
  }
}
