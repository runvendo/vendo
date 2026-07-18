import { join } from "node:path";
import { rm } from "node:fs/promises";
import { z } from "zod";
import {
  draftToolSchema,
  parseArtifact,
  type DraftTool,
  type ExtractionDraft,
  type ExtractionHarness,
} from "./harness.js";
import { readOptional, writeText } from "../shared.js";

/**
 * The staged extraction pipeline (install-dx, PostHog lesson: narrow stages
 * beat one-shot). Four passes over the SAME harness seam — each is one
 * `harness.run(instructions)` with its own narrow instructions and its own
 * zod-validated artifact, written to `.vendo/data/extract/<stage>.json` so a
 * failed run is diagnosable stage by stage:
 *
 * 1. survey — map the repo: frameworks, where the API surfaces live, and a
 *    grouping of the static tool list into surfaces (cheap/fast; respects a
 *    VENDO_EXTRACTION_SURVEY_MODEL override).
 * 2. draft — one focused pass per surface, drafting judgment for just that
 *    surface's tools. Surfaces run sequentially (rate-limit friendly); a
 *    failed surface is SKIPPED with an honest note, never aborting the run.
 * 3. cross-check — one pass over the combined draft for naming consistency,
 *    duplicate coverage, and risk sanity. It may only AMEND entries within
 *    the same schema (unknown names ignored, omitted entries stand); a
 *    failure degrades to the uncross-checked drafts.
 * 4. brief — drafted from what the survey and drafts learned; a failure
 *    keeps the current brief.
 *
 * The combined output feeds the EXISTING applyDraft guards in extraction.ts
 * unchanged — deterministic verification stays the single gate. Nothing here
 * assumes a vendor; the model override rides VENDO_EXTRACTION_MODEL, which
 * every harness already honors.
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

export const surveySchema = z.object({
  /** Frameworks/routers the surveyor identified (context for later stages). */
  frameworks: z.array(z.string().max(120)).optional(),
  surfaces: z.array(z.object({
    name: z.string().min(1).max(80),
    /** One line on where the surface lives in the code. */
    note: z.string().max(300).optional(),
    tools: z.array(z.string().min(1)),
  })).min(1),
});
export type Survey = z.infer<typeof surveySchema>;

/** Draft and cross-check share one schema: the cross-check may only AMEND
 *  the draft within it. */
export const surfaceDraftSchema = z.object({
  tools: z.array(draftToolSchema),
  missedSurfaces: z.array(z.string().max(300)).optional(),
});
export type SurfaceDraft = z.infer<typeof surfaceDraftSchema>;

export const briefSchema = z.object({
  brief: z.string().min(1).max(4000),
});

/** More surfaces than this get their tail merged into one pass — a runaway
 *  survey must not turn into a runaway number of model calls. */
const MAX_SURFACES = 12;

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

export function composeSurveyInstructions(tools: StaticTool[], appName: string): string {
  return [
    "You are Vendo's extraction surveyor. Map this repo (Read/Glob/Grep only) so later",
    "focused passes can draft tool documentation surface by surface.",
    "",
    `Product/package name: ${appName}`,
    "Statically extracted tools (name, method+path when known):",
    JSON.stringify(tools.map((tool) => ({
      name: tool.name,
      ...(tool.method === undefined ? {} : { method: tool.method }),
      ...(tool.path === undefined ? {} : { path: tool.path }),
    })), null, 2),
    "",
    "Rules:",
    "- Reply with ONLY one fenced json block matching:",
    '  { "frameworks"?: string[], "surfaces": [{ "name", "note"?, "tools": string[] }] }',
    "- surfaces: group EVERY tool above into a small number of product surfaces (billing,",
    "  auth, admin, …) by reading where their routes live. Each tool name appears in exactly",
    "  one surface; use only names from the list.",
    "- name: a short surface label. note: one line on where the surface lives in the code.",
    "- frameworks: the frameworks/routers you identified.",
    "- Survey only — do not draft descriptions or risk grades here.",
  ].join("\n");
}

