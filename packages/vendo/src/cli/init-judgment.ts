import { join } from "node:path";
import { stdin, stdout } from "node:process";
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
import { selectJudgmentEngines, type ResolveEngineOptions } from "./judge/engine.js";
import { runJudgmentPass } from "./judge/pass.js";
import { plainSelect, type SelectOption } from "./pretty.js";
import { askYesNo, readOptional, type Output } from "./shared.js";
import type { modelThemeSchema } from "./theme/extract-theme.js";

/**
 * init's model-assisted step: ONE consent question, then the judgment pass over
 * the freshly synced catalog, then the two prose stages (brief, theme).
 *
 * This replaces the staged AI extraction pass. The difference that matters is
 * WHERE tool judgment lands: the old pass drafted descriptions and risk grades
 * into `overrides.json` — the human-written layer — behind a restrictive-only
 * clamp. The judgment channel writes `judgments.json` instead, with a verbatim
 * source quote behind every proposal, an independent skeptic checking each one,
 * and loosenings held for a human. `overrides.json` goes back to meaning only
 * "what a person decided".
 *
 * The consent posture is unchanged and deliberately singular: one question,
 * asked once, naming the provider the source goes to. `--ai-polish` IS that
 * consent as a flag (so non-interactive runs can opt in); otherwise a
 * non-interactive run skips, because consent cannot be assumed.
 */

/** The telemetry `engine` enum value for each ladder rung (both Claude rungs
    are the same engine reached two ways). Unlisted ids (test seams) map to
    undefined — init's "none" default covers them. Distinct from the
    user-facing `--engine` family, which says "npx" where telemetry's closed
    enum says "npx-engine". */
const ENGINE_BY_HARNESS_ID: Record<string, "claude" | "codex" | "npx-engine"> = {
  "claude-agent-sdk": "claude",
  "claude-cli": "claude",
  "codex-cli": "codex",
  "npx-engine": "npx-engine",
};

export interface InitJudgmentOptions {
  root: string;
  output: Output;
  env: Record<string, string | undefined>;
  /** Non-interactive (--yes / no TTY): no consent possible — skip silently. */
  yes: boolean;
  /** --ai-polish: consent granted as a flag — skip the prompt and run even
      when non-interactive (the flag IS the answer). */
  consent?: boolean;
  force?: boolean;
  /** --engine: pin the rung family (claude | codex | npx) instead of
      first-available. An unavailable pin skips loudly — never a fallback. */
  engine?: string;
  /** Seams (tests / future harnesses). */
  harnesses?: ExtractionHarness[];
  confirm?: (question: string, defaultYes: boolean) => Promise<boolean>;
  /** The multi-engine consent select (init passes pretty.select); default is
      the plain numbered select. Resolves to an option value or "skip". */
  choose?: (question: string, options: SelectOption[], defaultIndex: number) => Promise<string>;
  interactive?: boolean;
  resolveCredential?: ResolveEngineOptions["resolveCredential"];
  /** Optional theme-stage input (init's exact-only summary, projected).
      Omitted when init has no theme pass to run this call (a pre-existing
      theme.json, e.g.). */
  theme?: Pick<ThemeStageInput, "needed" | "alreadyExact" | "evidencePaths">;
}

