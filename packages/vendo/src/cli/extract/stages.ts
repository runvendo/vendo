import { join } from "node:path";
import { z } from "zod";
import { parseArtifact, type ExtractionHarness } from "./harness.js";
import { readOptional, writeText } from "../shared.js";
import { BRAND_SLOTS, modelThemeSchema, type ThemeSlotValues } from "../theme/extract-theme.js";

/**
 * The two prose stages that survive the judgment layer. Tool judgment itself
 * moved to `cli/judge/` — a judge proposes with a verbatim quote, an
 * independent skeptic tears it apart, and the direction rule routes what
 * survives. The survey / draft-per-surface / cross-check pipeline that used to
 * live here existed to make ONE model's unevidenced opinion less wrong by
 * splitting it up; evidence plus a second opinion is the better answer, so the
 * pipeline is gone rather than layered on top of.
 *
 * What is left is the work the judgment channel does not do, each one
 * `harness.run(instructions)` with its own zod-validated artifact written to
 * `.vendo/data/extract/<stage>.json` so a failure stays diagnosable:
 *
 * - brief — the product brief, drafted from the JUDGED catalog (the graded
 *   names and descriptions, not the extractor's method+path strings) plus the
 *   code itself. A failure keeps whatever brief already stands.
 * - theme — OPTIONAL, only when the deterministic allowlist left brand slots
 *   unfilled. A failure degrades to a note; the exact reads and neutral
 *   defaults still stand.
 *
 * Nothing here assumes a vendor; the model override rides VENDO_MODEL_EXTRACT,
 * which every harness already honors.
 */

export const BRIEF_TEMPLATE =
  "Describe this product, its users, and the jobs the agent should help them complete.";

/** Static facts don't clutter passes that only need names — kept small. */
export const staticToolSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  risk: z.enum(["read", "write", "destructive"]).optional(),
  disabled: z.boolean().optional(),
  method: z.string().optional(),
  path: z.string().optional(),
});
export type StaticTool = z.infer<typeof staticToolSchema>;

const briefSchema = z.object({
  brief: z.string().min(1).max(4000),
});

export function staticFacts(tools: StaticTool[]): string {
  return JSON.stringify(tools.map((tool) => ({
    name: tool.name,
    ...(tool.method === undefined ? {} : { method: tool.method }),
    ...(tool.path === undefined ? {} : { path: tool.path }),
    risk: tool.risk,
    ...(tool.disabled === true ? { disabled: true } : {}),
    description: tool.description,
  })), null, 2);
}

/** One tool as the brief prompt reads it: what the judgment pass settled. */
export interface JudgedSummary {
  name: string;
  description?: string;
}

function composeBriefInstructions(input: { appName: string; judged: JudgedSummary[] }): string {
  return [
    "You are Vendo's extraction agent, drafting the product brief. The judgment pass already",
    "graded this product's tools; build on those names and descriptions plus the code itself.",
    "",
    `Product/package name: ${input.appName}`,
    "Judged tools (name + description):",
    JSON.stringify(input.judged.map(({ name, description }) => ({ name, description })), null, 2),
    "",
    "Rules:",
    '- Reply with ONLY one fenced json block matching: { "brief": string }',
    "- brief: one paragraph — what the product does, who uses it, the jobs the agent should help with. Written from the actual code, no marketing fluff.",
  ].join("\n");
}

/**
 * Instructions for the OPTIONAL theme stage — the SOLE copy of the theme
 * judgment rules (extract-theme.ts's old model pass and its prompt were
 * deleted when the deterministic split landed; that file now owns only the
 * exact pass, validators, and assembly).
 */
