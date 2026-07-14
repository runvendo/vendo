import { VendoError } from "@vendoai/core";
import type { SandboxAdapter } from "./sandbox.js";

export interface CloudSandboxOptions {
  apiKey?: string;
}

const cloudKey = (options: CloudSandboxOptions): string | undefined => (
  options.apiKey ?? globalThis.process?.env?.VENDO_API_KEY
);

const cloudBaseUrl = (): string => {
  const configured = globalThis.process?.env?.VENDO_CLOUD_URL;
  return (configured === undefined || configured === ""
    ? "https://console.vendo.run"
    : configured).replace(/\/+$/, "");
};

/**
 * 06-apps §3 — the public Vendo Cloud adapter seam.
 *
 * The hosted machine transport lands in the private Cloud repository. Keeping
 * this OSS stub on the frozen SandboxAdapter shape lets hosts wire the subpath
 * now and receive an explicit Cloud entitlement/availability error.
 */
export const cloudSandbox = (options: CloudSandboxOptions = {}): SandboxAdapter => {
  const apiKey = cloudKey(options);
  const baseUrl = cloudBaseUrl();

  const unavailable = (): never => {
    if (apiKey === undefined || apiKey === "") {
      throw new VendoError(
        "cloud-required",
        "Vendo Cloud sandbox requires VENDO_API_KEY and a Cloud plan",
      );
    }
    throw new VendoError(
      "cloud-required",
      `Vendo Cloud sandbox is not yet available at ${baseUrl}`,
    );
  };

  return {
    async create() {
      return unavailable();
    },
    async resume() {
      return unavailable();
    },
  };
};
