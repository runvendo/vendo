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
