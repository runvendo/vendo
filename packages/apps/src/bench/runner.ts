/**
 * W1-bench (docs/verification/w1-bench) — run one arm: generate a wire per
 * prompt (bounded concurrency), compile+score it, and judge it. Pure glue over
 * client/metrics/judge so each experiment file stays declarative.
 */
import { generateWire, pool, type GenOptions } from "./client.js";
import { computeWireMetrics } from "./metrics.js";
import { judge } from "./judge.js";
import { MAPLE_TOOL_SHAPES } from "./fixtures.js";
import type { Sample } from "./report.js";

export interface ArmConfig {
  system: string | ((prompt: string) => string);
  inlineRefs?: boolean;
  gen?: GenOptions;
  concurrency?: number;
}

export const runArm = async (prompts: string[], cfg: ArmConfig): Promise<Sample[]> =>
  pool(prompts, cfg.concurrency ?? 4, async (prompt): Promise<Sample> => {
    const system = typeof cfg.system === "function" ? cfg.system(prompt) : cfg.system;
    const g = await generateWire(system, `USER_REQUEST: ${prompt}`, cfg.gen ?? {});
    const metrics = computeWireMetrics(g.wire, MAPLE_TOOL_SHAPES, { inlineRefs: cfg.inlineRefs });
    const j = await judge(prompt, g.wire);
    return {
      prompt,
      wire: g.wire,
      inputTokens: g.inputTokens,
      outputTokens: g.outputTokens,
      ms: g.ms,
      genError: g.error,
      metrics,
      judge: j,
    };
  });
