import { join, resolve } from "node:path";
import { z } from "zod";
import { vendoSync } from "@vendoai/actions/sync";
import type { Telemetry } from "@vendoai/telemetry";
import { detectDepVersions } from "../dep-versions.js";
import { detectFramework } from "../framework.js";
import { applyDraft, reportApplied } from "./extraction.js";
import { parseDraft } from "./harness.js";
import { staticToolSchema, type StaticTool } from "./stages.js";
import {
  consoleOutput,
  readOptional,
  withCommandRun,
  type Output,
  type TelemetryOptions,
} from "../shared.js";

/**
 * `vendo extract --apply <draft.json>` — the delegation surface. An external
 * coding agent read the codebase against the aiPolish contract from
 * `vendo init --agent` and wrote a draft; this command parses it (the same
 * parseDraft init's built-in pass uses), runs the SAME deterministic guards
 * (applyDraft), writes the same artifacts, re-syncs, and prints the same
 * summary. Non-interactive safe; exits non-zero on an unusable draft.
 */

export interface ExtractApplyOptions {
  targetDir: string;
  /** Path to the draft file (cwd-relative or absolute). */
  apply: string;
  force?: boolean;
  output?: Output;
  /** Test seam (matches sync.ts): the re-sync implementation. */
  sync?: (input: { root: string; out: string }) => Promise<{ warnings: string[] }>;
  /** Injectable telemetry deps (matches init/doctor). */
  telemetry?: TelemetryOptions;
}

function describeError(error: unknown): string {
  if (error instanceof z.ZodError) {
    return error.issues
      .slice(0, 5)
      .map((issue) => `${issue.path.join(".") || "draft"}: ${issue.message}`)
      .join("; ");
  }
  return error instanceof Error ? error.message : "unknown error";
}

export async function runExtractApply(options: ExtractApplyOptions): Promise<number> {
  const output = options.output ?? consoleOutput;
  const root = resolve(options.targetDir);
  const started = Date.now();
  return withCommandRun(
    {
      command: "extract",
      root,
      ...(options.telemetry === undefined ? {} : { telemetry: options.telemetry }),
    },
    (failure, telemetry) => extractApply(options, output, root, started, failure, telemetry),
  );
}

async function extractApply(
  options: ExtractApplyOptions,
  output: Output,
  root: string,
  started: number,
  failure: { failedStep?: string },
  telemetry: Telemetry,
): Promise<number> {
  const toolsRaw = await readOptional(join(root, ".vendo", "tools.json"));
  if (toolsRaw === null) {
    failure.failedStep = "tools";
    output.error("No .vendo/tools.json here — run `vendo init` first, then apply the draft.");
    return 1;
  }
  let tools: StaticTool[];
  try {
    tools = z.object({ tools: z.array(staticToolSchema) }).parse(JSON.parse(toolsRaw)).tools;
  } catch (error) {
    failure.failedStep = "tools";
    output.error(`.vendo/tools.json is unreadable (${describeError(error)}) — run \`vendo sync\` and try again.`);
    return 1;
  }

  // readOptional only maps ENOENT to null — a directory (EISDIR) or a
  // permission error must still exit honestly, not as an uncaught crash.
  let draftRaw: string | null;
  try {
    draftRaw = await readOptional(resolve(options.apply));
  } catch (error) {
    failure.failedStep = "draft";
    output.error(`Draft file unreadable: ${options.apply} (${describeError(error)})`);
    return 1;
  }
  if (draftRaw === null) {
    failure.failedStep = "draft";
    output.error(`Draft file not found: ${options.apply}`);
    return 1;
  }
  let draft: ReturnType<typeof parseDraft>;
  try {
    draft = parseDraft(draftRaw);
  } catch (error) {
    failure.failedStep = "draft";
    output.error(`Draft rejected — it must match the aiPolish.draftSchema from \`vendo init --agent\` (${describeError(error)}).`);
    return 1;
  }

  // applyDraft throws on a hand-edited overrides.json it cannot parse — the
  // same honest-exit contract applies, never an unhandled stack trace.
  let applied: Awaited<ReturnType<typeof applyDraft>>;
  try {
    applied = await applyDraft({
      root,
      draft,
      tools,
      ...(options.force === undefined ? {} : { force: options.force }),
    });
  } catch (error) {
    failure.failedStep = "apply";
    output.error(`Could not apply the draft (${describeError(error)}) — check .vendo/overrides.json and re-apply.`);
    return 1;
  }
  // Same as init's built-in pass: a successful apply re-syncs so tools.json
  // reflects the polish immediately.
  try {
    const resynced = await (options.sync ?? vendoSync)({ root, out: join(root, ".vendo") });
    for (const warning of resynced.warnings) output.error(`warning: ${warning}`);
  } catch (error) {
    failure.failedStep = "resync";
    output.error(`Draft applied, but re-sync failed (${describeError(error)}) — run \`vendo sync\` to refresh tools.json.`);
    return 1;
  }
  reportApplied({ output, applied, briefDrafted: applied.briefWritten });

  // Result metrics (counts and enums only; TELEMETRY.md extract_completed).
  // Guarded like the wrapper: telemetry can never change the exit code.
  try {
    const framework = await detectFramework(root);
    // staticToolSchema strips bindings — count route tools off the raw file.
    const bindings = (JSON.parse(toolsRaw) as { tools?: Array<{ binding?: { kind?: string } }> }).tools ?? [];
    const routeCount = bindings.filter((tool) => tool.binding?.kind === "route").length;
    const versions = await detectDepVersions(root, framework);
    await telemetry.track("extract_completed", {
      framework,
      // route-scan today; "zod" reserved for a future oracle-backed detect.
      method: routeCount > 0 ? "route-scan" : "none",
      routeCount,
      toolCount: tools.length,
      ok: true,
      durationMs: Date.now() - started,
      ...(versions.frameworkVersion === undefined ? {} : { frameworkVersion: versions.frameworkVersion }),
      ...(versions.zodVersion === undefined ? {} : { zodVersion: versions.zodVersion }),
    });
  } catch {
    // Intentional silent failure.
  }
  return 0;
}
