import { join, resolve } from "node:path";
import { vendoSync, type SyncReportWithWarnings } from "@vendoai/actions";
import type { ToolImpact } from "../sync-impact.js";
import { pushSyncReport } from "./cloud/services.js";
import { consoleOutput, type Output } from "./shared.js";

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
  const output = options.output ?? consoleOutput;
  const json = options.json === true;
  // In --json mode, human lines that duplicate report fields are dropped and
  // CLI-level events collect into `notes`; stdout carries exactly one object.
  const notes: string[] = [];
  const note = (message: string): void => { if (json) notes.push(message); else output.log(message); };
  const noteError = (message: string): void => { if (json) notes.push(message); else output.error(message); };
  try {
    const root = resolve(options.targetDir);
    const report: SyncReportWithWarnings = await (options.sync ?? vendoSync)({
      root,
      out: join(root, ".vendo"),
      // The CLI needs the report to compute exit 2 vs 3; it applies strictness below.
      strict: false,
    });
    if (!json) {
      for (const warning of report.warnings) output.error(`warning: ${warning}`);
      output.log(`tools: +${report.tools.added.length} -${report.tools.removed.length} ~${report.tools.changed.length}`);
      output.log(`pins: ${report.pins.captured.length} captured, ${report.pins.drifted.length} drifted`);
    }

    const tools = [...new Set([
      ...report.breaking.map((breaking) => breaking.tool),
      ...report.tools.changed,
    ])];
    let impact: ToolImpact[] | undefined;
    if (tools.length > 0) {
      const impactUrl = (options.url ?? process.env.VENDO_URL ?? "http://localhost:3000/api/vendo").replace(/\/+$/, "");
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

    let exitCode: SyncJsonResult["exitCode"] = 0;
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
        report: { tools: { added: [], removed: [], changed: [] }, breaking: [], pins: { captured: [], drifted: [] }, warnings: [] },
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
