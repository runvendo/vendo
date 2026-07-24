import { describe, expect, it } from "vitest";
import type { KnowledgeAdapter } from "../index.js";
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
});
