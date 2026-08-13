import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import Module from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { UNKNOWN_MODEL_MAX_OUTPUT_TOKENS } from "@vendoai/apps";
import type { LanguageModel } from "ai";
import {
  DevModelController,
  bindVendoModelSlots,
  devModel,
  importHostModule,
  NO_CREDENTIAL_MESSAGE,
  vendoModel,
} from "../../src/dev-creds/model.js";

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

/**
 * The env-key rungs, as they are reachable AFTER the selection law: a provider
 * key in the environment selects nothing on its own, so every case that
 * exercises one of those rungs names it through the internal
 * `VENDO_DEV_CREDENTIAL` pin. The rung's own behaviour — per-slot precedence,
 * per-provider defaults, sampling params, host-first module resolution — is
 * unchanged and still fully covered; what changed is who may ask for it.
 * The keyless cases below prove the bare-key path is genuinely dead.
 */
const BYO = {
  anthropic: { VENDO_DEV_CREDENTIAL: "env-key:anthropic", ANTHROPIC_API_KEY: "sk-a" },
  openai: { VENDO_DEV_CREDENTIAL: "env-key:openai", OPENAI_API_KEY: "sk-o" },
  google: { VENDO_DEV_CREDENTIAL: "env-key:google", GOOGLE_GENERATIVE_AI_API_KEY: "g" },
} as const;

