import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { z } from "zod";
import { claudeCliHarness } from "./claude-cli-harness.js";
import { claudeHarness } from "./claude-harness.js";
import { codexCliHarness } from "./codex-cli-harness.js";
import { parseDraft, type ExtractionHarness } from "./harness.js";
import { npxEngineHarness } from "./npx-engine-harness.js";
import {
  BRIEF_TEMPLATE,
  runStagedExtraction,
  staticToolSchema,
  type StagedExtractionInput,
  type StagedExtractionResult,
  type StaticTool,
} from "./stages.js";
import { readOptional, writeText, type Output } from "../shared.js";

export { composeInstructions } from "./stages.js";

/**
 * The AI extraction pass (install-dx: staged pipeline + deterministic
 * verification — see stages.ts for the survey / draft-per-surface /
 * cross-check / brief orchestration). The agent reads the codebase and
 * drafts judgment on top of the static facts: task-oriented tool
 * descriptions, risk corrections, critical marks, waking unclassifiable
 * tools, and the product brief.
 *
 * Output rides the channels that SURVIVE `vendo sync` regeneration:
 * `.vendo/overrides.json` (per-tool description/risk/critical/disabled — the
 * designed merge layer) and `.vendo/brief.md`. It never writes tools.json
 * directly, so predev/prebuild re-extraction cannot clobber it.
 *
 * Deterministic guards (never cross fingers, PostHog lesson):
 * - only tool names the static extraction produced are accepted;
 * - risk may be RAISED, never lowered (fail-closed stays fail-closed);
 * - waking a disabled tool requires reasoning and an explicit risk;
 * - human decisions win: existing override fields are never overwritten, and
 *   a hand-written brief is never replaced (only the init template is).
 */

const RISK_ORDER = { read: 0, write: 1, destructive: 2 } as const;

const overridesSchema = z.object({
  format: z.literal("vendo/overrides@1"),
  tools: z.record(z.object({
    risk: z.enum(["read", "write", "destructive"]).optional(),
    critical: z.boolean().optional(),
    disabled: z.boolean().optional(),
    description: z.string().optional(),
  }).passthrough()),
}).passthrough();
type Overrides = z.infer<typeof overridesSchema>;

export interface AppliedSummary {
  described: number;
  riskRaised: number;
  critical: number;
  woken: number;
  briefWritten: boolean;
  refused: string[];
  missedSurfaces: string[];
}

/** Deterministic verification + application of a parsed draft. Exported for
 *  tests; init uses runAiExtraction below. */
export async function applyDraft(input: {
  root: string;
  draft: ReturnType<typeof parseDraft>;
  tools: StaticTool[];
  force?: boolean;
}): Promise<AppliedSummary> {
  const byName = new Map(input.tools.map((tool) => [tool.name, tool]));
  const overridesPath = join(input.root, ".vendo", "overrides.json");
  const raw = await readOptional(overridesPath);
  const overrides: Overrides = raw === null
    ? { format: "vendo/overrides@1", tools: {} }
    : overridesSchema.parse(JSON.parse(raw));

  const summary: AppliedSummary = {
    described: 0, riskRaised: 0, critical: 0, woken: 0,
    briefWritten: false, refused: [], missedSurfaces: input.draft.missedSurfaces ?? [],
  };

  for (const entry of input.draft.tools) {
    const fact = byName.get(entry.name);
    if (fact === undefined) {
      summary.refused.push(`${entry.name}: not an extracted tool`);
      continue;
    }
    const existing = overrides.tools[entry.name] ?? {};
    const next = { ...existing };

    if (existing.description === undefined && entry.description !== fact.description) {
      next.description = entry.description;
      summary.described += 1;
    }
    // Waking a statically-unclassifiable tool is its own path: the static
    // "destructive, disabled" grade is a fail-closed PLACEHOLDER, not
    // evidence, so a reasoned wake carries the model's grade without tripping
    // the downgrade guard (Greptile P1 / Devin on #363). A human-set risk or
    // disabled decision always wins.
    const isWake = entry.disabled === false && fact.disabled === true;
    if (isWake && existing.disabled === undefined) {
      if (entry.reasoning === undefined || entry.risk === undefined) {
        summary.refused.push(`${entry.name}: waking a disabled tool needs reasoning and a risk grade`);
      } else {
        next.disabled = false;
        if (existing.risk === undefined) next.risk = entry.risk;
        summary.woken += 1;
      }
    } else if (
      entry.risk !== undefined && existing.risk === undefined && fact.disabled !== true
    ) {
      const current = fact.risk ?? "destructive";
      if (RISK_ORDER[entry.risk] > RISK_ORDER[current]) {
        next.risk = entry.risk;
        summary.riskRaised += 1;
      } else if (RISK_ORDER[entry.risk] < RISK_ORDER[current]) {
        summary.refused.push(`${entry.name}: risk downgrade ${current}→${entry.risk} refused`);
      }
    }
    if (entry.critical === true && existing.critical === undefined) {
      next.critical = true;
      summary.critical += 1;
    }
    if (JSON.stringify(next) !== JSON.stringify(existing)) overrides.tools[entry.name] = next;
  }

  await writeText(overridesPath, `${JSON.stringify(overrides, null, 2)}\n`);

  const briefPath = join(input.root, ".vendo", "brief.md");
  const currentBrief = ((await readOptional(briefPath)) ?? "").trim();
  if (input.force === true || currentBrief === "" || currentBrief === BRIEF_TEMPLATE) {
    await writeText(briefPath, `${input.draft.brief.trim()}\n`);
    summary.briefWritten = true;
  }
  return summary;
}

