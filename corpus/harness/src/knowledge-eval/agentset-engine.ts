/**
 * An eval-only Agentset engine: a real `KnowledgeAdapter` over a real Agentset
 * namespace, for measuring the shipped tool against the shipped cloud engine
 * from this repo.
 *
 * WHY THIS EXISTS. The knowledge wire lives at the console mount (vendo-web);
 * OSS reaches it through `cloudKnowledge`, which needs a running console. The
 * verifier measurement does not need a console — it needs Agentset's real
 * retrieval behind the real tool. So this module speaks Agentset directly, and
 * MIRRORS the shipped client (`apps/console/lib/knowledge/agentset-client.ts`)
 * in the two places that decide what a search returns:
 *
 *   - the search body: `topK = min(100, max(limit * 2, 20))`, metadata on,
 *     rerank ON for the deep intent and OFF for chat, keyword mode for schema;
 *   - the hit mapping: rows are servable only when they carry our
 *     `vendoDocId` stamp, internal visibility is filtered in-process, and the
 *     caller's limit is applied after filtering.
 *
 * Divergence from the shipped client is deliberate only where it cannot affect
 * a score: no rate budgeting (one harness, well under the 600 rpm org ceiling),
 * no vendor doc-map persistence (the namespace is created and destroyed by one
 * run), no re-upsert or delete-orphan paths (nothing is ever re-ingested).
 */

import type {
  KnowledgeAdapter,
  KnowledgeDoc,
  KnowledgeHit,
  KnowledgeQuery,
  KnowledgeSearchResult,
  KnowledgeStatus,
} from "@vendoai/core";

const AGENTSET_BASE = "https://api.agentset.ai";
const SEARCH_DEFAULT_LIMIT = 10;
/** Docs per ingest job — the corpus is ~360KB, too much for one batch. */
const INGEST_BATCH = 10;
const READY_TIMEOUT_MS = 600_000;
const POLL_MS = 3_000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

const dataOf = (payload: unknown): unknown => asRecord(payload).data;

function errorMessage(payload: unknown): string | undefined {
  const error = asRecord(payload).error;
  if (typeof error === "string") return error;
  const message = asRecord(error).message;
  return typeof message === "string" && message !== "" ? message : undefined;
}

export interface AgentsetRequestResult {
  ok: boolean;
  status: number;
  payload: unknown;
}

export type AgentsetRequest = (
  path: string,
  options?: { method?: string; query?: Record<string, string>; body?: Record<string, unknown> },
) => Promise<AgentsetRequestResult>;

/** The raw client. Throws if the key is absent: a live harness that silently
    measures nothing is worse than one that stops. */