export function composeInstructions(
  tools: StaticTool[],
  appName: string,
  surface?: { name: string; note?: string },
): string {
  return [
    "You are Vendo's extraction agent. Read this codebase (Read/Glob/Grep only) and return",
    surface === undefined
      ? "judgment on the API tools a static extractor already found."
      : `judgment on the API tools a static extractor already found, focusing ONLY on the "${surface.name}" surface.`,
    "",
    `Product/package name: ${appName}`,
    ...(surface?.note === undefined ? [] : [`Where this surface lives: ${surface.note}`]),
    "Statically extracted tools (name, method+path when known, current risk, disabled state):",
    staticFacts(tools),
    "",
    "Rules:",
    "- Reply with ONLY one fenced json block matching:",
    '  { "tools": [{ "name", "description", "risk"?, "critical"?, "disabled"?, "reasoning"? }], "missedSurfaces"?: string[] }',
    "- tools: include ONLY names from the list above. Rewrite each description so an agent choosing tools understands what it actually does (read the handler source). <= 200 chars each.",
    "- risk: you may RAISE risk (read->write->destructive) when the handler is more dangerous than labeled; never lower it. Mark irreversible operations critical: true.",
    "- A tool listed as disabled was statically unclassifiable. If you can read its handler and grade it, set disabled: false WITH a risk and one-line reasoning. Leave it out otherwise.",
    "- missedSurfaces: API surfaces you found that the list is missing (path + one line). Do not invent tools for them.",
  ].join("\n");
}

export function composeCrossCheckInstructions(
  drafted: DraftTool[],
  tools: StaticTool[],
  appName: string,
): string {
  return [
    "You are Vendo's extraction cross-checker. Focused passes drafted judgment surface by",
    "surface; review the COMBINED draft for naming consistency, duplicate coverage, and",
    "risk sanity.",
    "",
    `Product/package name: ${appName}`,
    "Combined draft:",
    JSON.stringify(drafted, null, 2),
    "Static facts for the same tools:",
    staticFacts(tools),
    "",
    "Rules:",
    "- Reply with ONLY one fenced json block matching:",
    '  { "tools": [{ "name", "description", "risk"?, "critical"?, "disabled"?, "reasoning"? }] }',
    "- Return ONLY the entries you want to AMEND. Entries you omit stand as drafted; you cannot remove a tool. Use only names from the combined draft.",
    "- Same rules as drafting: risk may be RAISED, never lowered; mark irreversible operations critical: true.",
  ].join("\n");
}

export function composeBriefInstructions(input: {
  appName: string;
  survey: Survey | null;
  drafted: DraftTool[];
}): string {
  return [
    "You are Vendo's extraction agent, drafting the product brief. A survey and per-surface",
    "drafting passes already ran; build on what they learned plus the code itself.",
    "",
    `Product/package name: ${input.appName}`,
    ...(input.survey === null ? [] : [
      "Surveyed surfaces:",
      JSON.stringify(input.survey.surfaces.map(({ name, note }) => ({ name, ...(note === undefined ? {} : { note }) })), null, 2),
    ]),
    "Drafted tools (name + description):",
    JSON.stringify(input.drafted.map(({ name, description }) => ({ name, description })), null, 2),
    "",
    "Rules:",
    '- Reply with ONLY one fenced json block matching: { "brief": string }',
    "- brief: one paragraph — what the product does, who uses it, the jobs the agent should help with. Written from the actual code, no marketing fluff.",
  ].join("\n");
}

interface NormalizedSurface {
  name: string;
  slug: string;
  note?: string;
  tools: StaticTool[];
}

function slugify(name: string, taken: Set<string>): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "surface";
  let slug = base;
  for (let suffix = 2; taken.has(slug); suffix += 1) slug = `${base}-${suffix}`;
  taken.add(slug);
  return slug;
}