/** The one applied-polish summary both init's built-in pass and
 *  `vendo extract --apply` print — delegation must read identically. */
export function reportApplied(input: {
  output: Output;
  applied: AppliedSummary;
  briefDrafted: boolean;
  artifactsNote?: string;
  notes?: string[];
}): void {
  const { output, applied } = input;
  const parts = [
    `${applied.described} descriptions`,
    ...(applied.riskRaised > 0 ? [`${applied.riskRaised} risk raises`] : []),
    ...(applied.critical > 0 ? [`${applied.critical} critical marks`] : []),
    ...(applied.woken > 0 ? [`${applied.woken} tools woken`] : []),
    ...(input.briefDrafted ? ["brief drafted"] : []),
  ];
  output.log(`AI polish applied: ${parts.join(" · ")} → .vendo/overrides.json, .vendo/brief.md${input.artifactsNote ?? ""}`);
  for (const note of input.notes ?? []) output.error(`  ${note}`);
  for (const refused of applied.refused) output.error(`  refused: ${refused}`);
  for (const missed of applied.missedSurfaces) output.log(`  missed surface (not extracted yet): ${missed}`);
}

/** Consent-style one-line prompt — shared machinery: the AI-polish consent
    here and init's detected-auth confirm both use it. */
export async function askYesNo(question: string, defaultYes: boolean): Promise<boolean> {
  const prompt = createInterface({ input: stdin, output: stdout });
  try {
    const answer = (await prompt.question(`${question} ${defaultYes ? "[Y/n]" : "[y/N]"} `)).trim().toLowerCase();
    if (answer === "") return defaultYes;
    return ["y", "yes"].includes(answer);
  } finally {
    prompt.close();
  }
}

export interface AiExtractionOptions {
  root: string;
  output: Output;
  env: Record<string, string | undefined>;
  /** Non-interactive (--yes / no TTY): no consent possible — skip silently. */
  yes: boolean;
  /** --ai-polish: consent granted as a flag — skip the prompt and run even
      when non-interactive (the flag IS the answer). */
  consent?: boolean;
  force?: boolean;
  /** Seams (tests / future harnesses). */
  harnesses?: ExtractionHarness[];
  confirm?: (question: string, defaultYes: boolean) => Promise<boolean>;
  interactive?: boolean;
  /** Optional theme-stage input (init's exact-only summary, projected) — see
      `StagedExtractionInput.theme`. Omitted when init has no theme pass to
      run this call (a pre-existing theme.json, e.g.). */
  theme?: StagedExtractionInput["theme"];
}

