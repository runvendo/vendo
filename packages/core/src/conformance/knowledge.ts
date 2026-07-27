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

/** The suite seeds, mutates, and removes fixed `doc_conformance_*` ids: run
    it against a dedicated corpus/namespace only — never shared or production
    data — and never concurrently against one corpus. Isolation is the
    caller's contract, which is why fixture ids are deliberately stable
    (reruns self-clean instead of leaking uniquely-named orphans). */
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

    adapterCase("R2 — search retrieves the pre-seeded public doc and respects limit", async (adapter) => {
      const result = await adapter.search({ text: seed.public.title }, ctx);
      assertParses(knowledgeSearchResultSchema, result, "search result is invalid");
      assert(
        result.hits.some((hit) => hit.ref.docId === seed.public.id),
        "search did not retrieve the pre-seeded public doc by id — retrieval is required in every posture",
      );
      const limited = await adapter.search({ text: seed.public.title, limit: 1 }, ctx);
      assert(limited.hits.length === 1, "limit: 1 did not truncate to exactly one hit");
      assert(
        limited.hits[0]!.ref.docId === result.hits[0]!.ref.docId,
        "limit changed the ranking — the limited top hit differs from the unlimited top hit",
      );
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

    adapterCase("R4 — scores are optional, but where present they never increase down the ranking (ENG-366)", async (adapter) => {
      const scores = (await adapter.search({ text: seed.public.title }, ctx)).hits
        .filter((hit) => hit.score !== undefined)
        .map((hit) => hit.score!);
      for (let index = 1; index < scores.length; index += 1) {
        assert(
          scores[index]! <= scores[index - 1]!,
          "a later hit scored higher than an earlier one — hits must be ordered most-relevant-first",
        );
      }
    }),

    adapterCase("R3 — schema intent stays honest under a kinds filter (ENG-366)", async (adapter) => {
      const result = assertParses<{ hits: unknown[] }>(
        knowledgeSearchResultSchema,
        await adapter.search({ text: "zz_absent_term_never_seeded_zz", intent: "schema", kinds: ["glossary", "api"] }, ctx),
        "kinds-filtered schema-intent result is invalid",
      );
      assert(result.hits.length === 0, "schema intent with a kinds filter fuzzy-matched an absent term");
    }),
  ];

  if (opts.posture.visibility === "enforced") {
    cases.push(
      adapterCase("R5 — a default context never surfaces internal hits", async (adapter) => {
        const result = await adapter.search({ text: seed.internal.title }, ctx);
        assert(result.hits.every((hit) => hit.visibility === "public"), "internal content leaked into a default-context search");
      }),
      adapterCase("R5 — internal stays invisible to default contexts across every intent and kinds filter (ENG-370)", async (adapter) => {
        // The internal seed is glossary-kind, so the schema/kinds leg probes
        // the exact surface the tool's lookup mode queries — visibility must
        // be honored per-hit, never assumed from the query shape.
        const probes: Array<Parameters<KnowledgeAdapter["search"]>[0]> = [
          { text: seed.internal.title, intent: "deep" },
          { text: seed.internal.title, intent: "schema" },
          { text: seed.internal.title, intent: "schema", kinds: ["glossary", "api"] },
          { text: seed.internal.title, kinds: [seed.internal.kind] },
        ];
        for (const query of probes) {
          const result = await adapter.search(query, ctx);
          assert(
            result.hits.every((hit) => hit.visibility === "public" && hit.ref.docId !== seed.internal.id),
            `internal content leaked into a default-context search (intent: ${query.intent ?? "chat"}, kinds: ${JSON.stringify(query.kinds ?? "unset")})`,
          );
        }
      }),
      adapterCase("R5 — includeInternal surfaces internal content for trusted callers", async (adapter) => {
        const result = await adapter.search({ text: seed.internal.title }, { ...ctx, includeInternal: true });
        assert(
          result.hits.some((hit) => hit.ref.docId === seed.internal.id && hit.visibility === "internal"),
          "includeInternal did not surface the seeded internal doc",
        );
      }),
    );
    if (opts.posture.fetch) {
      cases.push(adapterCase("R5 — fetch treats internal refs as unknown for default contexts", async (adapter) => {
        const trusted = await adapter.search({ text: seed.internal.title }, { ...ctx, includeInternal: true });
        const internalHit = trusted.hits.find((hit) => hit.ref.docId === seed.internal.id);
        assert(internalHit !== undefined, "includeInternal search did not surface the seeded internal doc — fetch visibility cannot be exercised");
        assert(await adapter.fetch?.(internalHit.ref, ctx) === null, "fetch leaked an internal doc to a default context — a ref is not a capability");
        const fetched = await adapter.fetch?.(internalHit.ref, { ...ctx, includeInternal: true });
        assert(fetched !== null && fetched !== undefined, "fetch denied an internal ref to a trusted includeInternal context");
        assertParses(knowledgeFetchResultSchema, fetched, "trusted internal fetch result is invalid");
      }));
    }
  }

  if (opts.posture.visibility === "public-only") {
    cases.push(adapterCase("R2 — public-only posture: every hit is public and includeInternal changes nothing (ENG-366)", async (adapter) => {
      const plain = await adapter.search({ text: seed.public.title }, ctx);
      assert(plain.hits.length > 0, "public-only search returned nothing for the seeded public doc");
      assert(plain.hits.every((hit) => hit.visibility === "public"), "a public-only corpus surfaced a non-public hit — the posture is the host's attestation");
      const trusted = await adapter.search({ text: seed.public.title }, { ...ctx, includeInternal: true });
      assert(trusted.hits.every((hit) => hit.visibility === "public"), "includeInternal surfaced non-public content from a public-only corpus");
    }));
  }

  if (opts.posture.fetch) {
    cases.push(adapterCase("R3 — fetch resolves a searched ref and nulls an unknown one", async (adapter) => {
      const hits = (await adapter.search({ text: seed.public.title }, ctx)).hits;
      const seedHit = hits.find((hit) => hit.ref.docId === seed.public.id);
      assert(seedHit !== undefined, "search did not retrieve the pre-seeded public doc — fetch cannot be exercised");
      const fetched = await adapter.fetch?.(seedHit.ref, ctx);
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
    cases.push(adapterCase("R3 — limit truncates a multi-hit result to a prefix", async (adapter) => {
      const sibling: KnowledgeDoc = {
        id: "doc_conformance_public_sibling",
        kind: "docs",
        visibility: "public",
        title: `${seed.public.title} addendum`,
        text: "Conformance sibling content for truncation.",
        source: "conformance/refunds-addendum.md",
      };
      await adapter.upsert?.([sibling]);
      try {
        const unlimited = await adapter.search({ text: seed.public.title, limit: 10 }, ctx);
        assert(unlimited.hits.length >= 2, "seeding a sibling doc did not produce a multi-hit result — truncation cannot be exercised");
        const limited = await adapter.search({ text: seed.public.title, limit: 1 }, ctx);
        assert(limited.hits.length === 1, "limit: 1 did not truncate the multi-hit result to one hit");
        assert(limited.hits[0]!.ref.docId === unlimited.hits[0]!.ref.docId, "limit changed the ranking — the limited top hit differs from the unlimited top hit");
      } finally {
        await adapter.remove?.([sibling.id]);
      }
    }));
    cases.push(adapterCase("R1 — upsert resolves only once documents are searchable, no settle wait (ENG-366)", async (adapter) => {
      const fresh: KnowledgeDoc = {
        id: "doc_conformance_resolved",
        kind: "docs",
        visibility: "public",
        title: "Conformance resolution barrier",
        text: "Conformance resolution barrier body content.",
        source: "conformance/resolution.md",
      };
      try {
        await adapter.upsert?.([fresh]);
        // Immediately: a resolved upsert IS the searchability signal.
        const result = await adapter.search({ text: fresh.title }, ctx);
        assert(
          result.hits.some((hit) => hit.ref.docId === fresh.id),
          "a doc was not searchable the moment its upsert resolved — engines with async indexing must await searchability",
        );
      } finally {
        await adapter.remove?.([fresh.id]);
      }
    }));
    cases.push(adapterCase("R1 — remove empties search for the id and unknown ids are no-ops (ENG-366)", async (adapter) => {
      await adapter.remove?.([seed.public.id]);
      const result = await adapter.search({ text: seed.public.title }, ctx);
      assert(!result.hits.some((hit) => hit.ref.docId === seed.public.id), "a removed doc remained searchable");
      // Unknown ids resolve as no-ops — a throw here is non-conformant.
      await adapter.remove?.(["doc_conformance_never_existed"]);
    }));
    cases.push(adapterCase("R3 — limit k truncates the unlimited ranking to its exact prefix (ENG-366)", async (adapter) => {
      const siblings: KnowledgeDoc[] = ["a", "b"].map((suffix) => ({
        id: `doc_conformance_prefix_${suffix}`,
        kind: "docs",
        visibility: "public",
        title: `${seed.public.title} appendix ${suffix}`,
        text: `Conformance prefix content ${suffix}.`,
        source: `conformance/prefix-${suffix}.md`,
      }));
      try {
        await adapter.upsert?.(siblings);
        const unlimited = await adapter.search({ text: seed.public.title, limit: 10 }, ctx);
        assert(unlimited.hits.length >= 3, "seeding two siblings did not produce three hits — prefix truncation cannot be exercised");
        const limited = await adapter.search({ text: seed.public.title, limit: 2 }, ctx);
        const identity = (hit: { ref: { docId: string; chunkId?: string } }): string => `${hit.ref.docId} ${hit.ref.chunkId ?? ""}`;
        assert(
          JSON.stringify(limited.hits.map(identity)) === JSON.stringify(unlimited.hits.slice(0, 2).map(identity)),
          "limit: 2 did not return the unlimited ranking's exact two-hit prefix — limit must truncate, never re-rank",
        );
      } finally {
        await adapter.remove?.(siblings.map((doc) => doc.id));
      }
    }));
  }

  return { seam: "KnowledgeAdapter", cases };
}
