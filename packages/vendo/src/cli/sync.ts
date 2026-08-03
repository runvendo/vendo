import { join, resolve } from "node:path";
import { stdin, stdout } from "node:process";
import { vendoSync, type SyncReportWithWarnings } from "@vendoai/actions/sync";
import type { ToolImpact } from "../sync-impact.js";
import { pushPinBaselines } from "./cloud/pin-baselines.js";
import { pushSyncReport } from "./cloud/services.js";
import { mergeEnvOverDotEnv, readDotEnvFallback } from "./doctor.js";
import { runJudgmentPass, type JudgmentPassOptions } from "./judge/pass.js";
import { extractTheme } from "./theme/extract-theme.js";
import { baseFrom, mergeExtraction, readBase, writeBase } from "./theme/provenance.js";
import { askYesNo, consoleOutput, exists, invokedByPackageScript, readOptional, withCommandRun, writeText, type Output, type TelemetryOptions } from "./shared.js";

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
  /** Test seam: the wall-clock budget for the whole pin-baseline reconcile. */
  baselineBudgetMs?: number;
  /** Judgment-pass seams (tests / init's chosen harness). */
  judge?: Pick<JudgmentPassOptions,
    "harness" | "harnesses" | "resolveCredential" | "confirm" | "onProgress">;
}

/** `sync --json` — the one machine-readable object printed on stdout. */
export interface SyncJsonResult {
  ok: boolean;                       // exitCode === 0
  /** 2 = uncapturable `<Remixable>` wrapper, or breaking changes under
   *  --strict; 3 = breaking changes with saved references. */
  exitCode: 0 | 2 | 3;
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
  error?: string;                    // present when extraction itself failed soft
}

function impactResponse(value: unknown): ToolImpact[] {
  if (typeof value !== "object" || value === null || !Array.isArray((value as { impact?: unknown }).impact)) {
    throw new Error("invalid sync impact response");
  }
  const impact = (value as { impact: unknown[] }).impact;
  for (const entry of impact) {
    if (typeof entry !== "object" || entry === null) throw new Error("invalid sync impact response");
    const candidate = entry as Partial<ToolImpact>;
    if (typeof candidate.tool !== "string" || !Array.isArray(candidate.apps)
      || !Array.isArray(candidate.automations) || typeof candidate.grants !== "number") {
      throw new Error("invalid sync impact response");
    }
  }
  return impact as ToolImpact[];
}

function printImpact(output: Output, impact: ToolImpact[]): void {
  for (const entry of impact) {
    const categories = [
      [entry.automations.length, "automation"],
      [entry.apps.length, "app"],
      [entry.grants, "grant"],
    ] as const;
    const references = categories
      .filter(([count]) => count > 0)
      .map(([count, label]) => `${count} ${label}${count === 1 ? "" : "s"}`);
    output.log(references.length === 0
      ? `impact: ${entry.tool} no saved references`
      : `impact: ${entry.tool} breaks ${references.join(", ")}`);
  }
}

function nonzero(entry: ToolImpact): boolean {
  return entry.apps.length > 0 || entry.automations.length > 0 || entry.grants > 0;
}

/**
 * The theme re-scan (decision 3): a rebrand must reach Vendo, but a hand edit
 * must never be clobbered. Deterministic, keyless, and fail-soft — a theme
 * problem is a note, never an exit code. See theme/provenance.ts for the law.
 */