/** init's AI extraction step. Never changes init's exit code. */
export async function runAiExtraction(
  options: AiExtractionOptions,
): Promise<{ ran: boolean; theme?: StagedExtractionResult["theme"] }> {
  const { root, output, env } = options;
  const toolsRaw = await readOptional(join(root, ".vendo", "tools.json"));
  let tools: StaticTool[] = [];
  // tools.json missing or unparseable degrades tool polish to a no-op — but
  // must NOT also silently kill a requested theme pass (Task 4): the staged
  // call below runs with an empty tool list, and only the tool-polish half
  // (applyDraft/reportApplied) is skipped.
  let toolsAvailable = false;
  if (toolsRaw !== null) {
    try {
      tools = z.object({ tools: z.array(staticToolSchema) }).parse(JSON.parse(toolsRaw)).tools;
      toolsAvailable = true;
    } catch {
      // Unparseable tools.json — tool polish stays skipped below.
    }
  }
  if (!toolsAvailable && options.theme === undefined) return { ran: false };

  const interactive = options.interactive ?? (Boolean(stdin.isTTY) && Boolean(stdout.isTTY));
  if (options.consent !== true && (options.yes || !interactive)) {
    output.log("AI polish (descriptions, risk review, brief, theme): skipped — needs an interactive run (`vendo init` in a terminal).");
    return { ran: false };
  }

  // Ordered engine ladder (install-dx: init-selfcontained-engine, Task 2/4):
  // Agent SDK -> claude CLI -> codex CLI -> npx-fetched engine. A rung whose
  // availability() is null (binary missing or present-but-unauthenticated) is
  // skipped and the next rung is tried; the first non-null credential wins.
  // The npx rung is last on purpose: it's the only one with a real first-run
  // cost (an npm fetch), so every rung that can run for free (something
  // already installed) gets first refusal.
  const harnesses = options.harnesses
    ?? [claudeHarness(), claudeCliHarness(), codexCliHarness(), npxEngineHarness()];
  let chosen: { harness: ExtractionHarness; credential: string } | null = null;
  for (const harness of harnesses) {
    const credential = await harness.availability({ root, env });
    if (credential !== null) {
      chosen = { harness, credential };
      break;
    }
  }
  if (chosen === null) {
    output.log("AI polish: unavailable — needs Claude Code installed (`npm install -g @anthropic-ai/claude-code`) or @anthropic-ai/claude-agent-sdk resolvable, plus a Claude Code login or ANTHROPIC_API_KEY; or the `codex` CLI installed, plus a codex login (`codex login`) or OPENAI_API_KEY; or a VENDO_API_KEY (`vendo login`), which fetches Claude Code on the fly via npx. Extractor defaults stand; re-run `vendo init` once set up.");
    return { ran: false };
  }

  const confirm = options.confirm ?? askYesNo;
  const consented = options.consent === true || await confirm(
    `Let ${chosen.credential} read this codebase to draft tool descriptions, review risk, write the product brief, and fill unresolved theme slots? Source goes to your model provider under your account.`,
    true,
  );
  if (!consented) {
    output.log("Skipped — extractor defaults stand; re-run `vendo init` any time to add the AI polish.");
    return { ran: false };
  }

  let appName = "app";
  try {
    appName = (JSON.parse((await readOptional(join(root, "package.json"))) ?? "{}") as { name?: string }).name ?? "app";
  } catch {
    // package.json is optional context
  }

  output.log(`\nReading your product (${chosen.credential})…`);
  try {
    const staged = await runStagedExtraction({
      root,
      env,
      harness: chosen.harness,
      tools,
      appName,
      onProgress: (line) => output.log(`  ${line}`),
      ...(options.theme === undefined ? {} : { theme: options.theme }),
    });
    if (toolsAvailable) {
      const applied = await applyDraft({ root, draft: staged.draft, tools, ...(options.force === undefined ? {} : { force: options.force }) });
      reportApplied({
        output,
        applied,
        briefDrafted: applied.briefWritten && staged.briefFromStage,
        artifactsNote: " (stage artifacts: .vendo/data/extract/)",
        notes: staged.notes,
      });
    } else {
      for (const note of staged.notes) output.error(`  ${note}`);
    }
    return { ran: true, ...(staged.theme === undefined ? {} : { theme: staged.theme }) };
  } catch (error) {
    output.error(`AI polish did not complete (${error instanceof Error ? error.message : "unknown error"}); extractor defaults stand. Re-run \`vendo init\` to retry — stage artifacts in .vendo/data/extract/ show how far it got.`);
    return { ran: false };
  }
}
