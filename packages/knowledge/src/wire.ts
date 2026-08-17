import {
  KNOWLEDGE_WIRE_PATHS,
  isVendoError,
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

/** How one client names its own failures. Everything else about speaking
    `vendo/knowledge-wire@1` is identical for Cloud and BYO, so this is the
    whole difference between them. */
export interface WireErrors {
  /** The transport never answered. */
  unreachable: (cause: unknown) => Error;
  /** Consulted before the wire's status mapping, for statuses this client
      reads as its own (Cloud folds any 401 into a key problem, whatever the
      response body claims). Return undefined to fall through. */
  rejected?: (status: number) => Error | undefined;
  /** 2xx with a body that is not the wire. */
  badBody: (route: string) => Error;
}

export interface WireClientOptions {
  /** The five wire paths are appended directly to this base. */
  base: string;
  bearer?: string;
  posture: KnowledgePosture;
  fetch?: typeof fetch;
  errors: WireErrors;
}

/** The one `vendo/knowledge-wire@1` client. Both shipped engines are this
    function plus a base url, a bearer, a posture and an error flavour, so a
    retry, a header or a status mapping is added in exactly one place.

    Optional members exist exactly when the declared posture covers them
    (presence is conformance-tested, not promised) — a full-posture caller gets
    fetch/upsert/remove, a search-only endpoint's adapter simply lacks them. */
export function knowledgeWireAdapter(options: WireClientOptions): KnowledgeAdapter {
  const { base, bearer, posture, errors } = options;
  const transport = options.fetch ?? fetch;

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
      throw errors.unreachable(error);
    }
    const body: unknown = await response.json().catch(() => undefined);
    const rejected = errors.rejected?.(response.status);
    if (rejected !== undefined) throw rejected;
    if (!response.ok) throw parseKnowledgeWireError(response.status, body);
    return body;
  }

  const parse = <T>(
    schema: { safeParse(value: unknown): { success: boolean; data?: unknown } },
    value: unknown,
    route: string,
  ): T => {
    const parsed = schema.safeParse(value);
    if (!parsed.success) throw errors.badBody(route);
    return parsed.data as T;
  };

  const includeInternal = (ctx: KnowledgeContext): { includeInternal?: boolean } =>
    ctx.includeInternal === true ? { includeInternal: true } : {};

  const adapter: KnowledgeAdapter = {
    posture,

    async search(query, ctx) {
      const body = await call(KNOWLEDGE_WIRE_PATHS.search, { method: "POST", body: { query, ...includeInternal(ctx) } });
      return parse(knowledgeSearchResultSchema, body, KNOWLEDGE_WIRE_PATHS.search);
    },

    async status(): Promise<KnowledgeStatus> {
      const body = await call(KNOWLEDGE_WIRE_PATHS.status, { method: "GET" });
      return parse<{ status: KnowledgeStatus }>(knowledgeWireStatusSchema, body, KNOWLEDGE_WIRE_PATHS.status).status;
    },
  };

  if (posture.fetch) {
    adapter.fetch = async (ref, ctx) => {
      try {
        const body = await call(KNOWLEDGE_WIRE_PATHS.fetch, { method: "POST", body: { ref, ...includeInternal(ctx) } });
        return parse(knowledgeFetchResultSchema, body, KNOWLEDGE_WIRE_PATHS.fetch);
      } catch (error) {
        // Only an ENVELOPED not-found means document absence; a bare 404
        // already degraded to "not-implemented" in the parser — the
        // hosted-store lesson: a missing mount must not read as absence.
        if (isVendoError(error) && error.code === "not-found") return null;
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
