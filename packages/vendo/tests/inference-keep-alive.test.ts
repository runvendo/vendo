/**
 * Inference rides the keep-alive pool the host-API and store calls already
 * ride: Node's stock dispatcher drops an idle socket after ~4s, shorter than
 * the gap between two turns, so the gateway was re-handshaking constantly.
 *
 * The seam runs end to end here — the real `resolveModels` composing the real
 * `vendoModel`, with only the provider module and the environment faked (they
 * have to be) — because the whole point is that the fetch a producer sets
 * arrives at the provider a consumer builds.
 */
import { vendoModel } from "@vendoai/harnesses/inference";
import { describe, expect, it } from "vitest";
import { keepAliveFetch } from "../src/keep-alive-fetch.js";
import { resolveModels } from "../src/models-config.js";

type ProviderConfig = { apiKey: string; baseURL?: string; fetch?: typeof fetch };

/** A provider module whose factory records the config it was built with. */
function scriptedAnthropic(seen: ProviderConfig[]) {
  return async (): Promise<Record<string, unknown>> => ({
    createAnthropic: (config: ProviderConfig) => {
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

async function resolve(model: unknown): Promise<void> {
  await (model as { doGenerate(options: unknown): Promise<unknown> }).doGenerate({ prompt: [] });
}

describe("composed model seats dial the gateway over the keep-alive pool", () => {
  it("hands the keep-alive fetch to the provider every seat resolves", async () => {
    const seen: ProviderConfig[] = [];
    const { seats } = resolveModels({}, (name, options) =>
      vendoModel(name, {
        ...options,
        env: { VENDO_API_KEY: "vnd_key" },
        importModule: scriptedAnthropic(seen),
      }));

    for (const model of Object.values(seats)) await resolve(model);

    expect(seen).toHaveLength(4);
    expect(seen.map((config) => config.fetch)).toEqual(Array(4).fill(keepAliveFetch));
  });

  it("leaves a model the host passed as an object entirely alone", async () => {
    const seen: ProviderConfig[] = [];
    const hostModel = { specificationVersion: "v3", provider: "host", modelId: "host-model" } as never;
    const { seats } = resolveModels({ models: { default: hostModel } }, (name, options) =>
      vendoModel(name, {
        ...options,
        env: { VENDO_API_KEY: "vnd_key" },
        importModule: scriptedAnthropic(seen),
      }));

    expect(seats.default).toBe(hostModel);
    expect(seen).toEqual([]);
  });
});
