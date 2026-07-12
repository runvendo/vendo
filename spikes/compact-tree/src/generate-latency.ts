/**
 * KEY-GATED live latency + validity trials (NOT part of `pnpm test`). Run with:
 *   pnpm --filter @vendoai/spike-compact-tree build
 *   source /Users/yousefh/orca/workspaces/flowlet/.env
 *   pnpm --filter @vendoai/spike-compact-tree measure:latency
 *
 * Env knobs: MODELS (comma list, default "claude-sonnet-5,claude-haiku-4-5"),
 *            TRIALS (per arm, default 5), REQUESTS (comma list of UI_REQUEST ids).
 *
 * Bias controls (review round 2):
 *   - ARM ORDER IS SHUFFLED per (model, request, trial-round) — arms never run
 *     in a fixed readable→cjt→vtl sequence, so warm-up/rate-limit drift cannot
 *     systematically favor one arm.
 *   - EVERY attempted trial is retained (invalid and errored included) and the
 *     raw per-trial records are written to results/latency.json (committed,
 *     linked from DESIGN.md). Aggregates report ALL-TRIALS and VALID-ONLY
 *     numbers separately.
 *   - Each valid trial records TREE COMPLEXITY (nodes / prop keys / components /
 *     queries): the arms answer the same request but each generates its own
 *     tree, so an arm could "win" by emitting a simpler tree. Complexity means
 *     are reported next to latency so that confound is visible, not hidden.
 *
 * Validity uses the STRICT decoders (+ the same extension-field boundary on the
 * readable arm) — emission reliability is reported as plainly as speed.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { GEN_MODEL, getAnthropic } from "./harness.js";
import { extractText, parseArm, thinkingParam } from "./model.js";
import type { TreeComplexity } from "./model.js";
import type { Arm } from "./prompts.js";
import { systemPromptFor, UI_REQUESTS } from "./prompts.js";

const ARMS: Arm[] = ["readable", "cjt", "vtl"];
const HERE = dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = join(HERE, "..", "results");

interface Trial {
  model: string;
  request: string;
  arm: Arm;
  round: number;
  /** Position within the shuffled round (0-2) — for auditing order effects. */
  orderInRound: number;
  status: "completed" | "request-error";
  outputTokens?: number;
  ttfbMs?: number;
  totalMs?: number;
  valid?: boolean;
  complexity?: TreeComplexity;
  error?: string;
}

function shuffled<T>(items: readonly T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

async function runTrial(
  anthropic: Awaited<ReturnType<typeof getAnthropic>>,
  base: Pick<Trial, "model" | "request" | "arm" | "round" | "orderInRound">,
  prompt: string,
): Promise<Trial> {
  const t0 = performance.now();
  let ttfb = -1;
  const stream = anthropic.messages.stream({
    model: base.model,
    max_tokens: 8000,
    system: systemPromptFor(base.arm),
    messages: [{ role: "user", content: prompt }],
    ...thinkingParam(base.model),
  });
  for await (const event of stream) {
    if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
      if (ttfb < 0) ttfb = performance.now() - t0;
    }
  }
  const final = await stream.finalMessage();
  const totalMs = performance.now() - t0;
  const text = extractText(final.content);
  const parsed = parseArm(base.arm, text);
  return {
    ...base,
    status: "completed",
    outputTokens: final.usage.output_tokens,
    ttfbMs: ttfb < 0 ? totalMs : ttfb,
    totalMs,
    valid: parsed.ok,
    complexity: parsed.complexity,
    error: parsed.error,
  };
}

function mean(xs: number[]): string {
  return xs.length ? (xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(0) : "-";
}

async function main(): Promise<void> {
  const anthropic = await getAnthropic();
  const models = (process.env.MODELS ?? `${GEN_MODEL},claude-haiku-4-5`).split(",").map((m) => m.trim()).filter(Boolean);
  const trialsPer = Number(process.env.TRIALS ?? "5");
  const requestFilter = (process.env.REQUESTS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const requests = requestFilter.length ? UI_REQUESTS.filter((r) => requestFilter.includes(r.id)) : UI_REQUESTS;

  const trials: Trial[] = [];
  for (const model of models) {
    for (const req of requests) {
      for (let round = 0; round < trialsPer; round += 1) {
        // Shuffle arm order every round — no fixed readable-first sequencing.
        const order = shuffled(ARMS);
        for (let pos = 0; pos < order.length; pos += 1) {
          const arm = order[pos]!;
          const base = { model, request: req.id, arm, round, orderInRound: pos };
          let trial: Trial;
          try {
            trial = await runTrial(anthropic, base, req.prompt);
          } catch (err) {
            trial = { ...base, status: "request-error", error: err instanceof Error ? err.message : String(err) };
          }
          trials.push(trial);
          const c = trial.complexity;
          // eslint-disable-next-line no-console
          console.log(
            trial.status === "request-error"
              ? `${model} ${req.id} ${arm} r${round}p${pos}: REQUEST ERROR — ${trial.error?.slice(0, 80)}`
              : `${model} ${req.id} ${arm} r${round}p${pos}: ${trial.outputTokens}tok ${trial.totalMs!.toFixed(0)}ms ttfb ${trial.ttfbMs!.toFixed(0)}ms ${trial.valid ? `VALID (${c!.nodes}n/${c!.propKeys}p/${c!.components}c)` : "INVALID"}${trial.error ? " — " + trial.error.slice(0, 80) : ""}`,
          );
        }
      }
    }
  }

  mkdirSync(RESULTS_DIR, { recursive: true });
  const outFile = join(RESULTS_DIR, "latency.json");
  writeFileSync(
    outFile,
    `${JSON.stringify({ generatedAt: new Date().toISOString(), models, trialsPerArmPerModel: trialsPer * requests.length, trials }, null, 2)}\n`,
    "utf8",
  );
  // eslint-disable-next-line no-console
  console.log(`\nraw per-trial records -> ${outFile}`);

  // eslint-disable-next-line no-console
  console.log("\n=== PER-ARM AGGREGATE ===");
  // eslint-disable-next-line no-console
  console.log(
    [
      "model",
      "arm",
      "n",
      "validRate",
      "outTok(all)",
      "outTok(valid)",
      "totalMs(all)",
      "totalMs(valid)",
      "ttfbMs(valid)",
      "nodes(valid)",
      "propKeys(valid)",
      "comps(valid)",
    ].join("\t"),
  );
  for (const model of models) {
    for (const arm of ARMS) {
      const subset = trials.filter((t) => t.model === model && t.arm === arm);
      if (subset.length === 0) continue;
      const completed = subset.filter((t) => t.status === "completed");
      const valid = completed.filter((t) => t.valid);
      const validRate = subset.length ? `${((valid.length / subset.length) * 100).toFixed(0)}%` : "-";
      // eslint-disable-next-line no-console
      console.log(
        [
          model,
          arm,
          subset.length,
          validRate,
          mean(completed.map((t) => t.outputTokens!)),
          mean(valid.map((t) => t.outputTokens!)),
          mean(completed.map((t) => t.totalMs!)),
          mean(valid.map((t) => t.totalMs!)),
          mean(valid.map((t) => t.ttfbMs!)),
          mean(valid.map((t) => t.complexity!.nodes)),
          mean(valid.map((t) => t.complexity!.propKeys)),
          mean(valid.map((t) => t.complexity!.components)),
        ].join("\t"),
      );
    }
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
