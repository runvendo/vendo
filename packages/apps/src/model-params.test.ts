/**
 * The Claude 5 line rejects sampling parameters outright (400
 * "`temperature` is deprecated for this model."), so the engine's hardcoded
 * `temperature: 0` made generation impossible on those models. These tests pin
 * both halves of the fix — the parameter rule itself, and the fact that the
 * rule actually reaches the model layer through the real engine — with no live
 * API calls.
 */
import type { LanguageModel } from "ai";
import { describe, expect, it } from "vitest";
import {
  UNKNOWN_MODEL_MAX_OUTPUT_TOKENS,
  acceptsSamplingParams,
  modelCallParams,
} from "./model-params.js";

/** Only the id matters to the rule, so the model body can be a stub. */
const idOnly = (modelId: string): LanguageModel =>
  ({ specificationVersion: "v2", provider: "anthropic", modelId, supportedUrls: {} }) as unknown as LanguageModel;

const CLAUDE_5 = ["claude-opus-5", "claude-sonnet-5", "claude-fable-5", "claude-mythos-5"];
const SAMPLING_ERA = [
  "claude-sonnet-4-6",
  "claude-opus-4-6",
  "claude-sonnet-4-5",
  "claude-sonnet-4-5-20250929",
  "claude-opus-4-5-20251101",
  "claude-haiku-4-5",
  "claude-opus-4-1",
  "claude-opus-4-0",
  "claude-opus-4-20250514",
  "claude-3-7-sonnet-latest",
  "claude-3-haiku-20240307",
];

describe("model sampling capability", () => {
  it.each(CLAUDE_5)("omits temperature for %s (the API rejects it with a 400)", (id) => {
    expect(acceptsSamplingParams(idOnly(id))).toBe(false);
    expect(modelCallParams(idOnly(id))).not.toHaveProperty("temperature");
  });

  it.each(SAMPLING_ERA)("keeps temperature: 0 for %s", (id) => {
    expect(acceptsSamplingParams(idOnly(id))).toBe(true);
    expect(modelCallParams(idOnly(id))).toEqual({ temperature: 0 });
  });

  it("treats Opus 4.7 and 4.8 as rejecting — the removal predates the 5 line", () => {
    expect(acceptsSamplingParams(idOnly("claude-opus-4-7"))).toBe(false);
    expect(acceptsSamplingParams(idOnly("claude-opus-4-8"))).toBe(false);
  });

  it("leaves non-Claude models entirely alone", () => {
    for (const id of ["gpt-5", "gemini-3-pro", "vendo-scripted-v1", "llama-4-70b"]) {
      expect(acceptsSamplingParams(idOnly(id))).toBe(true);
      expect(modelCallParams(idOnly(id))).toEqual({ temperature: 0 });
    }
  });

  it("reads the claude token out of gateway and Bedrock id spellings", () => {
    expect(acceptsSamplingParams(idOnly("anthropic/claude-opus-5"))).toBe(false);
    expect(acceptsSamplingParams(idOnly("anthropic.claude-opus-5"))).toBe(false);
    expect(acceptsSamplingParams(idOnly("anthropic/claude-sonnet-4-6"))).toBe(true);
  });

  it("accepts a bare string model id (LanguageModel is string | object)", () => {
    expect(modelCallParams("claude-opus-5")).not.toHaveProperty("temperature");
    expect(modelCallParams("claude-sonnet-4-6")).toEqual({ temperature: 0 });
  });

  it("defaults an unrecognised claude id to rejecting, so a new model cannot 400 us", () => {
    expect(acceptsSamplingParams(idOnly("claude-opus-9"))).toBe(false);
    expect(acceptsSamplingParams(idOnly("claude-something-new"))).toBe(false);
  });
});

describe("max output tokens", () => {
  it.each(CLAUDE_5)("sets an explicit cap for %s rather than inheriting the provider's silent 4096", (id) => {
    // A provider whose registry predates these ids treats them as unknown and
    // defaults max_tokens to 4096, truncating generated wire mid-app.
    expect(modelCallParams(idOnly(id)).maxOutputTokens).toBe(UNKNOWN_MODEL_MAX_OUTPUT_TOKENS);
    expect(UNKNOWN_MODEL_MAX_OUTPUT_TOKENS).toBeGreaterThan(4096);
  });

  it("sets an explicit cap for an unrecognised claude id too", () => {
    expect(modelCallParams(idOnly("claude-opus-9")).maxOutputTokens).toBe(UNKNOWN_MODEL_MAX_OUTPUT_TOKENS);
  });

  it("leaves the cap unset on sampling-era models, so today's behaviour is unchanged", () => {
    expect(modelCallParams(idOnly("claude-sonnet-4-6"))).not.toHaveProperty("maxOutputTokens");
  });
});
