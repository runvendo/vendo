import { describe, expect, it } from "vitest";
import { DevModelController, devModel, NO_CREDENTIAL_MESSAGE } from "./model.js";

describe("devModel (env-resolving default model)", () => {
  it("is an ai-SDK LanguageModel", () => {
    const model = devModel({ env: {} });
    const record = model as unknown as Record<string, unknown>;
    expect(record.specificationVersion).toBe("v3");
    expect(record.provider).toBe("vendo-dev");
    expect(typeof record.doGenerate).toBe("function");
    expect(typeof record.doStream).toBe("function");
  });

  it("fails every call with the honest instructions when nothing is available", async () => {
    const model = devModel({ env: {} });
    const record = model as unknown as {
      doGenerate(options: unknown): Promise<unknown>;
      doStream(options: unknown): Promise<unknown>;
    };
    await expect(record.doGenerate({ prompt: [] })).rejects.toThrow(NO_CREDENTIAL_MESSAGE);
    // doStream rejects with the same message (streamText's error path shows
    // the generic error part; the operator log carries this one).
    await expect(record.doStream({ prompt: [] })).rejects.toThrow(NO_CREDENTIAL_MESSAGE);
  });

  it("serves the vendo-cloud rung through @ai-sdk/anthropic pointed at the Cloud gateway", async () => {
    const seen: Array<{ apiKey: string; baseURL: string }> = [];
    const controller = new DevModelController({
      env: { VENDO_API_KEY: "vnd_x" },
      importModule: async (_root, specifier) => {
        expect(specifier).toBe("@ai-sdk/anthropic");
        return {
          createAnthropic: (config: { apiKey: string; baseURL: string }) => {
            seen.push(config);
            return (modelId: string) => ({
              specificationVersion: "v3",
              provider: "anthropic",
              modelId,
              supportedUrls: {},
              doGenerate: async (options: unknown) => ({ delegated: "generate", modelId, options }),
              doStream: async (options: unknown) => ({ delegated: "stream", modelId, options }),
            });
          },
        };
      },
    });
    const callOptions = { prompt: [] };
    // The gateway serves curated aliases only; vendo-default is the SDK's
    // default (raw claude-* ids would be grace-remapped server-side).
    expect(await controller.doGenerate(callOptions)).toEqual({
      delegated: "generate",
      modelId: "vendo-default",
      options: callOptions,
    });
    expect(await controller.doStream(callOptions)).toEqual({
      delegated: "stream",
      modelId: "vendo-default",
      options: callOptions,
    });
    // The key rides as the provider apiKey; the base is the production
    // console's /api/v1, where the Anthropic-shaped /messages endpoint lives.
    expect(seen).toEqual([
      { apiKey: "vnd_x", baseURL: "https://console.vendo.run/api/v1" },
    ]);
  });

  it("honors VENDO_CLOUD_URL and the VENDO_CLOUD_MODEL alias override on the vendo-cloud rung", async () => {
    const seen: Array<{ baseURL: string }> = [];
    const controller = new DevModelController({
      env: {
        VENDO_API_KEY: "vnd_x",
        VENDO_CLOUD_URL: "http://localhost:3001/",
        VENDO_CLOUD_MODEL: "vendo-strong",
        // The anthropic env-key override must NOT leak onto the cloud rung.
        VENDO_DEV_ANTHROPIC_MODEL: "claude-opus-4-8",
      },
      importModule: async () => ({
        createAnthropic: (config: { apiKey: string; baseURL: string }) => {
          seen.push({ baseURL: config.baseURL });
          return (modelId: string) => ({
            specificationVersion: "v3",
            provider: "anthropic",
            modelId,
            supportedUrls: {},
            doGenerate: async () => ({ modelId }),
            doStream: async () => ({ modelId }),
          });
        },
      }),
    });
    expect(await controller.doGenerate({ prompt: [] })).toEqual({ modelId: "vendo-strong" });
    expect(seen).toEqual([{ baseURL: "http://localhost:3001/api/v1" }]);
  });

  it("names the missing anthropic install when the vendo-cloud rung lacks the provider", async () => {
    const controller = new DevModelController({
      env: { VENDO_API_KEY: "vnd_x" },
      importModule: async (_root, specifier) => {
        throw new Error(`Cannot find module '${specifier}'`);
      },
    });
    await expect(controller.doGenerate({ prompt: [] })).rejects.toThrow(/@ai-sdk\/anthropic@\^3/);
  });

  it("names the missing provider install for an env-key rung without the package", async () => {
    const controller = new DevModelController({
      env: { OPENAI_API_KEY: "sk-o" },
      importModule: async (_root, specifier) => {
        throw new Error(`Cannot find module '${specifier}'`);
      },
    });
    await expect(controller.doGenerate({ prompt: [] })).rejects.toThrow(/@ai-sdk\/openai@\^3/);
  });

  it("delegates env-key calls to the host provider model with full fidelity", async () => {
    const seen: unknown[] = [];
    const controller = new DevModelController({
      env: { ANTHROPIC_API_KEY: "sk-a" },
      importModule: async () => ({
        createAnthropic: (config: { apiKey: string }) => {
          seen.push(config.apiKey);
          return (modelId: string) => ({
            specificationVersion: "v3",
            provider: "anthropic",
            modelId,
            supportedUrls: {},
            doGenerate: async (options: unknown) => ({ delegated: "generate", options }),
            doStream: async (options: unknown) => ({ delegated: "stream", options }),
          });
        },
      }),
    });
    const callOptions = { prompt: [], tools: [{ name: "t" }] };
    expect(await controller.doGenerate(callOptions)).toEqual({ delegated: "generate", options: callOptions });
    expect(await controller.doStream(callOptions)).toEqual({ delegated: "stream", options: callOptions });
    expect(seen).toEqual(["sk-a"]);
  });

  it("honors the model-override env var for the resolved provider", async () => {
    const controller = new DevModelController({
      env: { ANTHROPIC_API_KEY: "sk-a", VENDO_DEV_ANTHROPIC_MODEL: "claude-opus-4-8" },
      importModule: async () => ({
        createAnthropic: () => (modelId: string) => ({
          specificationVersion: "v3",
          provider: "anthropic",
          modelId,
          supportedUrls: {},
          doGenerate: async () => ({ modelId }),
          doStream: async () => ({ modelId }),
        }),
      }),
    });
    expect(await controller.doGenerate({ prompt: [] })).toEqual({ modelId: "claude-opus-4-8" });
  });
});
