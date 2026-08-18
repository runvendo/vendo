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

/** One model per vendor, all three through OpenRouter's single OpenAI-compatible
 *  endpoint and all three in the SAME price band — Sonnet 5 at $2/$10, Terra and
 *  Gemini 3.1 Pro at $2/$12 list. One alias per vendor rather than a menu: this
 *  is the cross-vendor row, and it only answers the buy-versus-build question if
 *  the three cost the same to run, because a flagship set against another
 *  vendor's mid-tier measures a price tag rather than a product. Membership here
 *  is what says an alias is served by the router — the provider a run builds for
 *  it, the key it demands and the one harness it may run under all read this. */
export const OPENROUTER_MODEL_IDS = {
  claude: "anthropic/claude-sonnet-5",
  gpt: "openai/gpt-5.6-terra",
  gemini: "google/gemini-3.1-pro-preview",
} as const;

/** The Codex CLI's own model line, on the same price band as the router row
 *  above — Terra is OpenAI's own word for that tier ("balanced quality, latency,
 *  and cost", `codex` 0.147.0). That column spawns OpenAI's engine and never
 *  reads `meter.model`, exactly as `claude-code` spawns Anthropic's, so the id
 *  here is what prices its session rather than what a provider is built from.
 *  One alias, and `contenders` in `run.ts` is what keeps it to it. */
export const CODEX_MODEL_IDS = { terra: "gpt-5.6-terra" } as const;

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
  // OpenRouter takes no cut of tokens — what it really charges is 5.5% (min
  // $0.80) on credit TOP-UPS, which is not a per-token price and so is in no
  // number this meter can produce — so a row here is the vendor's own rate
  // unless the router is discounting it, and one of them is.
  // Identical to Anthropic's first-party Sonnet 5 rate above, introductory
  // period and all.
  "anthropic/claude-sonnet-5": { inputPerMTok: 2, outputPerMTok: 10 },
  // List rate, not the router's temporary 50% discount: the router's OpenAI
  // endpoint carries `discount: 0.5` today, but its Azure and Bedrock endpoints
  // for the same model quote this undiscounted rate, and so does OpenAI's own
  // page (matches the `gpt-5.6-terra` row below). A coupon that can expire any
  // day shouldn't flatter one column over the others it's compared against —
  // the actual bill may be lower while the discount lasts. The ≤272k-context
  // tier either way — a genbench prompt is 10-20k tokens, so the tier above it
  // is unreachable.
  "openai/gpt-5.6-terra": { inputPerMTok: 2, outputPerMTok: 12 },
  // The ≤200k tier; Google still labels the model preview.
  "google/gemini-3.1-pro-preview": { inputPerMTok: 2, outputPerMTok: 12 },
  // OpenAI's own list rate (developers.openai.com/api/docs/pricing, read
  // 2026-08-17), not the router's discounted one: the codex CLI bills the
  // platform account directly.
  "gpt-5.6-terra": { inputPerMTok: 2, outputPerMTok: 12 },
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
  /** The part of `outputTokens` the provider says was THINKING rather than
   *  written into the screen — a SPLIT of that total and never an addend, so
   *  every dollar figure is the same number it was before this field existed.
   *
   *  Absent where the provider states nothing, which is every Anthropic call:
   *  their wire itemises no such count and `@ai-sdk/anthropic` reports
   *  `outputTokens.reasoning` as undefined for it. The OpenAI-compatible door —
   *  Wafer and the router — states `completion_tokens_details.reasoning_tokens`
   *  and gets a number here. A 0 is a provider that said zero; the gap is a
   *  provider that said nothing, and a thinking-budget experiment reads those
   *  two as opposite findings. */
  readonly reasoningTokens?: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly calls: number;
}

/** {@link UsageTotals} as a running tally: writable, so a contender billed by
 *  its own engine adds its turns up in the same counters the meter does.
 *  Mapped rather than `Record<keyof UsageTotals, number>` so a count only some
 *  providers state stays optional here too — an engine that says nothing about
 *  thinking reports nothing rather than a zero. */
export type UsageTally = { -readonly [K in keyof UsageTotals]: number };

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

/** One call's bill, in the four counters the report is built from — and the
 *  fifth only some providers keep, which is why it may be absent. */
interface Bill {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens?: number;
}

const COUNTERS = ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens"] as const;

const noBill = (): Bill => ({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });

const billOf = (usage: LanguageModelV3Usage): Bill => {
  const cacheReadTokens = usage.inputTokens.cacheRead ?? 0;
  const cacheWriteTokens = usage.inputTokens.cacheWrite ?? 0;
  return {
    // `noCache` is what the full input rate applies to. Providers that only
    // report a total get the same number by subtraction.
    inputTokens: usage.inputTokens.noCache
      ?? Math.max(0, (usage.inputTokens.total ?? 0) - cacheReadTokens - cacheWriteTokens),
    outputTokens: usage.outputTokens.total ?? 0,
    // Stated or absent, never defaulted: `outputTokens.reasoning` is a number
    // wherever the provider itemises thinking and undefined wherever it does
    // not, and the two mean different things ({@link UsageTotals}).
    ...(usage.outputTokens.reasoning === undefined ? {} : { reasoningTokens: usage.outputTokens.reasoning }),
    cacheReadTokens,
    cacheWriteTokens,
  };
};

