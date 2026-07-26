import { afterEach, describe, expect, it } from "vitest";
import type { LanguageModel } from "ai";
import {
  DevModelController,
  configureVendoModelSlots,
  devModel,
  NO_CREDENTIAL_MESSAGE,
  vendoModel,
} from "./model.js";

/** Scripted provider module: records the factory config, delegates every call
 *  to a stub model that echoes its modelId — the passthrough oracle. */
function scriptedProvider(factoryName: string, seen: Array<{ apiKey: string; baseURL?: string }> = []) {
  return async (_root: string, _specifier: string): Promise<Record<string, unknown>> => ({
    [factoryName]: (config: { apiKey: string; baseURL?: string }) => {
      seen.push(config);
      return (modelId: string) => ({
        specificationVersion: "v3",
        provider: "scripted",
        modelId,
        supportedUrls: {},
        doGenerate: async () => ({ modelId }),
        doStream: async () => ({ modelId }),
      });
    },
  });
}

/** Resolve the model id a lazily-resolving model would call the provider with. */
async function resolvedId(model: LanguageModel): Promise<string> {
  const record = model as unknown as { doGenerate(options: unknown): Promise<{ modelId: string }> };
  return (await record.doGenerate({ prompt: [] })).modelId;
}

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
    // Cloud rung default is the flagship family name `vendo` (models spec
    // 2026-07-22); the gateway grace-remaps unknown aliases server-side.
    expect(await controller.doGenerate(callOptions)).toEqual({
      delegated: "generate",
      modelId: "vendo",
      options: callOptions,
    });
    expect(await controller.doStream(callOptions)).toEqual({
      delegated: "stream",
      modelId: "vendo",
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

describe("vendoModel (the vendo model family entry)", () => {
  afterEach(() => configureVendoModelSlots(undefined));

  it("is an ai-SDK LanguageModel and devModel stays a working deprecated alias", () => {
    const model = vendoModel(undefined, { env: {} }) as unknown as Record<string, unknown>;
    expect(model.specificationVersion).toBe("v3");
    expect(typeof model.doGenerate).toBe("function");
    // devModel keeps its exact historical wrapper identity.
    const legacy = devModel({ env: {} }) as unknown as Record<string, unknown>;
    expect(legacy.provider).toBe("vendo-dev");
    expect(legacy.modelId).toBe("dev-env");
  });

  it("keeps the honest keyless failure unchanged", async () => {
    const model = vendoModel(undefined, { env: {} }) as unknown as {
      doGenerate(options: unknown): Promise<unknown>;
    };
    await expect(model.doGenerate({ prompt: [] })).rejects.toThrow(NO_CREDENTIAL_MESSAGE);
  });

  it("passes an explicit name VERBATIM to the provider rung — no client-side mapping", async () => {
    const model = vendoModel("claude-opus-4-8", {
      env: { ANTHROPIC_API_KEY: "sk-a" },
      importModule: scriptedProvider("createAnthropic"),
    });
    expect(await resolvedId(model)).toBe("claude-opus-4-8");
    // Even a vendo-* family name goes through untouched: the provider's own
    // error is the surface for unknown names, never a client-side remap.
    const family = vendoModel("vendo-paint", {
      env: { ANTHROPIC_API_KEY: "sk-a" },
      importModule: scriptedProvider("createAnthropic"),
    });
    expect(await resolvedId(family)).toBe("vendo-paint");
  });

  it("passes an explicit name VERBATIM to the Cloud gateway as the model id", async () => {
    const seen: Array<{ apiKey: string; baseURL?: string }> = [];
    const model = vendoModel("vendo-strong", {
      env: { VENDO_API_KEY: "vnd_x" },
      importModule: scriptedProvider("createAnthropic", seen),
    });
    expect(await resolvedId(model)).toBe("vendo-strong");
    expect(seen[0]?.baseURL).toBe("https://console.vendo.run/api/v1");
  });

  it("defaults to `vendo` on the Cloud rung and the provider flagship on env-key rungs", async () => {
    expect(await resolvedId(vendoModel(undefined, {
      env: { VENDO_API_KEY: "vnd_x" },
      importModule: scriptedProvider("createAnthropic"),
    }))).toBe("vendo");
    expect(await resolvedId(vendoModel(undefined, {
      env: { ANTHROPIC_API_KEY: "sk-a" },
      importModule: scriptedProvider("createAnthropic"),
    }))).toBe("claude-sonnet-4-6");
    expect(await resolvedId(vendoModel(undefined, {
      env: { OPENAI_API_KEY: "sk-o" },
      importModule: scriptedProvider("createOpenAI"),
    }))).toBe("gpt-5");
  });

  it("defaults the paint slot to the family fast pick per rung", async () => {
    expect(await resolvedId(vendoModel(undefined, {
      slot: "paint",
      env: { VENDO_API_KEY: "vnd_x" },
      importModule: scriptedProvider("createAnthropic"),
    }))).toBe("vendo-paint");
    expect(await resolvedId(vendoModel(undefined, {
      slot: "paint",
      env: { ANTHROPIC_API_KEY: "sk-a" },
      importModule: scriptedProvider("createAnthropic"),
    }))).toBe("claude-haiku-4-5");
    expect(await resolvedId(vendoModel(undefined, {
      slot: "paint",
      env: { OPENAI_API_KEY: "sk-o" },
      importModule: scriptedProvider("createOpenAI"),
    }))).toBe("gpt-5-mini");
    expect(await resolvedId(vendoModel(undefined, {
      slot: "paint",
      env: { GOOGLE_GENERATIVE_AI_API_KEY: "g" },
      importModule: scriptedProvider("createGoogleGenerativeAI"),
    }))).toBe("gemini-2.5-flash-lite");
  });

  it("VENDO_MODEL pins the agent slot above a configured name string", async () => {
    expect(await resolvedId(vendoModel("claude-opus-4-8", {
      env: { ANTHROPIC_API_KEY: "sk-a", VENDO_MODEL: "claude-sonnet-4-6" },
      importModule: scriptedProvider("createAnthropic"),
    }))).toBe("claude-sonnet-4-6");
    // The new pin outranks the deprecated per-provider var.
    expect(await resolvedId(vendoModel(undefined, {
      env: {
        ANTHROPIC_API_KEY: "sk-a",
        VENDO_MODEL: "claude-sonnet-4-6",
        VENDO_DEV_ANTHROPIC_MODEL: "claude-opus-4-8",
      },
      importModule: scriptedProvider("createAnthropic"),
    }))).toBe("claude-sonnet-4-6");
  });

  it("keeps the deprecated VENDO_DEV_*_MODEL / VENDO_CLOUD_MODEL pins working on the agent slot only", async () => {
    expect(await resolvedId(vendoModel(undefined, {
      env: { ANTHROPIC_API_KEY: "sk-a", VENDO_DEV_ANTHROPIC_MODEL: "claude-opus-4-8" },
      importModule: scriptedProvider("createAnthropic"),
    }))).toBe("claude-opus-4-8");
    expect(await resolvedId(vendoModel(undefined, {
      env: { VENDO_API_KEY: "vnd_x", VENDO_CLOUD_MODEL: "vendo-strong" },
      importModule: scriptedProvider("createAnthropic"),
    }))).toBe("vendo-strong");
    // The deprecated pins never leak onto the paint slot.
    expect(await resolvedId(vendoModel(undefined, {
      slot: "paint",
      env: { ANTHROPIC_API_KEY: "sk-a", VENDO_DEV_ANTHROPIC_MODEL: "claude-opus-4-8" },
      importModule: scriptedProvider("createAnthropic"),
    }))).toBe("claude-haiku-4-5");
  });

  it("VENDO_MODEL_PAINT pins the paint slot; VENDO_MODEL does not", async () => {
    expect(await resolvedId(vendoModel(undefined, {
      slot: "paint",
      env: { ANTHROPIC_API_KEY: "sk-a", VENDO_MODEL: "claude-opus-4-8", VENDO_MODEL_PAINT: "claude-haiku-4-5" },
      importModule: scriptedProvider("createAnthropic"),
    }))).toBe("claude-haiku-4-5");
    expect(await resolvedId(vendoModel(undefined, {
      slot: "paint",
      env: { ANTHROPIC_API_KEY: "sk-a", VENDO_MODEL: "claude-opus-4-8" },
      importModule: scriptedProvider("createAnthropic"),
    }))).toBe("claude-haiku-4-5");
  });

  it("infers the judge slot from the family name so VENDO_MODEL_JUDGE pins vendoModel(\"vendo-judge\")", async () => {
    expect(await resolvedId(vendoModel("vendo-judge", {
      env: { VENDO_API_KEY: "vnd_x", VENDO_MODEL_JUDGE: "vendo-strong" },
      importModule: scriptedProvider("createAnthropic"),
    }))).toBe("vendo-strong");
    // No pin, no config: the family name passes through verbatim.
    expect(await resolvedId(vendoModel("vendo-judge", {
      env: { VENDO_API_KEY: "vnd_x" },
      importModule: scriptedProvider("createAnthropic"),
    }))).toBe("vendo-judge");
  });

  it("feeds models.judge (string) into vendoModel(\"vendo-judge\") via configureVendoModelSlots", async () => {
    configureVendoModelSlots({ judge: "vendo-strong" });
    expect(await resolvedId(vendoModel("vendo-judge", {
      env: { VENDO_API_KEY: "vnd_x" },
      importModule: scriptedProvider("createAnthropic"),
    }))).toBe("vendo-strong");
    // Env pin still outranks the configured string.
    expect(await resolvedId(vendoModel("vendo-judge", {
      env: { VENDO_API_KEY: "vnd_x", VENDO_MODEL_JUDGE: "vendo-fast" },
      importModule: scriptedProvider("createAnthropic"),
    }))).toBe("vendo-fast");
    // Non-judge slots never read the judge config.
    expect(await resolvedId(vendoModel(undefined, {
      env: { VENDO_API_KEY: "vnd_x" },
      importModule: scriptedProvider("createAnthropic"),
    }))).toBe("vendo");
  });

  it("feeds models.judge (explicit LanguageModel object) straight through — it wins over env pins", async () => {
    const explicit = {
      specificationVersion: "v3",
      provider: "host",
      modelId: "host-judge",
      supportedUrls: {},
      doGenerate: async () => ({ modelId: "host-judge" }),
      doStream: async () => ({ modelId: "host-judge" }),
    } as unknown as LanguageModel;
    configureVendoModelSlots({ judge: explicit });
    expect(await resolvedId(vendoModel("vendo-judge", {
      env: { VENDO_API_KEY: "vnd_x", VENDO_MODEL_JUDGE: "vendo-fast" },
      importModule: scriptedProvider("createAnthropic"),
    }))).toBe("host-judge");
  });
});
