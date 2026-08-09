import { join } from "node:path";
import type { z } from "zod";
import {
  applyJudgment,
  judgmentsFileSchema,
  toolsFileSchema,
  type ExtractedTool,
} from "@vendoai/actions";
import type { ExtractionHarness } from "./extract/harness.js";
import {
  applyBrief,
  runBriefStage,
  runThemeStage,
  type JudgedSummary,
  type ThemeStageInput,
} from "./extract/stages.js";
import type { ResolveEngineOptions } from "./judge/engine.js";
import type { SelectOption } from "./pretty.js";
import { readOptional, type Output } from "./shared.js";
import type { modelThemeSchema } from "./theme/extract-theme.js";

/**
 * The PROSE half of the model-assisted step — the product brief and the theme
 * fill — run once the judgment pass has settled names and descriptions.
 *
 * Consent, engine selection and the pass itself are NOT here: they belong to
 * the one shared flow (`sync-flow.ts`), so `vendo init` and `vendo sync` ask
 * the same question once, in one implementation. What lives here is what to do
 * after an engine has been chosen.
 */

/** init's AI-polish seam, in init's own flat spelling — tests reach the engine
 *  ladder and the consent question through it. `runInit` maps it onto the
 *  shared flow's options. */
export interface InitPolishSeam {
  /** --ai / --no-ai: `true` runs without asking (even non-interactively),
      `false` skips, `undefined` asks in an interactive run and skips
      otherwise. Never persisted anywhere. */
  ai?: boolean;
  /** --engine: pin the rung family (claude | codex | npx) instead of
      first-available. An unavailable pin skips loudly — never a fallback. */
  engine?: string;
  harnesses?: ExtractionHarness[];
  confirm?: (question: string, defaultYes: boolean) => Promise<boolean>;
  /** The multi-engine consent select (init passes pretty.select); default is
      the plain numbered select. Resolves to an option value or "skip". */
  choose?: (question: string, options: SelectOption[], defaultIndex: number) => Promise<string>;
  interactive?: boolean;
  resolveCredential?: ResolveEngineOptions["resolveCredential"];
}

/** The EFFECTIVE catalog the brief prompt reads: skeleton ⊕ standing judgments.
 *  Anything unreadable degrades to an empty list — the brief stage still has
 *  the code itself, and a missing artifact is never worth failing init over. */
async function judgedSummaries(vendoDir: string): Promise<JudgedSummary[]> {
  const toolsRaw = await readOptional(join(vendoDir, "tools.json"));
  if (toolsRaw === null) return [];
  let tools: ExtractedTool[];
  try {
    tools = toolsFileSchema.parse(JSON.parse(toolsRaw) as unknown).tools;
  } catch {
    return [];
  }
  let judgments: Record<string, Parameters<typeof applyJudgment>[1]> = {};
  const judgmentsRaw = await readOptional(join(vendoDir, "judgments.json"));
  if (judgmentsRaw !== null) {
    try {
      judgments = judgmentsFileSchema.parse(JSON.parse(judgmentsRaw) as unknown).tools;
    } catch {
      // A malformed judgments file is the judgment pass's own loud failure;
      // the brief just reads the skeleton instead.
    }
  }
  return tools.map((tool) => {
    const effective = applyJudgment(tool, judgments[tool.name]);
    return {
      name: effective.name,
      ...(effective.description === undefined ? {} : { description: effective.description }),
    };
  });
}

export interface ProseStagesOptions {
  root: string;
  output: Output;
  env: Record<string, string | undefined>;
  harness: ExtractionHarness;
  force?: boolean;
  /** false = no catalog to brief about (the brief reads the graded tools). */
  tools: boolean;
  /** The theme slots still open after the deterministic pass. Omitted when
      this run has no theme to fill (a pre-existing theme.json). */
  theme?: Pick<ThemeStageInput, "needed" | "alreadyExact" | "evidencePaths">;
}

/** Neither stage is worth failing a run over: a failure degrades to one line
 *  and the extractor/deterministic values stand. */
export async function runProseStages(
  options: ProseStagesOptions,
): Promise<{ theme?: z.infer<typeof modelThemeSchema> }> {
  const { root, output, env, harness } = options;
  let appName = "app";
  try {
    appName = (JSON.parse((await readOptional(join(root, "package.json"))) ?? "{}") as { name?: string }).name ?? "app";
  } catch {
    // package.json is optional context
  }
  const context = {
    root,
    env,
    harness,
    appName,
    onProgress: (line: string): void => output.log(`  ${line}`),
  };
  const notes: string[] = [];
  let theme: z.infer<typeof modelThemeSchema> | undefined;
  try {
    if (options.tools) {
      const brief = await runBriefStage({ ...context, judged: await judgedSummaries(join(root, ".vendo")) });
      notes.push(...brief.notes);
      if (brief.fromStage && await applyBrief(root, brief.brief, options.force === true)) {
        output.log("brief: drafted → .vendo/brief.md");
      }
    }
    if (options.theme !== undefined) {
      const stage = await runThemeStage({ ...context, ...options.theme });
      notes.push(...stage.notes);
      theme = stage.theme;
    }
  } catch (error) {
    output.error(`AI polish did not complete (${error instanceof Error ? error.message : "unknown error"}); extractor defaults stand. Re-run \`vendo init\` to retry — stage artifacts in .vendo/data/ show how far it got.`);
  }
  for (const note of notes) output.error(`  ${note}`);
  return theme === undefined ? {} : { theme };
}
