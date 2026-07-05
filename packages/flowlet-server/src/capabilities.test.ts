import { describe, expect, it } from "vitest";
import { detectCapabilities } from "./capabilities";

describe("detectCapabilities", () => {
  it("is chat-only with just an Anthropic key (the one-key minimum)", () => {
    expect(detectCapabilities({ ANTHROPIC_API_KEY: "sk-ant-x" })).toEqual({
      chat: true,
      integrations: false,
      voice: false,
      mcp: false,
    });
  });

  it("enables chat from an OpenAI key alone (any of the big-3 providers)", () => {
    expect(detectCapabilities({ OPENAI_API_KEY: "sk-x" })).toEqual({
      chat: true,
      integrations: false,
      voice: true, // OPENAI_API_KEY doubles as the voice key
      mcp: false,
    });
  });

  it("enables chat from a Google key alone", () => {
    expect(detectCapabilities({ GOOGLE_GENERATIVE_AI_API_KEY: "g-x" })).toEqual({
      chat: true,
      integrations: false,
      voice: false,
      mcp: false,
    });
  });

  it("adds integrations with a Composio key and voice with an OpenAI key", () => {
    expect(
      detectCapabilities({
        ANTHROPIC_API_KEY: "sk-ant-x",
        COMPOSIO_API_KEY: "ck_x",
        OPENAI_API_KEY: "sk-x",
      }),
    ).toEqual({ chat: true, integrations: true, voice: true, mcp: false });
  });

  it("treats empty/whitespace values as absent", () => {
    expect(
      detectCapabilities({ ANTHROPIC_API_KEY: "  ", COMPOSIO_API_KEY: "" }),
    ).toEqual({ chat: false, integrations: false, voice: false, mcp: false });
  });

  it("is all-false with nothing set", () => {
    expect(detectCapabilities({})).toEqual({
      chat: false,
      integrations: false,
      voice: false,
      mcp: false,
    });
  });

  it("enables chat when a model is injected, regardless of env", () => {
    expect(detectCapabilities({}, { hasInjectedModel: true })).toEqual({
      chat: true,
      integrations: false,
      voice: false,
      mcp: false,
    });
  });

  it("does NOT enable chat from a bare FLOWLET_MODEL with no keys and no injected model", () => {
    // FLOWLET_MODEL alone resolves a ModelChoice (falls back to Anthropic per
    // resolveModelChoice's back-compat rule), but that model has no usable
    // credential — chat needs a real key or an injected model, not just a
    // configured model id.
    expect(detectCapabilities({ FLOWLET_MODEL: "claude-sonnet-4-6" })).toEqual({
      chat: false,
      integrations: false,
      voice: false,
      mcp: false,
    });
  });

  it("reports mcp false from env detection (the handler overrides it from resolved config)", () => {
    expect(detectCapabilities({ ANTHROPIC_API_KEY: "k" }).mcp).toBe(false);
  });
});