describe("THE SELECTION LAW — a provider key is a credential, not a choice", () => {
  it("a stray ANTHROPIC_API_KEY with no models config gets the boot error, not a model", async () => {
    // The breaking change. A key left in a shell (or inherited by a container)
    // used to pick both the provider and the model for the whole deployment.
    const controller = new DevModelController({
      env: { ANTHROPIC_API_KEY: "sk-a" },
      // Would answer happily if it were ever reached — and it must not be.
      importModule: scriptedProvider("createAnthropic"),
    });
    await expect(controller.doGenerate({ prompt: [] })).rejects.toThrow(NO_CREDENTIAL_MESSAGE);
    await expect(controller.doStream({ prompt: [] })).rejects.toThrow(NO_CREDENTIAL_MESSAGE);
  });

  it("says so for every provider key, and for all of them at once", async () => {
    for (const env of [
      { ANTHROPIC_API_KEY: "sk-a" },
      { OPENAI_API_KEY: "sk-o" },
      { GOOGLE_GENERATIVE_AI_API_KEY: "g" },
      { ANTHROPIC_API_KEY: "sk-a", OPENAI_API_KEY: "sk-o", GOOGLE_GENERATIVE_AI_API_KEY: "g" },
    ]) {
      const model = vendoModel(undefined, { env, importModule: scriptedProvider("createAnthropic") });
      await expect(resolvedId(model)).rejects.toThrow(NO_CREDENTIAL_MESSAGE);
    }
  });

  it("teaches both ways out, in order: explicit config first, then VENDO_API_KEY", () => {
    expect(NO_CREDENTIAL_MESSAGE).toContain("models: { default: anthropic(\"claude-sonnet-4-6\") }");
    expect(NO_CREDENTIAL_MESSAGE).toContain("set VENDO_API_KEY for the Vendo Cloud gateway");
    expect(NO_CREDENTIAL_MESSAGE).toContain("`vendo login` mints a free dev key");
    expect(NO_CREDENTIAL_MESSAGE.indexOf("models: { default:"))
      .toBeLessThan(NO_CREDENTIAL_MESSAGE.indexOf("VENDO_API_KEY"));
  });

  it("still serves VENDO_API_KEY when a provider key sits beside it", async () => {
    // The Cloud key is the ONE blessed default-filler; a provider key next to it
    // no longer shadows it (nor does it get used).
    const seen: Array<{ apiKey: string; baseURL?: string }> = [];
    expect(await resolvedId(vendoModel(undefined, {
      env: { ANTHROPIC_API_KEY: "sk-a", VENDO_API_KEY: "vnd_x" },
      importModule: scriptedProvider("createAnthropic", seen),
    }))).toBe("vendo");
    expect(seen).toEqual([{ apiKey: "vnd_x", baseURL: "https://console.vendo.run/api/v1" }]);
  });

  /**
   * THE COUPLING, from the producer's side.
   *
   * `MODEL_UNAVAILABLE_SIGNAL` in `@vendoai/apps` (server/doors/build-messages.ts)
   * is anchored BYTE-FOR-BYTE to this sentence's opening: it is what lets the
   * app-build door surface the actionable line instead of collapsing it to
   * "generation failed · retry", where it reaches only the operator's terminal
   * (0.4.x, measured twice). apps may not import vendo and this test may not
   * import apps' internals, so the coupling is pinned from BOTH sides against one
   * literal — this assertion, and the same literal fed through the real
   * `buildFailureReason` in packages/apps/tests/build-failure.test.ts ("passes the
   * dev-model's own unavailable-credential lines through verbatim"). Reword the
   * message and THIS fails; retune the pattern away from the literal and THAT
   * fails. Neither can drift quietly.
   */
  it("keeps the exact bytes @vendoai/apps' MODEL_UNAVAILABLE_SIGNAL anchors on", () => {
    // The anchored prefix — the pattern is ^-anchored, so this opening is the
    // load-bearing part.
    expect(NO_CREDENTIAL_MESSAGE.startsWith("Vendo has no model.")).toBe(true);
    // And the whole line, which is what the door surfaces verbatim.
    expect(NO_CREDENTIAL_MESSAGE).toBe(
      "Vendo has no model. Pass one — models: { default: anthropic(\"claude-sonnet-4-6\") } in "
      + "createVendo — or set VENDO_API_KEY for the Vendo Cloud gateway (`vendo login` mints a free "
      + "dev key). A provider key alone no longer selects a model; Vendo never picks a provider for you.",
    );
  });
});

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
    // 2026-07-22); the gateway grace-remaps unknown aliases server-side. The
    // explicit output cap rides every gateway call — "vendo" is unknown to
    // the stock provider's registry, which otherwise clamps it to 4096.
    const capped = { prompt: [], maxOutputTokens: UNKNOWN_MODEL_MAX_OUTPUT_TOKENS };
    expect(await controller.doGenerate(callOptions)).toEqual({
      delegated: "generate",
      modelId: "vendo",
      options: capped,
    });
    expect(await controller.doStream(callOptions)).toEqual({
      delegated: "stream",
      modelId: "vendo",
      options: capped,
    });
    // The key rides as the provider apiKey; the base is the production
    // console's /api/v1, where the Anthropic-shaped /messages endpoint lives.
    expect(seen).toEqual([
      { apiKey: "vnd_x", baseURL: "https://console.vendo.run/api/v1" },
    ]);
  });

  it("honors VENDO_CLOUD_URL on the vendo-cloud rung", async () => {
    const seen: Array<{ baseURL: string }> = [];
    const controller = new DevModelController({
      env: {
        VENDO_API_KEY: "vnd_x",
        VENDO_CLOUD_URL: "http://localhost:3001/",
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
    expect(await controller.doGenerate({ prompt: [] })).toEqual({ modelId: "vendo" });
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
      env: { ...BYO.openai },
      importModule: async (_root, specifier) => {
        throw new Error(`Cannot find module '${specifier}'`);
      },
    });
    await expect(controller.doGenerate({ prompt: [] })).rejects.toThrow(/@ai-sdk\/openai@\^3/);
  });

  it("delegates env-key calls to the host provider model with full fidelity", async () => {
    const seen: unknown[] = [];
    const controller = new DevModelController({
      env: { ...BYO.anthropic },
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

  it("honors the VENDO_MODEL pin for the resolved provider", async () => {
    const controller = new DevModelController({
      env: { ...BYO.anthropic, VENDO_MODEL: "claude-opus-4-8" },
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

// Sampling capability is re-decided at call time against the RESOLVED rung
// (#692): the wrapper's own modelId is the family name by design, so
// model-params' Claude 5 allowlist sends the engine's `temperature: 0`
// through the ladder — the ladder must drop it before the rung 400s.
describe("call-time sampling params on the resolved rung", () => {
  /** Provider module whose stub model echoes the call options it received. */
  function optionsEcho(factoryName: string) {
    return async (): Promise<Record<string, unknown>> => ({
      [factoryName]: () => (modelId: string) => ({
        specificationVersion: "v3",
        provider: "scripted",
        modelId,
        supportedUrls: {},
        doGenerate: async (options: unknown) => ({ modelId, options }),
        doStream: async (options: unknown) => ({ modelId, options }),
      }),
    });
  }

  it("drops temperature/topP/topK and caps output for a ladder-resolved Claude 5 model", async () => {
    const controller = new DevModelController({
      env: { ...BYO.anthropic, VENDO_MODEL: "claude-sonnet-5" },
      importModule: optionsEcho("createAnthropic"),
    });
    expect(await controller.doGenerate({ prompt: [], temperature: 0, topP: 0.9, topK: 40 })).toEqual({
      modelId: "claude-sonnet-5",
      options: { prompt: [], maxOutputTokens: UNKNOWN_MODEL_MAX_OUTPUT_TOKENS },
    });
    expect(await controller.doStream({ prompt: [], temperature: 0 })).toEqual({
      modelId: "claude-sonnet-5",
      options: { prompt: [], maxOutputTokens: UNKNOWN_MODEL_MAX_OUTPUT_TOKENS },
    });
  });

  it("drops temperature and caps output for the Cloud gateway's own family id", async () => {
    // Field: linkwarden 2026-08-08 — "vendo" is unknown to the stock
    // @ai-sdk/anthropic capability registry, which silently limits max_tokens
    // to 4096 without an explicit cap; a screen agent's document truncates
    // mid-wire and the app never lands a row.
    const controller = new DevModelController({
      env: { VENDO_API_KEY: `vnd_${"k".repeat(40)}` },
      importModule: optionsEcho("createAnthropic"),
    });
    expect(await controller.doStream({ prompt: [], temperature: 0 })).toEqual({
      modelId: "vendo",
      options: { prompt: [], maxOutputTokens: UNKNOWN_MODEL_MAX_OUTPUT_TOKENS },
    });
  });

  it("keeps a caller's explicit output cap while dropping the sampling params", async () => {
    const controller = new DevModelController({
      env: { ...BYO.anthropic, VENDO_MODEL: "claude-opus-5" },
      importModule: optionsEcho("createAnthropic"),
    });
    expect(await controller.doGenerate({ prompt: [], temperature: 0, maxOutputTokens: 9_000 })).toEqual({
      modelId: "claude-opus-5",
      options: { prompt: [], maxOutputTokens: 9_000 },
    });
  });

  it("leaves a non-Claude resolution untouched — temperature still flows", async () => {
    const controller = new DevModelController({
      env: { ...BYO.openai },
      importModule: optionsEcho("createOpenAI"),
    });
    expect(await controller.doGenerate({ prompt: [], temperature: 0 })).toEqual({
      modelId: "gpt-5",
      options: { prompt: [], temperature: 0 },
    });
  });

  it("leaves a sampling-era Claude resolution untouched", async () => {
    const controller = new DevModelController({
      env: { ...BYO.anthropic, VENDO_MODEL: "claude-sonnet-4-6" },
      importModule: optionsEcho("createAnthropic"),
    });
    expect(await controller.doGenerate({ prompt: [], temperature: 0 })).toEqual({
      modelId: "claude-sonnet-4-6",
      options: { prompt: [], temperature: 0 },
    });
  });
});

// The vendo-shipped provider fallback (unified try surface follow-up): the
// umbrella ships @ai-sdk/anthropic as a real dependency, so a key alone lights
// up live chat under `npx vendo try` on repos with no @ai-sdk install. These
// tests exercise the REAL resolution path (no importModule seam): host-root
// resolution against a temp fixture repo, vendo's own module context as the
// provider fallback.
describe("provider module resolution (host first, vendo's copy as fallback)", () => {
  const cleanup: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const dispose of cleanup.splice(0).reverse()) await dispose();
  });

  async function fixtureRoot(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "vendo-model-fallback-"));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    await writeFile(join(root, "package.json"), JSON.stringify({ name: "fixture", version: "0.0.0" }));
    return root;
  }

  /** Vitest exports NODE_PATH pointing at the workspace's .pnpm store, which
   *  makes EVERY bare specifier resolve from any root. Real hosts don't run
   *  with that; drop it (Module._initPaths re-reads NODE_PATH — mutating the
   *  Module.globalPaths snapshot does nothing) so host-root resolution
   *  honestly fails for the fixture, the way the 0.4.x E2E cert proved it
   *  does in the field. */
  async function withoutGlobalPaths<Result>(run: () => Promise<Result>): Promise<Result> {
    const initPaths = (Module as unknown as { _initPaths: () => void })._initPaths;
    const saved = process.env["NODE_PATH"];
    delete process.env["NODE_PATH"];
    initPaths();
    try {
      return await run();
    } finally {
      process.env["NODE_PATH"] = saved;
      initPaths();
    }
  }

  it("falls back to vendo's own @ai-sdk/anthropic when the host has no provider install", async () => {
    const root = await fixtureRoot();
    const controller = new DevModelController({ root, env: { ...BYO.anthropic } });
    const resolution = await withoutGlobalPaths(() => controller.resolve());
    expect(resolution.mode).toBe("delegate");
    if (resolution.mode !== "delegate") return;
    // The model is the real vendo-shipped provider's, constructed and callable.
    expect(resolution.model.provider).toContain("anthropic");
    expect(resolution.model.modelId).toBe("claude-sonnet-4-6");
  });

  it("prefers the host's own provider install over vendo's copy", async () => {
    const root = await fixtureRoot();
    // A fake host install: their version, their module instance, must win —
    // dual copies of one provider are the ai-SDK dual-package hazard.
    const moduleDir = join(root, "node_modules", "@ai-sdk", "anthropic");
    await mkdir(moduleDir, { recursive: true });
    await writeFile(
      join(moduleDir, "package.json"),
      JSON.stringify({ name: "@ai-sdk/anthropic", version: "0.0.0", type: "module", main: "index.js" }),
    );
    await writeFile(
      join(moduleDir, "index.js"),
      `export function createAnthropic() {
        return (modelId) => ({
          specificationVersion: "v3",
          provider: "host-anthropic",
          modelId,
          supportedUrls: {},
          doGenerate: async () => ({ from: "host" }),
          doStream: async () => ({ from: "host" }),
        });
      }
      `,
    );
    const controller = new DevModelController({ root, env: { ...BYO.anthropic } });
    expect(await controller.doGenerate({ prompt: [] })).toEqual({ from: "host" });
  });

  it("scopes the fallback to @ai-sdk/* provider modules only", async () => {
    const root = await fixtureRoot();
    await withoutGlobalPaths(async () => {
      // zod resolves from vendo's own context, but it is not a provider
      // module: arbitrary specifiers keep strict host-root resolution.
      await expect(importHostModule(root, "zod")).rejects.toThrow();
      // The provider module DOES fall back from the same fixture root.
      const loaded = await importHostModule(root, "@ai-sdk/anthropic");
      expect(typeof loaded["createAnthropic"]).toBe("function");
    });
  });
});

describe("vendoModel (the vendo model family entry)", () => {
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
      env: { ...BYO.anthropic },
      importModule: scriptedProvider("createAnthropic"),
    });
    expect(await resolvedId(model)).toBe("claude-opus-4-8");
    // Even a vendo-* family name goes through untouched: the provider's own
    // error is the surface for unknown names, never a client-side remap.
    const family = vendoModel("vendo-paint", {
      env: { ...BYO.anthropic },
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
      env: { ...BYO.anthropic },
      importModule: scriptedProvider("createAnthropic"),
    }))).toBe("claude-sonnet-4-6");
    expect(await resolvedId(vendoModel(undefined, {
      env: { ...BYO.openai },
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
      env: { ...BYO.anthropic },
      importModule: scriptedProvider("createAnthropic"),
    }))).toBe("claude-haiku-4-5");
    expect(await resolvedId(vendoModel(undefined, {
      slot: "paint",
      env: { ...BYO.openai },
      importModule: scriptedProvider("createOpenAI"),
    }))).toBe("gpt-5-mini");
    expect(await resolvedId(vendoModel(undefined, {
      slot: "paint",
      env: { ...BYO.google },
      importModule: scriptedProvider("createGoogleGenerativeAI"),
    }))).toBe("gemini-2.5-flash-lite");
  });

  it("VENDO_MODEL pins the agent slot above a configured name string", async () => {
    expect(await resolvedId(vendoModel("claude-opus-4-8", {
      env: { ...BYO.anthropic, VENDO_MODEL: "claude-sonnet-4-6" },
      importModule: scriptedProvider("createAnthropic"),
    }))).toBe("claude-sonnet-4-6");
  });

  it("VENDO_MODEL_PAINT pins the paint slot; VENDO_MODEL does not", async () => {
    expect(await resolvedId(vendoModel(undefined, {
      slot: "paint",
      env: { ...BYO.anthropic, VENDO_MODEL: "claude-opus-4-8", VENDO_MODEL_PAINT: "claude-haiku-4-5" },
      importModule: scriptedProvider("createAnthropic"),
    }))).toBe("claude-haiku-4-5");
    expect(await resolvedId(vendoModel(undefined, {
      slot: "paint",
      env: { ...BYO.anthropic, VENDO_MODEL: "claude-opus-4-8" },
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

  it("binds models.judge (string) onto ONE vendoModel(\"vendo-judge\") instance via bindVendoModelSlots", async () => {
    const bound = vendoModel("vendo-judge", {
      env: { VENDO_API_KEY: "vnd_x" },
      importModule: scriptedProvider("createAnthropic"),
    });
    bindVendoModelSlots(bound, { judge: "vendo-strong" });
    expect(await resolvedId(bound)).toBe("vendo-strong");
    // The binding is PER INSTANCE: a second judge model in the same process
    // keeps its own (unbound) resolution — no last-createVendo-wins registry.
    expect(await resolvedId(vendoModel("vendo-judge", {
      env: { VENDO_API_KEY: "vnd_x" },
      importModule: scriptedProvider("createAnthropic"),
    }))).toBe("vendo-judge");
    // Env pin still outranks the bound string.
    const pinned = vendoModel("vendo-judge", {
      env: { VENDO_API_KEY: "vnd_x", VENDO_MODEL_JUDGE: "vendo-fast" },
      importModule: scriptedProvider("createAnthropic"),
    });
    bindVendoModelSlots(pinned, { judge: "vendo-strong" });
    expect(await resolvedId(pinned)).toBe("vendo-fast");
    // Non-judge slots never read the judge config.
    const agent = vendoModel(undefined, {
      env: { VENDO_API_KEY: "vnd_x" },
      importModule: scriptedProvider("createAnthropic"),
    });
    bindVendoModelSlots(agent, { judge: "vendo-strong" });
    expect(await resolvedId(agent)).toBe("vendo");
  });

  it("two instances bind independently — each createVendo gets ITS OWN models.judge", async () => {
    const options = () => ({
      env: { VENDO_API_KEY: "vnd_x" },
      importModule: scriptedProvider("createAnthropic"),
    });
    const first = vendoModel("vendo-judge", options());
    const second = vendoModel("vendo-judge", options());
    bindVendoModelSlots(first, { judge: "vendo-strong" });
    bindVendoModelSlots(second, { judge: "vendo-fast" });
    expect(await resolvedId(first)).toBe("vendo-strong");
    expect(await resolvedId(second)).toBe("vendo-fast");
  });

  it("binds models.judge (explicit LanguageModel object) straight through — it wins over env pins", async () => {
    const explicit = {
      specificationVersion: "v3",
      provider: "host",
      modelId: "host-judge",
      supportedUrls: {},
      doGenerate: async () => ({ modelId: "host-judge" }),
      doStream: async () => ({ modelId: "host-judge" }),
    } as unknown as LanguageModel;
    const bound = vendoModel("vendo-judge", {
      env: { VENDO_API_KEY: "vnd_x", VENDO_MODEL_JUDGE: "vendo-fast" },
      importModule: scriptedProvider("createAnthropic"),
    });
    bindVendoModelSlots(bound, { judge: explicit });
    expect(await resolvedId(bound)).toBe("host-judge");
  });

  it("binding a BYO model object (not a vendoModel instance) is a no-op", () => {
    const byo = {
      specificationVersion: "v3",
      provider: "host",
      modelId: "host-model",
      supportedUrls: {},
      doGenerate: async () => ({ modelId: "host-model" }),
      doStream: async () => ({ modelId: "host-model" }),
    } as unknown as LanguageModel;
    expect(() => bindVendoModelSlots(byo, { judge: "vendo-strong" })).not.toThrow();
    expect(() => bindVendoModelSlots(undefined, { judge: "vendo-strong" })).not.toThrow();
    expect((byo as unknown as { modelId: string }).modelId).toBe("host-model");
  });
});
