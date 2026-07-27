import { join, resolve } from "node:path";
import { vendoSync, type SyncReportWithWarnings } from "@vendoai/actions/sync";
import type { ToolImpact } from "../sync-impact.js";
import { pushSyncReport } from "./cloud/services.js";
import { mergeEnvOverDotEnv, readDotEnvFallback } from "./doctor.js";
import { askYesNo } from "./extract/extraction.js";
import { readPreviousToolsState, runSyncEnrichment, type SyncEnrichmentOptions } from "./enrich/pass.js";
import { syncSemantics } from "./semantics.js";
import { consoleOutput, withCommandRun, type Output, type TelemetryOptions } from "./shared.js";

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
  /** --review: show the AI enrichment narrative and confirm before writing. */
  review?: boolean;
  /** --full: force full re-enrichment (ignore the watermark diff). */
  full?: boolean;
  /** --no-watermark: workspace-internal sync — suppress the tools.json
   *  watermark field and skip the AI enrichment pass entirely (the demo
   *  apps' predev/prebuild hooks; committed files must not churn). */
  noWatermark?: boolean;
  /** --engine: pin the enrichment engine family (claude | codex | npx). */
  engine?: string;
  /** Enrichment seams (tests / init's chosen harness). */
  enrich?: Pick<SyncEnrichmentOptions,
    "harness" | "harnesses" | "resolveCredential" | "computeDiff" | "treeHash" | "confirm" | "onProgress">;
}

/** `sync --json` — the one machine-readable object printed on stdout. */
export interface SyncJsonResult {
  ok: boolean;                       // exitCode === 0
  exitCode: 0 | 2 | 3;
  report: SyncReportWithWarnings;
  /** [] = nothing referenced the changed tools; null = impact unknown (dev server unreachable). */
  impact: ToolImpact[] | null;
  /** CLI-level events not carried by the report (unreachable impact endpoint, report-push problems). */
  notes: string[];
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
    // Pre-sync snapshot for the AI pass: which srcHashes move and where the
    // watermark stood — read BEFORE the structural sync rewrites the file.
    const previousTools = options.noWatermark === true ? null : await readPreviousToolsState(vendoDir);
    const report: SyncReportWithWarnings = await (options.sync ?? vendoSync)({
      root,
      out: vendoDir,
      // The CLI needs the report to compute exit 2 vs 3; it applies strictness below.
      strict: false,
      ...(options.noWatermark === true ? { watermark: false } : {}),
    });
    if (!json) {
      for (const warning of report.warnings) output.error(`warning: ${warning}`);
      // Format v3: the engine's one-time legacy rewrite announces itself.
      if (report.migrated !== undefined) output.log(report.migrated);
      output.log(`tools: +${report.tools.added.length} -${report.tools.removed.length} ~${report.tools.changed.length}`);
      output.log(`pins: ${report.pins.captured.length} captured, ${report.pins.drifted.length} drifted`);
      output.log(`catalog.json: ${report.catalog.discovered} discovered, ${report.catalog.registered} registered`);
      if (report.pins.drifted.length > 0) {
        // 06-apps §8 — drift never auto-rebases: the fork's owner decides.
        output.log(`drifted: ${report.pins.drifted.join(", ")} — existing forks stay on the old capture until each owner rebases (POST /apps/:id/rebase-pin or the vendo_apps_rebase_pin agent tool)`);
      }
    }
    // Unresolved slots fail the run regardless of --strict (silent remix skips
    // are eliminated), but impact analysis, the report push, and the breaking
    // gate below still execute so the most severe exit code wins. In --json
    // mode the human lines are dropped: the pins ride in report.unresolvedPins.
    let unresolvedExit: 0 | 2 = 0;
    if (report.unresolvedPins.length > 0) {
      if (!json) {
        output.error("unresolved remixable slots:");
        for (const pin of report.unresolvedPins) {
          output.error(`  ${pin.slot} [${pin.reason}]: ${pin.hint}`);
        }
      }
      unresolvedExit = 2;
    }

    const wireUrl = (options.url ?? process.env.VENDO_URL ?? "http://localhost:3000/api/vendo").replace(/\/+$/, "");
    // W3 (format v3) — field semantics land inside .vendo/tools.json per tool
    // (one-time inference via the dev server; existing entries and host
    // annotations in overrides.json always win). Fail-soft like everything
    // else in sync.
    try {
      await syncSemantics({
        vendoDir: join(root, ".vendo"),
        url: wireUrl,
        ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
        note,
      });
    } catch (error) {
      note(`semantics sync failed soft: ${error instanceof Error ? error.message : "unknown error"}`);
    }

    // The AI enrichment pass (cse lane 1c): diff since the watermark + the
    // current catalog → restrictive-only updates to affected entries and a
    // change narrative. Keyless resolves to structural-only with one line;
    // --no-watermark (workspace-internal syncs) skips the pass entirely.
    // Fail-soft like everything else in sync — the exit code never changes.
    if (options.noWatermark !== true) {
      // The enrichment credential resolves from this env, so the project's
      // dotenv must be visible: `vendo login` and BYO keys land in `.env.local`
      // / `.env`, and a fresh shell that never `source`d them would otherwise
      // sync structural-only with no signal why (#567). Reuse doctor's parser
      // (never hand-roll) — real process env still wins over both files.
      // Precedence end to end: explicit > process.env > .env.local > .env.
      const enrichEnv = mergeEnvOverDotEnv(await readDotEnvFallback(root), process.env);
      try {
        await runSyncEnrichment({
          root,
          vendoDir,
          env: enrichEnv,
          note,
          warn: noteError,
          previous: previousTools,
          ...(options.review === true ? { review: true } : {}),
          ...(options.full === true ? { full: true } : {}),
          ...(options.engine === undefined ? {} : { engine: options.engine }),
          confirm: options.enrich?.confirm ?? askYesNo,
          ...(options.enrich?.harness === undefined ? {} : { harness: options.enrich.harness }),
          ...(options.enrich?.harnesses === undefined ? {} : { harnesses: options.enrich.harnesses }),
          ...(options.enrich?.resolveCredential === undefined ? {} : { resolveCredential: options.enrich.resolveCredential }),
          ...(options.enrich?.computeDiff === undefined ? {} : { computeDiff: options.enrich.computeDiff }),
          ...(options.enrich?.treeHash === undefined ? {} : { treeHash: options.enrich.treeHash }),
          ...(options.enrich?.onProgress === undefined ? {} : { onProgress: options.enrich.onProgress }),
        });
      } catch (error) {
        note(`enrichment failed soft: ${error instanceof Error ? error.message : "unknown error"}`);
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

    if (options.report === true) {
      const apiKey = options.apiKey ?? process.env.VENDO_API_KEY;
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

    // Unresolved slots set the floor; the strict breaking gate overrides with
    // its own (equal-or-worse) code, so the most severe exit wins.
    let exitCode: SyncJsonResult["exitCode"] = unresolvedExit;
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
        report: { tools: { added: [], removed: [], changed: [] }, breaking: [], pins: { captured: [], drifted: [] }, unresolvedPins: [], catalog: { discovered: 0, registered: 0 }, warnings: [] },
        impact: null,
        notes,
        error: message,
      };
      output.log(JSON.stringify(result, null, 2));
    } else {
      output.error(`warning: ${message}`);
    }
    return exitCode;
  }
}
