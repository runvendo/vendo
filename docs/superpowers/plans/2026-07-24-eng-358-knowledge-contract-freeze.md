# ENG-358 Knowledge Contract Freeze Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Freeze the `KnowledgeAdapter` seam in `@vendoai/core` — adapter contract + capability posture, chunker/embedder interfaces, doc-hash manifest schema — with a posture-adaptive conformance kit that compiles and runs green against an in-memory stub (the ENG-358 gate).

**Architecture:** One new contract module `packages/core/src/knowledge.ts` (types + zod schemas, mirroring `store.ts`/`capability-miss.ts` conventions), plus a conformance kit `packages/core/src/conformance/knowledge.ts` and stub `packages/core/src/conformance/memory-knowledge.ts` (mirroring the `memoryStoreAdapter` precedent). No runtime code beyond the stub; engines land in Stage 2 behind this contract.

**Tech Stack:** TypeScript 5.6, zod ^3.25 (core's only dependency — add nothing), vitest 2.1, ESM with `.js` import suffixes.

## Global Constraints

- Working tree: `C:\Vendo\New_Vendo_Workspace\vendo` on branch `amr/eng-358-s0-contract-freeze-knowledgeadapter-chunkerembedder` (in-place branch — no worktrees). Never commit to `main`.
- Run all pnpm commands from PowerShell with `$env:PATH = "C:\Users\kille\bin;$env:PATH"` prepended (pnpm.exe lives there; Git Bash's GNU tar breaks the packaging e2e).
- Only `packages/core` changes (plus this plan file and a changeset). Dependency-guard: `@vendoai/core` imports NOTHING from other `@vendoai/*` packages.
- Schema conventions (copy exactly): interface first, then `export const xSchema = z.object({...}).passthrough() satisfies z.ZodType<X>;` — `.passthrough()` on every object schema (01-core §15 additive tolerance), `satisfies` not `as` (except discriminated unions, which need `as unknown as z.ZodType<T>` — see `capability-miss.ts:71`).
- Doc comments cite the decision record: `/** Knowledge design v2 (2026-07-22) R<n>. */` — there is no `docs/contracts/` section number for knowledge; the design doc is the reference.
- All imports inside core use relative paths with `.js` suffix. Tests import from `./index.js` / `../index.js`, not from sibling module files, mirroring `capability-miss.test.ts`.
- Commit messages: `feat(core): …` / `test(core): …` style (repo convention), each ending with the line `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- Conformance-kit circularity rule: `conformance/knowledge.ts` may import `ConformanceCase`/`ConformanceSuite` from `./index.js` **as `import type` only** (erased at compile time — no runtime cycle).
- Spike-verdict constraints baked into the contract (ENG-357 comment, 2026-07-23): citation refs are **doc-id + opaque chunk-id** (no page/offset fields); the contract carries **no tenant selector of any kind** (tenancy is server-side, out of contract); `schema` intent is an honest exact-lookup mode (empty hits = not found, never fuzzy fallback).

---

### Task 1: The contract module — types, schemas, format constant

**Files:**
- Create: `packages/core/src/knowledge.ts`
- Create: `packages/core/src/knowledge.test.ts`
- Modify: `packages/core/src/index.ts` (add one export line between `./jcs.js` and `./kit/index.js`)

**Interfaces:**
- Consumes: `isoDateTimeSchema`, `IsoDateTime` from `./ids.js`; `principalSchema`, `Principal` from `./principal.js`.
- Produces (later tasks + ENG-359/361/363/364/365 rely on these exact names): `KnowledgeKind`, `KnowledgeVisibility`, `KnowledgeDoc`, `KnowledgeRef`, `KnowledgeIntent`, `KnowledgeQuery`, `KnowledgeContext`, `KnowledgeHit`, `KnowledgeSearchResult`, `KnowledgeFetchResult`, `KnowledgeStatus`, `KnowledgePosture`, `KnowledgeAdapter`, `KnowledgeChunk`, `KnowledgeChunker`, `KnowledgeEmbedder`, `KnowledgeHashManifest`, `VENDO_KNOWLEDGE_HASH_FORMAT`, and schemas `knowledgeDocSchema`, `knowledgeRefSchema`, `knowledgeQuerySchema`, `knowledgeContextSchema`, `knowledgeHitSchema`, `knowledgeSearchResultSchema`, `knowledgeFetchResultSchema`, `knowledgeStatusSchema`, `knowledgePostureSchema`, `knowledgeChunkSchema`, `knowledgeHashManifestSchema`.

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/knowledge.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import {
  VENDO_KNOWLEDGE_HASH_FORMAT,
  knowledgeDocSchema,
  knowledgeHashManifestSchema,
  knowledgePostureSchema,
  knowledgeQuerySchema,
  knowledgeSearchResultSchema,
  type KnowledgeDoc,
  type KnowledgeHashManifest,
  type KnowledgeSearchResult,
} from "./index.js";

const doc: KnowledgeDoc = {
  id: "doc_refunds",
  kind: "docs",
  visibility: "public",
  title: "Refund policy",
  text: "Refunds are processed within 5 business days.",
  source: "help/refunds.md",
};

describe("vendo knowledge contract", () => {
  it("parses a well-formed KnowledgeDoc and rejects a bad visibility", () => {
    expect(knowledgeDocSchema.parse(doc)).toMatchObject({ id: "doc_refunds" });
    expect(knowledgeDocSchema.safeParse({ ...doc, visibility: "secret" }).success).toBe(false);
  });

  it("rejects an empty query text and accepts the three intents", () => {
    expect(knowledgeQuerySchema.safeParse({ text: "" }).success).toBe(false);
    for (const intent of ["chat", "deep", "schema"] as const) {
      expect(knowledgeQuerySchema.parse({ text: "refunds", intent }).intent).toBe(intent);
    }
    expect(knowledgeQuerySchema.safeParse({ text: "refunds", intent: "rerank" }).success).toBe(false);
  });

  it("parses a search result whose refs carry doc-id + opaque chunk-id only", () => {
    const result: KnowledgeSearchResult = {
      hits: [{
        ref: { docId: "doc_refunds", chunkId: "doc_refunds#2" },
        snippet: "Refunds are processed within 5 business days.",
        kind: "docs",
        visibility: "public",
        score: 0.87,
      }],
    };
    expect(knowledgeSearchResultSchema.parse(result).hits).toHaveLength(1);
  });

  it("constrains posture visibility to enforced | public-only", () => {
    expect(knowledgePostureSchema.parse({ fetch: true, write: true, visibility: "enforced" }).write).toBe(true);
    expect(knowledgePostureSchema.safeParse({ fetch: false, write: false, visibility: "partial" }).success).toBe(false);
  });

  it("parses the doc-hash manifest and rejects a malformed hash value", () => {
    const manifest: KnowledgeHashManifest = {
      format: VENDO_KNOWLEDGE_HASH_FORMAT,
      docs: { doc_refunds: `sha256:${"a".repeat(64)}` },
      updatedAt: "2026-07-24T12:00:00.000Z",
    };
    expect(VENDO_KNOWLEDGE_HASH_FORMAT).toBe("vendo/knowledge-hash@1");
    expect(knowledgeHashManifestSchema.parse(manifest).docs.doc_refunds).toMatch(/^sha256:/);
    expect(knowledgeHashManifestSchema.safeParse({ ...manifest, docs: { doc_refunds: "md5:beef" } }).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run (from the worktree root): `pnpm --filter @vendoai/core exec vitest run src/knowledge.test.ts`
Expected: FAIL — `knowledge.test.ts` cannot resolve the new exports (they do not exist yet).

- [ ] **Step 3: Write the contract module**

Create `packages/core/src/knowledge.ts`:

```typescript
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
```

Then add the export to `packages/core/src/index.ts` — after the `export * from "./jcs.js";` line and before `export * from "./kit/index.js";`:

```typescript
export * from "./knowledge.js";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @vendoai/core exec vitest run src/knowledge.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/knowledge.ts packages/core/src/knowledge.test.ts packages/core/src/index.ts
git commit -m "feat(core): freeze the KnowledgeAdapter contract — posture, chunker/embedder interfaces, doc-hash manifest (ENG-358)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: The in-memory stub adapter

**Files:**
- Create: `packages/core/src/conformance/memory-knowledge.ts`
- Create: `packages/core/src/conformance/memory-knowledge.test.ts`

**Interfaces:**
- Consumes: `KnowledgeAdapter`, `KnowledgeDoc`, `KnowledgeContext`, `KnowledgeHit`, `KnowledgeQuery` types + no runtime imports beyond `../index.js`.
- Produces: `memoryKnowledgeAdapter(options?: MemoryKnowledgeAdapterOptions): KnowledgeAdapter` where `MemoryKnowledgeAdapterOptions = { docs?: KnowledgeDoc[] }`. Full posture `{ fetch: true, write: true, visibility: "enforced" }`. Task 3's kit and every future engine test double rely on this factory.

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/conformance/memory-knowledge.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import type { KnowledgeContext, KnowledgeDoc } from "../index.js";
import { memoryKnowledgeAdapter } from "./index.js";

const publicDoc: KnowledgeDoc = {
  id: "doc_pub",
  kind: "docs",
  visibility: "public",
  title: "Refund policy",
  text: "Refunds are processed within 5 business days.",
  source: "help/refunds.md",
};
const internalDoc: KnowledgeDoc = {
  id: "doc_int",
  kind: "glossary",
  visibility: "internal",
  title: "Chargeback runbook",
  text: "Internal chargeback escalation contacts.",
  source: "internal/chargebacks.md",
};
const ctx: KnowledgeContext = { principal: { kind: "user", subject: "user_stub" } };

describe("memoryKnowledgeAdapter", () => {
  it("filters internal docs unless the context says includeInternal", async () => {
    const adapter = memoryKnowledgeAdapter({ docs: [publicDoc, internalDoc] });
    const defaultHits = (await adapter.search({ text: "chargeback" }, ctx)).hits;
    expect(defaultHits).toHaveLength(0);
    const internalHits = (await adapter.search({ text: "chargeback" }, { ...ctx, includeInternal: true })).hits;
    expect(internalHits.map((hit) => hit.ref.docId)).toEqual(["doc_int"]);
  });

  it("round-trips upsert → search → fetch → remove", async () => {
    const adapter = memoryKnowledgeAdapter();
    await adapter.upsert?.([publicDoc]);
    const hit = (await adapter.search({ text: "refunds" }, ctx)).hits[0];
    expect(hit?.ref.docId).toBe("doc_pub");
    const fetched = await adapter.fetch?.(hit!.ref, ctx);
    expect(fetched?.text).toContain("5 business days");
    await adapter.remove?.(["doc_pub"]);
    expect((await adapter.search({ text: "refunds" }, ctx)).hits).toHaveLength(0);
    expect(await adapter.fetch?.({ docId: "doc_pub" }, ctx)).toBeNull();
  });

  it("respects kinds and limit, and reports status counts", async () => {
    const adapter = memoryKnowledgeAdapter({ docs: [publicDoc, internalDoc] });
    const kindHits = (await adapter.search({ text: "chargeback", kinds: ["docs"] }, { ...ctx, includeInternal: true })).hits;
    expect(kindHits).toHaveLength(0);
    const limited = (await adapter.search({ text: "e", limit: 1 }, { ...ctx, includeInternal: true })).hits;
    expect(limited.length).toBeLessThanOrEqual(1);
    const status = await adapter.status();
    expect(status.docs).toBe(2);
    expect(status.byKind).toMatchObject({ docs: 1, glossary: 1 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @vendoai/core exec vitest run src/conformance/memory-knowledge.test.ts`
Expected: FAIL — `memoryKnowledgeAdapter` is not exported from `./index.js`.

- [ ] **Step 3: Write the stub**

Create `packages/core/src/conformance/memory-knowledge.ts`:

```typescript
import type {
  KnowledgeAdapter,
  KnowledgeContext,
  KnowledgeDoc,
  KnowledgeHit,
  KnowledgeQuery,
} from "../index.js";

export interface MemoryKnowledgeAdapterOptions {
  docs?: KnowledgeDoc[];
}

const SNIPPET_RADIUS = 80;

const snippetAround = (text: string, needle: string): string => {
  const index = text.toLowerCase().indexOf(needle.toLowerCase());
  if (index === -1) return text.slice(0, SNIPPET_RADIUS * 2);
  const start = Math.max(0, index - SNIPPET_RADIUS);
  return text.slice(start, index + needle.length + SNIPPET_RADIUS);
};

/** Full-posture in-memory KnowledgeAdapter: the conformance stub (ENG-358
    gate) and the test double later engine work builds against. Naive
    substring retrieval — deliberately not a quality bar, just contract-true. */
export function memoryKnowledgeAdapter(options: MemoryKnowledgeAdapterOptions = {}): KnowledgeAdapter {
  const docs = new Map<string, KnowledgeDoc>();
  for (const doc of options.docs ?? []) docs.set(doc.id, doc);

  return {
    posture: { fetch: true, write: true, visibility: "enforced" },

    async search(query: KnowledgeQuery, ctx: KnowledgeContext) {
      const limit = query.limit ?? 10;
      const hits: KnowledgeHit[] = [];
      for (const doc of docs.values()) {
        if (doc.visibility === "internal" && ctx.includeInternal !== true) continue;
        if (query.kinds !== undefined && !query.kinds.includes(doc.kind)) continue;
        const haystack = `${doc.title}\n${doc.text}`.toLowerCase();
        if (!haystack.includes(query.text.toLowerCase())) continue;
        hits.push({
          ref: { docId: doc.id, chunkId: `${doc.id}#0`, title: doc.title, source: doc.source },
          snippet: snippetAround(`${doc.title}\n${doc.text}`, query.text),
          kind: doc.kind,
          visibility: doc.visibility,
          score: 1,
        });
        if (hits.length >= limit) break;
      }
      return { hits };
    },

    async fetch(ref, ctx) {
      const doc = docs.get(ref.docId);
      if (doc === undefined) return null;
      if (doc.visibility === "internal" && ctx.includeInternal !== true) return null;
      return { ref: { docId: doc.id, title: doc.title, source: doc.source }, text: doc.text };
    },

    async upsert(incoming) {
      for (const doc of incoming) docs.set(doc.id, doc);
    },

    async remove(docIds) {
      for (const id of docIds) docs.delete(id);
    },

    async status() {
      const byKind: Partial<Record<KnowledgeDoc["kind"], number>> = {};
      for (const doc of docs.values()) byKind[doc.kind] = (byKind[doc.kind] ?? 0) + 1;
      return { docs: docs.size, byKind };
    },
  };
}
```

Then add the re-export to `packages/core/src/conformance/index.ts`, directly under the existing `memoryStoreAdapter` line:

```typescript
export { memoryKnowledgeAdapter, type MemoryKnowledgeAdapterOptions } from "./memory-knowledge.js";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @vendoai/core exec vitest run src/conformance/memory-knowledge.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/conformance/memory-knowledge.ts packages/core/src/conformance/memory-knowledge.test.ts packages/core/src/conformance/index.ts
git commit -m "feat(core): in-memory KnowledgeAdapter stub for conformance and engine tests (ENG-358)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: The posture-adaptive conformance kit (the ENG-358 gate)

**Files:**
- Create: `packages/core/src/conformance/knowledge.ts`
- Create: `packages/core/src/conformance/knowledge.test.ts`
- Modify: `packages/core/src/conformance/index.ts` (one more re-export line)

**Interfaces:**
- Consumes: `memoryKnowledgeAdapter` (Task 2); `ConformanceCase`/`ConformanceSuite` from `./index.js` (**type-only import**); knowledge schemas from `../index.js` (Task 1).
- Produces: `knowledgeAdapterConformance(opts: KnowledgeConformanceOptions): ConformanceSuite` where `KnowledgeConformanceOptions = { makeAdapter(): Promise<{ adapter: KnowledgeAdapter; close?(): Promise<void> }>; posture: KnowledgePosture; seedDocs?: { public: KnowledgeDoc; internal: KnowledgeDoc } }`. ENG-359 grows this suite's behavioral cases; ENG-363/364/365 run it per adapter (IC-7).

- [ ] **Step 1: Write the failing mount test**

Create `packages/core/src/conformance/knowledge.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { knowledgeAdapterConformance, memoryKnowledgeAdapter, runConformance } from "./index.js";

describe("KnowledgeAdapter conformance kit against the memory stub", () => {
  const suite = knowledgeAdapterConformance({
    makeAdapter: async () => ({ adapter: memoryKnowledgeAdapter() }),
    posture: { fetch: true, write: true, visibility: "enforced" },
  });

  it("mounts every case", () => {
    expect(suite.seam).toBe("KnowledgeAdapter");
    expect(suite.cases.length).toBeGreaterThanOrEqual(6);
  });

  for (const conformanceCase of suite.cases) {
    it(conformanceCase.name, conformanceCase.run);
  }

  it("public-only postures skip the internal-tier cases", () => {
    const publicOnly = knowledgeAdapterConformance({
      makeAdapter: async () => ({ adapter: memoryKnowledgeAdapter() }),
      posture: { fetch: true, write: true, visibility: "public-only" },
    });
    const names = publicOnly.cases.map((c) => c.name).join("\n");
    expect(names).not.toContain("internal");
  });

  it("runConformance reports ok for the full-posture stub", async () => {
    const report = await runConformance(suite);
    expect(report.failures).toEqual([]);
    expect(report.ok).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @vendoai/core exec vitest run src/conformance/knowledge.test.ts`
Expected: FAIL — `knowledgeAdapterConformance` is not exported.

- [ ] **Step 3: Write the kit**

Create `packages/core/src/conformance/knowledge.ts`:

```typescript
import {
  knowledgeFetchResultSchema,
  knowledgePostureSchema,
  knowledgeSearchResultSchema,
  knowledgeStatusSchema,
  type KnowledgeAdapter,
  type KnowledgeContext,
  type KnowledgeDoc,
  type KnowledgePosture,
} from "../index.js";
import type { ConformanceCase, ConformanceSuite } from "./index.js";

export interface KnowledgeConformanceOptions {
  makeAdapter(): Promise<{ adapter: KnowledgeAdapter; close?(): Promise<void> }>;
  /** The posture the adapter DECLARES. Cases adapt: required capabilities are
      always tested, optional ones only when declared, `public-only` skips the
      internal-tier cases (knowledge design v2 R2). */
  posture: KnowledgePosture;
  /** Docs the visibility/round-trip cases key on. Write-posture adapters get
      them upserted by the suite; read-only adapters must come pre-seeded with
      equivalent content. */
  seedDocs?: { public: KnowledgeDoc; internal: KnowledgeDoc };
}

const DEFAULT_SEED: { public: KnowledgeDoc; internal: KnowledgeDoc } = {
  public: {
    id: "doc_conformance_public",
    kind: "docs",
    visibility: "public",
    title: "Conformance refund policy",
    text: "Conformance refunds are processed within 5 business days.",
    source: "conformance/refunds.md",
  },
  internal: {
    id: "doc_conformance_internal",
    kind: "glossary",
    visibility: "internal",
    title: "Conformance chargeback runbook",
    text: "Conformance internal chargeback escalation contacts.",
    source: "conformance/chargebacks.md",
  },
};

const ctx: KnowledgeContext = { principal: { kind: "user", subject: "user_knowledge_conformance" } };

const assert: (condition: unknown, message: string) => asserts condition = (condition, message) => {
  if (!condition) throw new Error(message);
};

const assertParses = <T>(schema: { safeParse(value: unknown): { success: boolean; error?: unknown; data?: unknown } }, value: unknown, message: string): T => {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new Error(`${message}: ${JSON.stringify(parsed.error)}`);
  return parsed.data as T;
};

/** Executable KnowledgeAdapter checks — knowledge design v2 (2026-07-22) R2/R5.
    ENG-358 freezes this skeleton; ENG-359 grows the behavioral case set. */
export function knowledgeAdapterConformance(opts: KnowledgeConformanceOptions): ConformanceSuite {
  const seed = opts.seedDocs ?? DEFAULT_SEED;

  const adapterCase = (
    name: string,
    body: (adapter: KnowledgeAdapter) => Promise<void>,
  ): ConformanceCase => ({
    name,
    async run(): Promise<void> {
      const made = await opts.makeAdapter();
      try {
        if (opts.posture.write) {
          const docs = opts.posture.visibility === "enforced" ? [seed.public, seed.internal] : [seed.public];
          await made.adapter.upsert?.(docs);
        }
        await body(made.adapter);
      } finally {
        await made.close?.();
      }
    },
  });

  const cases: ConformanceCase[] = [
    adapterCase("R2 — declared posture is schema-valid and matches the adapter surface", async (adapter) => {
      assertParses(knowledgePostureSchema, adapter.posture, "posture is invalid");
      assert(JSON.stringify(adapter.posture) === JSON.stringify(opts.posture), "adapter posture differs from the declared posture");
      assert((adapter.fetch !== undefined) === opts.posture.fetch, "fetch presence does not match posture.fetch");
      assert((adapter.upsert !== undefined) === opts.posture.write, "upsert presence does not match posture.write");
      assert((adapter.remove !== undefined) === opts.posture.write, "remove presence does not match posture.write");
    }),

    adapterCase("R2 — search returns a schema-valid result and respects limit", async (adapter) => {
      const result = assertParses<{ hits: unknown[] }>(
        knowledgeSearchResultSchema,
        await adapter.search({ text: "conformance", limit: 1 }, ctx),
        "search result is invalid",
      );
      assert(result.hits.length <= 1, "search ignored the limit");
    }),

    adapterCase("R3 — schema intent answers honestly: unknown terms return zero hits", async (adapter) => {
      const result = assertParses<{ hits: unknown[] }>(
        knowledgeSearchResultSchema,
        await adapter.search({ text: "zz_conformance_absent_term_zz", intent: "schema" }, ctx),
        "schema-intent result is invalid",
      );
      assert(result.hits.length === 0, "schema intent fuzzy-matched an absent term instead of honest not-found");
    }),

    adapterCase("R1/R4 — status reports schema-valid counts", async (adapter) => {
      const status = assertParses<{ docs: number }>(knowledgeStatusSchema, await adapter.status(), "status is invalid");
      if (opts.posture.write) assert(status.docs >= 1, "status.docs did not reflect seeded documents");
    }),
  ];

  if (opts.posture.visibility === "enforced") {
    cases.push(
      adapterCase("R5 — a default context never surfaces internal hits", async (adapter) => {
        const result = await adapter.search({ text: "conformance" }, ctx);
        assert(result.hits.every((hit) => hit.visibility === "public"), "internal content leaked into a default-context search");
      }),
      adapterCase("R5 — includeInternal surfaces internal content for trusted callers", async (adapter) => {
        if (!opts.posture.write) return;
        const result = await adapter.search({ text: "chargeback" }, { ...ctx, includeInternal: true });
        assert(result.hits.some((hit) => hit.visibility === "internal"), "includeInternal did not surface the seeded internal doc");
      }),
    );
  }

  if (opts.posture.fetch) {
    cases.push(adapterCase("R3 — fetch resolves a searched ref and nulls an unknown one", async (adapter) => {
      const hits = (await adapter.search({ text: "conformance" }, ctx)).hits;
      if (hits.length > 0) {
        const fetched = await adapter.fetch?.(hits[0]!.ref, ctx);
        assert(fetched !== null && fetched !== undefined, "fetch returned null for a ref search just produced");
        assertParses(knowledgeFetchResultSchema, fetched, "fetch result is invalid");
      }
      assert(await adapter.fetch?.({ docId: "doc_conformance_absent" }, ctx) === null, "fetch of an unknown ref did not return null");
    }));
  }

  if (opts.posture.write) {
    cases.push(adapterCase("R1 — upsert/remove round-trip at document level", async (adapter) => {
      const doc: KnowledgeDoc = {
        id: "doc_conformance_roundtrip",
        kind: "api",
        visibility: "public",
        title: "Conformance roundtrip endpoint",
        text: "POST /conformance/roundtrip toggles the roundtrip flag.",
        source: "conformance/roundtrip.md",
      };
      await adapter.upsert?.([doc]);
      assert((await adapter.search({ text: "roundtrip" }, ctx)).hits.some((hit) => hit.ref.docId === doc.id), "upserted doc was not searchable");
      await adapter.remove?.([doc.id]);
      assert(!(await adapter.search({ text: "roundtrip" }, ctx)).hits.some((hit) => hit.ref.docId === doc.id), "removed doc remained searchable");
    }));
  }

  return { seam: "KnowledgeAdapter", cases };
}
```

Then add the re-export to `packages/core/src/conformance/index.ts`, under the memory-knowledge line added in Task 2:

```typescript
export { knowledgeAdapterConformance, type KnowledgeConformanceOptions } from "./knowledge.js";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @vendoai/core exec vitest run src/conformance/knowledge.test.ts`
Expected: PASS — mount test + every conformance case + public-only skip + runConformance ok.

- [ ] **Step 5: Run the whole core suite (regression sweep)**

Run: `pnpm --filter @vendoai/core build && pnpm --filter @vendoai/core test`
(build first — `cjs.test.ts` and the packaging/contract-coverage e2e tests read `dist/`)
Expected: PASS — all pre-existing core tests plus the three new files.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/conformance/knowledge.ts packages/core/src/conformance/knowledge.test.ts packages/core/src/conformance/index.ts
git commit -m "test(core): posture-adaptive KnowledgeAdapter conformance kit, green on the memory stub (ENG-358)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Changeset, full gate, plan commit

**Files:**
- Create: `.changeset/knowledge-contract-freeze.md`
- Create (already on disk, commit it): `docs/superpowers/plans/2026-07-24-eng-358-knowledge-contract-freeze.md`

**Interfaces:**
- Consumes: everything above.
- Produces: a PR-ready branch; the fixed lockstep group means the core minor bump versions all 11 published packages together.

- [ ] **Step 1: Write the changeset**

Create `.changeset/knowledge-contract-freeze.md`:

```markdown
---
"@vendoai/core": minor
---

Freeze the knowledge contract: `KnowledgeAdapter` seam with declared capability postures, chunker/embedder interfaces (local-engine internals), the `vendo/knowledge-hash@1` doc-hash manifest schema, and a posture-adaptive conformance kit with an in-memory stub adapter.
```

- [ ] **Step 2: Run the full repo gate**

Run, from the worktree root:
```bash
pnpm build && pnpm test && pnpm typecheck && pnpm lint
```
Expected: all four green (lint runs dependency-guard + portability-gate + per-package lint; build must precede lint).

- [ ] **Step 3: Commit the changeset and plan**

```bash
git add .changeset/knowledge-contract-freeze.md docs/superpowers/plans/2026-07-24-eng-358-knowledge-contract-freeze.md
git commit -m "chore(core): changeset + implementation plan for the knowledge contract freeze (ENG-358)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

- [ ] **Step 4: Verify branch state**

Run: `git log --oneline main..HEAD` — expected: exactly the four commits above, no others. `git status` clean.