/** Deterministic normalization of the survey grouping: unknown names are
 *  dropped, a tool claimed twice keeps its first surface, unassigned tools
 *  land in a catch-all pass, and a runaway surface count is merged down. The
 *  drafting stage always covers EVERY static tool exactly once. */
export function normalizeSurfaces(
  survey: Survey | null,
  tools: StaticTool[],
  notes: string[],
): NormalizedSurface[] {
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  const assigned = new Set<string>();
  const surfaces: Array<Omit<NormalizedSurface, "slug">> = [];
  for (const surface of survey?.surfaces ?? []) {
    const members: StaticTool[] = [];
    for (const name of surface.tools) {
      const fact = byName.get(name);
      if (fact === undefined) {
        notes.push(`survey: unknown tool "${name}" in surface "${surface.name}" ignored`);
        continue;
      }
      if (assigned.has(name)) continue;
      assigned.add(name);
      members.push(fact);
    }
    if (members.length > 0) {
      surfaces.push({ name: surface.name, ...(surface.note === undefined ? {} : { note: surface.note }), tools: members });
    }
  }
  const unassigned = tools.filter((tool) => !assigned.has(tool.name));
  if (unassigned.length > 0) {
    if (surfaces.length > 0) {
      notes.push(`survey left ${unassigned.length} tools unassigned — drafting them as "everything else"`);
    }
    surfaces.push({ name: surfaces.length > 0 ? "everything else" : "all tools", tools: unassigned });
  }
  if (surfaces.length > MAX_SURFACES) {
    const tail = surfaces.splice(MAX_SURFACES - 1);
    surfaces.push({ name: "everything else", tools: tail.flatMap((surface) => surface.tools) });
    notes.push(`survey produced ${MAX_SURFACES - 1 + tail.length} surfaces — merged the tail into one pass`);
  }
  const taken = new Set<string>();
  return surfaces.map((surface) => ({ ...surface, slug: slugify(surface.name, taken) }));
}

export interface StagedExtractionInput {
  root: string;
  env: Record<string, string | undefined>;
  harness: ExtractionHarness;
  tools: StaticTool[];
  appName: string;
  onProgress?: (line: string) => void;
}

export interface StagedExtractionResult {
  draft: ExtractionDraft;
  /** Honest degradation notes (skipped surfaces, failed cross-check, …). */
  notes: string[];
  /** false = the brief stage failed and draft.brief is the pre-existing one. */
  briefFromStage: boolean;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}

/** Orchestrate the staged pipeline. Throws only when no stage produced
 *  anything usable (the error names the failed stage); partial failures
 *  degrade with notes instead. */
