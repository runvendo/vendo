import { VendoError, defaultFetch } from "@vendoai/core";
import { z } from "zod";
import { consoleSender, raiseCloudError } from "./cloud-console.js";

/** The Cloud broker ensure-tenant client — the implementation the composition
 * seam (createVendo) calls when VENDO_API_KEY + a public VENDO_BASE_URL fill
 * the mcp seam's broker default (adapter rule — see selectMcpBroker in
 * server.ts; the door itself never reads the environment). Idempotent: the
 * console creates the tenant on the first call and returns the existing one
 * (with the federation secret, every call) after that. Rides the shared
 * console-client plumbing (cloud-console.ts): Bearer auth + deployment
 * identity + per-request abort timeout + the honest 401/402 → cloud-required
 * error table. */

export interface CloudMcpOptions {
  apiKey: string;
  /** Defaults to the Vendo console; the composition seam passes VENDO_CLOUD_URL. */
  baseUrl?: string;
  fetch?: typeof fetch;
  /** Per-request abort budget (default 30s, hosted-store's). */
  timeoutMs?: number;
}

/** The frozen ensure-tenant wire (plan 2026-08-03-mcp-broker-provisioning):
 * `status: "disabled"` still carries the secret — the host keeps composing
 * remoteAs and the BROKER refuses traffic, so a status flip needs no host
 * redeploy in either direction. */
export interface McpTenant {
  slug: string;
  issuer: string;
  audience: string;
  status: "active" | "disabled";
  upstreamOrigin: string;
  upstreamMount: string;
}

export interface EnsureTenantResult {
  tenant: McpTenant;
  federationSecret: string;
}

const DEFAULT_TIMEOUT_MS = 30_000;

/** The console mounts the broker tenant surface here. */
const CONSOLE_MCP_PATH = "/api/v1/mcp";

const ensureTenantSchema = z.object({
  tenant: z.object({
    slug: z.string(),
    issuer: z.string(),
    audience: z.string(),
    status: z.enum(["active", "disabled"]),
    upstreamOrigin: z.string(),
    upstreamMount: z.string(),
  }),
  federationSecret: z.string(),
});

/** Shared console error table: 401/402 → cloud-required, wire-legal envelope
 * codes forward as VendoErrors, anything else (unknown codes, 5xx, non-JSON
 * bodies) rides a plain Error with the server's code attached — never a
 * "validation" error blaming the caller for the console misbehaving. */
const raiseMcpError = (response: Response): Promise<never> =>
  raiseCloudError(response, "mcp", (code, message) => {
    throw Object.assign(new Error(message), { code: code ?? "unavailable" });
  });

export interface CloudMcpTenantClient {
  ensure(input: { baseUrl: string; mount: string }): Promise<EnsureTenantResult>;
}

export function cloudMcpTenant(options: CloudMcpOptions): CloudMcpTenantClient {
  const base = (options.baseUrl ?? "https://console.vendo.run").replace(/\/$/, "");
  const send = consoleSender({
    base,
    mountPath: CONSOLE_MCP_PATH,
    apiKey: options.apiKey,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    fetchImpl: options.fetch ?? defaultFetch,
    raise: raiseMcpError,
  });

  return {
    async ensure(input) {
      const response = await send("/tenant", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      });
      const payload: unknown = await response.json().catch(() => undefined);
      const parsed = ensureTenantSchema.safeParse(payload);
      if (!parsed.success) {
        // A server-shaped failure, never the caller's: the mount answered 2xx
        // with a body that is not the ensure-tenant wire (the knowledge
        // client's posture — a missing/misdeployed mount must not read as a
        // caller mistake).
        throw new VendoError(
          "not-implemented",
          "Vendo Cloud /api/v1/mcp/tenant answered with a body that is not the ensure-tenant wire — check VENDO_CLOUD_URL and the console deployment",
        );
      }
      return parsed.data;
    },
  };
}
