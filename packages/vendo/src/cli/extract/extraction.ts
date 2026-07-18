import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { z } from "zod";
import { claudeHarness } from "./claude-harness.js";
import { parseDraft, type DraftTool, type ExtractionHarness } from "./harness.js";
import { readOptional, writeText, type Output } from "../shared.js";

/**
 * The AI extraction pass (install-dx v1: draft + deterministic verification).
 * The agent reads the codebase and drafts judgment on top of the static
 * facts: task-oriented tool descriptions, risk corrections, critical marks,
 * waking unclassifiable tools, and the product brief.
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

const BRIEF_TEMPLATE =
  "Describe this product, its users, and the jobs the agent should help them complete.";

const RISK_ORDER = { read: 0, write: 1, destructive: 2 } as const;

const staticToolSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  risk: z.enum(["read", "write", "destructive"]).optional(),
  disabled: z.boolean().optional(),
  method: z.string().optional(),
  path: z.string().optional(),
});
type StaticTool = z.infer<typeof staticToolSchema>;

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

export function composeInstructions(tools: StaticTool[], appName: string): string {
  return [
    "You are Vendo's extraction agent. Read this codebase (Read/Glob/Grep only) and return",
    "judgment on the API tools a static extractor already found, plus a product brief.",
    "",
    `Product/package name: ${appName}`,
    "Statically extracted tools (name, method+path when known, current risk, disabled state):",
    JSON.stringify(tools.map((tool) => ({
      name: tool.name,
      ...(tool.method === undefined ? {} : { method: tool.method }),
      ...(tool.path === undefined ? {} : { path: tool.path }),
      risk: tool.risk,
      ...(tool.disabled === true ? { disabled: true } : {}),
      description: tool.description,
    })), null, 2),
    "",
    "Rules:",
    "- Reply with ONLY one fenced json block matching:",
    '  { "brief": string, "tools": [{ "name", "description", "risk"?, "critical"?, "disabled"?, "reasoning"? }], "missedSurfaces"?: string[] }',
    "- brief: one paragraph — what the product does, who uses it, the jobs the agent should help with. Written from the actual code, no marketing fluff.",
    "- tools: include ONLY names from the list above. Rewrite each description so an agent choosing tools understands what it actually does (read the handler source). <= 200 chars each.",
    "- risk: you may RAISE risk (read->write->destructive) when the handler is more dangerous than labeled; never lower it. Mark irreversible operations critical: true.",
    "- A tool listed as disabled was statically unclassifiable. If you can read its handler and grade it, set disabled: false WITH a risk and one-line reasoning. Leave it out otherwise.",
    "- missedSurfaces: API surfaces you found that the list is missing (path + one line). Do not invent tools for them.",
  ].join("\n");
}

interface AppliedSummary {
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
    if (entry.risk !== undefined && existing.risk === undefined) {
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
    if (entry.disabled === false && fact.disabled === true && existing.disabled === undefined) {
      if (entry.reasoning === undefined || entry.risk === undefined) {
        summary.refused.push(`${entry.name}: waking a disabled tool needs reasoning and a risk grade`);
      } else {
        next.disabled = false;
        next.risk = entry.risk;
        summary.woken += 1;
      }
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

async function askYesNo(question: string, defaultYes: boolean): Promise<boolean> {
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
  force?: boolean;
  /** Seams (tests / future harnesses). */
  harnesses?: ExtractionHarness[];
  confirm?: (question: string, defaultYes: boolean) => Promise<boolean>;
  interactive?: boolean;
}

/** init's AI extraction step. Never changes init's exit code. */
export async function runAiExtraction(options: AiExtractionOptions): Promise<{ ran: boolean }> {
  const { root, output, env } = options;
  const toolsRaw = await readOptional(join(root, ".vendo", "tools.json"));
  if (toolsRaw === null) return { ran: false };
  let tools: StaticTool[];
  try {
    tools = z.object({ tools: z.array(staticToolSchema) }).parse(JSON.parse(toolsRaw)).tools;
  } catch {
    return { ran: false };
  }

  const interactive = options.interactive ?? (Boolean(stdin.isTTY) && Boolean(stdout.isTTY));
  if (options.yes || !interactive) {
    output.log("AI polish (descriptions, risk review, brief): skipped — needs an interactive run (`vendo init` in a terminal).");
    return { ran: false };
  }

  const harnesses = options.harnesses ?? [claudeHarness()];
  let chosen: { harness: ExtractionHarness; credential: string } | null = null;
  for (const harness of harnesses) {
    const credential = await harness.availability({ root, env });
    if (credential !== null) {
      chosen = { harness, credential };
      break;
    }
  }
  if (chosen === null) {
    output.log("AI polish: unavailable — needs @anthropic-ai/claude-agent-sdk resolvable (`npm install -D @anthropic-ai/claude-agent-sdk`) plus a Claude Code login or ANTHROPIC_API_KEY. Extractor defaults stand; re-run `vendo init` once set up.");
    return { ran: false };
  }

  const confirm = options.confirm ?? askYesNo;
  const consented = await confirm(
    `Let ${chosen.credential} read this codebase to draft tool descriptions, review risk, and write the product brief? Source goes to your model provider under your account.`,
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
    const text = await chosen.harness.run({
      root,
      env,
      instructions: composeInstructions(tools, appName),
      onProgress: (line) => output.log(`  ${line}`),
    });
    const draft = parseDraft(text);
    const applied = await applyDraft({ root, draft, tools, ...(options.force === undefined ? {} : { force: options.force }) });
    const parts = [
      `${applied.described} descriptions`,
      ...(applied.riskRaised > 0 ? [`${applied.riskRaised} risk raises`] : []),
      ...(applied.critical > 0 ? [`${applied.critical} critical marks`] : []),
      ...(applied.woken > 0 ? [`${applied.woken} tools woken`] : []),
      ...(applied.briefWritten ? ["brief drafted"] : []),
    ];
    output.log(`AI polish applied: ${parts.join(" · ")} → .vendo/overrides.json, .vendo/brief.md`);
    for (const refused of applied.refused) output.error(`  refused: ${refused}`);
    for (const missed of applied.missedSurfaces) output.log(`  missed surface (not extracted yet): ${missed}`);
    return { ran: true };
  } catch (error) {
    output.error(`AI polish did not complete (${error instanceof Error ? error.message : "unknown error"}); extractor defaults stand. Re-run \`vendo init\` to retry.`);
    return { ran: false };
  }
}
