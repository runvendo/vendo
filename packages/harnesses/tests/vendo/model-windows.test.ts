/**
 * How big the model's window is — the number every other part of this shipment
 * measures against.
 *
 * The table is matched by SUBSTRING, longest first, because a model id does not
 * arrive as a bare name. It arrives prefixed by a gateway and suffixed by a
 * snapshot date (`us.anthropic.claude-sonnet-4-6-20260101`), so exact keys would
 * miss every real id and the whole shipment would run on the default. The two
 * failure directions are deliberately asymmetric: a model the table cannot name
 * falls to a CONSERVATIVE default, because under-guessing costs one early
 * compaction and over-guessing costs a 400 mid-turn.
 */
import type { LanguageModel } from "ai";
import { describe, expect, it } from "vitest";
import {
  contextWindowTokens,
  DEFAULT_CONTEXT_WINDOW_TOKENS,
  MODEL_CONTEXT_WINDOWS,
} from "../../src/vendo/model-windows.js";

/** The object form of a seat: the id is the only field this reads. */
const seat = (modelId: string): LanguageModel =>
  ({ specificationVersion: "v3", provider: "probe", modelId, supportedUrls: {} }) as unknown as LanguageModel;

describe("the model's context window", () => {
  it("names the seats the table knows", () => {
    expect(contextWindowTokens("claude-sonnet-4-5")).toBe(200_000);
    expect(contextWindowTokens("gpt-4o")).toBe(128_000);
    expect(contextWindowTokens("gemini-2.5-flash")).toBe(1_048_576);
  });

  it("reads a PREFIXED, DATE-SUFFIXED id — the form ids actually arrive in", () => {
    // A gateway prefix and a snapshot date are the normal case, not the edge
    // case; exact keys would miss every one of these.
    expect(contextWindowTokens("us.anthropic.claude-sonnet-4-6-20260101")).toBe(200_000);
    expect(contextWindowTokens(seat("anthropic/claude-opus-4-1-20250805"))).toBe(200_000);
    expect(contextWindowTokens(seat("gpt-4o-2024-11-20"))).toBe(128_000);
  });

  it("takes the LONGEST match, so a family default cannot shadow a member", () => {
    // `gemini-` carries the family's 1M window; 1.5 Pro is the 2M exception, and
    // it only wins if length breaks the tie rather than table order.
    expect(contextWindowTokens("gemini-1.5-pro-002")).toBe(2_097_152);
    expect(contextWindowTokens("gemini-1.5-flash-002")).toBe(1_048_576);
  });

  it("falls to the conservative default for a model it cannot name", () => {
    expect(contextWindowTokens("some-new-model-nobody-has-heard-of")).toBe(DEFAULT_CONTEXT_WINDOW_TOKENS);
    expect(DEFAULT_CONTEXT_WINDOW_TOKENS).toBe(128_000);
  });

  it("lets the host's override WIN, table hit or not — the BYO escape", () => {
    // The one knob a host has when the table is wrong about their seat. It has
    // to beat a table hit too, or a stale entry would be unfixable from outside.
    expect(contextWindowTokens("claude-sonnet-4-5", 42_000)).toBe(42_000);
    expect(contextWindowTokens("some-new-model-nobody-has-heard-of", 900_000)).toBe(900_000);
  });

  it("carries no duplicate keys, so a match is never ambiguous", () => {
    const keys = MODEL_CONTEXT_WINDOWS.map(([match]) => match);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
