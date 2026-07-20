/**
 * W1-bench Experiment 2 — builder-calls fork.
 * Arm A: current single-stream JSX. Arm B: app emitted as strict builder tool
 * calls in ONE assistant turn, extended thinking ON (think-then-constrain).
 * Reliability is ~guaranteed by construction; the GO/NO-GO metric is JUDGED
 * QUALITY (does composition survive many discrete calls?) plus tokens/latency.
 *
 * Run: (env-loaded) pnpm --filter @vendoai/apps exec vitest run src/bench/exp2.bench.test.ts
 */
import { describe, expect, it } from "vitest";
import { generateToolCalls, pool } from "./client.js";
import { computeWireMetrics } from "./metrics.js";
import { judge } from "./judge.js";
import { DEV_PROMPTS, QUERY_ARM_SYSTEM, FORK_SYSTEM } from "./prompts.js";
import { MAPLE_TOOL_SHAPES } from "./fixtures.js";
import { buildForkTools, reconstructWire } from "./toolfork.js";
import { runArm } from "./runner.js";
import { armTableRows, qualityDiffOutsideNoise, summarize, writeRaw, type Sample } from "./report.js";

const THINK_BUDGET = 3000;

const runForkArm = async (prompts: string[]): Promise<(Sample & { callCount: number })[]> => {
  const tools = buildForkTools();
  return pool(prompts, 3, async (prompt): Promise<Sample & { callCount: number }> => {
    const r = await generateToolCalls(FORK_SYSTEM, `USER_REQUEST: ${prompt}`, tools, { thinkingBudget: THINK_BUDGET, maxSteps: 24, maxOutputTokens: 16000 });
    const wire = reconstructWire(r.calls);
    const metrics = computeWireMetrics(wire, MAPLE_TOOL_SHAPES);
    const j = await judge(prompt, wire);
    return { prompt, wire, inputTokens: r.inputTokens, outputTokens: r.outputTokens, ms: r.ms, genError: r.error, metrics, judge: j, callCount: r.calls.length };
  });
};

describe.skipIf(!process.env.ANTHROPIC_API_KEY)("W1 Exp2: builder-calls fork", () => {
  it("A/B on composition quality, reliability, tokens/latency", { timeout: 1_800_000 }, async () => {
    const prompts = DEV_PROMPTS;

    const [jsxArm, forkArm] = await Promise.all([
      runArm(prompts, { system: QUERY_ARM_SYSTEM, concurrency: 3 }),
      runForkArm(prompts),
    ]);

    const sumJsx = summarize("A: single-stream JSX", jsxArm);
    const sumFork = summarize("B: builder tool calls (+thinking)", forkArm);
    const sig = qualityDiffOutsideNoise(forkArm, jsxArm);
    const meanCalls = forkArm.reduce((a, s) => a + s.callCount, 0) / forkArm.length;

    const artifact = {
      experiment: "exp2-builder-calls-fork",
      generatedAt: new Date().toISOString(),
      thinkingBudget: THINK_BUDGET,
      summaries: [sumJsx, sumFork],
      qualityDiff: sig,
      meanToolCallsPerApp: meanCalls,
      table: armTableRows([sumJsx, sumFork]),
      samples: { jsx: jsxArm, fork: forkArm },
    };
    const path = writeRaw("exp2.json", artifact);

    // eslint-disable-next-line no-console
    console.log(`\n=== EXP2 ===\n${artifact.table}\nmean tool calls/app (fork): ${meanCalls.toFixed(1)}\nquality diff (B-A): ${sig.diff.toFixed(2)} ± ${(2 * sig.se).toFixed(2)} outsideNoise=${sig.outside}\nraw: ${path}\n`);

    expect(jsxArm.length).toBe(prompts.length);
    expect(forkArm.length).toBe(prompts.length);
  });
});
