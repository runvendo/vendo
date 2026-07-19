import { VENDO_APP_FORMAT, VendoError, type AppDocument, type SecretsProvider } from "@vendoai/core";
import { describe, expect, it } from "vitest";
import { buildEnv, type BuildEnvContext } from "./box-env.js";

const app = (overrides: Partial<AppDocument> = {}): AppDocument => ({
  format: VENDO_APP_FORMAT,
  id: "app_box_env",
  name: "Box env app",
  ...overrides,
});

const secrets: SecretsProvider = {
  async get(name) {
    return { STRIPE_KEY: "sk_live_123", MAIL_KEY: "mk_456" }[name];
  },
};

const baseContext = (overrides: Partial<BuildEnvContext> = {}): BuildEnvContext => ({
  granted: new Set<string>(),
  storeUrl: "https://host.example/api/vendo/box",
  hostUrl: "https://host.example/api/vendo/box",
  appToken: "vat_" + "a".repeat(64),
  ...overrides,
});

describe("buildEnv (execution-v2 skin contract, env half)", () => {
  it("assembles the boundary env: PORT, store/host URLs, app token", async () => {
    const { env } = await buildEnv(app(), baseContext());
    expect(env).toEqual({
      PORT: "8080",
      VENDO_STORE_URL: "https://host.example/api/vendo/box",
      VENDO_APP_TOKEN: "vat_" + "a".repeat(64),
      VENDO_HOST_URL: "https://host.example/api/vendo/box",
    });
  });

  it("injects ONLY granted declared secrets, by name, with real values", async () => {
    const document = app({ secrets: ["STRIPE_KEY", "MAIL_KEY"] });
    const { env, injectedSecrets } = await buildEnv(document, baseContext({
      granted: new Set(["STRIPE_KEY"]),
      secrets,
    }));
    expect(env["STRIPE_KEY"]).toBe("sk_live_123");
    expect(env).not.toHaveProperty("MAIL_KEY");
    expect(injectedSecrets).toEqual(["STRIPE_KEY"]);
  });

  it("a granted but undeclared secret never injects", async () => {
    const { env, injectedSecrets } = await buildEnv(app(), baseContext({
      granted: new Set(["STRIPE_KEY"]),
      secrets,
    }));
    expect(env).not.toHaveProperty("STRIPE_KEY");
    expect(injectedSecrets).toEqual([]);
  });

  it("wires the inference seam when the resolver provides one", async () => {
    const { env } = await buildEnv(app(), baseContext({
      inference: async () => ({ url: "https://gateway.vendo.run/api/v1", key: "vik_1" }),
    }));
    expect(env["VENDO_INFERENCE_URL"]).toBe("https://gateway.vendo.run/api/v1");
    expect(env["VENDO_INFERENCE_KEY"]).toBe("vik_1");
  });

  it("omits inference vars when the resolver yields nothing", async () => {
    const { env } = await buildEnv(app(), baseContext({ inference: async () => undefined }));
    expect(env).not.toHaveProperty("VENDO_INFERENCE_URL");
    expect(env).not.toHaveProperty("VENDO_INFERENCE_KEY");
  });

  it("refuses a secret name that would shadow a reserved boundary var", async () => {
    for (const name of [
      "PORT",
      "VENDO_APP_TOKEN",
      "VENDO_STORE_URL",
      "VENDO_HOST_URL",
      "VENDO_INFERENCE_URL",
      "VENDO_INFERENCE_KEY",
    ]) {
      const document = app({ secrets: [name] });
      await expect(
        buildEnv(document, baseContext({ granted: new Set([name]), secrets: { get: async () => "x" } })),
      ).rejects.toThrowError(VendoError);
    }
  });

  it("honors an explicit port and refuses a nonsense one", async () => {
    const { env } = await buildEnv(app(), baseContext({ port: 3000 }));
    expect(env["PORT"]).toBe("3000");
    for (const port of [0, -1, 1.5, 70_000]) {
      await expect(buildEnv(app(), baseContext({ port }))).rejects.toThrowError(VendoError);
    }
  });

  it("deduplicates a doubly-declared secret", async () => {
    const document = app({ secrets: ["STRIPE_KEY", "STRIPE_KEY"] });
    const { injectedSecrets } = await buildEnv(document, baseContext({
      granted: new Set(["STRIPE_KEY"]),
      secrets,
    }));
    expect(injectedSecrets).toEqual(["STRIPE_KEY"]);
  });
});