export function agentsetClient(apiKey: string | undefined): AgentsetRequest {
  if (apiKey === undefined || apiKey.trim() === "") {
    throw new Error("AGENTSET_API_KEY is not set — there is nothing live to measure against.");
  }
  return async (path, options = {}) => {
    const url = new URL(`${AGENTSET_BASE}${path}`);
    for (const [key, value] of Object.entries(options.query ?? {})) url.searchParams.set(key, value);
    const response = await fetch(url, {
      method: options.method ?? "GET",
      headers: {
        authorization: `Bearer ${apiKey}`,
        accept: "application/json",
        ...(options.body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      signal: AbortSignal.timeout(120_000),
    });
    const text = await response.text();
    let payload: unknown = {};
    if (text !== "") {
      try {
        payload = JSON.parse(text);
      } catch {
        throw new Error(`Agentset ${path} response was not valid JSON (${response.status})`);
      }
    }
    return { ok: response.ok, status: response.status, payload };
  };
}

export async function createNamespace(request: AgentsetRequest, slug: string, name: string): Promise<string> {
  const created = await request("/v1/namespace", { method: "POST", body: { name, slug } });
  const id = asRecord(dataOf(created.payload)).id;
  if (!created.ok || typeof id !== "string" || id === "") {
    throw new Error(errorMessage(created.payload) ?? `Agentset namespace create failed with ${created.status}`);
  }
  return id;
}

/** The metadata the shipped client stamps — hits map back through it. */
const docMetadata = (doc: KnowledgeDoc): Record<string, string> => ({
  vendoDocId: doc.id,
  kind: doc.kind,
  visibility: doc.visibility,
  title: doc.title,
  source: doc.source,
});

/**
 * Ingest the corpus and resolve only once every document is SEARCHABLE (the
 * wire's upsert semantic): Agentset indexes asynchronously, so each batch's
 * job is polled to COMPLETED. Returns the vendo docId → Agentset document id
 * map the search path filters on.
 */
export async function ingestCorpus(
  request: AgentsetRequest,
  namespaceId: string,
  docs: KnowledgeDoc[],
  onProgress: (done: number, total: number) => void,
): Promise<Map<string, string>> {
  const ns = `/v1/namespace/${encodeURIComponent(namespaceId)}`;
  const byDocId = new Map<string, string>();

  for (let start = 0; start < docs.length; start += INGEST_BATCH) {
    const batch = docs.slice(start, start + INGEST_BATCH);
    const created = await request(`${ns}/ingest-jobs`, {
      method: "POST",
      body: {
        payload: {
          type: "BATCH",
          items: batch.map((doc) => ({
            type: "TEXT",
            text: doc.text,
            fileName: doc.id,
            config: { metadata: docMetadata(doc) },
          })),
        },
      },
    });
    if (!created.ok) {
      throw new Error(errorMessage(created.payload) ?? `Agentset ingest failed with ${created.status}`);
    }
    const job = asRecord(dataOf(created.payload));
    const jobId = job.id;
    if (typeof jobId !== "string" || jobId === "") throw new Error("Agentset ingest response carried no job id");

    const deadline = Date.now() + READY_TIMEOUT_MS;
    let status = typeof job.status === "string" ? job.status : "QUEUED";
    while (status !== "COMPLETED") {
      if (status === "FAILED" || status === "CANCELLED") {
        throw new Error(`Agentset ingest job ${jobId} ${status.toLowerCase()}`);
      }
      if (Date.now() >= deadline) throw new Error(`Agentset ingest job ${jobId} never became searchable`);
      await sleep(POLL_MS);
      const polled = await request(`${ns}/ingest-jobs/${encodeURIComponent(jobId)}`);
      if (!polled.ok) {
        throw new Error(errorMessage(polled.payload) ?? `Agentset ingest poll failed with ${polled.status}`);
      }
      status = typeof asRecord(dataOf(polled.payload)).status === "string"
        ? (asRecord(dataOf(polled.payload)).status as string)
        : status;
    }

    // fileName rides through as the document name, which is how the shipped
    // client recovers the mapping.
    let cursor: string | undefined;
    for (let page = 0; page < 50; page += 1) {
      const listed = await request(`${ns}/documents`, {
        query: { ingestJobId: jobId, perPage: "100", ...(cursor === undefined ? {} : { cursor }) },
      });
      if (!listed.ok) break;
      const body = asRecord(listed.payload);
      for (const raw of Array.isArray(body.data) ? body.data : []) {
        const row = asRecord(raw);
        if (typeof row.id === "string" && typeof row.name === "string" && row.name !== "") {
          byDocId.set(row.name, row.id);
        }
      }
      const pagination = asRecord(body.pagination);
      const next = pagination.nextCursor;
      if (pagination.hasMore !== true || typeof next !== "string" || next === "") break;
      cursor = next;
    }
    onProgress(Math.min(start + INGEST_BATCH, docs.length), docs.length);
  }

  const missing = docs.filter((doc) => !byDocId.has(doc.id));
  if (missing.length > 0) {
    throw new Error(`Agentset ingest returned no document id for ${missing.length} docs (first: ${missing[0]!.id})`);
  }
  return byDocId;
}

/** Delete the namespace and PROVE it is gone by listing. Agentset answers 422
    while a namespace's documents are still being torn down, then 404. */
export async function sweepNamespace(
  request: AgentsetRequest,
  namespaceId: string,
): Promise<{ deleted: boolean; listedStillContainsIt: boolean; namespacesRemaining: number }> {
  const deadline = Date.now() + 120_000;
  let deleted = false;
  let backoffMs = 1_000;
  while (!deleted) {
    const response = await request(`/v1/namespace/${encodeURIComponent(namespaceId)}`, { method: "DELETE" });
    if (response.ok || response.status === 404) {
      deleted = true;
      break;
    }
    if (response.status !== 422 || Date.now() >= deadline) break;
    await sleep(backoffMs);
    backoffMs = Math.min(backoffMs * 2, 5_000);
  }
  const listed = await request("/v1/namespace", { query: { perPage: "100" } });
  const rows = (asRecord(listed.payload).data ?? []) as Array<{ id?: string }>;
  return {
    deleted,
    listedStillContainsIt: Array.isArray(rows) && rows.some((row) => row.id === namespaceId),
    namespacesRemaining: Array.isArray(rows) ? rows.length : -1,
  };
}

/** The adapter the tool composes over. */
export function agentsetEngine(
  request: AgentsetRequest,
  namespaceId: string,
  docIds: Map<string, string>,
): KnowledgeAdapter {
  const ns = `/v1/namespace/${encodeURIComponent(namespaceId)}`;
  return {
    // The eval corpus carries internal-visibility docs, and the adapter
    // filters them in-process, so the posture is the enforcing one — the same
    // posture the shipped cloud engine declares.
    posture: { fetch: false, write: false, visibility: "enforced" },

    async search(query: KnowledgeQuery, ctx): Promise<KnowledgeSearchResult> {
      const limit = query.limit ?? SEARCH_DEFAULT_LIMIT;
      if (query.kinds !== undefined && query.kinds.length === 0) return { hits: [] };
      const response = await request(`${ns}/search`, {
        method: "POST",
        body: {
          query: query.text,
          topK: Math.min(100, Math.max(limit * 2, 20)),
          includeMetadata: true,
          ...(query.intent === "schema" ? { mode: "keyword" } : { rerank: query.intent === "deep" }),
        },
      });
      if (!response.ok) {
        throw new Error(errorMessage(response.payload) ?? `Agentset search failed with ${response.status}`);
      }
      const rows = dataOf(response.payload);
      if (!Array.isArray(rows)) throw new Error("Agentset search response did not contain a data array");

      const hits: KnowledgeHit[] = [];
      for (const raw of rows as Array<Record<string, unknown>>) {
        const metadata = asRecord(raw.metadata);
        const docId = metadata.vendoDocId;
        const kind = metadata.kind;
        const visibility = metadata.visibility;
        if (typeof docId !== "string" || docId === "" || !docIds.has(docId)) continue;
        if (kind !== "docs" && kind !== "glossary" && kind !== "api") continue;
        if (visibility !== "public" && visibility !== "internal") continue;
        if (visibility === "internal" && ctx.includeInternal !== true) continue;
        if (query.kinds !== undefined && !query.kinds.includes(kind)) continue;
        hits.push({
          ref: {
            docId,
            ...(typeof raw.id === "string" && raw.id !== "" ? { chunkId: raw.id } : {}),
            ...(typeof metadata.title === "string" ? { title: metadata.title } : {}),
            ...(typeof metadata.source === "string" ? { source: metadata.source } : {}),
          },
          snippet: typeof raw.text === "string" ? raw.text : "",
          kind,
          visibility,
          ...(typeof raw.score === "number" ? { score: raw.score } : {}),
        });
        if (hits.length >= limit) break;
      }
      return { hits };
    },

    /** The tool consults status() to verify an EMPTY search rather than trust
        it (a sick engine's silence is not a refusal), so this has to be a real
        reachability check, not a constant. */
    async status(): Promise<KnowledgeStatus> {
      const listed = await request(`${ns}/documents`, { query: { perPage: "1" } });
      if (!listed.ok) {
        throw new Error(errorMessage(listed.payload) ?? `Agentset status failed with ${listed.status}`);
      }
      return { docs: docIds.size };
    },
  };
}
