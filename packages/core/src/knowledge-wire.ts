import { z } from "zod";
import { VendoError, safeErrorMessage, vendoErrorCodeSchema, type VendoErrorCode } from "./errors.js";
import { formatMeterExhausted, parseMeterExhausted } from "./meter-exhausted.js";
import {
  knowledgeDocSchema,
  knowledgePostureSchema,
  knowledgeQuerySchema,
  knowledgeRefSchema,
  knowledgeStatusSchema,
  type KnowledgeDoc,
  type KnowledgePosture,
  type KnowledgeQuery,
  type KnowledgeRef,
  type KnowledgeStatus,
} from "./knowledge.js";

/** Knowledge design v2 (2026-07-22) R2 — the wire protocol version tag. The
    HTTP profile of the KnowledgeAdapter contract, shared verbatim by the
    cloud client and the BYO `httpKnowledge` template (decision 2026-07-24:
    two cloud backend adapters sit BEHIND this protocol — nothing
    backend-specific may appear on the wire). */
export const VENDO_KNOWLEDGE_WIRE_FORMAT = "vendo/knowledge-wire@1" as const;

/** Mount-relative endpoint paths. The mounting surface owns the prefix
    (cloud: `<console>/api/v1/knowledge`; BYO: the `httpKnowledge` url) and
    owns auth — the protocol itself is auth-agnostic and carries NO tenant
    selector of any kind (R5 invariant 1: tenancy derives server-side).
    Verbs: the four adapter operations are POST-JSON RPC; `status` is GET and
    doubles as the discovery handshake (format + posture). Requests to an
    endpoint the declared posture does not cover (POST /upsert or /remove on
    `write: false`, POST /fetch on `fetch: false`) are answered with the
    `not-implemented` envelope, 501 — never a bare 404, never `blocked`.
    Servers validate request bodies against the schemas in this module and
    answer schema-invalid bodies with the `validation` envelope, 400. The
    principal deliberately never crosses the wire — visibility is the only
    context-derived behavior, and it rides `includeInternal`. */
export const KNOWLEDGE_WIRE_PATHS = {
  search: "/search",
  fetch: "/fetch",
  upsert: "/upsert",
  remove: "/remove",
  status: "/status",
} as const;

/** POST /search — the wire form of `search(query, ctx)`. Response body on
    200: a `KnowledgeSearchResult` (see knowledge.js) — hits ordered
    most-relevant-first, refs carrying doc-id + opaque chunk-id.
    `includeInternal` is legitimate on the wire ONLY because every mounting
    surface is a key-authed, host-trusted hop (R5, KB-COV-7): the OSS
    composition enforces the trusted-caller rule BEFORE the request leaves
    the process, and the server trusts the flag because the bearer key
    already proves the caller is host code, never an end user. */
export interface KnowledgeWireSearchRequest {
  query: KnowledgeQuery;
  includeInternal?: boolean;
}

export const knowledgeWireSearchRequestSchema = z.object({
  query: knowledgeQuerySchema,
  includeInternal: z.boolean().optional(),
}).passthrough() satisfies z.ZodType<KnowledgeWireSearchRequest>;

/** POST /fetch — the wire form of `fetch(ref, ctx)`. A missing or
    internal-invisible ref is answered with the 404 error envelope, which
    clients translate back to the contract's `null` (a ref is not a
    capability — internal docs behave as unknown without `includeInternal`).
    Clients MUST require the envelope for that translation: only an
    enveloped `not-found` means `null`; a bare 404 with no parseable envelope
    is a mount/deployment failure and must surface as an error, never as
    `null` (the hosted-store bare-404 lesson). Response body on 200: a
    `KnowledgeFetchResult` (see knowledge.js). */
export interface KnowledgeWireFetchRequest {
  ref: KnowledgeRef;
  includeInternal?: boolean;
}

export const knowledgeWireFetchRequestSchema = z.object({
  ref: knowledgeRefSchema,
  includeInternal: z.boolean().optional(),
}).passthrough() satisfies z.ZodType<KnowledgeWireFetchRequest>;

/** POST /upsert — document-level, engines own chunking. The 200 response is
    an empty JSON object and MUST NOT be sent before the documents are
    searchable (the contract's upsert-resolves-when-searchable semantic —
    backends with asynchronous indexing await it server-side). */
export interface KnowledgeWireUpsertRequest {
  docs: KnowledgeDoc[];
}

