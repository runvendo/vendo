import { describe, expect, it, vi } from "vitest";
import type { LanguageModel } from "ai";
import { resolveModel, resolveModelChoice } from "./model";

describe("resolveModelChoice", () => {
  it("picks Anthropic + its default id from ANTHROPIC_API_KEY alone", () => {
    expect(resolveModelChoice({ ANTHROPIC_API_KEY: "sk-ant-x" })).toEqual({
      kind: "configured",
      provider: "anthropic",
      modelId: "claude-sonnet-5",
    });
  });

  it("picks OpenAI + its default id from OPENAI_API_KEY alone", () => {
    expect(resolveModelChoice({ OPENAI_API_KEY: "sk-x" })).toEqual({
      kind: "configured",
      provider: "openai",
      modelId: "gpt-5.5",
    });
  });

  it("picks Google + its default id from GOOGLE_GENERATIVE_AI_API_KEY alone", () => {
    expect(resolveModelChoice({ GOOGLE_GENERATIVE_AI_API_KEY: "g-x" })).toEqual({
      kind: "configured",
      provider: "google",
      modelId: "gemini-3.5-flash",
    });
  });

  it("prefers Anthropic > OpenAI > Google when several keys are present", () => {
    expect(
      resolveModelChoice({
        ANTHROPIC_API_KEY: "sk-ant-x",
        OPENAI_API_KEY: "sk-x",
        GOOGLE_GENERATIVE_AI_API_KEY: "g-x",
      }).provider,
    ).toBe("anthropic");
    expect(
      resolveModelChoice({
        OPENAI_API_KEY: "sk-x",
        GOOGLE_GENERATIVE_AI_API_KEY: "g-x",
      }).provider,
    ).toBe("openai");
  });

  it("lets FLOWLET_MODEL=provider/model override the detected provider", () => {
    expect(
      resolveModelChoice({ ANTHROPIC_API_KEY: "sk-ant-x", FLOWLET_MODEL: "openai/gpt-5.5" }),
    ).toEqual({ kind: "configured", provider: "openai", modelId: "gpt-5.5" });
    expect(resolveModelChoice({ FLOWLET_MODEL: "google/gemini-3.5-pro" })).toEqual({
      kind: "configured",
      provider: "google",
      modelId: "gemini-3.5-pro",
    });
  });

  it("throws a readable boot error for an unknown provider prefix", () => {
    expect(() => resolveModelChoice({ FLOWLET_MODEL: "grok/whatever" })).toThrow(/Flowlet/);
    expect(() => resolveModelChoice({ FLOWLET_MODEL: "grok/whatever" })).toThrow(
      /anthropic, openai, google/,
    );
  });

  it("applies a bare FLOWLET_MODEL id to the detected provider", () => {
    expect(
      resolveModelChoice({ OPENAI_API_KEY: "sk-x", FLOWLET_MODEL: "gpt-5.5-mini" }),
    ).toEqual({ kind: "configured", provider: "openai", modelId: "gpt-5.5-mini" });
  });

  it("falls a bare FLOWLET_MODEL id back to Anthropic when no key is set (back-compat)", () => {
    expect(resolveModelChoice({ FLOWLET_MODEL: "claude-sonnet-4-6" })).toEqual({
      kind: "configured",
      provider: "anthropic",
      modelId: "claude-sonnet-4-6",
    });
  });

  it("reports no provider configured with no keys and no FLOWLET_MODEL", () => {
    expect(resolveModelChoice({})).toEqual({ kind: "none" });
  });

  it("splits FLOWLET_MODEL on the first slash only, keeping the rest as the model id", () => {
    expect(
      resolveModelChoice({ FLOWLET_MODEL: "openai/ft:gpt-5.5:org/suffix" }),
    ).toEqual({ kind: "configured", provider: "openai", modelId: "ft:gpt-5.5:org/suffix" });
  });

  it("falls back to the provider's default id when FLOWLET_MODEL is empty after the slash", () => {
    expect(resolveModelChoice({ FLOWLET_MODEL: "openai/" })).toEqual({
      kind: "configured",
      provider: "openai",
      modelId: "gpt-5.5",
    });
  });

  it("treats empty/whitespace key values as absent", () => {
    expect(resolveModelChoice({ ANTHROPIC_API_KEY: "  ", OPENAI_API_KEY: "" })).toEqual({
      kind: "none",
    });
  });
});

