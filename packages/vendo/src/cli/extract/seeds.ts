import { rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { parseArtifact, type ExtractionHarness } from "./harness.js";
import { staticFacts, type StaticTool } from "./stages.js";
import { writeText, type Output } from "../shared.js";
import {
  VENDO_FIXTURES_FORMAT,
  VENDO_USECASES_FORMAT,
  fixturesFileSchema,
  usecaseSchema,
  usecasesFileSchema,
  type Usecase,
} from "../try/profile.js";

/**
 * The seeds pass (unified try surface, Task 3): ONE generative
 * `harness.run(instructions)` after the staged extraction, seeding the try
 * surface's first touch — 4–6 product-specific use-case chips plus synthetic
 * fixture rows for the read tools those chips lean on, so generated apps can
 * paint plausible data without the host's API running. Purely generative: the
 * harness runs in the PROFILE root (never the host repo) and everything it
 * needs — the brief, the tool facts — rides in the instructions.
 *
 * Contract discipline: the artifacts are validated against and written in the
 * profile's own file schemas (`vendo/usecases@1`, `vendo/fixtures@1`),
 * imported from try/profile.ts — never a second copy of the `@1` strings.
 *
 * Depth honesty: the profile assembler counts usecases CONTENT toward the
 * depth level, so a failed or invalid pass writes NOTHING — no artifact, no
 * error record — and returns generic fallback chips the server may render as
 * non-artifact defaults instead.
 */

/** Rendered by the try server when the pass failed — never written to disk,
 *  so they can't masquerade as extracted depth. */
export const FALLBACK_USECASES: Usecase[] = [
  { label: "Show my recent activity", prompt: "Show me a dashboard of my recent activity" },
  { label: "Summarize my account", prompt: "Give me a summary of my account and flag anything that needs attention" },
  { label: "What can you do?", prompt: "What can you help me with in this product?" },
];

/** Prompt-bounding cap: only the first N tools (tools.json order — the same
 *  ordering the draft passes consume) ride into the instructions; a huge host
 *  surface must not turn one seeding call into a runaway prompt. */
const MAX_SEED_TOOLS = 40;

/** What the model answers with; the format literals are stamped on at write
 *  time. min(1): the 4–6 target is prompt-level guidance (a 3-chip answer
 *  still beats fallbacks), but zero chips would write depth with no content. */
const seedsResponseSchema = z.object({
  usecases: z.array(usecaseSchema).min(1),
  fixtures: z.record(z.array(z.unknown())).default({}),
});

function composeSeedsInstructions(brief: string | null, tools: StaticTool[]): string {
  const seedTools = tools.slice(0, MAX_SEED_TOOLS);
  return [
    "You are Vendo's try-surface seeder. Invent the playground's first-touch content from the",
    "product brief and tool list below — do not read the repo; everything you need is here.",
    "",
    "Product brief:",
    brief ?? "unknown product (no brief was extracted — infer what you can from the tools)",
    "",
    seedTools.length === tools.length
      ? "Extracted tools (name, method+path when known, risk, description):"
      : `Extracted tools (first ${seedTools.length} of ${tools.length}; name, method+path when known, risk, description):`,
    staticFacts(seedTools),
    "",
    "Rules:",
    "- Reply with ONLY one fenced json block matching:",
    '  { "usecases": [{ "label", "prompt" }], "fixtures": { "<tool name>": [ <row>, ... ] } }',
    "- usecases: 4-6 product-specific suggestion chips a first-time visitor would press.",
    '  label: the chip text, <= 40 chars ("Build a renewals dashboard"). prompt: the full',
    "  message that visitor would send the agent to get that outcome.",
    "- fixtures: for each READ/list-shaped tool the use cases rely on, 3-8 plausible rows,",
    "  each shaped like a plausible response item for that endpoint, keyed by the exact tool",
    "  name from the list above. {} is acceptable when no read tool fits.",
    "- Synthetic data ONLY: plausible but obviously fake names and values (Ada Lovelace,",
    '  "Acme Demo Co", 555 phone numbers, example.com emails). Never real people, real',
    "  companies' data, or real-world PII.",
  ].join("\n");
}

export interface SeedsPassOptions {
  harness: ExtractionHarness;
  /** The try profile root (the deterministic pass's output dir). Artifacts
   *  land under `<profileRoot>/.vendo/data/extract/`; the harness also runs
   *  here, never in the host repo. */
  profileRoot: string;
  /** The staged extraction's product brief, or null when that stage failed. */
  brief: string | null;
  /** The extracted tool summaries, in tools.json order. */
  tools: StaticTool[];
  /** Harness env (VENDO_EXTRACTION_MODEL override etc.). Defaults to {}. */
  env?: Record<string, string | undefined>;
  output?: Output;
}

export type SeedsPassResult =
  | { status: "written"; usecases: Usecase[]; fixtures: Record<string, unknown[]> }
  | { status: "failed"; fallbackUsecases: Usecase[] };

/** Run the seeds pass. Never throws: any failure (harness, parse, schema)
 *  degrades to the fallback chips with nothing on disk. */
export async function runSeedsPass(options: SeedsPassOptions): Promise<SeedsPassResult> {
  const { harness, profileRoot, brief, tools, output } = options;
  const artifactDir = join(profileRoot, ".vendo", "data", "extract");
  output?.log("seeds: drafting use-case chips and synthetic fixtures");
  try {
    // onProgress stays unwired: this is one bounded generative call with no
    // repo exploration, so there is no live narration worth relaying.
    const text = await harness.run({
      root: profileRoot,
      env: options.env ?? {},
      instructions: composeSeedsInstructions(brief, tools),
    });
    const parsed = parseArtifact(text, seedsResponseSchema);
    // A hallucinated fixture key would ship dead rows to the synthetic
    // executor — keep only keys naming a tool that actually exists.
    const known = new Set(tools.map((tool) => tool.name));
    const fixtures = Object.fromEntries(Object.entries(parsed.fixtures).filter(([name]) => known.has(name)));
    // Both artifacts are validated through the profile's own file schemas
    // BEFORE the first write — a VALIDATION failure can't leave a half-written
    // pair (a mid-write disk failure is cleaned up in the catch below).
    const usecasesFile = usecasesFileSchema.parse({ format: VENDO_USECASES_FORMAT, usecases: parsed.usecases });
    const fixturesFile = fixturesFileSchema.parse({ format: VENDO_FIXTURES_FORMAT, fixtures });
    await writeText(join(artifactDir, "usecases.json"), `${JSON.stringify(usecasesFile, null, 2)}\n`);
    await writeText(join(artifactDir, "fixtures.json"), `${JSON.stringify(fixturesFile, null, 2)}\n`);
    return { status: "written", usecases: usecasesFile.usecases, fixtures: fixturesFile.fixtures };
  } catch (error) {
    // Depth honesty even on a partial write failure: if usecases.json landed
    // before fixtures.json threw, the assembler would count it toward depth
    // while the server serves fallbacks. Best-effort remove exactly OUR two
    // files — never the dir, sibling stage artifacts live there — and swallow
    // rm errors (there may be nothing to remove).
    await Promise.all(["usecases.json", "fixtures.json"].map((name) =>
      rm(join(artifactDir, name), { force: true }).catch(() => {}),
    ));
    const message = error instanceof Error ? error.message : "unknown error";
    output?.error(`seeds pass failed (${message}) — serving generic chips instead`);
    return { status: "failed", fallbackUsecases: FALLBACK_USECASES };
  }
}
