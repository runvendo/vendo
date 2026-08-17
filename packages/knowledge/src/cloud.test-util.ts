import {
  KNOWLEDGE_WIRE_PATHS,
  VENDO_KNOWLEDGE_WIRE_FORMAT,
  isVendoError,
  VendoError,
  knowledgeWireErrorBody,
  knowledgeWireFetchRequestSchema,
  knowledgeWireRemoveRequestSchema,
  knowledgeWireSearchRequestSchema,
  knowledgeWireUpsertRequestSchema,
  type KnowledgeAdapter,
  type KnowledgeContext,
  type KnowledgePosture,
} from "@vendoai/core";
import { memoryKnowledgeAdapter } from "@vendoai/core/conformance";

/** One request the fake saw — tests assert auth rode as a Bearer token and
    that NO tenant selector of any kind crossed the wire. */
export interface RecordedKnowledgeRequest {
  /** Wire path suffix (`/search`); the mount prefix is stripped. */
  path: string;
  method: string;
  authorization: string | null;
  body?: unknown;
}

export interface FakeKnowledgeServerOptions {
  /** The engine behind the wire (default: a fresh memoryKnowledgeAdapter). */
  adapter?: KnowledgeAdapter;
  /** The posture the server declares AND enforces: routes outside it answer
      the `not-implemented` envelope, 501 (never a bare 404). */
  posture?: KnowledgePosture;
  /** When set, requests not carrying `Bearer <token>` get the console-style
      401 (an envelope that is deliberately NOT wire-legal — auth belongs to
      the mounting surface, so clients must fold 401 themselves). */
  bearer?: string;
}

export interface FakeKnowledgeServer {
  /** Drop-in `fetch` for cloudKnowledge/httpKnowledge's injectable transport. */
  fetch: typeof fetch;
  requests: RecordedKnowledgeRequest[];
  adapter: KnowledgeAdapter;
  posture: KnowledgePosture;
}

/**
 * In-process fake of a `vendo/knowledge-wire@1` server — the test double for
 * the cloud client and the REFERENCE implementation the BYO docs
 * point at: everything a conformant wire server must do fits in this one
 * handler. Speaks core's wire schemas verbatim over any KnowledgeAdapter:
 *
 *   1. bodies are validated with the wire request schemas → `validation`, 400;
 *   2. routes the declared posture does not cover → `not-implemented`, 501;
 *   3. adapter `VendoError`s → `knowledgeWireErrorBody` envelopes;
 *   4. a missing/invisible /fetch ref → the enveloped `not-found`, 404
 *      (clients translate ONLY the envelope back to null);
 *   5. GET /status is the discovery handshake: format + posture + counts.
 *
 * The principal never crosses the wire — the server mints a local one and
 * `includeInternal` is the only context-derived behavior that rides in.
 */
export function fakeKnowledgeServer(options: FakeKnowledgeServerOptions = {}): FakeKnowledgeServer {
  const adapter = options.adapter ?? memoryKnowledgeAdapter();
  const posture = options.posture ?? { fetch: true, write: true, visibility: "enforced" };
  const requests: RecordedKnowledgeRequest[] = [];

  const json = (body: unknown, status = 200): Response => Response.json(body, { status });
  const envelope = (error: VendoError): Response => {
    const wire = knowledgeWireErrorBody(error);
    return json(wire.body, wire.status);
  };

  const ctx = (includeInternal: boolean | undefined): KnowledgeContext => ({
    principal: { kind: "user", subject: "user_knowledge_wire_server" },
    ...(includeInternal === true ? { includeInternal: true } : {}),
  });

  const handler = async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const path = Object.values(KNOWLEDGE_WIRE_PATHS).find((wire) => url.pathname.endsWith(wire));
    const body: unknown = request.method === "GET" ? undefined : await request.json().catch(() => undefined);
    requests.push({
      path: path ?? url.pathname,
      method: request.method,
      authorization: request.headers.get("authorization"),
      ...(body === undefined ? {} : { body }),
    });

    if (options.bearer !== undefined && request.headers.get("authorization") !== `Bearer ${options.bearer}`) {
      return json({ error: { code: "unauthorized", message: "Valid API key required." } }, 401);
    }

    try {
      if (path === KNOWLEDGE_WIRE_PATHS.status && request.method === "GET") {
        return json({ format: VENDO_KNOWLEDGE_WIRE_FORMAT, posture, status: await adapter.status() });
      }
      if (path === undefined || request.method !== "POST") {
        return envelope(new VendoError("not-found", `unknown knowledge wire route: ${request.method} ${url.pathname}`));
      }
      if (path === KNOWLEDGE_WIRE_PATHS.search) {
        const parsed = knowledgeWireSearchRequestSchema.safeParse(body);
        if (!parsed.success) return envelope(new VendoError("validation", "search body is not vendo/knowledge-wire@1"));
        return json(await adapter.search(parsed.data.query, ctx(parsed.data.includeInternal)));
      }
      if (path === KNOWLEDGE_WIRE_PATHS.fetch) {
        if (!posture.fetch) return envelope(new VendoError("not-implemented", "this knowledge endpoint does not implement /fetch"));
        const parsed = knowledgeWireFetchRequestSchema.safeParse(body);
        if (!parsed.success) return envelope(new VendoError("validation", "fetch body is not vendo/knowledge-wire@1"));
        const fetched = await adapter.fetch?.(parsed.data.ref, ctx(parsed.data.includeInternal));
        if (fetched === null || fetched === undefined) {
          return envelope(new VendoError("not-found", `no readable document for ref ${parsed.data.ref.docId}`));
        }
        return json(fetched);
      }
      if (path === KNOWLEDGE_WIRE_PATHS.upsert) {
        if (!posture.write) return envelope(new VendoError("not-implemented", "this knowledge endpoint is read-only (posture.write: false)"));
        const parsed = knowledgeWireUpsertRequestSchema.safeParse(body);
        if (!parsed.success) return envelope(new VendoError("validation", "upsert body is not vendo/knowledge-wire@1"));
        // MUST NOT answer before the docs are searchable: awaiting the
        // adapter's upsert is exactly that contract.
        await adapter.upsert?.(parsed.data.docs);
        return json({});
      }
      if (path === KNOWLEDGE_WIRE_PATHS.remove) {
        if (!posture.write) return envelope(new VendoError("not-implemented", "this knowledge endpoint is read-only (posture.write: false)"));
        const parsed = knowledgeWireRemoveRequestSchema.safeParse(body);
        if (!parsed.success) return envelope(new VendoError("validation", "remove body is not vendo/knowledge-wire@1"));
        await adapter.remove?.(parsed.data.docIds);
        return json({});
      }
      return envelope(new VendoError("not-found", `unknown knowledge wire route: ${url.pathname}`));
    } catch (error) {
      if (isVendoError(error)) return envelope(error);
      return json({ error: { message: error instanceof Error ? error.message : String(error) } }, 500);
    }
  };

  return { fetch: handler as typeof fetch, requests, adapter, posture };
}
