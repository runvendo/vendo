import { join, resolve } from "node:path";
import { vendoSync, type SyncReportWithWarnings } from "@vendoai/actions";
import { consoleOutput, type Output } from "./shared.js";

export interface SyncOptions {
  targetDir: string;
  strict?: boolean;
  output?: Output;
  sync?: typeof vendoSync;
}

/** 04-actions §1 / 09-vendo §5 — fail-soft extraction, strict CI gate. */
export async function runSync(options: SyncOptions): Promise<number> {
  const output = options.output ?? consoleOutput;
  try {
    const root = resolve(options.targetDir);
    const report: SyncReportWithWarnings = await (options.sync ?? vendoSync)({
      root,
      out: join(root, ".vendo"),
      strict: options.strict === true,
    });
    for (const warning of report.warnings) output.error(`warning: ${warning}`);
    output.log(`tools: +${report.tools.added.length} -${report.tools.removed.length} ~${report.tools.changed.length}`);
    output.log(`pins: ${report.pins.captured.length} captured, ${report.pins.drifted.length} drifted`);
    if (options.strict === true && report.breaking.length > 0) {
      for (const breaking of report.breaking) output.error(`breaking: ${breaking.tool} ${breaking.change}`);
      return 2;
    }
    return 0;
  } catch (error) {
    output.error(`warning: sync failed soft: ${error instanceof Error ? error.message : "unknown error"}`);
    return options.strict === true ? 2 : 0;
  }
}
