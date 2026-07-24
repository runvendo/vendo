import { z } from "zod";
import { isoDateTimeSchema, type IsoDateTime } from "./ids.js";
import { principalSchema, type Principal } from "./principal.js";

/** Knowledge design v2 (2026-07-22) R1 — the doc-hash manifest version tag. */
export const VENDO_KNOWLEDGE_HASH_FORMAT = "vendo/knowledge-hash@1" as const;

/** Knowledge design v2 (2026-07-22) R1 — the two content shapes that must not
    be flattened: prose (`docs`) for semantic retrieval; structured facts
    (`glossary`, `api`) for exact lookup. */
export type KnowledgeKind = "docs" | "glossary" | "api";

export const knowledgeKindSchema = z.enum(["docs", "glossary", "api"]) satisfies z.ZodType<KnowledgeKind>;

/** Knowledge design v2 (2026-07-22) R5 — a NEW, knowledge-only label; no
    general per-document visibility system exists elsewhere. */
export type KnowledgeVisibility = "public" | "internal";

export const knowledgeVisibilitySchema = z.enum(["public", "internal"]) satisfies z.ZodType<KnowledgeVisibility>;

/** Knowledge design v2 (2026-07-22) R1 — the unit adapters ingest. Upsert is
    DOCUMENT-level: chunking belongs to the engine behind the contract, so a
    doc carries normalized text, never chunks. */
export interface KnowledgeDoc {
  /** Stable host-side id — the upsert/remove key and the citation anchor. */
  id: string;
  kind: KnowledgeKind;
  visibility: KnowledgeVisibility;
  title: string;
  /** Parsed, normalized text. Engines own chunking/embedding/indexing. */
  text: string;
  /** Source identity, e.g. a repo-relative path or connector URI. */
  source: string;
  metadata?: Record<string, string>;
  updatedAt?: IsoDateTime;
}

export const knowledgeDocSchema = z.object({
  id: z.string().min(1),
  kind: knowledgeKindSchema,
  visibility: knowledgeVisibilitySchema,
  title: z.string(),
  text: z.string(),
  source: z.string().min(1),
  metadata: z.record(z.string()).optional(),
  updatedAt: isoDateTimeSchema.optional(),
}).passthrough() satisfies z.ZodType<KnowledgeDoc>;

/** Knowledge design v2 (2026-07-22) R4 + spike verdict (ENG-357, 2026-07-23):
    citation-grade refs are doc-id + an engine-scoped opaque chunk id — no
    provider documents page/offset precision, so the contract does not promise
    it. `fetch(ref)` accepts a ref with or without `chunkId`. */
export interface KnowledgeRef {
  docId: string;
  /** Opaque to callers; meaningful only to the engine that minted it. */
  chunkId?: string;
  title?: string;
  source?: string;
}

export const knowledgeRefSchema = z.object({
  docId: z.string().min(1),
  chunkId: z.string().optional(),
  title: z.string().optional(),
  source: z.string().optional(),
}).passthrough() satisfies z.ZodType<KnowledgeRef>;

/** Knowledge design v2 (2026-07-22) R3 — the mode selector. `chat` = fast
    retrieval; `deep` = agentic search (engines without it treat as `chat`);
    `schema` = exact lookup over glossary/api rows — empty hits mean an honest
    not-found, never a fuzzy fallback. */
export type KnowledgeIntent = "chat" | "deep" | "schema";

export const knowledgeIntentSchema = z.enum(["chat", "deep", "schema"]) satisfies z.ZodType<KnowledgeIntent>;

/** Knowledge design v2 (2026-07-22) R2. The contract carries NO tenant
    selector: tenancy is derived server-side by whichever composition wires the
    adapter (R5 invariant 1, confirmed by the spike across every provider). */
export interface KnowledgeQuery {
  text: string;
  /** Defaults to "chat" when absent. */
  intent?: KnowledgeIntent;
  kinds?: KnowledgeKind[];
  limit?: number;
}

export const knowledgeQuerySchema = z.object({
  text: z.string().min(1),
  intent: knowledgeIntentSchema.optional(),
  kinds: z.array(knowledgeKindSchema).optional(),
  limit: z.number().int().positive().optional(),
}).passthrough() satisfies z.ZodType<KnowledgeQuery>;

/** Knowledge design v2 (2026-07-22) R5, review fix KB-COV-7: `includeInternal`
    is settable ONLY by trusted host-wired composition code (dev-rider wiring,
    host-registered automations, direct backend calls) and never derived from
    any request property. Absent means public-only on every
    principal-carrying path. */
export interface KnowledgeContext {
  principal: Principal;
  includeInternal?: boolean;
}

export const knowledgeContextSchema = z.object({
  principal: principalSchema,
  includeInternal: z.boolean().optional(),
}).passthrough() satisfies z.ZodType<KnowledgeContext>;

/** Knowledge design v2 (2026-07-22) R3/R4. */
export interface KnowledgeHit {
  ref: KnowledgeRef;
  snippet: string;
  kind: KnowledgeKind;
  visibility: KnowledgeVisibility;
  score?: number;
}

export const knowledgeHitSchema = z.object({
  ref: knowledgeRefSchema,
  snippet: z.string(),
  kind: knowledgeKindSchema,
  visibility: knowledgeVisibilitySchema,
  score: z.number().optional(),
}).passthrough() satisfies z.ZodType<KnowledgeHit>;

