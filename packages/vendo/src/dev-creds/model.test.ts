import { describe, expect, it, vi } from "vitest";
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

  it("delegates the vendo-cloud rung to managed inference through the console endpoint", async () => {
    const requests: Array<{ url: string; authorization: string | null; body: unknown }> = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      requests.push({
        url: request.url,
        authorization: request.headers.get("authorization"),
        body: await request.json(),
      });
      return Response.json({ content: [{ type: "text", text: "ok" }], finishReason: { unified: "stop", raw: null }, usage: {}, warnings: [] });
    }) as unknown as typeof fetch;
    const controller = new DevModelController({
      env: { VENDO_API_KEY: `vnd_${"a".repeat(40)}`, VENDO_CLOUD_URL: "https://cloud.test" },
      fetchImpl,
    });
    const result = await controller.doGenerate({ prompt: [] }) as { content: unknown[] };
    expect(result.content).toEqual([{ type: "text", text: "ok" }]);
    expect(requests[0]).toMatchObject({
      url: "https://cloud.test/api/v1/inference",
      authorization: `Bearer vnd_${"a".repeat(40)}`,
      body: { mode: "generate", options: { prompt: [] } },
    });
  });

  it("prefers a provider env key over VENDO_API_KEY (explicit beats managed)", async () => {
    const cloudFetch = vi.fn();
    const controller = new DevModelController({
      env: { ANTHROPIC_API_KEY: "sk-a", VENDO_API_KEY: `vnd_${"a".repeat(40)}` },
      fetchImpl: cloudFetch as unknown as typeof fetch,
      importModule: async () => ({
        createAnthropic: () => (modelId: string) => ({
          specificationVersion: "v3",
          provider: "anthropic",
          modelId,
          supportedUrls: {},
          doGenerate: async () => ({ via: "provider" }),
          doStream: async () => ({ via: "provider" }),
        }),
      }),
    });
    expect(await controller.doGenerate({ prompt: [] })).toEqual({ via: "provider" });
    expect(cloudFetch).not.toHaveBeenCalled();
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
