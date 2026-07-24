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
