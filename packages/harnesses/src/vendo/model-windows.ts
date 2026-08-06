/**
 * How many tokens the model's context window holds.
 *
 * The loop has never known this, which is why every context rail it had was a
 * number a host guessed at: `contextTokenBudget` is an absolute figure with no
 * default and no way to reach it from `createVendo`, so in practice nothing
 * bounded the prompt but the provider's own 400. A window table is the smallest
 * thing that turns that into a decision the loop can make for itself.
 *
 * Matched by SUBSTRING, longest first, because a model id does not arrive as a
 * bare name. It arrives prefixed by whichever gateway routed it and suffixed by a
 * snapshot date — `us.anthropic.claude-sonnet-4-6-20260101` — so a table of exact
 * keys would miss every real id and silently run the whole shipment on the
 * default.
 *
 * No tokenizer, no network lookup, no per-provider metadata fetch: a table in the
 * repo is wrong slowly and visibly, which is the failure mode a host can fix with
 * the override below.
 */
import type { LanguageModel } from "ai";

/** The window assumed for a model this table does not name. Deliberately the
 *  smallest window still in wide use: under-guessing costs one early compaction,
 *  over-guessing costs a 400 in the middle of somebody's turn. */
export const DEFAULT_CONTEXT_WINDOW_TOKENS = 128_000;

/**
 * Substring → window, longest match wins.
 *
 * Family entries carry the family's standard window and member entries carry the
 * exceptions, so a new dated snapshot of a known family is right on the day it
 * ships rather than on the day someone remembers this file. Every figure is the
 * window available on a PLAIN request: Anthropic's 1M window is behind a beta
 * header we do not send, so claiming it here would trade one early compaction for
 * a request the provider rejects.
 */
export const MODEL_CONTEXT_WINDOWS: readonly (readonly [match: string, tokens: number])[] = [
  ["claude-", 200_000],
  ["gpt-4o", 128_000],
  ["gpt-4.1", 1_047_576],
  ["gpt-5", 400_000],
  ["gemini-", 1_048_576],
  ["gemini-1.5-pro", 2_097_152],
];

/**
 * THE one new public knob of this shipment.
 *
 * `override` is the BYO escape and it wins outright, table hit or not: a host on
 * a model this repo has never heard of, or on a seat whose entry has gone stale,
 * needs a way to be right that does not involve waiting for a release.
 */
export function contextWindowTokens(model: LanguageModel, override?: number): number {
  if (override !== undefined) return override;
  const id = (typeof model === "string" ? model : model.modelId).toLowerCase();
  let matched: readonly [string, number] | undefined;
  for (const entry of MODEL_CONTEXT_WINDOWS) {
    if (!id.includes(entry[0])) continue;
    if (matched === undefined || entry[0].length > matched[0].length) matched = entry;
  }
  return matched?.[1] ?? DEFAULT_CONTEXT_WINDOW_TOKENS;
}
