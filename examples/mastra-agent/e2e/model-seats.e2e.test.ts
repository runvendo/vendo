/**
 * What "the host has an OpenAI key" MEANS to this composition.
 *
 * `OPENAI_API_KEY=''` satisfies a presence check, so an empty exported key made
 * the composition name explicit `openai(...)` seats — preempting the
 * `VENDO_API_KEY` Cloud fallback that would have filled them correctly, and then
 * failing the turn against OpenAI with no credential. Blank is not set: this
 * pins the same non-blank rule the SDK's own detection uses, so the example and
 * the SDK cannot disagree about it.
 */
import { describe, expect, it } from "vitest";
import { hasOpenAiCredential } from "../src/lib/vendo";

describe("the model seats are gated on a NON-BLANK credential", () => {
  it.each([
    ["absent", {}],
    ["an exported-but-empty key", { OPENAI_API_KEY: "" }],
    ["whitespace only", { OPENAI_API_KEY: "   " }],
    ["a tab", { OPENAI_API_KEY: "\t" }],
  ])("leaves the seats to VENDO_API_KEY when the key is %s", (_label, env) => {
    expect(hasOpenAiCredential(env)).toBe(false);
  });

  it("names the seats for a real key", () => {
    expect(hasOpenAiCredential({ OPENAI_API_KEY: "sk-proj-real" })).toBe(true);
  });

  it("ignores a key that is not this example's", () => {
    expect(hasOpenAiCredential({ ANTHROPIC_API_KEY: "sk-ant-real" })).toBe(false);
  });
});
