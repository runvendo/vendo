import { performance } from "node:perf_hooks";
import { createAnthropic } from "@ai-sdk/anthropic";
import { streamText } from "ai";
import { createApps } from "@vendoai/apps";
import { createGuard } from "@vendoai/guard";
import { summarize } from "../stats.js";
import { memoryStore } from "../fixtures/memory-store.js";
import { benchContext, benchTools } from "../fixtures/tools.js";
import type { CaseResult, Suite, SuiteResult } from "../types.js";

const TRIALS = 3;
const PROMPT = "Build a simple dashboard that lists three recent invoices with their totals.";

/**
 * Live generation latency (ANTHROPIC_API_KEY required; never in CI).
 *
 * Honesty notes baked into the metrics:
 *  - The engine (packages/apps/src/engine.ts) calls the ai-SDK `generateText`
 *    (buffered, non-streaming), so TTFB is NOT separable at the create() seam.
 *    We measure a direct `streamText` TTFB/total for a real first-token number,
 *    and separately time apps.create() end-to-end.
 *  - The engine hardcodes `temperature: 0`, which claude-sonnet-5 rejects with a
 *    400. create() therefore fails (after its internal retries) on sonnet-5; we
 *    record that and also run create() against a temperature-compatible model so
 *    RESULTS carries a real engine-through-LLM number.
 */
export const genLiveSuite: Suite = {
  name: "gen-live",
  kind: "live",
  async run(): Promise<SuiteResult> {
    if (!process.env.ANTHROPIC_API_KEY) {
      return { suite: "gen-live", kind: "live", cases: [], skipped: true, reason: "ANTHROPIC_API_KEY not set" };
    }

    const anthropic = createAnthropic();
    const streamModelId = process.env.VENDO_BENCH_LIVE_MODEL ?? "claude-sonnet-5";
    const createModelId = process.env.VENDO_BENCH_CREATE_MODEL ?? "claude-haiku-4-5";
    const notes: string[] = [];
    const cases: CaseResult[] = [];

    // 1) Direct streamText TTFB + total (honest first-token latency).
    const ttfbs: number[] = [];
    const totals: number[] = [];
    for (let i = 0; i < TRIALS; i += 1) {
      const start = performance.now();
      let ttfb: number | undefined;
      const result = streamText({ model: anthropic(streamModelId), prompt: PROMPT });
      for await (const _chunk of result.textStream) {
        if (ttfb === undefined) ttfb = performance.now() - start;
      }
      totals.push(performance.now() - start);
      if (ttfb !== undefined) ttfbs.push(ttfb);
    }
    cases.push(summarize(`stream-ttfb (${streamModelId})`, ttfbs));
    cases.push(summarize(`stream-total (${streamModelId})`, totals));
    notes.push(
      "TTFB measured via a direct streamText; the engine itself uses non-streaming generateText, so TTFB is not separable at the create() seam.",
    );

    // 2) apps.create() end-to-end (engine + LLM). Configured stream model first.
    const runCreate = async (modelId: string): Promise<{ durations: number[]; error?: string }> => {
      const store = memoryStore();
      const guard = createGuard({ store });
      const apps = createApps({
        store,
        guard,
        tools: guard.bind(benchTools()),
        catalog: [],
        model: anthropic(modelId),
      });
      const ctx = benchContext("bench_live");
      const durations: number[] = [];
      try {
        for (let i = 0; i < TRIALS; i += 1) {
          const start = performance.now();
          await apps.create({ prompt: PROMPT }, ctx);
          durations.push(performance.now() - start);
        }
        return { durations };
      } catch (error) {
        return { durations, error: error instanceof Error ? error.message : String(error) };
      }
    };

    const primary = await runCreate(streamModelId);
    if (primary.error !== undefined) {
      notes.push(`create() on ${streamModelId} failed: ${primary.error} (the engine sends temperature:0, which sonnet-5 rejects).`);
    } else {
      cases.push(summarize(`create-total (${streamModelId})`, primary.durations));
    }

    if (primary.error !== undefined && createModelId !== streamModelId) {
      const fallback = await runCreate(createModelId);
      if (fallback.error === undefined) {
        cases.push(summarize(`create-total (${createModelId})`, fallback.durations));
        notes.push(`create-total measured on ${createModelId} (temperature-compatible) since ${streamModelId} rejects temperature:0.`);
      } else {
        notes.push(`create() on ${createModelId} also failed: ${fallback.error}`);
      }
    }

    return { suite: "gen-live", kind: "live", cases, notes };
  },
};