export interface InitJudgmentResult {
  /** true = consent was granted, an engine was chosen, and the pass ran. */
  ran: boolean;
  engine?: "claude" | "codex" | "npx-engine";
  /** Present only when the theme stage ran and succeeded. */
  theme?: z.infer<typeof modelThemeSchema>;
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

export async function runInitJudgment(options: InitJudgmentOptions): Promise<InitJudgmentResult> {
  const { root, output, env } = options;
  const vendoDir = join(root, ".vendo");
  // A missing/unparseable tools.json makes tool judgment a no-op, but must NOT
  // also silently kill a requested theme pass: the theme stage reads the repo,
  // not the catalog.
  const toolsAvailable = await readOptional(join(vendoDir, "tools.json")) !== null;
  if (!toolsAvailable && options.theme === undefined) return { ran: false };

  const interactive = options.interactive ?? (Boolean(stdin.isTTY) && Boolean(stdout.isTTY));
  if (options.consent !== true && (options.yes || !interactive)) {
    output.log("AI polish (descriptions, risk review, brief, theme): skipped — needs an interactive run (`vendo init` in a terminal).");
    return { ran: false };
  }

  const available = await selectJudgmentEngines({
    root,
    env,
    ...(options.harnesses === undefined ? {} : { harnesses: options.harnesses }),
  });
  if (available.length === 0) {
    output.log("AI polish: unavailable — needs Claude Code installed (`npm install -g @anthropic-ai/claude-code`) or @anthropic-ai/claude-agent-sdk resolvable, plus a Claude Code login or ANTHROPIC_API_KEY; or the `codex` CLI installed, plus a codex login (`codex login`) or OPENAI_API_KEY; or a VENDO_API_KEY (`vendo login`), which fetches Claude Code on the fly via npx. Extractor defaults stand; re-run `vendo init` once set up.");
    return { ran: false };
  }

  // --engine pins a family. An unavailable pin never falls back to another
  // provider (the pin is usually a privacy/policy choice about where source
  // goes) — one loud line naming what IS available, exit code untouched.
  let chosen = available[0]!;
  if (options.engine !== undefined) {
    const pinned = available.find((entry) => entry.family === options.engine);
    if (pinned === undefined) {
      const alternatives = available
        .map((entry) => `\`--engine ${entry.family}\` (${entry.credential})`)
        .join(", or ");
      output.log(`AI polish: \`--engine ${options.engine}\` requested but that engine isn't available on this machine. Available: ${alternatives}. Extractor defaults stand; re-run \`vendo init\` once it's set up.`);
      return { ran: false };
    }
    chosen = pinned;
  }

  if (options.consent !== true) {
    if (options.engine === undefined && available.length > 1) {
      // Several engines: the SAME single consent question, as a pick-with-
      // default instead of yes/no — never a second question.
      const choose = options.choose ?? plainSelect;
      const picked = await choose(
        "Let a coding agent read this codebase to draft tool descriptions, review risk, write the product brief, and fill unresolved theme slots? Source goes to the chosen provider under your account.",
        [
          ...available.map((entry) => ({ value: entry.family, label: entry.credential, hint: `--engine ${entry.family}` })),
          { value: "skip", label: "Skip — keep extractor defaults" },
        ],
        0,
      );
      const selected = available.find((entry) => entry.family === picked);
      if (selected === undefined) {
        output.log("Skipped — extractor defaults stand; re-run `vendo init` any time to add the AI polish.");
        return { ran: false };
      }
      chosen = selected;
    } else {
      const confirm = options.confirm ?? askYesNo;
      const consented = await confirm(
        `Let ${chosen.credential} read this codebase to draft tool descriptions, review risk, write the product brief, and fill unresolved theme slots? Source goes to your model provider under your account.`,
        true,
      );
      if (!consented) {
        output.log("Skipped — extractor defaults stand; re-run `vendo init` any time to add the AI polish.");
        return { ran: false };
      }
    }
  }

  let appName = "app";
  try {
    appName = (JSON.parse((await readOptional(join(root, "package.json"))) ?? "{}") as { name?: string }).name ?? "app";
  } catch {
    // package.json is optional context
  }

  output.log(`\nReading your product (${chosen.credential})…`);
  const onProgress = (line: string): void => output.log(`  ${line}`);
  const context = { root, env, harness: chosen.harness, appName, onProgress };
  const notes: string[] = [];
  let theme: z.infer<typeof modelThemeSchema> | undefined;
  try {
    // Judgment first: the brief reads the GRADED catalog, so it must run after
    // the pass has settled names and descriptions. Init judges the whole
    // catalog (mode "full" — a fresh install has judged nothing), and an
    // interactive run reviews loosenings inline instead of queueing them.
    if (toolsAvailable) {
      await runJudgmentPass({
        root,
        out: vendoDir,
        mode: "full",
        loosenings: interactive ? "review" : "queue",
        env,
        output,
        harness: chosen.harness,
        appName,
        onProgress,
        ...(options.confirm === undefined ? {} : { confirm: options.confirm }),
        ...(options.resolveCredential === undefined ? {} : { resolveCredential: options.resolveCredential }),
      });

      const brief = await runBriefStage({ ...context, judged: await judgedSummaries(vendoDir) });
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
    for (const note of notes) output.error(`  ${note}`);
    const engine = ENGINE_BY_HARNESS_ID[chosen.harness.id];
    return {
      ran: true,
      ...(engine === undefined ? {} : { engine }),
      ...(theme === undefined ? {} : { theme }),
    };
  } catch (error) {
    output.error(`AI polish did not complete (${error instanceof Error ? error.message : "unknown error"}); extractor defaults stand. Re-run \`vendo init\` to retry — stage artifacts in .vendo/data/ show how far it got.`);
    return { ran: false };
  }
}
