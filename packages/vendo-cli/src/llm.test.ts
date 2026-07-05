import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { LanguageModel } from "ai";
import { cliModel, generateJson } from "./llm.js";
import { textModel } from "./test-helpers.js";

const schema = z.object({ ok: z.boolean() });

describe("generateJson", () => {
  it("parses fenced JSON", async () => {
    const model = textModel(['```json\n{"ok": true}\n```']);
    expect(await generateJson({ model, schema, prompt: "x" })).toEqual({ ok: true });
  });

  it("retries once with the validation error, then throws", async () => {
    const model = textModel(["not json", "still not json"]);
    await expect(generateJson({ model, schema, prompt: "x" })).rejects.toThrow(/after retry/);
  });

  it("recovers on the retry", async () => {
    const model = textModel(["nope", '{"ok": false}']);
    expect(await generateJson({ model, schema, prompt: "x" })).toEqual({ ok: false });
  });
});

/** Fakes the `@ai-sdk/openai`/`@ai-sdk/google` dynamic import so tests never
 *  need those optional peers installed. */
function fakeImporter(exportName: string) {
  const factory = vi.fn((id: string) => ({ modelId: id }) as unknown as LanguageModel);
  return { importer: vi.fn(async () => ({ [exportName]: factory })), factory };
}

/** `LanguageModel` also admits bare gateway-alias strings; narrow to the
 *  object form before reading `.modelId` (mirrors resolveModel's own tests). */
function modelId(model: LanguageModel | null): string | undefined {
  return model && typeof model === "object" ? model.modelId : undefined;
}

describe("cliModel", () => {
  it("resolves Anthropic's default model from ANTHROPIC_API_KEY alone", async () => {
    const model = await cliModel({ ANTHROPIC_API_KEY: "sk-ant-x" });
    expect(modelId(model)).toBe("claude-sonnet-5");
  });

  it("resolves OpenAI's default model from OPENAI_API_KEY alone", async () => {
    const { importer, factory } = fakeImporter("openai");
    const model = await cliModel({ OPENAI_API_KEY: "sk-x" }, { import: importer });
    expect(importer).toHaveBeenCalledWith("@ai-sdk/openai");
    expect(factory).toHaveBeenCalledWith("gpt-5.5");
    expect(modelId(model)).toBe("gpt-5.5");
  });

  it("resolves Google's default model from GOOGLE_GENERATIVE_AI_API_KEY alone", async () => {
    const { importer, factory } = fakeImporter("google");
    const model = await cliModel({ GOOGLE_GENERATIVE_AI_API_KEY: "g-x" }, { import: importer });
    expect(importer).toHaveBeenCalledWith("@ai-sdk/google");
    expect(factory).toHaveBeenCalledWith("gemini-3.5-flash");
    expect(modelId(model)).toBe("gemini-3.5-flash");
  });

  it("prefers Anthropic > OpenAI > Google when several keys are present", async () => {
    const model = await cliModel({
      ANTHROPIC_API_KEY: "a",
      OPENAI_API_KEY: "b",
      GOOGLE_GENERATIVE_AI_API_KEY: "c",
    });
    expect(modelId(model)).toBe("claude-sonnet-5");
  });

  it("applies a bare VENDO_MODEL id to the detected provider", async () => {
    const { importer, factory } = fakeImporter("openai");
    const model = await cliModel({ OPENAI_API_KEY: "sk-x", VENDO_MODEL: "gpt-5.5-mini" }, { import: importer });
    expect(factory).toHaveBeenCalledWith("gpt-5.5-mini");
    expect(modelId(model)).toBe("gpt-5.5-mini");
  });

  it("lets VENDO_MODEL=provider/model override the detected provider", async () => {
    const { importer, factory } = fakeImporter("openai");
    await cliModel({ ANTHROPIC_API_KEY: "sk-ant-x", VENDO_MODEL: "openai/gpt-5.5-pro" }, { import: importer });
    expect(factory).toHaveBeenCalledWith("gpt-5.5-pro");
  });

  it("applies a bare VENDO_CLI_MODEL id to the detected provider", async () => {
    const { importer, factory } = fakeImporter("google");
    const model = await cliModel(
      { GOOGLE_GENERATIVE_AI_API_KEY: "g-x", VENDO_CLI_MODEL: "gemini-3.5-pro" },
      { import: importer },
    );
    expect(factory).toHaveBeenCalledWith("gemini-3.5-pro");
    expect(modelId(model)).toBe("gemini-3.5-pro");
  });

  it("lets VENDO_CLI_MODEL=provider/model override the detected provider", async () => {
    const { importer, factory } = fakeImporter("google");
    await cliModel({ ANTHROPIC_API_KEY: "sk-ant-x", VENDO_CLI_MODEL: "google/gemini-3.5-pro" }, { import: importer });
    expect(factory).toHaveBeenCalledWith("gemini-3.5-pro");
  });

  it("prefers VENDO_CLI_MODEL over VENDO_MODEL when both are set", async () => {
    const { importer, factory } = fakeImporter("google");
    await cliModel(
      {
        ANTHROPIC_API_KEY: "sk-ant-x",
        VENDO_MODEL: "openai/gpt-5.5-pro",
        VENDO_CLI_MODEL: "google/gemini-3.5-pro",
      },
      { import: importer },
    );
    expect(factory).toHaveBeenCalledWith("gemini-3.5-pro");
    expect(importer).toHaveBeenCalledWith("@ai-sdk/google");
  });

  it("returns null when no key and no model override is configured", async () => {
    expect(await cliModel({})).toBeNull();
  });

  // A model id alone is not a credential — same principle as the runtime's
  // chat capability gate. Without a provider key the CLI must take the
  // deterministic-rescue path (null), never construct an unkeyed model that
  // fails mid-init with a raw SDK "API key is missing" error.
  it("returns null for a bare VENDO_MODEL with zero provider keys", async () => {
    expect(await cliModel({ VENDO_MODEL: "claude-sonnet-5" })).toBeNull();
  });

  it("returns null for a bare VENDO_CLI_MODEL with zero provider keys", async () => {
    expect(await cliModel({ VENDO_CLI_MODEL: "claude-sonnet-5" })).toBeNull();
  });

  it("returns null for VENDO_MODEL=provider/model with zero provider keys (named provider, no credential)", async () => {
    // Even the importer must not be touched — no key means skip LLM steps,
    // not a missing-peer throw.
    const importer = vi.fn(async () => {
      throw new Error("Cannot find package '@ai-sdk/openai'");
    });
    expect(await cliModel({ VENDO_MODEL: "openai/gpt-5.5" }, { import: importer })).toBeNull();
    expect(importer).not.toHaveBeenCalled();
  });

  it("returns null for VENDO_CLI_MODEL=provider/model with zero provider keys", async () => {
    expect(await cliModel({ VENDO_CLI_MODEL: "google/gemini-3.5-pro" })).toBeNull();
  });

  it("throws the actionable peer error when a provider is explicitly configured but its package is missing", async () => {
    const importer = vi.fn(async () => {
      throw new Error("Cannot find package '@ai-sdk/openai'");
    });
    await expect(cliModel({ OPENAI_API_KEY: "sk-x" }, { import: importer })).rejects.toThrow(
      'Vendo: model "openai/gpt-5.5" requires @ai-sdk/openai — run: npm i @ai-sdk/openai',
    );
  });
});
