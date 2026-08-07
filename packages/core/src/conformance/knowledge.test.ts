import { describe, expect, it } from "vitest";
import type { KnowledgeAdapter } from "../index.js";
import { knowledgeAdapterConformance, memoryKnowledgeAdapter, runConformance } from "./index.js";

describe("KnowledgeAdapter conformance kit against the memory stub", () => {
  const suite = knowledgeAdapterConformance({
    makeAdapter: async () => ({ adapter: memoryKnowledgeAdapter() }),
    posture: { fetch: true, write: true, visibility: "enforced" },
  });

  it("mounts a non-trivial case set (posture gating must never mount nothing)", () => {
    expect(suite.cases.length).toBeGreaterThanOrEqual(6);
  });

  for (const conformanceCase of suite.cases) {
    it(conformanceCase.name, conformanceCase.run);
  }

  it("posture picks the visibility tier: public-only gets R2, enforced gets R5", () => {
    // The posture is the host's attestation about its corpus, so it decides
    // which visibility cases exist at all — an internal-tier case run against a
    // public-only corpus would fail on a corpus that is correct by declaration.
    const publicOnly = knowledgeAdapterConformance({
      makeAdapter: async () => ({ adapter: memoryKnowledgeAdapter() }),
      posture: { fetch: true, write: true, visibility: "public-only" },
    });
    const tiers = (cases: typeof suite.cases): string[] =>
      [...new Set(cases.map((c) => c.name.slice(0, c.name.indexOf(" "))))];
    expect(tiers(suite.cases)).toContain("R5");
    expect(tiers(publicOnly.cases)).not.toContain("R5");
    const attestation = (cases: typeof suite.cases): boolean =>
      cases.some((c) => c.name.includes("public-only posture"));
    expect(attestation(publicOnly.cases)).toBe(true);
    expect(attestation(suite.cases)).toBe(false);
  });

  it("a nonfunctional search fails conformance even at the weakest posture", async () => {
    const emptySearchAdapter: KnowledgeAdapter = {
      posture: { fetch: false, write: false, visibility: "public-only" },
      async search() {
        return { hits: [] };
      },
      async status() {
        return { docs: 1 };
      },
    };
    const report = await runConformance(knowledgeAdapterConformance({
      makeAdapter: async () => ({ adapter: emptySearchAdapter }),
      posture: { fetch: false, write: false, visibility: "public-only" },
    }));
    expect(report.ok).toBe(false);
    expect(report.failures.map((failure) => failure.name).join("\n")).toContain("search");
  });

  it("a search that returns only unrelated hits fails conformance", async () => {
    const junkAdapter: KnowledgeAdapter = {
      posture: { fetch: false, write: false, visibility: "public-only" },
      async search(query) {
        if (query.text.startsWith("zz_")) return { hits: [] };
        return {
          hits: [{ ref: { docId: "doc_unrelated" }, snippet: "unrelated", kind: "docs", visibility: "public" }],
        };
      },
      async status() {
        return { docs: 1 };
      },
    };
    const report = await runConformance(knowledgeAdapterConformance({
      makeAdapter: async () => ({ adapter: junkAdapter }),
      posture: { fetch: false, write: false, visibility: "public-only" },
    }));
    expect(report.ok).toBe(false);
    expect(report.failures.map((failure) => failure.name).join("\n")).toContain("search");
  });

  it("a limited search that swaps in a different doc fails conformance", async () => {
    const divergentAdapter: KnowledgeAdapter = {
      posture: { fetch: false, write: false, visibility: "public-only" },
      async search(query) {
        if (query.text.startsWith("zz_")) return { hits: [] };
        const docId = query.limit === undefined ? "doc_conformance_public" : "doc_unrelated";
        return { hits: [{ ref: { docId }, snippet: "hit", kind: "docs", visibility: "public" }] };
      },
      async status() {
        return { docs: 1 };
      },
    };
    const report = await runConformance(knowledgeAdapterConformance({
      makeAdapter: async () => ({ adapter: divergentAdapter }),
      posture: { fetch: false, write: false, visibility: "public-only" },
    }));
    expect(report.ok).toBe(false);
    expect(report.failures.map((failure) => failure.name).join("\n")).toContain("search");
  });

  it("a fetch that leaks internal docs to default contexts fails conformance", async () => {
    const inner = memoryKnowledgeAdapter();
    const leakyFetch: KnowledgeAdapter = {
      posture: { fetch: true, write: true, visibility: "enforced" },
      search: (query, searchCtx) => inner.search(query, searchCtx),
      fetch: (ref) => inner.fetch!(ref, { principal: { kind: "user", subject: "leak" }, includeInternal: true }),
      upsert: (docs) => inner.upsert!(docs),
      remove: (docIds) => inner.remove!(docIds),
      status: () => inner.status(),
    };
    const report = await runConformance(knowledgeAdapterConformance({
      makeAdapter: async () => ({ adapter: leakyFetch }),
      posture: { fetch: true, write: true, visibility: "enforced" },
    }));
    expect(report.ok).toBe(false);
    expect(report.failures.map((failure) => failure.name).join("\n")).toContain("fetch");
  });

  it("a search that silently caps multi-hit results fails conformance", async () => {
    const inner = memoryKnowledgeAdapter();
    const cappedSearch: KnowledgeAdapter = {
      posture: { fetch: true, write: true, visibility: "enforced" },
      search: async (query, searchCtx) => {
        const result = await inner.search(query, searchCtx);
        return { hits: result.hits.slice(0, 1) };
      },
      fetch: (ref, fetchCtx) => inner.fetch!(ref, fetchCtx),
      upsert: (docs) => inner.upsert!(docs),
      remove: (docIds) => inner.remove!(docIds),
      status: () => inner.status(),
    };
    const report = await runConformance(knowledgeAdapterConformance({
      makeAdapter: async () => ({ adapter: cappedSearch }),
      posture: { fetch: true, write: true, visibility: "enforced" },
    }));
    expect(report.ok).toBe(false);
    expect(report.failures.map((failure) => failure.name).join("\n")).toContain("limit");
  });
});