export function composeThemeInstructions(input: {
  needed: string[];
  alreadyExact: Record<string, string>;
  evidencePaths: string[];
  appName: string;
}): string {
  return [
    "You are Vendo's extraction agent, filling the theme's brand slots. Read this codebase",
    "(Read/Glob/Grep — not just the hints below) to fill the brand theme slots a deterministic",
    "allowlist pass could not read exactly.",
    "",
    "Slots: accent (the brand's primary interactive color), accentText (text on accent),",
    "background (page), surface (cards/panels), text (body), mutedText (secondary text),",
    "border (default hairline), danger (destructive/error), radius (default control corner",
    "radius, canonical px), fontFamily (body stack), headingFamily (heading stack, only if",
    "distinct), baseSize (body font size, px), density (compact|comfortable), motion (full|reduced).",
    "",
    `Product/package name: ${input.appName}`,
    "Needed slots:",
    JSON.stringify(input.needed, null, 2),
    "Already exact (context — do not re-derive these):",
    JSON.stringify(input.alreadyExact, null, 2),
    "Evidence files found so far (starting hints — read more of the repo if useful):",
    JSON.stringify(input.evidencePaths, null, 2),
    "",
    "Rules:",
    "- Reply with ONLY one fenced json block matching:",
    '  { "slots": { <slot>: string, ... }, "uncertain"?: [{ "slot", "note" }] }',
    "- Fill ONLY the needed slots above, ONLY from evidence in the codebase.",
    "- Colors must be 6-digit hex. Resolve CSS variables and color functions yourself.",
    "- next/font: the imported font's export name is the family (underscores become spaces).",
    "- The geist npm package's GeistSans/GeistMono imports are font sources exactly like next/font.",
    "- fontFamily is the BODY font: the Tailwind `sans`/default fontFamily key. A `display` face",
    "  goes to headingFamily, never fontFamily.",
    "- A design-token sheet outranks scattered utility classes; dominant usage outranks one-offs.",
    "- When several tokens could fill the same slot (e.g. multiple muted/soft/faint text inks),",
    "  COUNT their usages across the sheets and pick the dominant one; if you did not count or",
    "  the counts are close, still fill the slot with your best pick AND list it in uncertain.",
    "- Status/state colors (success, positive, negative, warning, error, overdue, verified,",
    "  and colors a comment demotes to data/status-only) are NEVER the brand accent.",
    "- Monochrome brands exist: when the sheet declares no saturated non-status brand color,",
    "  the ink/text color itself is the accent (primary buttons are painted with it).",
    "- radius is the default CONTROL radius (buttons/inputs); a token named for cards or",
    "  popovers rounds cards, which are typically larger than controls.",
    "- An accessibility-only prefers-reduced-motion override does NOT make the brand 'reduced'.",
    "- Omit any slot the codebase does not evidence. Do not invent plausible values.",
    "- List a slot in `uncertain` ONLY when the codebase genuinely supports multiple different",
    "  answers (a real fork, e.g. two plausible brand colors). A value settled by the rules",
    "  above — monochrome accent, contrast-derived accentText, single-font inheritance,",
    "  browser-default sizing — is NOT uncertain.",
  ].join("\n");
}

/** Stage lifecycle statuses reported to callers that narrate progress: the
 *  "started" marker plus the terminal trio the try profile understands. */
export type StagedStageStatus = "started" | "done" | "failed" | "skipped";

function message(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}

/** What every stage here shares: the repo the harness explores, where the
 *  artifacts land, and the model seam. `artifactRoot` defaults to `root`;
 *  `vendo try` splits the two so the harness explores the HOST repo while
 *  every write stays under the temp profile root (the zero-commit law). */
interface StageContext {
  root: string;
  env: Record<string, string | undefined>;
  harness: ExtractionHarness;
  appName: string;
  artifactRoot?: string;
  onProgress?: (line: string) => void;
}

/** One harness call plus its artifact. A throw records the failure artifact
 *  (with the raw text when there was any) and rethrows, so each stage decides
 *  how to degrade. */
