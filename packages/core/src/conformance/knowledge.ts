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
  /** Docs the retrieval/visibility/round-trip cases key on. Write-posture
      adapters get them upserted by the suite; read-only adapters MUST come
      pre-seeded with these docs (the module's default seed docs when omitted —
      pass explicit seedDocs for a read-only adapter, since you control its
      contents). The suite makes positive retrieval assertions against the
      public seed in EVERY posture: an empty search is non-conformant. */
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
      assert(adapter.posture.fetch === opts.posture.fetch, "adapter posture.fetch differs from the declared posture");
      assert(adapter.posture.write === opts.posture.write, "adapter posture.write differs from the declared posture");
      assert(adapter.posture.visibility === opts.posture.visibility, "adapter posture.visibility differs from the declared posture");
      assert((adapter.fetch !== undefined) === opts.posture.fetch, "fetch presence does not match posture.fetch");
      assert((adapter.upsert !== undefined) === opts.posture.write, "upsert presence does not match posture.write");
      assert((adapter.remove !== undefined) === opts.posture.write, "remove presence does not match posture.write");
    }),

    adapterCase("R2 — search returns a schema-valid result and respects limit", async (adapter) => {
      const result = assertParses<{ hits: unknown[] }>(
        knowledgeSearchResultSchema,
        await adapter.search({ text: seed.public.title, limit: 1 }, ctx),
        "search result is invalid",
      );
      assert(result.hits.length >= 1, "search returned no hits for the pre-seeded public doc — retrieval is required in every posture");
      assert(result.hits.length <= 1, "search ignored the limit");
    }),

    adapterCase("R3 — schema intent answers honestly: unknown terms return zero hits", async (adapter) => {
      const result = assertParses<{ hits: unknown[] }>(
        knowledgeSearchResultSchema,
        await adapter.search({ text: "zz_absent_term_never_seeded_zz", intent: "schema" }, ctx),
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
        const result = await adapter.search({ text: seed.internal.title }, ctx);
        assert(result.hits.every((hit) => hit.visibility === "public"), "internal content leaked into a default-context search");
      }),
      adapterCase("R5 — includeInternal surfaces internal content for trusted callers", async (adapter) => {
        const result = await adapter.search({ text: seed.internal.title }, { ...ctx, includeInternal: true });
        assert(result.hits.some((hit) => hit.visibility === "internal"), "includeInternal did not surface the seeded internal doc");
      }),
    );
  }

  if (opts.posture.fetch) {
    cases.push(adapterCase("R3 — fetch resolves a searched ref and nulls an unknown one", async (adapter) => {
      const hits = (await adapter.search({ text: seed.public.title }, ctx)).hits;
      assert(hits.length > 0, "search returned no hits for the pre-seeded public doc — fetch cannot be exercised");
      const fetched = await adapter.fetch?.(hits[0]!.ref, ctx);
      assert(fetched !== null && fetched !== undefined, "fetch returned null for a ref search just produced");
      assertParses(knowledgeFetchResultSchema, fetched, "fetch result is invalid");
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
