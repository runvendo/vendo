import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { knowledgeDocSchema, knowledgeIntentSchema, knowledgeKindSchema, type KnowledgeDoc } from "@vendoai/core";

/**
 * The knowledge eval's data files (knowledge design spec §Evals, lane K2).
 * Doctrine and the golden/refusal/bars data live in the eval front door
 * (docs/eval/knowledge/ — see docs/eval/KNOWLEDGE.md); the fixture corpus
 * lives beside this module. Schemas are zod-strict so a stray field in a
 * hand-edited data file fails loudly instead of silently not counting.
 */

export const goldenItemSchema = z
  .object({
    id: z.string().min(1),
    /** The natural question real engines are measured on. */
    question: z.string().min(1),
    /** A phrase that literally occurs in the target doc's `title\ntext`
        (case-insensitive). The memory engine matches by whole-query substring
        (score always 1), so the per-PR offline leg queries with this instead
        of the natural question. Authored until the item retrieves at rank 1. */
    memoryQuery: z.string().min(1).optional(),
    kinds: z.array(knowledgeKindSchema).min(1).optional(),
    /** Defaults to "chat" when absent, mirroring KnowledgeQuery. */
    intent: knowledgeIntentSchema.optional(),
    expectedDocIds: z.array(z.string().min(1)).min(1),
    keyPoints: z.array(z.string().min(1)).min(2).max(4),
  })
  .strict();

export type GoldenItem = z.infer<typeof goldenItemSchema>;

export const goldenSetSchema = z
  .object({
    version: z.literal(1),
    items: z.array(goldenItemSchema).min(1),
  })
  .strict();

export type GoldenSet = z.infer<typeof goldenSetSchema>;

export const refusalItemSchema = z
  .object({
    id: z.string().min(1),
    question: z.string().min(1),
    paraphrases: z.array(z.string().min(1)),
  })
  .strict();

export type RefusalItem = z.infer<typeof refusalItemSchema>;

export const refusalSetSchema = z
  .object({
    version: z.literal(1),
    items: z.array(refusalItemSchema).min(1),
  })
  .strict();

export type RefusalSet = z.infer<typeof refusalSetSchema>;

/** Per-engine pass bars with baseline-ratchet semantics (the corpus layer-2
    baseline.json + bench/budgets.json convention): a bar may only move via a
    PR editing the file, justified in `toleranceRationale`. Keys are metric
    ids from the runner ("recall@5", "mrr", per-intent variants, "judge.*"). */
export const engineBarsSchema = z
  .object({
    version: z.literal(1),
    generatedAt: z.string().min(1),
    toleranceRationale: z.string().min(1),
    bars: z.record(z.string().min(1), z.number()),
  })
  .strict();

export type EngineBars = z.infer<typeof engineBarsSchema>;

export const fixtureCorpusSchema = z
  .object({
    version: z.literal(1),
    docs: z.array(knowledgeDocSchema).min(1),
  })
  .strict();

export interface FixtureCorpus {
  version: 1;
  docs: KnowledgeDoc[];
}

const moduleDir = path.dirname(fileURLToPath(import.meta.url));

/** corpus/harness/src/knowledge-eval → repo root. */
export const defaultWorkspaceRoot = path.resolve(moduleDir, "../../../../");

export function knowledgeEvalDataDir(workspaceRoot = defaultWorkspaceRoot): string {
  return path.join(workspaceRoot, "docs", "eval", "knowledge");
}

export const fixtureCorpusPath = path.join(moduleDir, "fixtures", "corpus.json");

async function readJson(file: string): Promise<unknown> {
  return JSON.parse(await readFile(file, "utf8")) as unknown;
}

export async function loadGoldenSet(workspaceRoot = defaultWorkspaceRoot): Promise<GoldenSet> {
  return goldenSetSchema.parse(await readJson(path.join(knowledgeEvalDataDir(workspaceRoot), "golden.json")));
}

export async function loadRefusalSet(workspaceRoot = defaultWorkspaceRoot): Promise<RefusalSet> {
  return refusalSetSchema.parse(await readJson(path.join(knowledgeEvalDataDir(workspaceRoot), "refusals.json")));
}

export function engineBarsPath(engine: string, workspaceRoot = defaultWorkspaceRoot): string {
  return path.join(knowledgeEvalDataDir(workspaceRoot), "bars", `${engine}.json`);
}

/** Bars are discovered by file presence: `bars/<engine>.json` exists → that
    engine's run is regression-gated. Absent file = no bars yet (null). */
export async function loadEngineBars(engine: string, workspaceRoot = defaultWorkspaceRoot): Promise<EngineBars | null> {
  let raw: unknown;
  try {
    raw = await readJson(engineBarsPath(engine, workspaceRoot));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  return engineBarsSchema.parse(raw);
}

export async function loadFixtureCorpus(): Promise<FixtureCorpus> {
  return fixtureCorpusSchema.parse(await readJson(fixtureCorpusPath)) as FixtureCorpus;
}
