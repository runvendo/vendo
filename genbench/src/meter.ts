import type { LanguageModelV3, LanguageModelV3Middleware, LanguageModelV3Usage } from "@ai-sdk/provider";
import { wrapLanguageModel, type LanguageModel } from "ai";

/** The open-source contenders, served through one OpenAI-compatible endpoint at
 *  Wafer. Membership here is what says an alias is NOT an Anthropic model — the
 *  provider a run builds for it, and the key it demands, both read this. */
export const WAFER_MODEL_IDS = {
  "glm-fast": "glm5.2-fast",
  "deepseek-flash": "DeepSeek-V4-Flash-0731-Fast",
} as const;

export const WAFER_BASE_URL = "https://pass.wafer.ai/v1";

/** The bought product's own model line. Thesys C1 does not let a host choose a
 *  model the way the other columns do — the column IS the product — so it has
 *  exactly one alias, and `contenders` in `run.ts` is what keeps it to it. This
 *  is their newest FIRST-PARTY (non-OpenRouter) Anthropic model, read off
 *  docs.thesys.dev/api-reference/models-and-compatibility on 2026-08-16 and
 *  confirmed against the live endpoint. */
export const THESYS_MODEL_IDS = { c1: "c1/anthropic/claude-sonnet-4.6/v-20260331" } as const;

/** One frontier model per vendor, all three through OpenRouter's single
 *  OpenAI-compatible endpoint. One alias per vendor rather than a menu: this is
 *  the cross-vendor row, and a vendor's second-best model answers a question
 *  nobody asked. Membership here is what says an alias is served by the router —
 *  the provider a run builds for it, the key it demands and the one harness it
 *  may run under all read this. */
export const OPENROUTER_MODEL_IDS = {
  claude: "anthropic/claude-opus-5",
  gpt: "openai/gpt-5.6-sol",
  gemini: "google/gemini-3.1-pro-preview",
} as const;

/** The Codex CLI's own model line. That column spawns OpenAI's engine and never
 *  reads `meter.model`, exactly as `claude-code` spawns Anthropic's, so the id
 *  here is what prices its session rather than what a provider is built from.
 *  One alias, and `contenders` in `run.ts` is what keeps it to it. */
export const CODEX_MODEL_IDS = { sol: "gpt-5.6-sol" } as const;

export type ModelAlias =
  | "opus"
  | "sonnet"
  | "haiku"
  | keyof typeof WAFER_MODEL_IDS
  | keyof typeof THESYS_MODEL_IDS
  | keyof typeof OPENROUTER_MODEL_IDS
  | keyof typeof CODEX_MODEL_IDS;

/**
 * Pinned ids. Each one was checked against the live API through
 * `@ai-sdk/anthropic` before being written here.
 *
 * Two of the three Anthropic ids are floating aliases, and not for want of trying: as of
 * 2026-08-15 `GET /v1/models` lists `claude-opus-5` and `claude-sonnet-5` with
 * no dated snapshot beside them, so there is nothing to pin them to. Haiku has
 * one and carries it. Until the other two do, `Meter.answeredBy` is what says
 * which model actually answered — a pinned alias is a promise the provider
 * makes and the run has to record it keeping.
 */
export const MODEL_IDS: Readonly<Record<ModelAlias, string>> = {
  opus: "claude-opus-5",
  sonnet: "claude-sonnet-5",
  haiku: "claude-haiku-4-5-20251001",
  ...WAFER_MODEL_IDS,
  ...THESYS_MODEL_IDS,
  ...OPENROUTER_MODEL_IDS,
  ...CODEX_MODEL_IDS,
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
  // Wafer's own quote, read off `GET /v1/models` on 2026-08-16 — its `pricing`
  // block is in cents per million. Its cache reads are a tenth of input for GLM
  // and a QUARTER for DeepSeek, so DeepSeek's cache-read dollars read low
  // against the one multiplier below; its token counts are exact either way.
  "glm5.2-fast": { inputPerMTok: 2.1, outputPerMTok: 6.6 },
  "DeepSeek-V4-Flash-0731-Fast": { inputPerMTok: 0.28, outputPerMTok: 0.56 },
  // Thesys passes the underlying provider's per-token rates through with no
  // markup ("same rates as the models themselves … no markups",
  // thesys.dev/pricing), so this row is Anthropic's Sonnet 4.6 list rate. Their
  // flat per-call platform fee is not a token rate and is billed by the driver
  // (`THESYS_CALL_USD` in `thesys.ts`) rather than smuggled in here.
  "c1/anthropic/claude-sonnet-4.6/v-20260331": { inputPerMTok: 3, outputPerMTok: 15 },
  // The three router rows, read off OpenRouter's models API on 2026-08-17.
  // OpenRouter takes 0% on tokens, so each is the vendor's own list rate — what
  // it really charges is 5.5% (min $0.80) on credit TOP-UPS, which is not a
  // per-token price and so is in no number this meter can produce.
  // Identical to Anthropic's first-party Opus 5 rate above.
  "anthropic/claude-opus-5": { inputPerMTok: 5, outputPerMTok: 25 },
  // The ≤272k-context tier. A genbench prompt is 10-20k tokens, so the $10/$45
  // tier above it is unreachable here.
  "openai/gpt-5.6-sol": { inputPerMTok: 5, outputPerMTok: 30 },
  // The ≤200k tier; Google still labels the model preview.
  "google/gemini-3.1-pro-preview": { inputPerMTok: 2, outputPerMTok: 12 },
  // OpenAI's own list rate (platform.openai.com/pricing, read 2026-08-17), not
  // the router's: the codex CLI bills the platform account directly.
  "gpt-5.6-sol": { inputPerMTok: 5, outputPerMTok: 30 },
};

/** Cache reads bill at a tenth of the input rate; 5-minute cache writes at 1.25x. */
const CACHE_READ_MULTIPLIER = 0.1;
const CACHE_WRITE_MULTIPLIER = 1.25;

/** The screen agent builds its Turn with no `maxOutputTokens`, so the provider
 *  default applies and a long document can truncate mid-write with no error.
 *  The meter fills the gap only when the caller left it unset. Exported because
 *  the judge, the triage and the auditor need the same floor and are not metered
 *  through this wrapper — a grader that truncates fails every line it never
 *  reached, and charges that to the screen. */
export const MAX_OUTPUT_TOKENS_FLOOR = 32_000;

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
  /** What the provider says actually answered, once anything has. Undefined
   *  until the first response, and for a contender that never called this
   *  model at all. */
  answeredBy(): string | undefined;
}

export function meteredModel(base: LanguageModelV3, modelId: string): Meter {
  const startedAt = performance.now();
  const totals = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, calls: 0 };
  let answeredBy: string | undefined;

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
      answeredBy = result.response?.modelId ?? answeredBy;
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
              if (part.type === "response-metadata") answeredBy = part.modelId ?? answeredBy;
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
    answeredBy: () => answeredBy,
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