describe("resolveModel", () => {
  it("constructs the Anthropic default model from an Anthropic key", async () => {
    const model = await resolveModel({ ANTHROPIC_API_KEY: "sk-ant-x" });
    expect(model.modelId).toBe("claude-sonnet-5");
  });

  it("constructs the Anthropic default even with no provider configured (preserves today's behavior)", async () => {
    const model = await resolveModel({});
    expect(model.modelId).toBe("claude-sonnet-5");
  });

  it("respects a bare FLOWLET_MODEL id on the Anthropic path", async () => {
    const model = await resolveModel({ ANTHROPIC_API_KEY: "sk-ant-x", FLOWLET_MODEL: "claude-opus-4-8" });
    expect(model.modelId).toBe("claude-opus-4-8");
  });

  it("loads @ai-sdk/openai via the injected importer for the OpenAI path", async () => {
    const openai = vi.fn((id: string) => ({ modelId: id, provider: "openai.chat" }) as unknown as LanguageModel);
    const importer = vi.fn(async () => ({ openai }));
    const model = await resolveModel({ OPENAI_API_KEY: "sk-x" }, { import: importer });
    expect(importer).toHaveBeenCalledWith("@ai-sdk/openai");
    expect(openai).toHaveBeenCalledWith("gpt-5.5");
    expect(model.modelId).toBe("gpt-5.5");
  });

  it("loads @ai-sdk/google via the injected importer for the Google path", async () => {
    const google = vi.fn((id: string) => ({ modelId: id, provider: "google.generative-ai" }) as unknown as LanguageModel);
    const importer = vi.fn(async () => ({ google }));
    const model = await resolveModel({ GOOGLE_GENERATIVE_AI_API_KEY: "g-x" }, { import: importer });
    expect(importer).toHaveBeenCalledWith("@ai-sdk/google");
    expect(google).toHaveBeenCalledWith("gemini-3.5-flash");
    expect(model.modelId).toBe("gemini-3.5-flash");
  });

  it("honours FLOWLET_MODEL provider syntax over the detected key", async () => {
    const openai = vi.fn((id: string) => ({ modelId: id }) as unknown as LanguageModel);
    const importer = vi.fn(async () => ({ openai }));
    await resolveModel(
      { ANTHROPIC_API_KEY: "sk-ant-x", FLOWLET_MODEL: "openai/gpt-5.5-pro" },
      { import: importer },
    );
    expect(openai).toHaveBeenCalledWith("gpt-5.5-pro");
  });

  it("raises an actionable error naming the model and install command when the peer is missing", async () => {
    const importer = vi.fn(async () => {
      throw new Error("Cannot find package '@ai-sdk/openai'");
    });
    await expect(resolveModel({ OPENAI_API_KEY: "sk-x" }, { import: importer })).rejects.toThrow(
      'Flowlet: model "openai/gpt-5.5" requires @ai-sdk/openai — run: npm i @ai-sdk/openai',
    );
  });

  it("raises the same actionable error when the peer module resolves but doesn't export the provider factory", async () => {
    // e.g. a stale/incompatible @ai-sdk/openai version, or a broken mock —
    // `mod.openai` isn't a function, so calling it would throw a cryptic
    // "openai is not a function" instead of naming the missing peer.
    const importer = vi.fn(async () => ({ openai: undefined }));
    await expect(resolveModel({ OPENAI_API_KEY: "sk-x" }, { import: importer })).rejects.toThrow(
      'Flowlet: model "openai/gpt-5.5" requires @ai-sdk/openai — run: npm i @ai-sdk/openai',
    );
  });
});