async function runStage<Schema extends z.ZodTypeAny>(
  context: StageContext,
  stage: string,
  instructions: string,
  schema: Schema,
): Promise<z.infer<Schema>> {
  const artifactDir = join(context.artifactRoot ?? context.root, ".vendo", "data", "extract");
  let text: string | null = null;
  try {
    text = await context.harness.run({
      root: context.root,
      env: context.env,
      instructions,
      ...(context.onProgress === undefined ? {} : { onProgress: context.onProgress }),
    });
    const artifact = parseArtifact(text, schema);
    await writeText(join(artifactDir, `${stage}.json`), `${JSON.stringify(artifact, null, 2)}\n`);
    return artifact;
  } catch (error) {
    await writeText(
      join(artifactDir, `${stage}.json`),
      `${JSON.stringify({ stage, error: message(error), ...(text === null ? {} : { raw: text }) }, null, 2)}\n`,
    );
    throw error;
  }
}

export interface BriefStageInput extends StageContext {
  /** The JUDGED catalog (skeleton ⊕ standing judgments), name + description. */
  judged: JudgedSummary[];
}

export interface BriefStageResult {
  brief: string;
  /** false = the stage failed and `brief` is the pre-existing one (or the
   *  template when there was none). */
  fromStage: boolean;
  notes: string[];
}

/**
 * The brief stage. A failure is never fatal: the brief that already stands is
 * returned instead, and `applyBrief`'s hand-written-brief guard still decides
 * whether anything lands on disk.
 */
export async function runBriefStage(input: BriefStageInput): Promise<BriefStageResult> {
  const notes: string[] = [];
  input.onProgress?.("brief: drafting the product brief");
  try {
    const artifact = await runStage(
      input,
      "brief",
      composeBriefInstructions({ appName: input.appName, judged: input.judged }),
      briefSchema,
    );
    return { brief: artifact.brief, fromStage: true, notes };
  } catch (error) {
    notes.push(
      `the AI polish for your brief did not finish (${message(error)}) — your install is `
      + "complete and valid with the default brief; run `vendo sync --ai` to try the polish again",
    );
  }
  // The "current brief" is an ARTIFACT, so the fallback reads it from the
  // artifact root — the same file as before for callers that don't split.
  const current = ((await readOptional(join(input.artifactRoot ?? input.root, ".vendo", "brief.md"))) ?? "").trim();
  return { brief: current === "" ? BRIEF_TEMPLATE : current, fromStage: false, notes };
}

/** Write the drafted brief unless a human already wrote one (only the init
 *  template or an empty file is replaceable without --force). */
export async function applyBrief(root: string, brief: string, force: boolean): Promise<boolean> {
  const briefPath = join(root, ".vendo", "brief.md");
  const currentBrief = ((await readOptional(briefPath)) ?? "").trim();
  if (force || currentBrief === "" || currentBrief === BRIEF_TEMPLATE) {
    await writeText(briefPath, `${brief.trim()}\n`);
    return true;
  }
  return false;
}

export interface ThemeStageInput extends StageContext {
  needed: Array<keyof ThemeSlotValues>;
  alreadyExact: Record<string, string>;
  evidencePaths: string[];
}

export interface ThemeStageResult {
  /** Present only when the stage ran and succeeded. */
  theme?: z.infer<typeof modelThemeSchema>;
  notes: string[];
}

/**
 * The theme stage — OPTIONAL, and only when the allowlist left BRAND slots
 * unfilled: the non-brand slots (accentText, headingFamily, baseSize, density,
 * motion) derive or default safely and must never trigger a model call on
 * their own. A failure degrades to a note and never throws.
 */
export async function runThemeStage(input: ThemeStageInput): Promise<ThemeStageResult> {
  const notes: string[] = [];
  if (input.needed.filter((slot) => BRAND_SLOTS.includes(slot)).length === 0) return { notes };
  input.onProgress?.("theme: filling brand slots");
  try {
    const theme = await runStage(
      input,
      "theme",
      composeThemeInstructions({
        needed: input.needed,
        alreadyExact: input.alreadyExact,
        evidencePaths: input.evidencePaths,
        appName: input.appName,
      }),
      modelThemeSchema,
    );
    return { theme, notes };
  } catch (error) {
    notes.push(`theme stage failed (${message(error)}) — exact reads and defaults stand`);
    return { notes };
  }
}
