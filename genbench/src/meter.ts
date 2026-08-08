import type { LanguageModelV3, LanguageModelV3Middleware, LanguageModelV3Usage } from "@ai-sdk/provider";
import { wrapLanguageModel, type LanguageModel } from "ai";

export type ModelAlias = "opus" | "sonnet" | "haiku";

/** Pinned ids. Each one was checked against the live API through
 *  `@ai-sdk/anthropic` before being written here. */
export const MODEL_IDS: Readonly<Record<ModelAlias, string>> = {
  opus: "claude-opus-5",
  sonnet: "claude-sonnet-5",
  haiku: "claude-haiku-4-5-20251001",
};

interface ModelPrice {
  readonly inputPerMTok: number;
  readonly outputPerMTok: number;
}

/** Effective $/MTok as of 2026-08-08. Sonnet 5 is on introductory pricing —
 *  $2/$10 rather than its $3/$15 list rate — through 2026-08-31, after which
 *  this row goes back up and two runs' dollars stop comparing. The token counts
 *  beside every dollar figure are the durable number; the dollars are a reading
 *  of this table on the day the run happened. */
const PRICING: Readonly<Record<string, ModelPrice>> = {
  "claude-opus-5": { inputPerMTok: 5, outputPerMTok: 25 },
  "claude-sonnet-5": { inputPerMTok: 2, outputPerMTok: 10 },
  "claude-haiku-4-5-20251001": { inputPerMTok: 1, outputPerMTok: 5 },
};

/** Cache reads bill at a tenth of the input rate; 5-minute cache writes at 1.25x. */
const CACHE_READ_MULTIPLIER = 0.1;
const CACHE_WRITE_MULTIPLIER = 1.25;

/** The screen agent builds its Turn with no `maxOutputTokens`, so the provider
 *  default applies and a long document can truncate mid-write with no error.
 *  The meter fills the gap only when the caller left it unset. */
const MAX_OUTPUT_TOKENS_FLOOR = 32_000;

export interface UsageTotals {
  /** Input tokens billed at the full rate — cache reads and writes are excluded. */
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly calls: number;
}

export interface Meter {
  /** Hand this to the driver. Every contender is metered by this same wrapper,
   *  which is what makes the columns comparable. */
  readonly model: LanguageModel;
  /** Milliseconds since the meter was created. The run's only clock. */
  elapsedMs(): number;
  totals(): UsageTotals;
  usd(): number;
}

export function meteredModel(base: LanguageModelV3, modelId: string): Meter {
  const startedAt = performance.now();
  const totals = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, calls: 0 };

  const record = (usage: LanguageModelV3Usage): void => {
    const cacheRead = usage.inputTokens.cacheRead ?? 0;
    const cacheWrite = usage.inputTokens.cacheWrite ?? 0;
    // `noCache` is what the full input rate applies to. Providers that only
    // report a total get the same number by subtraction.
    const uncached =
      usage.inputTokens.noCache ?? Math.max(0, (usage.inputTokens.total ?? 0) - cacheRead - cacheWrite);
    totals.inputTokens += uncached;
    totals.outputTokens += usage.outputTokens.total ?? 0;
    totals.cacheReadTokens += cacheRead;
    totals.cacheWriteTokens += cacheWrite;
    totals.calls += 1;
  };

  const middleware: LanguageModelV3Middleware = {
    specificationVersion: "v3",
    transformParams: async ({ params }) => ({
      ...params,
      maxOutputTokens: params.maxOutputTokens ?? MAX_OUTPUT_TOKENS_FLOOR,
    }),
    wrapGenerate: async ({ doGenerate }) => {
      const result = await doGenerate();
      record(result.usage);
      return result;
    },
    wrapStream: async ({ doStream }) => {
      const result = await doStream();
      return {
        ...result,
        stream: result.stream.pipeThrough(
          new TransformStream({
            transform(part, controller) {
              if (part.type === "finish") record(part.usage);
              controller.enqueue(part);
            },
          }),
        ),
      };
    },
  };

  return {
    model: wrapLanguageModel({ model: base, middleware }),
    elapsedMs: () => Math.round(performance.now() - startedAt),
    totals: () => ({ ...totals }),
    usd: () => usdFor({ ...totals }, modelId),
  };
}

export function usdFor(usage: UsageTotals, modelId: string): number {
  const price = PRICING[modelId];
  if (!price) throw new Error(`genbench: no price for model "${modelId}"`);
  const input =
    usage.inputTokens +
    usage.cacheReadTokens * CACHE_READ_MULTIPLIER +
    usage.cacheWriteTokens * CACHE_WRITE_MULTIPLIER;
  return (input * price.inputPerMTok + usage.outputTokens * price.outputPerMTok) / 1_000_000;
}