async function reconcileTheme(
  root: string,
  vendoDir: string,
  force: boolean,
  note: (message: string) => void,
): Promise<SyncJsonResult["theme"]> {
  const raw = await readOptional(join(vendoDir, "theme.json"));
  if (raw === null) return null;
  let theme: unknown;
  try {
    theme = JSON.parse(raw);
  } catch {
    note("theme: .vendo/theme.json is not valid JSON — skipped (fix it, or delete it and re-run `vendo init`)");
    return null;
  }
  const summary = await extractTheme(root);
  const base = await readBase(vendoDir);
  const merge = mergeExtraction({ theme, base, summary, ...(force ? { force: true } : {}) });
  if (merge.theme !== null) {
    await writeText(join(vendoDir, "theme.json"), `${JSON.stringify(merge.theme, null, 2)}\n`);
  }
  // The base advances whenever this run is unambiguous — everything agreed, or
  // every disagreement was resolved. While disagreements remain unresolved it
  // stays put, so the warning repeats every sync instead of quietly baking the
  // stale value in as the new truth.
  if (merge.pinned.length === 0) await writeBase(vendoDir, baseFrom(summary));
  // One line, and every claim in it is literally true: "re-read" names ONLY
  // the slots just written to theme.json, and a pinned slot shows BOTH values
  // so nobody can read it as "your accent now tracks your CSS" — the earlier
  // `accent → #b91c1c` phrasing read exactly like that assignment.
  const parts: string[] = [];
  if (merge.updated.length > 0) {
    parts.push(`${merge.updated.length} slot${merge.updated.length === 1 ? "" : "s"} re-read from your app (${merge.updated.join(", ")}) → .vendo/theme.json`);
  }
  if (merge.pinned.length > 0) {
    const detail = merge.pinned.map((entry) => `${entry.slot} — yours ${entry.mine} vs your app's ${entry.theirs}`).join("; ");
    parts.push(`${merge.pinned.length} pinned by you, unchanged (${detail}) — \`vendo sync --theme-refresh\` takes your app's values`);
  }
  if (parts.length > 0) note(`theme: ${parts.join(" · ")}`);
  return { updated: merge.updated, pinned: merge.pinned.map((entry) => entry.slot) };
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

async function sync(options: SyncOptions): Promise<number> {
  const output = options.output ?? consoleOutput;
  const json = options.json === true;
  // In --json mode, human lines that duplicate report fields are dropped and
  // CLI-level events collect into `notes`; stdout carries exactly one object.
  const notes: string[] = [];
  const note = (message: string): void => { if (json) notes.push(message); else output.log(message); };
  const noteError = (message: string): void => { if (json) notes.push(message); else output.error(message); };
  try {
    const root = resolve(options.targetDir);
    const vendoDir = join(root, ".vendo");
    const report: SyncReportWithWarnings = await (options.sync ?? vendoSync)({
      root,
      out: vendoDir,
      // The CLI needs the report to compute exit 2 vs 3; it applies strictness below.
      strict: false,
    });
    if (!json) {
      for (const warning of report.warnings) output.error(`warning: ${warning}`);
      output.log(`tools: +${report.tools.added.length} -${report.tools.removed.length} ~${report.tools.changed.length}`);
      output.log(`pins: ${report.pins.captured.length} captured, ${report.pins.drifted.length} drifted`);
      for (const slot of report.pins.pruned ?? []) {
        output.log(`pruned: ${slot} — stale baseline deleted (no <Remixable> wrapper names this slot anymore)`);
      }
      output.log(`catalog.json: ${report.catalog.discovered} discovered, ${report.catalog.registered} registered`);
      if (report.pins.drifted.length > 0) {
        // 06-apps §8 — drift never auto-rebases: the fork's owner decides.
        output.log(`drifted: ${report.pins.drifted.join(", ")} — existing forks stay on the old capture until each owner rebases (POST /apps/:id/rebase-pin or the vendo_apps_rebase_pin agent tool)`);
      }
    }
    // A `<Remixable>` wrapper that cannot capture is a hard error (final-shape
    // spec 2026-08-02): the constraint — one statically importable child — is
    // defended loudly at sync time, never degraded silently. In --json mode
    // the human lines are dropped: the errors ride in report.remixableErrors.
    if (report.remixableErrors.length > 0 && !json) {
      output.error("error: <Remixable> wrappers that cannot be captured:");
      for (const remixableError of report.remixableErrors) {
        output.error(`  ${remixableError}`);
      }
    }

    const wireUrl = (options.url ?? process.env.VENDO_URL ?? "http://localhost:3000/api/vendo").replace(/\/+$/, "");

    // Theme (decision 3): sync owns the WHOLE scan, so a rebrand reaches Vendo
    // instead of the agent rendering the old brand forever. Runs before the
    // judgment pass so `--json` still emits exactly one object at the end.
    const theme = await reconcileTheme(root, vendoDir, options.themeRefresh === true, note);

    // The credential env for both the judgment pass and the Cloud key: the
    // project's dotenv must be visible, because `vendo login` and BYO keys land
    // in `.env.local` / `.env` and a fresh shell that never `source`d them
    // would otherwise sync structural-only with no signal why (#567). Reuse
    // doctor's parser (never hand-roll) — real process env still wins over both
    // files. Precedence end to end: explicit > process.env > .env.local > .env.
    const env = mergeEnvOverDotEnv(await readDotEnvFallback(root), process.env);

    // The judgment pass: grade the freshly synced catalog, with a verbatim
    // quote behind every proposal and an independent skeptic checking each one.
    // Hardenings and prose apply themselves; loosenings wait for a human —
    // `--review` asks now, otherwise they queue as `pending`. Keyless resolves
    // to one structural-only line. Fail-soft like everything else in sync — the
    // exit code never changes.
    //
    // Consent (decision 2, identical to init's rule): `--ai` runs it, `--no-ai`
    // skips it, and with neither flag an interactive run ASKS — every run,
    // because no answer is ever persisted — while a non-interactive one skips,
    // so CI builds stay deterministic and never spend. `--json` and `--yes`
    // are non-interactive by construction, and so is a run started by a
    // package script: the `predev` hook an older init wrote has a TTY, but the
    // human asked for a dev server, not a question (invokedByPackageScript).
    const interactive = options.interactive
      ?? (options.yes !== true && !json && !invokedByPackageScript()
        && Boolean(stdin.isTTY) && Boolean(stdout.isTTY));
    let runAi = options.ai;
    if (runAi === undefined) {
      runAi = interactive
        && await (options.judge?.confirm ?? askYesNo)(
          "Let a coding agent read this codebase to grade the tools sync just extracted? Source goes to your model provider under your account.",
          true,
        );
      if (!runAi && !interactive) {
        note("judgment: skipped — this run cannot ask (pass `--ai` to judge non-interactively, `--no-ai` to say so explicitly)");
      }
    }
    if (runAi) {
      try {
        await runJudgmentPass({
          root,
          out: vendoDir,
          mode: options.full === true ? "full" : "incremental",
          loosenings: options.review === true ? "review" : "queue",
          env,
          // --json keeps exactly one object on stdout, so the pass's narrative
          // rides the same `notes` channel every other human line does.
          output: { log: note, error: noteError },
          ...(options.engine === undefined ? {} : { engine: options.engine }),
          confirm: options.judge?.confirm ?? askYesNo,
          ...(options.judge?.harness === undefined ? {} : { harness: options.judge.harness }),
          ...(options.judge?.harnesses === undefined ? {} : { harnesses: options.judge.harnesses }),
          ...(options.judge?.resolveCredential === undefined ? {} : { resolveCredential: options.judge.resolveCredential }),
          ...(options.judge?.onProgress === undefined ? {} : { onProgress: options.judge.onProgress }),
        });
      } catch (error) {
        note(`judgment failed soft: ${error instanceof Error ? error.message : "unknown error"}`);
      }
    }

    const tools = [...new Set([
      ...report.breaking.map((breaking) => breaking.tool),
      ...report.tools.changed,
    ])];
    let impact: ToolImpact[] | undefined;
    if (tools.length > 0) {
      const impactUrl = wireUrl;
      try {
        const response = await (options.fetchImpl ?? fetch)(`${impactUrl}/sync/impact`, {
          method: "POST",
          headers: { accept: "application/json", "content-type": "application/json" },
          body: JSON.stringify({ tools }),
        });
        if (!response.ok) throw new Error(`sync impact returned ${response.status}`);
        impact = impactResponse(await response.json());
        if (!json) printImpact(output, impact);
      } catch {
        note(`impact unknown — dev server not reachable at ${impactUrl}`);
      }
    }

    // Pin baselines → Vendo Cloud (decision 4). Part of a NORMAL keyed sync,
    // not something `--report` gates: the console's Remix reviews screen cannot
    // show a fork's diff without the host baseline it forked from. Keyless/BYO
    // makes no request at all, and a Cloud hiccup is a note — never a failed
    // build. What crosses the wire is the captured component source; see
    // cloud/pin-baselines.ts.
    const cloudKey = options.apiKey ?? env.VENDO_API_KEY;
    // No `.vendo/remixable/` at all means this host has never had a wrapper —
    // nothing to push, and nothing Cloud could be holding to prune.
    let baselines: SyncJsonResult["baselines"] = null;
    if (await exists(join(vendoDir, "remixable")) && cloudKey !== undefined && cloudKey.trim() !== "") {
      // Never throws: whatever landed before a failure is still accounted for,
      // so `--json` can't report `null` over rows that really did reach Cloud.
      const result = await pushPinBaselines({
        vendoDir,
        apiKey: cloudKey,
        ...(options.apiUrl === undefined ? {} : { baseUrl: options.apiUrl }),
        ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
        ...(options.baselineBudgetMs === undefined ? {} : { budgetMs: options.baselineBudgetMs }),
      });
      baselines = { pushed: result.pushed, pruned: result.pruned };
      if (result.unreadable.length > 0) {
        // A file that exists but won't parse is a half-written capture, not a
        // deleted slot — its Cloud row was deliberately left in place.
        noteError(`warning: unreadable baselines left untouched in Vendo Cloud: ${result.unreadable.join(", ")} — re-run sync to recapture .vendo/remixable/<slot>.json`);
      }
      if (result.pushed.length > 0 || result.pruned.length > 0) {
        note(`baselines → Vendo Cloud: ${result.pushed.length} pushed, ${result.pruned.length} pruned (component source crosses the wire so the console can review forks)`);
      }
      if (result.error !== undefined) {
        noteError(`warning: pin baselines did not fully reach Vendo Cloud: ${result.error} — the rest stay in .vendo/remixable/ and the next sync retries`);
      }
    }

    if (options.report === true) {
      // The same resolved key the baseline push uses — a `--report` that saw a
      // different env from the reconcile beside it was a trap (#567's fix
      // applies to every keyed leg of a sync, not just the judgment pass).
      const apiKey = cloudKey;
      if (!apiKey) {
        noteError("--report requires VENDO_API_KEY or --key");
      } else {
        const payload: SyncReportPayload = {
          report,
          ...(impact === undefined ? {} : { impact }),
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
      }
    }

    let exitCode: SyncJsonResult["exitCode"] = report.remixableErrors.length > 0 ? 2 : 0;
    if (options.strict === true && report.breaking.length > 0) {
      if (!json) for (const breaking of report.breaking) output.error(`breaking: ${breaking.tool} ${breaking.change}`);
      const breakingTools = new Set(report.breaking.map((breaking) => breaking.tool));
      exitCode = impact?.some((entry) => breakingTools.has(entry.tool) && nonzero(entry)) === true ? 3 : 2;
    }
    if (json) {
      const result: SyncJsonResult = {
        ok: exitCode === 0,
        exitCode,
        report,
        // Nothing changed → nothing could be impacted; changes without a
        // reachable dev server → unknown, surfaced as null plus a note.
        impact: impact ?? (tools.length === 0 ? [] : null),
        notes,
        theme,
        baselines,
      };
      output.log(JSON.stringify(result, null, 2));
    }
    return exitCode;
  } catch (error) {
    const message = `sync failed soft: ${error instanceof Error ? error.message : "unknown error"}`;
    const exitCode = options.strict === true ? 2 : 0;
    if (json) {
      const result: SyncJsonResult = {
        ok: exitCode === 0,
        exitCode,
        report: { tools: { added: [], removed: [], changed: [] }, breaking: [], pins: { captured: [], drifted: [] }, remixableErrors: [], catalog: { discovered: 0, registered: 0 }, warnings: [] },
        impact: null,
        notes,
        theme: null,
        baselines: null,
        error: message,
      };
      output.log(JSON.stringify(result, null, 2));
    } else {
      output.error(`warning: ${message}`);
    }
    return exitCode;
  }
}
