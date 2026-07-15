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
  try {
    const root = resolve(options.targetDir);
    const report: SyncReportWithWarnings = await (options.sync ?? vendoSync)({
      root,
      out: join(root, ".vendo"),
      // The CLI needs the report to compute exit 2 vs 3; it applies strictness below.
      strict: false,
    });
    for (const warning of report.warnings) output.error(`warning: ${warning}`);
    output.log(`tools: +${report.tools.added.length} -${report.tools.removed.length} ~${report.tools.changed.length}`);
    output.log(`pins: ${report.pins.captured.length} captured, ${report.pins.drifted.length} drifted`);

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
        printImpact(output, impact);
      } catch {
        output.log(`impact unknown — dev server not reachable at ${impactUrl}`);
      }
    }

    if (options.report === true) {
      const apiKey = options.apiKey ?? process.env.VENDO_API_KEY;
      if (!apiKey) {
        output.error("--report requires VENDO_API_KEY or --key");
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
          output.error(`warning: failed to push sync report: ${error instanceof Error ? error.message : "unknown error"}`);
        }
      }
    }

    if (options.strict === true && report.breaking.length > 0) {
      for (const breaking of report.breaking) output.error(`breaking: ${breaking.tool} ${breaking.change}`);
      const breakingTools = new Set(report.breaking.map((breaking) => breaking.tool));
      return impact?.some((entry) => breakingTools.has(entry.tool) && nonzero(entry)) === true ? 3 : 2;
    }
    return 0;
  } catch (error) {
    output.error(`warning: sync failed soft: ${error instanceof Error ? error.message : "unknown error"}`);
    return options.strict === true ? 2 : 0;
  }
}
