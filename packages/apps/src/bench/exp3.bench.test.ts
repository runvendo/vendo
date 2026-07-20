/**
 * W1-bench Experiment 3 — fetch-then-generate vs shape-cards-only.
 * Arm A: today (shape cards in the prompt). Arm B: phase-1 no-think call picks
 * read tools+args → runtime reads them (simulated from fixtures, truncated) →
 * phase-2 generation sees per-tool args/shape/rowCount/sample rows.
 * Includes negative prompts (no tool for the ask) to probe honesty.
 *
 * Run: (env-loaded) pnpm --filter @vendoai/apps exec vitest run src/bench/exp3.bench.test.ts
 */
import { describe, expect, it } from "vitest";
import { describeShape, type Json } from "@vendoai/core";
import { generateWire, generateModelJsonList, pool } from "./client.js";
import { computeWireMetrics } from "./metrics.js";
import { judge } from "./judge.js";
import { DEV_PROMPTS, NEGATIVE_PROMPTS, QUERY_ARM_SYSTEM, buildFetchAwareSystem } from "./prompts.js";
import { MAPLE_TOOLS, MAPLE_TOOL_SHAPES } from "./fixtures.js";
import { runArm } from "./runner.js";
import { armTableRows, qualityDiffOutsideNoise, summarize, writeRaw, type Sample } from "./report.js";

const READ_TOOLS = MAPLE_TOOLS.filter((t) => t.risk === "read");

const truncateSample = (sample: Json): { preview: Json; rowCount: number } => {
  if (sample && typeof sample === "object" && !Array.isArray(sample) && Array.isArray((sample as Record<string, Json>).data)) {
    const rec = { ...(sample as Record<string, Json>) };
    const rows = rec.data as Json[];
    rec.data = rows.slice(0, 3);
    return { preview: rec, rowCount: rows.length };
  }
  return { preview: sample, rowCount: Array.isArray(sample) ? sample.length : 1 };
};

const phase1System = `You are the read-planner. Given a user request and the available READ tools, output ONLY a JSON array of the reads needed, each {"tool":"<name>","input":{...}}. Use only these tools; if NONE provides the data the request needs, output []. No prose.
READ TOOLS:
${READ_TOOLS.map((t) => `- ${t.name}: ${t.description}`).join("\n")}`;

const buildFetchedBlock = (reads: { tool: string; input?: Record<string, unknown> }[]): string => {
  if (reads.length === 0) return "(no host tool matched this request — nothing was read)";
  const lines: string[] = [];
  for (const r of reads) {
    const def = MAPLE_TOOLS.find((t) => t.name === r.tool);
    if (!def) continue;
    const { preview, rowCount } = truncateSample(def.sample);
    lines.push(
      `- ${r.tool}(${JSON.stringify(r.input ?? {})}) → rowCount ${rowCount}; shape ${describeShape(MAPLE_TOOL_SHAPES[r.tool]!)}\n  sample: ${JSON.stringify(preview)}`,
    );
  }
  return lines.join("\n");
};

const runFetchThenGenerate = async (prompts: string[]): Promise<Sample[]> =>
  pool(prompts, 3, async (prompt): Promise<Sample> => {
    // Phase 1 — no-think tool selection.
    const reads = await generateModelJsonList(phase1System, `USER_REQUEST: ${prompt}`);
    const validReads = reads
      .filter((r): r is { tool: string; input?: Record<string, unknown> } => Boolean(r && typeof r.tool === "string"))
      .filter((r) => READ_TOOLS.some((t) => t.name === r.tool));
    // Phase 2 — generation sees the real fetched data.
    const system = buildFetchAwareSystem(buildFetchedBlock(validReads));
    const g = await generateWire(system, `USER_REQUEST: ${prompt}`);
    const metrics = computeWireMetrics(g.wire, MAPLE_TOOL_SHAPES);
    const j = await judge(prompt, g.wire);
    return { prompt, wire: g.wire, inputTokens: g.inputTokens, outputTokens: g.outputTokens, ms: g.ms, genError: g.error, metrics, judge: j };
  });

describe.skipIf(!process.env.ANTHROPIC_API_KEY)("W1 Exp3: fetch-then-generate vs shape-cards", () => {
  it("A/B on field-ref, cents-format, honesty, latency", { timeout: 1_800_000 }, async () => {
    const prompts = [...DEV_PROMPTS, ...NEGATIVE_PROMPTS];

    const [cardsArm, fetchArm] = await Promise.all([
      runArm(prompts, { system: QUERY_ARM_SYSTEM, concurrency: 3 }),
      runFetchThenGenerate(prompts),
    ]);

    const sumCards = summarize("A: shape cards", cardsArm);
    const sumFetch = summarize("B: fetch-then-generate", fetchArm);
    const sig = qualityDiffOutsideNoise(fetchArm, cardsArm);

    // Honesty on negatives only.
    const negIdx = prompts.map((p, i) => (NEGATIVE_PROMPTS.includes(p) ? i : -1)).filter((i) => i >= 0);
    const negFab = (arr: Sample[]) => negIdx.filter((i) => arr[i]!.judge.fabricated).length;

    const artifact = {
      experiment: "exp3-fetch-vs-cards",
      generatedAt: new Date().toISOString(),
      summaries: [sumCards, sumFetch],
      qualityDiff: sig,
      negativePrompts: { count: negIdx.length, fabricatedCards: negFab(cardsArm), fabricatedFetch: negFab(fetchArm) },
      table: armTableRows([sumCards, sumFetch]),
      samples: { cards: cardsArm, fetch: fetchArm },
    };
    const path = writeRaw("exp3.json", artifact);

    // eslint-disable-next-line no-console
    console.log(`\n=== EXP3 ===\n${artifact.table}\nnegatives fabricated — cards:${negFab(cardsArm)}/${negIdx.length} fetch:${negFab(fetchArm)}/${negIdx.length}\nquality diff (B-A): ${sig.diff.toFixed(2)} ± ${(2 * sig.se).toFixed(2)} outsideNoise=${sig.outside}\nraw: ${path}\n`);

    expect(cardsArm.length).toBe(prompts.length);
    expect(fetchArm.length).toBe(prompts.length);
  });
});
