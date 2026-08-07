import {
  KNOWLEDGE_WIRE_PATHS,
  VendoError,
  knowledgeFetchResultSchema,
  knowledgeSearchResultSchema,
  knowledgeWireStatusSchema,
  parseKnowledgeWireError,
  type KnowledgeAdapter,
  type KnowledgeContext,
  type KnowledgePosture,
  type KnowledgeStatus,
} from "@vendoai/core";

const DEFAULT_TIMEOUT_MS = 30_000;

/** BYO defaults: the least a wire endpoint can promise — search + status,
    read-only, attested public-only. Declare more via `posture`. */
const DEFAULT_POSTURE: KnowledgePosture = { fetch: false, write: false, visibility: "public-only" };

export interface HttpKnowledgeOptions {
  /** The endpoint base: the five `vendo/knowledge-wire@1` paths are appended
      directly (`<url>/search`, `<url>/status`, …). */
  url: string;
  auth?: { bearer?: string };
  /** Injectable transport (tests point this at an in-process fake server). */
  fetch?: typeof fetch;
  /** Overrides onto the read-only search-only default — declare exactly what
      the endpoint implements; the conformance suite verifies the claim. */
  posture?: Partial<KnowledgePosture>;
}

/** The BYO template (knowledge design v2 R2, ENG-365): any host endpoint —
 * any language — implementing the `vendo/knowledge-wire@1` routes is a
 * first-class knowledge engine. Partial implementations are first-class too:
 * a search-only endpoint declares the default posture and the optional
 * adapter members are simply absent (`fetch` missing ⇒ read-more gracefully
 * absent; `write: false` ⇒ `vendo knowledge sync` refuses loudly to push).
 * The reference server implementation lives in this package's
 * `cloud.test-util.ts` fake — one handler, wire-schema-validated. */
export function httpKnowledge(options: HttpKnowledgeOptions): KnowledgeAdapter {
  const posture: KnowledgePosture = { ...DEFAULT_POSTURE, ...options.posture };
  const base = options.url.replace(/\/+$/, "");
  const transport = options.fetch ?? fetch;
  const bearer = options.auth?.bearer;

  async function call(path: string, init: { method: "GET" | "POST"; body?: unknown }): Promise<unknown> {
    let response: Response;
    try {
      response = await transport(`${base}${path}`, {
        method: init.method,
        headers: {
          ...(bearer === undefined ? {} : { authorization: `Bearer ${bearer}` }),
          ...(init.body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
        signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
      });
    } catch (error) {
      throw new Error(
        `knowledge endpoint ${base} is unreachable: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
    const body: unknown = await response.json().catch(() => undefined);
    if (!response.ok) throw parseKnowledgeWireError(response.status, body);
    return body;
  }

  const parse = <T>(schema: { safeParse(value: unknown): { success: boolean; data?: unknown } }, value: unknown, route: string): T => {
    const parsed = schema.safeParse(value);
    if (!parsed.success) {
      throw new VendoError("not-implemented", `knowledge endpoint ${base}${route} answered with a body that is not vendo/knowledge-wire@1`);
    }
    return parsed.data as T;
  };

  const includeInternal = (ctx: KnowledgeContext): { includeInternal?: boolean } =>
    ctx.includeInternal === true ? { includeInternal: true } : {};

  const adapter: KnowledgeAdapter = {
    posture,

    async search(query, ctx) {
      const body = await call(KNOWLEDGE_WIRE_PATHS.search, { method: "POST", body: { query, ...includeInternal(ctx) } });
      return parse(knowledgeSearchResultSchema, body, "/search");
    },

    async status(): Promise<KnowledgeStatus> {
      const body = await call(KNOWLEDGE_WIRE_PATHS.status, { method: "GET" });
      return parse<{ status: KnowledgeStatus }>(knowledgeWireStatusSchema, body, "/status").status;
    },
  };

  // Optional members exist exactly when the declared posture covers them
  // (R2: presence is conformance-tested, not promised).
  if (posture.fetch) {
    adapter.fetch = async (ref, ctx) => {
      try {
        const body = await call(KNOWLEDGE_WIRE_PATHS.fetch, { method: "POST", body: { ref, ...includeInternal(ctx) } });
        return parse(knowledgeFetchResultSchema, body, "/fetch");
      } catch (error) {
        // Only the ENVELOPED not-found means document absence; a bare 404
        // already degraded to "not-implemented" in the parser.
        if (error instanceof VendoError && error.code === "not-found") return null;
        throw error;
      }
    };
  }
  if (posture.write) {
    adapter.upsert = async (docs) => {
      await call(KNOWLEDGE_WIRE_PATHS.upsert, { method: "POST", body: { docs } });
    };
    adapter.remove = async (docIds) => {
      await call(KNOWLEDGE_WIRE_PATHS.remove, { method: "POST", body: { docIds } });
    };
  }
  return adapter;
}
