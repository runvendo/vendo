/**
 * The model-credential ladder, now that it lives here (agents-dx P1). Its full
 * rung matrix stays where it has always been tested — `packages/vendo/tests/
 * dev-creds/model.test.ts`, through vendo's `#dev-creds/model` door, which is
 * the same code as this module. What is pinned HERE is the part the move could
 * have broken by itself: the Cloud rung's base URL, which used to be computed
 * by `resolveCloudBaseUrl` in `@vendoai/vendo` and is read from the environment
 * here, because the edge back to the umbrella would be a cycle.
 */
import { describe, expect, it } from "vitest";
import { NO_CREDENTIAL_MESSAGE, vendoModel } from "../src/inference/model.js";

/** A provider module whose factory records the config it was built with and
 *  answers a model that echoes its own id. */
function scriptedAnthropic(seen: Array<{ apiKey: string; baseURL?: string }>) {
  return async (): Promise<Record<string, unknown>> => ({
    createAnthropic: (config: { apiKey: string; baseURL?: string }) => {
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

async function resolvedId(model: unknown): Promise<string> {
  const record = model as { doGenerate(options: unknown): Promise<{ modelId: string }> };
  return (await record.doGenerate({ prompt: [] })).modelId;
}

describe("the inference ladder resolves from @vendoai/harnesses", () => {
  it("points the anthropic provider at the console gateway for a VENDO_API_KEY", async () => {
    const seen: Array<{ apiKey: string; baseURL?: string }> = [];
    const model = vendoModel(undefined, {
      env: { VENDO_API_KEY: "vnd_key" },
      importModule: scriptedAnthropic(seen),
    });

    expect(await resolvedId(model)).toBe("vendo");
    expect(seen).toEqual([{ apiKey: "vnd_key", baseURL: "https://console.vendo.run/api/v1" }]);
  });

  it("honors VENDO_CLOUD_URL, trailing slashes and all — what resolveCloudBaseUrl did", async () => {
    const seen: Array<{ apiKey: string; baseURL?: string }> = [];
    const model = vendoModel("vendo-paint", {
      env: { VENDO_API_KEY: "vnd_key", VENDO_CLOUD_URL: "https://console.test//" },
      importModule: scriptedAnthropic(seen),
    });

    expect(await resolvedId(model)).toBe("vendo-paint");
    expect(seen[0]?.baseURL).toBe("https://console.test/api/v1");
  });

  it("fails with the exact instructions when there is no credential at all", async () => {
    const model = vendoModel(undefined, { env: {}, importModule: scriptedAnthropic([]) });
    await expect(resolvedId(model)).rejects.toThrow(NO_CREDENTIAL_MESSAGE);
  });
});
