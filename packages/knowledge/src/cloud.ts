import { VendoError, type KnowledgeAdapter } from "@vendoai/core";
import { knowledgeWireAdapter } from "./wire.js";

const DEFAULT_BASE_URL = "https://console.vendo.run";

export interface CloudKnowledgeOptions {
  /** The Vendo Cloud key (`vendo login`); sent as a Bearer token. */
  apiKey: string;
  /** Console base; the knowledge mount lives at `/api/v1/knowledge`. */
  baseUrl?: string;
  /** Injectable transport (tests point this at an in-process fake server). */
  fetch?: typeof fetch;
}

/** The Vendo Cloud knowledge engine client: speaks exactly
 * `vendo/knowledge-wire@1` against the console mount — the same five routes
 * any BYO endpoint implements. Tenancy never crosses the wire: the corpus is
 * the key's org, resolved server-side.
 *
 * Full posture: the cloud engine chunks/searches vendor-side and its upsert
 * resolves only once documents are searchable (the mount owns awaiting that;
 * this client just doesn't resolve early). Layering keeps this sender
 * self-contained (core-only imports — no cloud-console reuse). */
export function cloudKnowledge(options: CloudKnowledgeOptions): KnowledgeAdapter {
  const base = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  return knowledgeWireAdapter({
    base: `${base}/api/v1/knowledge`,
    bearer: options.apiKey,
    posture: { fetch: true, write: true, visibility: "enforced" },
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    errors: {
      unreachable: (cause) => new VendoError(
        "cloud-required",
        `Vendo Cloud knowledge is unreachable at ${base}: ${cause instanceof Error ? cause.message : String(cause)}`,
      ),
      // Client-specific tail sanctioned by the wire module: any 401 is a key
      // problem, whatever the body looks like.
      rejected: (status) => status === 401
        ? new VendoError("cloud-required", "Vendo Cloud rejected the API key — run `vendo login` or check VENDO_API_KEY")
        : undefined,
      badBody: (route) => new VendoError(
        "not-implemented",
        `Vendo Cloud ${route} answered with a body that is not vendo/knowledge-wire@1`,
      ),
    },
  });
}
