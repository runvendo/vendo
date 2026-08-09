import { memoryKnowledgeAdapter } from "@vendoai/core/conformance";
import type { KnowledgeAdapter, KnowledgeDoc } from "@vendoai/core";
import { describe, expect, it } from "vitest";
import { knowledgeIndexResolver, knowledgeIndexSummary, parseKnowledgeConfig } from "../src/prompt-note.js";

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

  it("P0 (ENG-370): never names an internal source — internal corpus metadata stays off end-user prompts", () => {
    const summary = knowledgeIndexSummary({ docs: 9 }, {
      format: "vendo/knowledge@1",
      sources: [
        { name: "help-center", glob: "docs/**/*.md", kind: "docs", visibility: "public" },
        { name: "secret-fraud-runbooks", glob: "internal/**/*.md", kind: "docs", visibility: "internal" },
      ],
    });
    expect(summary).toContain("sources: help-center (docs).");
    expect(summary).not.toContain("secret-fraud-runbooks");

    // All-internal config: the sources clause disappears entirely.
    const allInternal = knowledgeIndexSummary({ docs: 2 }, {
      format: "vendo/knowledge@1",
      sources: [{ name: "secret-fraud-runbooks", glob: "internal/**/*.md", kind: "docs", visibility: "internal" }],
    });
    expect(allInternal).not.toContain("sources:");
    expect(allInternal).not.toContain("secret-fraud-runbooks");
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

describe("knowledgeIndexResolver (byte-stable at fixed sync state, refreshes on sync change)", () => {
  const readers = (state: { manifest?: string; config?: string }) => ({
    readConfig: () => state.config,
    readManifest: () => state.manifest,
  });

  it("is byte-stable at a FIXED sync state — repeated resolves return the same string with one status() call", async () => {
    let statusCalls = 0;
    const base = memoryKnowledgeAdapter({ docs: [doc("a"), doc("b")] });
    const counted: KnowledgeAdapter = {
      ...base,
      posture: base.posture,
      status: async () => {
        statusCalls += 1;
        return base.status();
      },
    };
    const state = { manifest: '{"format":"vendo/knowledge-hash@1","docs":{},"updatedAt":"2026-07-26T00:00:00Z"}' };
    const resolve = knowledgeIndexResolver(counted, readers(state));
    const first = await resolve();
    expect(first).toContain("2 documents");
    // Corpus mutation WITHOUT a sync-manifest change does not move the bytes
    // (the manifest is the sync-state signal, written last by sync).
    await base.upsert?.([doc("c")]);
    expect(await resolve()).toBe(first);
    expect(await resolve()).toBe(first);
    expect(statusCalls).toBe(1);
  });

  it("REFRESHES when the sync manifest changes, then is byte-stable at the new state", async () => {
    const base = memoryKnowledgeAdapter({ docs: [doc("a")] });
    const state: { manifest?: string; config?: string } = { manifest: "v1" };
    const resolve = knowledgeIndexResolver(base, readers(state));
    const first = await resolve();
    expect(first).toContain("1 document");

    // A sync lands: docs change AND the manifest is rewritten.
    await base.upsert?.([doc("b"), doc("c", "glossary")]);
    state.manifest = "v2";
    const refreshed = await resolve();
    expect(refreshed).toContain("3 documents");
    expect(refreshed).not.toBe(first);
    expect(await resolve()).toBe(refreshed);
  });

  it("picks up config changes (new sources) on the same refresh", async () => {
    const base = memoryKnowledgeAdapter({ docs: [doc("a")] });
    const state: { manifest?: string; config?: string } = { manifest: "v1" };
    const resolve = knowledgeIndexResolver(base, readers(state));
    expect(await resolve()).not.toContain("sources:");
    state.manifest = "v2";
    state.config = JSON.stringify({
      format: "vendo/knowledge@1",
      sources: [{ name: "help-center", glob: "docs/**/*.md", kind: "docs", visibility: "public" }],
    });
    expect(await resolve()).toContain("sources: help-center (docs)");
  });

  it("does no I/O at construction and single-flights concurrent first turns", async () => {
    let statusCalls = 0;
    const base = memoryKnowledgeAdapter({ docs: [doc("a")] });
    const counted: KnowledgeAdapter = {
      ...base,
      posture: base.posture,
      status: async () => {
        statusCalls += 1;
        return base.status();
      },
    };
    const resolve = knowledgeIndexResolver(counted, readers({}));
    expect(statusCalls).toBe(0);
    const [first, second] = await Promise.all([resolve(), resolve()]);
    expect(first).toBe(second);
    expect(statusCalls).toBe(1);
  });

  it("resolves undefined while the engine is down, retries on recovery, and serves STALE bytes over absence after a failed refresh", async () => {
    let healthy = false;
    const base = memoryKnowledgeAdapter({ docs: [doc("a")] });
    const flaky: KnowledgeAdapter = {
      ...base,
      posture: base.posture,
      status: async () => {
        if (!healthy) throw new Error("engine down");
        return base.status();
      },
    };
    const state: { manifest?: string; config?: string } = { manifest: "v1" };
    const resolve = knowledgeIndexResolver(flaky, readers(state));
    expect(await resolve()).toBeUndefined();
    healthy = true;
    const recovered = await resolve();
    expect(recovered).toContain("1 document");
    // A sync lands but the engine is sick: the last good bytes keep serving
    // (guidance never vanishes mid-session), and recovery re-caches.
    healthy = false;
    state.manifest = "v2";
    await base.upsert?.([doc("b")]);
    expect(await resolve()).toBe(recovered);
    healthy = true;
    expect(await resolve()).toContain("2 documents");
  });
});
