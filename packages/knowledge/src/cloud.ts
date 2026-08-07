import {
  KNOWLEDGE_WIRE_PATHS,
  VendoError,
  knowledgeFetchResultSchema,
  knowledgeSearchResultSchema,
  knowledgeWireStatusSchema,
  parseKnowledgeWireError,
  type KnowledgeAdapter,
  type KnowledgeContext,
} from "@vendoai/core";

const DEFAULT_BASE_URL = "https://console.vendo.run";
const DEFAULT_TIMEOUT_MS = 30_000;

export interface CloudKnowledgeOptions {
  /** The Vendo Cloud key (`vendo login`); sent as a Bearer token. */
  apiKey: string;
  /** Console base; the knowledge mount lives at `/api/v1/knowledge`. */
  baseUrl?: string;
  /** Injectable transport (tests point this at an in-process fake server). */
  fetch?: typeof fetch;
}

/** The Vendo Cloud knowledge engine client (knowledge design v2 R2,
 * ENG-364): speaks exactly `vendo/knowledge-wire@1` against the console
 * mount — the same five routes any BYO endpoint implements. Tenancy never
 * crosses the wire: the corpus is the key's org, resolved server-side.
 *
 * Full posture: the cloud engine chunks/searches vendor-side and its upsert
 * resolves only once documents are searchable (the mount owns awaiting
 * that; this client just doesn't resolve early). Layering keeps this
 * sender self-contained (core-only imports — no cloud-console reuse). */
export function cloudKnowledge(options: CloudKnowledgeOptions): KnowledgeAdapter {
  const base = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const transport = options.fetch ?? fetch;

  async function call(path: string, init: { method: "GET" | "POST"; body?: unknown }): Promise<unknown> {
    let response: Response;
    try {
      response = await transport(`${base}/api/v1/knowledge${path}`, {
        method: init.method,
        headers: {
          authorization: `Bearer ${options.apiKey}`,
          ...(init.body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
        signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
      });
    } catch (error) {
      throw new VendoError(
        "cloud-required",
        `Vendo Cloud knowledge is unreachable at ${base}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const body: unknown = await response.json().catch(() => undefined);
    if (response.status === 401) {
      // Client-specific tail sanctioned by the wire module: any 401 is a key
      // problem, whatever the body looks like.
      throw new VendoError("cloud-required", "Vendo Cloud rejected the API key — run `vendo login` or check VENDO_API_KEY");
    }
    if (!response.ok) throw parseKnowledgeWireError(response.status, body);
    return body;
  }

  const parse = <T>(schema: { safeParse(value: unknown): { success: boolean; data?: unknown } }, value: unknown, route: string): T => {
    const parsed = schema.safeParse(value);
    if (!parsed.success) {
      // A server-shaped failure, never the caller's: the mount answered 2xx
      // with a body that is not the knowledge wire.
      throw new VendoError("not-implemented", `Vendo Cloud ${route} answered with a body that is not vendo/knowledge-wire@1`);
    }
    return parsed.data as T;
  };

  const includeInternal = (ctx: KnowledgeContext): { includeInternal?: boolean } =>
    ctx.includeInternal === true ? { includeInternal: true } : {};

  return {
    posture: { fetch: true, write: true, visibility: "enforced" },

    async search(query, ctx) {
      const body = await call(KNOWLEDGE_WIRE_PATHS.search, { method: "POST", body: { query, ...includeInternal(ctx) } });
      return parse(knowledgeSearchResultSchema, body, "/search");
    },

    async fetch(ref, ctx) {
      try {
        const body = await call(KNOWLEDGE_WIRE_PATHS.fetch, { method: "POST", body: { ref, ...includeInternal(ctx) } });
        return parse(knowledgeFetchResultSchema, body, "/fetch");
      } catch (error) {
        // Only an ENVELOPED not-found translates to the contract's null (a
        // bare 404 already degraded to "not-implemented" in the parser — the
        // hosted-store lesson: a missing mount must not read as absence).
        if (error instanceof VendoError && error.code === "not-found") return null;
        throw error;
      }
    },

    async upsert(docs) {
      await call(KNOWLEDGE_WIRE_PATHS.upsert, { method: "POST", body: { docs } });
    },

    async remove(docIds) {
      await call(KNOWLEDGE_WIRE_PATHS.remove, { method: "POST", body: { docIds } });
    },

    async status() {
      const body = await call(KNOWLEDGE_WIRE_PATHS.status, { method: "GET" });
      return parse<{ status: Awaited<ReturnType<KnowledgeAdapter["status"]>> }>(knowledgeWireStatusSchema, body, "/status").status;
    },
  };
}
