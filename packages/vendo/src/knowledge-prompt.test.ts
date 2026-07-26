import { memoryKnowledgeAdapter } from "@vendoai/core/conformance";
import type { KnowledgeAdapter, KnowledgeDoc } from "@vendoai/core";
import { describe, expect, it } from "vitest";
import { bootLockedKnowledgeIndex, knowledgeIndexSummary, parseKnowledgeConfig } from "./knowledge-prompt.js";

const doc = (id: string, kind: KnowledgeDoc["kind"] = "docs"): KnowledgeDoc => ({
  id,
  kind,
  visibility: "public",
  title: `Doc ${id}`,
  text: `Body of ${id}.`,
  source: `docs/${id}.md`,
});

describe("knowledgeIndexSummary (k8 prompt index)", () => {
  it("reflects status counts, breaks them down by kind, and names the tool + lookup + readMore", () => {
    const summary = knowledgeIndexSummary({ docs: 12, byKind: { docs: 9, glossary: 2, api: 1 } });
    expect(summary.startsWith("Knowledge\n")).toBe(true);
    expect(summary).toContain("12 documents (9 docs, 2 glossary, 1 api)");
    expect(summary).toContain("vendo_knowledge_search");
    expect(summary).toContain("lookup:true");
    expect(summary).toContain("readMore:{docId}");
    expect(summary).toContain("insufficient-evidence");
  });

  it("renders without byKind, singular counts, and zero-count kinds dropped", () => {
    expect(knowledgeIndexSummary({ docs: 1 })).toContain("1 document.");
    expect(knowledgeIndexSummary({ docs: 3, byKind: { docs: 3, glossary: 0 } }))
      .toContain("3 documents (3 docs).");
  });

  it("appends the knowledge.json sources when a config is provided", () => {
    const summary = knowledgeIndexSummary({ docs: 4 }, {
      format: "vendo/knowledge@1",
      sources: [
        { name: "product-docs", glob: "docs/**/*.md", kind: "docs", visibility: "public" },
        { name: "api-ref", glob: "api/**/*.md", kind: "api", visibility: "public" },
      ],
    });
    expect(summary).toContain("sources: product-docs (docs), api-ref (api)");
  });
});

describe("parseKnowledgeConfig (fail-soft ingestion-input read)", () => {
  it("parses a valid file and returns undefined for absent, broken JSON, or invalid schema", () => {
    const valid = JSON.stringify({
      format: "vendo/knowledge@1",
      sources: [{ name: "docs", glob: "docs/**/*.md", kind: "docs", visibility: "public" }],
    });
    expect(parseKnowledgeConfig(valid)?.sources[0]?.name).toBe("docs");
    expect(parseKnowledgeConfig(undefined)).toBeUndefined();
    expect(parseKnowledgeConfig("{not json")).toBeUndefined();
    expect(parseKnowledgeConfig(JSON.stringify({ format: "wrong" }))).toBeUndefined();
  });
});

describe("bootLockedKnowledgeIndex (cache-stability, a hard k8 criterion)", () => {
  it("locks to the first resolved bytes — later corpus changes never move the block", async () => {
    const adapter = memoryKnowledgeAdapter({ docs: [doc("a"), doc("b")] });
    const resolve = bootLockedKnowledgeIndex(adapter, () => undefined);
    const first = await resolve();
    expect(first).toContain("2 documents");
    await adapter.upsert?.([doc("c"), doc("d", "glossary")]);
    const second = await resolve();
    const third = await resolve();
    expect(second).toBe(first);
    expect(third).toBe(first);
  });

  it("does no I/O at construction and only one status() flight for concurrent first turns", async () => {
    let statusCalls = 0;
    const adapter = memoryKnowledgeAdapter({ docs: [doc("a")] });
    const counted: KnowledgeAdapter = {
      ...adapter,
      posture: adapter.posture,
      status: async () => {
        statusCalls += 1;
        return adapter.status();
      },
    };
    const resolve = bootLockedKnowledgeIndex(counted, () => undefined);
    expect(statusCalls).toBe(0);
    const [first, second] = await Promise.all([resolve(), resolve()]);
    expect(first).toBe(second);
    expect(statusCalls).toBe(1);
  });

  it("resolves undefined while the engine is down, then retries and locks on recovery", async () => {
    let healthy = false;
    const adapter = memoryKnowledgeAdapter({ docs: [doc("a")] });
    const flaky: KnowledgeAdapter = {
      ...adapter,
      posture: adapter.posture,
      status: async () => {
        if (!healthy) throw new Error("engine down");
        return adapter.status();
      },
    };
    const resolve = bootLockedKnowledgeIndex(flaky, () => undefined);
    expect(await resolve()).toBeUndefined();
    healthy = true;
    const recovered = await resolve();
    expect(recovered).toContain("1 document");
    expect(await resolve()).toBe(recovered);
  });
});
