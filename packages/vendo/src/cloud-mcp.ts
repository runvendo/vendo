/**
 * The Cloud MCP implementation of the mcp seam (adapter rule — the seam itself
 * is `selectBrokerage` in compose-mcp.ts, and this module never reads the
 * environment).
 *
 * ONE console call provisions the tenant's door: the broker that fronts it, the
 * secret its login federation is signed with, and the service key its backend
 * exchanges for user tokens. Provisioning is idempotent, so a redeploy re-reads
 * the same tenant rather than minting a second one.
 *
 * Wire contract:
 *
 *   POST <console>/api/v1/mcp   { "base_url": "<the deployment's public URL>" }
 *     authorization: Bearer <key>   (cloudKeyFetch's shared plumbing)
 *
 *   200 { issuer, audience, federation_secret, service_key }
 *
 * LAZY, and that is load-bearing: composition is sync and must do no I/O (a
 * Worker forbids it, and a console outage must not stop a deployment booting).
 * The fetch happens on the first request that actually needs the tenant — a
 * discovery hit, a door hit, or `vendo.tokenFor` — and is cached for the
 * process.
 */
import { cloudKeyFetch } from "./cloud-key-fetch.js";

export interface McpBundle {
  issuer: string;
  audience: string;
  federationSecret: string;
  serviceKey: string;
}

interface McpBundleWire {
  issuer: string;
  audience: string;
  federation_secret: string;
  service_key: string;
}

export function cloudMcpBundle(
  cloud: { apiKey: string; baseUrl?: string },
  appBaseUrl: string | undefined,
): () => Promise<McpBundle> {
  let pending: Promise<McpBundle> | undefined;
  const provision = async (): Promise<McpBundle> => {
    const wire = await cloudKeyFetch<McpBundleWire>("/api/v1/mcp", {
      apiKey: cloud.apiKey,
      ...(cloud.baseUrl === undefined ? {} : { apiUrl: cloud.baseUrl }),
      body: { base_url: appBaseUrl },
    });
    return {
      issuer: wire.issuer,
      audience: wire.audience,
      federationSecret: wire.federation_secret,
      serviceKey: wire.service_key,
    };
  };
  return () => (pending ??= provision().catch((error: unknown) => {
    // A console blip must not wedge the door shut for the life of the process:
    // only a SUCCESSFUL provisioning is the one-per-process cache.
    pending = undefined;
    throw error;
  }));
}