export interface KnowledgeSearchResult {
  hits: KnowledgeHit[];
}

export const knowledgeSearchResultSchema = z.object({
  hits: z.array(knowledgeHitSchema),
}).passthrough() satisfies z.ZodType<KnowledgeSearchResult>;

/** Knowledge design v2 (2026-07-22) R3 — read-more: expanded context around a
    ref, up to the whole doc; sizing against the tool-output cap is the
    CALLER's concern, not the adapter's. */
export interface KnowledgeFetchResult {
  ref: KnowledgeRef;
  text: string;
  truncated?: boolean;
}

export const knowledgeFetchResultSchema = z.object({
  ref: knowledgeRefSchema,
  text: z.string(),
  truncated: z.boolean().optional(),
}).passthrough() satisfies z.ZodType<KnowledgeFetchResult>;

/** Knowledge design v2 (2026-07-22) R1/R4 — status() is the unified read-back
    across ingestion paths; the prompt index is built from it. */
export interface KnowledgeStatus {
  docs: number;
  byKind?: Partial<Record<KnowledgeKind, number>>;
  lastSyncAt?: IsoDateTime;
}

export const knowledgeStatusSchema = z.object({
  docs: z.number().int().nonnegative(),
  byKind: z.record(knowledgeKindSchema, z.number().int().nonnegative()).optional(),
  lastSyncAt: isoDateTimeSchema.optional(),
}).passthrough() satisfies z.ZodType<KnowledgeStatus>;

/** Knowledge design v2 (2026-07-22) R2 — the declared capability posture.
    `search` and `status` are required of every adapter and therefore not
    declared; the posture names the optional halves. `public-only` is the
    host's attestation that the corpus carries no `internal` content. */
export interface KnowledgePosture {
  fetch: boolean;
  write: boolean;
  visibility: "enforced" | "public-only";
}

export const knowledgePostureSchema = z.object({
  fetch: z.boolean(),
  write: z.boolean(),
  visibility: z.enum(["enforced", "public-only"]),
}).passthrough() satisfies z.ZodType<KnowledgePosture>;

/** Knowledge design v2 (2026-07-22) R2 — the seam all three engines (local,
    cloud, BYO HTTP template) implement. Optional members are present exactly
    when the posture declares them (conformance-tested, not promised). */
export interface KnowledgeAdapter {
  posture: KnowledgePosture;
  search(query: KnowledgeQuery, ctx: KnowledgeContext): Promise<KnowledgeSearchResult>;
  /** Present iff `posture.fetch`. Null for an unknown ref. */
  fetch?(ref: KnowledgeRef, ctx: KnowledgeContext): Promise<KnowledgeFetchResult | null>;
  /** Present iff `posture.write`. Document-level; engines own chunking. */
  upsert?(docs: KnowledgeDoc[]): Promise<void>;
  /** Present iff `posture.write`. */
  remove?(docIds: string[]): Promise<void>;
  status(): Promise<KnowledgeStatus>;
}

/** Knowledge design v2 (2026-07-22) R1 — local-engine internal: one chunk of a
    structurally chunked doc. Frozen here, consumed only by the local engine;
    the cloud engine never sees it. */
export interface KnowledgeChunk {
  docId: string;
  /** Stable within (docId, chunker version) — the citation chunk anchor. */
  chunkId: string;
  text: string;
  index: number;
  heading?: string;
}

export const knowledgeChunkSchema = z.object({
  docId: z.string().min(1),
  chunkId: z.string().min(1),
  text: z.string(),
  index: z.number().int().nonnegative(),
  heading: z.string().optional(),
}).passthrough() satisfies z.ZodType<KnowledgeChunk>;

/** Knowledge design v2 (2026-07-22) R1 — structural chunking only in v1
    (semantic chunking cut 2026-07-22). Bumping `version` obliges the local
    engine to re-chunk stored docs (the engine owns re-index versioning). */
export interface KnowledgeChunker {
  version: number;
  chunk(doc: KnowledgeDoc): KnowledgeChunk[];
}

/** Knowledge design v2 (2026-07-22) R3 — the minimal embedding client: exists
    solely because hybrid RRF needs a vector list to fuse. Local-engine
    internal; Anthropic-only hosts never invoke it. A changed `model` obliges
    re-embedding from stored docs. */
export interface KnowledgeEmbedder {
  model: string;
  embed(texts: string[]): Promise<number[][]>;
}

/** Knowledge design v2 (2026-07-22) R1 — sync's doc-level content-hash
    manifest: which documents changed → re-upsert/remove. Persisted host-side
    in the store's meta area, engine-independent; sync owns it for every
    source it moves. */
export interface KnowledgeHashManifest {
  format: typeof VENDO_KNOWLEDGE_HASH_FORMAT;
  /** `sha256:<64 hex>` content hash per doc id. */
  docs: Record<string, string>;
  updatedAt: IsoDateTime;
}

export const knowledgeHashManifestSchema = z.object({
  format: z.literal(VENDO_KNOWLEDGE_HASH_FORMAT),
  docs: z.record(z.string().regex(/^sha256:[0-9a-f]{64}$/)),
  updatedAt: isoDateTimeSchema,
}).passthrough() satisfies z.ZodType<KnowledgeHashManifest>;