/**
 * What a stream has said about its own usage so far, read off the raw wire.
 *
 * An Anthropic stream states the input and cache counts on `message_start` and
 * restates the running output total on every `message_delta`;
 * `@ai-sdk/anthropic` accumulates exactly those and only converts them into a
 * `finish` part at `message_stop`. The screen agent hangs up on its own last
 * turn from inside the final save's tool call, and nothing downstream is then
 * left to close or cancel the pipe — so `finish` never arrives, no terminal hook
 * ever runs, and the turn that WROTE the screen billed as nothing at all:
 * maple/rent-check, 133 output tokens for a 2.3kB painted screen.
 *
 * MERGED, never summed: each event restates the running totals rather than
 * adding to them, exactly as the provider's own accumulator treats them. An
 * OpenAI-compatible stream states no usage until its final chunk, which arrives
 * beside the `finish` it is folded into, so there is nothing here for one to
 * read — and nothing is estimated in its place. A guessed number in this table
 * is worse than a gap, because a gap can be seen.
 */
const wireBill = (event: unknown, running: Bill): Bill | undefined => {
  const wire = event as { type?: string; usage?: Record<string, number>; message?: { usage?: Record<string, number> } } | null;
  const usage = wire?.type === "message_start" ? wire.message?.usage
    : wire?.type === "message_delta" ? wire.usage
    : undefined;
  return usage === undefined ? undefined : {
    inputTokens: usage.input_tokens ?? running.inputTokens,
    outputTokens: usage.output_tokens ?? running.outputTokens,
    cacheReadTokens: usage.cache_read_input_tokens ?? running.cacheReadTokens,
    cacheWriteTokens: usage.cache_creation_input_tokens ?? running.cacheWriteTokens,
  };
};

export function meteredModel(base: LanguageModelV3, modelId: string): Meter {
  const startedAt = performance.now();
  const totals = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, calls: 0 };
  /** Undefined until a provider states one, and never invented: see
   *  {@link UsageTotals}. */
  let reasoningTokens: number | undefined;
  let answeredBy: string | undefined;

  /**
   * ONE call's meter tape. Every reading is what that call has cost so far, and
   * the tape charges only what it has not charged yet — so a stream billed as it
   * goes and one billed once at `finish` come to the same number, and a stream
   * nobody is left to close has still been billed for everything it said.
   */
  const tape = (): ((bill: Bill) => void) => {
    const charged = noBill();
    let counted = false;
    return (bill) => {
      for (const counter of COUNTERS) {
        totals[counter] += bill[counter] - charged[counter];
        charged[counter] = bill[counter];
      }
      // The same tape for the one counter a provider may not keep, charged only
      // where it was stated — so a call that says nothing about thinking leaves
      // the gap rather than filling it with a zero.
      if (bill.reasoningTokens !== undefined) {
        reasoningTokens = (reasoningTokens ?? 0) + bill.reasoningTokens - (charged.reasoningTokens ?? 0);
        charged.reasoningTokens = bill.reasoningTokens;
      }
      if (counted) return;
      counted = true;
      totals.calls += 1;
    };
  };

  const middleware: LanguageModelV3Middleware = {
    specificationVersion: "v3",
    transformParams: async ({ params }) => ({
      ...params,
      maxOutputTokens: params.maxOutputTokens ?? MAX_OUTPUT_TOKENS_FLOOR,
      // The raw events are the only place a stream's usage exists before the
      // provider folds it into `finish` — see {@link wireBill}. `ai` drops a raw
      // part for a caller that did not ask for one, so this buys the meter its
      // counts and changes nothing a driver sees.
      includeRawChunks: true,
    }),
    wrapGenerate: async ({ doGenerate }) => {
      const result = await doGenerate();
      tape()(billOf(result.usage));
      answeredBy = result.response?.modelId ?? answeredBy;
      return result;
    },
    wrapStream: async ({ doStream }) => {
      const result = await doStream();
      const charge = tape();
      let running = noBill();
      return {
        ...result,
        stream: result.stream.pipeThrough(
          new TransformStream({
            transform(part, controller) {
              if (part.type === "raw") {
                const stated = wireBill(part.rawValue, running);
                if (stated !== undefined) charge(running = stated);
              }
              // The provider's own count, and the last word on this call: it
              // restates what the wire already said rather than adding to it.
              if (part.type === "finish") charge(billOf(part.usage));
              if (part.type === "response-metadata") answeredBy = part.modelId ?? answeredBy;
              controller.enqueue(part);
            },
          }),
        ),
      };
    },
  };

  /** Everything charged so far, the thinking split included only where a
   *  provider stated one. */
  const read = (): UsageTotals => ({ ...totals, ...(reasoningTokens === undefined ? {} : { reasoningTokens }) });

  return {
    model: wrapLanguageModel({ model: base, middleware }),
    elapsedMs: () => Math.round(performance.now() - startedAt),
    totals: read,
    usd: () => usdFor(read(), modelId),
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