export const knowledgeWireUpsertRequestSchema = z.object({
  docs: z.array(knowledgeDocSchema),
}).passthrough() satisfies z.ZodType<KnowledgeWireUpsertRequest>;

/** POST /remove — unknown ids resolve as no-ops; 200 is an empty object. */
export interface KnowledgeWireRemoveRequest {
  docIds: string[];
}

export const knowledgeWireRemoveRequestSchema = z.object({
  docIds: z.array(z.string().min(1)),
}).passthrough() satisfies z.ZodType<KnowledgeWireRemoveRequest>;

/** GET /status — the discovery handshake. Clients learn the protocol
    version (`format`), the declared capability posture, and the corpus
    counts in one round-trip; the posture here is the same declaration the
    conformance suite verifies (knowledge design v2 R2). */
export interface KnowledgeWireStatus {
  format: typeof VENDO_KNOWLEDGE_WIRE_FORMAT;
  posture: KnowledgePosture;
  status: KnowledgeStatus;
}

export const knowledgeWireStatusSchema = z.object({
  format: z.literal(VENDO_KNOWLEDGE_WIRE_FORMAT),
  posture: knowledgePostureSchema,
  status: knowledgeStatusSchema,
}).passthrough() satisfies z.ZodType<KnowledgeWireStatus>;

/** The standard wire error envelope — byte-identical to the umbrella wire's
    (`packages/vendo/src/wire/shared.ts`): `{ error: { code, message } }`. */
export interface KnowledgeWireError {
  error: {
    code: VendoErrorCode;
    message: string;
  };
}

export const knowledgeWireErrorSchema = z.object({
  error: z.object({
    code: vendoErrorCodeSchema,
    message: z.string(),
  }).passthrough(),
}).passthrough() satisfies z.ZodType<KnowledgeWireError>;

/** Mirrors the umbrella wire's STATUS_BY_CODE so the two surfaces never
    diverge; core cannot import it (layering — core depends on nothing). */
export const KNOWLEDGE_WIRE_STATUS_BY_CODE: Record<VendoErrorCode, number> = {
  validation: 400,
  "not-found": 404,
  blocked: 403,
  forbidden: 403,
  conflict: 409,
  "cloud-required": 402,
  "sandbox-unavailable": 501,
  "not-implemented": 501,
  // Table entry only: `unavailable` is a store-wire concern (a transient
  // dependency failure server-side). This wire's own STATUS_TO_CODE is
  // untouched — a bare 5xx/429 here still degrades to "not-implemented",
  // unchanged by this slice.
  unavailable: 503,
};

/** 404 is deliberately absent: only an ENVELOPED `not-found` may become the
    document-absence code (the /fetch 404→null translation). A bare 404 is a
    mount/deployment failure and degrades to "not-implemented" so it surfaces
    as an error instead of silently reading as an empty corpus. */
const STATUS_TO_CODE: Record<number, VendoErrorCode> = {
  400: "validation",
  402: "cloud-required",
  403: "blocked",
  409: "conflict",
};

/** Server half: one VendoError → the enveloped body + HTTP status. */
export function knowledgeWireErrorBody(error: VendoError): { status: number; body: KnowledgeWireError } {
  return {
    status: KNOWLEDGE_WIRE_STATUS_BY_CODE[error.code],
    body: { error: { code: error.code, message: safeErrorMessage(error) } },
  };
}

/** Client half: a non-2xx response → VendoError. An enveloped wire-legal
    code wins over the bare status; recognized statuses map through
    STATUS_TO_CODE; anything else degrades to "not-implemented" (never blame
    the caller with "validation" for a server-shaped failure). Client-specific
    tails — e.g. the cloud client folding bare 401 into "cloud-required" —
    belong to the client (ENG-364), not the protocol. */
export function parseKnowledgeWireError(status: number, body: unknown): VendoError {
  // The pool refusal wins: it is the ONE crafted sentence every Vendo surface
  // prints, and this door used to swallow it into a generic 402.
  const refusal = parseMeterExhausted(body);
  if (refusal !== undefined) {
    return new VendoError("cloud-required", formatMeterExhausted(refusal));
  }
  const parsed = knowledgeWireErrorSchema.safeParse(body);
  if (parsed.success) {
    return new VendoError(parsed.data.error.code, parsed.data.error.message);
  }
  const code = STATUS_TO_CODE[status];
  if (code !== undefined) {
    return new VendoError(code, `knowledge wire request failed with HTTP ${status}`);
  }
  return new VendoError("not-implemented", `knowledge wire request failed with HTTP ${status}`);
}