export async function runStagedExtraction(input: StagedExtractionInput): Promise<StagedExtractionResult> {
  const { root, env, harness, tools, appName, onProgress } = input;
  const artifactDir = join(root, ".vendo", "data", "extract");
  await rm(artifactDir, { recursive: true, force: true });
  const notes: string[] = [];

  async function runStage<Schema extends z.ZodTypeAny>(
    stage: string,
    instructions: string,
    schema: Schema,
    stageEnv: Record<string, string | undefined>,
  ): Promise<z.infer<Schema>> {
    let text: string | null = null;
    try {
      text = await harness.run({ root, env: stageEnv, instructions, ...(onProgress === undefined ? {} : { onProgress }) });
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

  // Survey: cheap repo map; an override can point it at a faster model. A
  // failed survey degrades to drafting everything as one surface (= v1).
  const surveyModel = env["VENDO_EXTRACTION_SURVEY_MODEL"];
  let survey: Survey | null = null;
  onProgress?.("survey: mapping API surfaces");
  try {
    survey = await runStage(
      "survey",
      composeSurveyInstructions(tools, appName),
      surveySchema,
      surveyModel === undefined ? env : { ...env, VENDO_EXTRACTION_MODEL: surveyModel },
    );
  } catch (error) {
    notes.push(`survey stage failed (${message(error)}) — drafting all ${tools.length} tools as one surface`);
  }
  const surfaces = normalizeSurfaces(survey, tools, notes);

  // Draft per surface, sequentially. A failed surface is skipped, not fatal —
  // unless EVERY surface failed, which means the harness itself is broken.
  const drafted = new Map<string, DraftTool>();
  const missedSurfaces: string[] = [];
  let failures = 0;
  let lastError = "";
  for (const surface of surfaces) {
    onProgress?.(`drafting "${surface.name}" (${surface.tools.length} tools)`);
    try {
      const artifact = await runStage(
        `draft.${surface.slug}`,
        composeInstructions(surface.tools, appName, surface),
        surfaceDraftSchema,
        env,
      );
      // A focused pass may only draft its own surface's tools — an
      // out-of-surface entry would defeat the containment story (a skipped
      // surface must actually keep extractor defaults).
      const members = new Set(surface.tools.map((tool) => tool.name));
      for (const entry of artifact.tools) {
        if (!members.has(entry.name)) {
          notes.push(`surface "${surface.name}": draft for out-of-surface tool "${entry.name}" ignored`);
          continue;
        }
        drafted.set(entry.name, entry);
      }
      missedSurfaces.push(...(artifact.missedSurfaces ?? []));
    } catch (error) {
      failures += 1;
      lastError = message(error);
      notes.push(`surface "${surface.name}" skipped (${lastError}) — its ${surface.tools.length} tools keep extractor defaults`);
    }
  }
  if (surfaces.length > 0 && failures === surfaces.length) {
    throw new Error(`draft stage failed for every surface (${lastError})`);
  }

  // Cross-check: amendments only, within the draft schema. applyDraft remains
  // the gate — an amendment can no more downgrade risk than a draft can.
  if (drafted.size > 0) {
    onProgress?.("cross-check: consistency pass over the combined draft");
    try {
      const artifact = await runStage(
        "cross-check",
        composeCrossCheckInstructions([...drafted.values()], tools, appName),
        surfaceDraftSchema,
        env,
      );
      for (const amendment of artifact.tools) {
        const existing = drafted.get(amendment.name);
        if (existing === undefined) {
          notes.push(`cross-check: amendment for undrafted tool "${amendment.name}" ignored`);
          continue;
        }
        // Merge, never replace: a description-only amendment must not drop
        // the risk/critical/wake judgment the focused pass produced.
        drafted.set(amendment.name, { ...existing, ...amendment });
      }
    } catch (error) {
      notes.push(`cross-check stage failed (${message(error)}) — using the uncross-checked drafts`);
    }
  }

  // Brief: drafted from what the earlier stages learned; on failure the
  // current brief stands (applyDraft's hand-written-brief guard still wins).
  let brief: string | null = null;
  onProgress?.("brief: drafting the product brief");
  try {
    brief = (await runStage("brief", composeBriefInstructions({ appName, survey, drafted: [...drafted.values()] }), briefSchema, env)).brief;
  } catch (error) {
    notes.push(`brief stage failed (${message(error)}) — keeping the current brief`);
  }
  const briefFromStage = brief !== null;
  if (brief === null) {
    const current = ((await readOptional(join(root, ".vendo", "brief.md"))) ?? "").trim();
    brief = current === "" ? BRIEF_TEMPLATE : current;
  }

  const missed = [...new Set(missedSurfaces)];
  const draft: ExtractionDraft = {
    brief,
    tools: [...drafted.values()],
    ...(missed.length === 0 ? {} : { missedSurfaces: missed }),
  };
  await writeText(join(artifactDir, "draft.json"), `${JSON.stringify(draft, null, 2)}\n`);
  return { draft, notes, briefFromStage };
}
