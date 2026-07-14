import { afterEach, describe, expect, it, vi } from "vitest";
import { cloudSandbox } from "./cloud-sandbox.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

const invoke = async (operation: "create" | "resume", keyed: boolean): Promise<unknown> => {
  const adapter = cloudSandbox(keyed ? { apiKey: "cloud-key" } : {});
  return operation === "create"
    ? adapter.create({ env: {} })
    : adapter.resume("cloud:snapshot");
};

describe("cloudSandbox", () => {
  it.each(["create", "resume"] as const)("requires a Cloud key and plan for %s", async (operation) => {
    vi.stubEnv("VENDO_API_KEY", "");
    await expect(invoke(operation, false)).rejects.toMatchObject({
      code: "cloud-required",
      message: "Vendo Cloud sandbox requires VENDO_API_KEY and a Cloud plan",
    });
  });

  it.each(["create", "resume"] as const)("reports keyed %s as not yet available", async (operation) => {
    vi.stubEnv("VENDO_CLOUD_URL", "https://cloud.example/");
    await expect(invoke(operation, true)).rejects.toMatchObject({
      code: "cloud-required",
      message: "Vendo Cloud sandbox is not yet available at https://cloud.example",
    });
  });
});
