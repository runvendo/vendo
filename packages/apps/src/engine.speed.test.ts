/**
 * Speed harness (vendo-v2-speed lane) — a live, repeatable measurement of the
 * real create path: modelEngine.create against a demo host catalog, timing
 * time-to-tier-0-paint and time-to-complete with token counts and the
 * paint/full lane split.
 *
 * NOT part of the gate: guarded by SPEED_MODE so `pnpm test` never runs it (no
 * keys, no cost). Each `vitest run` is a fresh process, which is how cold vs
 * warm first-paint is measured honestly.
 *
 *   SPEED_MODE=loop  SPEED_RUNS=5 — N steady-state creates, p50/p90 report
 *   SPEED_MODE=cold               — one create, no prewarm (process cold)
 *   SPEED_MODE=warm               — prewarm() then one create (connection warm)
 *
 * Results append to docs/verification/vendo-v2-speed/samples.ndjson so runs
 * across processes aggregate. Env: ANTHROPIC_API_KEY, optional
 * VENDO_SPEED_FULL_MODEL / VENDO_SPEED_PAINT_MODEL / SPEED_PROMPT.
 */
import { appendFileSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import type { LanguageModel } from "ai";
import { describe, it } from "vitest";
import type { NormalizedCatalog } from "@vendoai/core";
import { modelEngine, type GenerationDependencies, type GenerationTimingEvent } from "./engine.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
const samplesPath = resolve(repoRoot, "docs/verification/vendo-v2-speed/samples.ndjson");

const FULL_MODEL = process.env.VENDO_SPEED_FULL_MODEL ?? "claude-sonnet-4-6";
const PAINT_MODEL = process.env.VENDO_SPEED_PAINT_MODEL ?? "claude-haiku-4-5";
const PROMPT = process.env.SPEED_PROMPT
  ?? "Build me a net-worth dashboard with my total balance, a balance-over-time chart, and my recent transactions.";

const loadCatalog = (): NormalizedCatalog => {
  const raw = JSON.parse(readFileSync(resolve(repoRoot, "apps/demo-bank/.vendo/catalog.json"), "utf8")) as {
    entries: Array<{ name: string; description: string; propsSchema: unknown; examples?: string[] }>;
  };
  return raw.entries.map((e) => ({
    name: e.name,
    description: e.description,
    propsJsonSchema: e.propsSchema as NormalizedCatalog[number]["propsJsonSchema"],
    ...(e.examples === undefined ? {} : { examples: e.examples }),
  })) as NormalizedCatalog;
};

const anthropicModel = async (id: string): Promise<LanguageModel> => {
  const { createAnthropic } = await import("@ai-sdk/anthropic");
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (apiKey === undefined || apiKey === "") throw new Error("ANTHROPIC_API_KEY missing — copy /Users/.../flowlet/.env into .env");
  return createAnthropic({ apiKey })(id);
};

interface Sample {
  mode: string;
  variant: string;
  firstPaintMs: number | null;
  completeMs: number | null;
  paintCompleteMs: number | null;
  fullFirstMs: number | null;
  paintOutTokens: number | null;
  fullOutTokens: number | null;
}

const runOnce = async (deps: GenerationDependencies, variant: string, mode: string): Promise<Sample> => {
  const events: GenerationTimingEvent[] = [];
  const start = Date.now();
  let firstPaintMs: number | null = null;
  const wired: GenerationDependencies = {
    ...deps,
    onPartial: () => { if (firstPaintMs === null) firstPaintMs = Date.now() - start; },
    onTiming: (e) => events.push(e),
  };
  await modelEngine.create({ prompt: PROMPT }, wired);
  const completeMs = Date.now() - start;
  // The full lane repairs up to 3×, emitting one `complete` per attempt — take
  // the LAST match so tokens/atMs reflect the successful document, not a failed
  // repair attempt (Devin review). first-partial is the first prefix either way.
  const find = (lane: string, phase: string) => phase === "complete"
    ? events.findLast((e) => e.lane === lane && e.phase === phase)
    : events.find((e) => e.lane === lane && e.phase === phase);
  const sample: Sample = {
    mode,
    variant,
    firstPaintMs,
    completeMs,
    paintCompleteMs: find("paint", "complete")?.atMs ?? null,
    fullFirstMs: find("full", "first-partial")?.atMs ?? null,
    paintOutTokens: find("paint", "complete")?.usage?.outputTokens ?? null,
    fullOutTokens: find("full", "complete")?.usage?.outputTokens ?? null,
  };
  appendFileSync(samplesPath, `${JSON.stringify(sample)}\n`);
  // eslint-disable-next-line no-console
  console.log(`[speed:${mode}:${variant}] firstPaint=${firstPaintMs}ms complete=${completeMs}ms paint=${sample.paintCompleteMs}ms fullFirst=${sample.fullFirstMs}ms tokens(paint/full)=${sample.paintOutTokens}/${sample.fullOutTokens}`);
  return sample;
};

const baseDeps = async (variant: "single-lane" | "two-lane"): Promise<GenerationDependencies> => ({
  model: await anthropicModel(FULL_MODEL),
  catalog: loadCatalog(),
  // two-lane: haiku paint + sonnet full (demo default). single-lane: paint
  // disabled, so first paint comes straight from the full lane.
  paint: variant === "two-lane" ? { model: await anthropicModel(PAINT_MODEL) } : { disabled: true },
});

const mode = process.env.SPEED_MODE;
const TIMEOUT = 600_000;

describe.runIf(mode !== undefined && mode !== "")("speed harness (live)", () => {
  const variant = (process.env.SPEED_VARIANT ?? "two-lane") as "single-lane" | "two-lane";

  it(`mode=${mode} variant=${variant}`, async () => {
    if (mode === "loop") {
      const runs = Number(process.env.SPEED_RUNS ?? "5");
      const deps = await baseDeps(variant);
      for (let i = 0; i < runs; i += 1) await runOnce(deps, variant, "loop");
    } else if (mode === "warm") {
      const deps = await baseDeps(variant);
      // Prewarm: establish the provider import + TLS/HTTP connection with a
      // throwaway 1-token generation, then measure the real create warm.
      await prewarm(deps.model);
      if (deps.paint?.model !== undefined) await prewarm(deps.paint.model);
      await runOnce(deps, variant, "warm");
    } else {
      const deps = await baseDeps(variant);
      await runOnce(deps, variant, "cold");
    }
  }, TIMEOUT);
});

/** Warm the model connection the same way a page-open prewarm would: a minimal
 *  generation that pays the import + TLS + first-token cost up front. */
const prewarm = async (model: LanguageModel): Promise<void> => {
  const { generateText } = await import("ai");
  await generateText({ model, prompt: "ok", maxOutputTokens: 1, maxRetries: 0 }).catch(() => undefined);
};
