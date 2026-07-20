/**
 * W1-bench Experiment 1 — inline tool refs vs <Query> declarations.
 * A/B over the same dev prompts, same generator model. Compiler is production
 * compileWireV2 (inline arm uses the inlineRefs prototype). Writes raw samples
 * + an arm summary to docs/verification/w1-bench/raw/.
 *
 * Run: (env-loaded) pnpm --filter @vendoai/apps exec vitest run src/bench/exp1.bench.test.ts
 */
import { describe, expect, it } from "vitest";
import { DEV_PROMPTS, QUERY_ARM_SYSTEM, INLINE_ARM_SYSTEM } from "./prompts.js";
import { runArm } from "./runner.js";
import { armTableRows, qualityDiffOutsideNoise, summarize, writeRaw } from "./report.js";

describe.skipIf(!process.env.ANTHROPIC_API_KEY)("W1 Exp1: inline refs vs <Query>", () => {
  it("A/B measures reference reliability and quality", { timeout: 1_800_000 }, async () => {
    const prompts = DEV_PROMPTS;

    const [queryArm, inlineArm] = await Promise.all([
      runArm(prompts, { system: QUERY_ARM_SYSTEM }),
      runArm(prompts, { system: INLINE_ARM_SYSTEM, inlineRefs: true }),
    ]);

    const sumQuery = summarize("A: <Query> decls", queryArm);
    const sumInline = summarize("B: inline refs", inlineArm);
    const sig = qualityDiffOutsideNoise(queryArm, inlineArm);

    const artifact = {
      experiment: "exp1-inline-vs-query",
      generatedAt: new Date().toISOString(),
      summaries: [sumQuery, sumInline],
      qualityDiff: sig,
      table: armTableRows([sumQuery, sumInline]),
      samples: { query: queryArm, inline: inlineArm },
    };
    const path = writeRaw("exp1.json", artifact);

    // eslint-disable-next-line no-console
    console.log(`\n=== EXP1 ===\n${artifact.table}\nquality diff (A-B): ${sig.diff.toFixed(2)} ± ${(2 * sig.se).toFixed(2)} outsideNoise=${sig.outside}\nraw: ${path}\n`);

    expect(queryArm.length).toBe(prompts.length);
    expect(inlineArm.length).toBe(prompts.length);
  });
});
