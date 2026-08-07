import { describe, expect, it } from "vitest";
import type { KnowledgeContext, KnowledgeDoc } from "@vendoai/core";
import { knowledgeAdapterConformance, memoryStoreAdapter, runConformance } from "@vendoai/core/conformance";
import { KNOWLEDGE_CHUNKS_COLLECTION, KNOWLEDGE_DOCS_COLLECTION } from "../collections.js";
import { vendoKnowledge } from "./lexical.js";

const ctx: KnowledgeContext = { principal: { kind: "user", subject: "user_lexical_test" } };

const doc = (overrides: Partial<KnowledgeDoc> & Pick<KnowledgeDoc, "id" | "title" | "text">): KnowledgeDoc => ({
  kind: "docs",
  visibility: "public",
  source: `${overrides.id}.md`,
  ...overrides,
});

const CORPUS: KnowledgeDoc[] = [
  doc({
    id: "docs#refunds.md",
    title: "Refund policy",
    text: "# Refund policy\nRefunds are processed within five business days. A refund lands on the original payment method.",
  }),
  doc({
    id: "docs#shipping.md",
    title: "Shipping",
    text: "# Shipping\nOrders ship within two days. Tracking numbers arrive by email.",
  }),
  doc({
    id: "docs#internal-runbook.md",
    title: "Refund escalation runbook",
    visibility: "internal",
    text: "# Refund escalation runbook\nInternal refund escalation contacts and thresholds.",
  }),
  doc({
    id: "glossary#terms.md#apr",
    title: "APR",
    kind: "glossary",
    text: "Annual percentage rate charged on outstanding balances.",
  }),
];

async function seeded() {
  const store = memoryStoreAdapter();
  const adapter = vendoKnowledge({ store });
  await adapter.upsert!(CORPUS);
  return { store, adapter };
}

describe("vendoKnowledge — conformance", () => {
  it("passes the KnowledgeAdapter conformance suite over the memory store", async () => {
    const report = await runConformance(knowledgeAdapterConformance({
      makeAdapter: async () => ({ adapter: vendoKnowledge({ store: memoryStoreAdapter() }) }),
      posture: { fetch: true, write: true, visibility: "enforced" },
    }));
    expect(report.failures).toEqual([]);
    expect(report.ok).toBe(true);
  });
});

describe("vendoKnowledge — retrieval quality", () => {
  it("answers multi-word natural questions with ranked hits (not substring matching)", async () => {
    const { adapter } = await seeded();
    const result = await adapter.search({ text: "How long do refunds take?" }, ctx);
    expect(result.hits.length).toBeGreaterThan(0);
    expect(result.hits[0]!.ref.docId).toBe("docs#refunds.md");
    // Ranked: scores are present, positive, and non-increasing.
    const scores = result.hits.map((hit) => hit.score!);
    expect(scores.every((score) => score > 0)).toBe(true);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
  });

  it("returns zero hits on a zero-match query — never score-1-everything", async () => {
    const { adapter } = await seeded();
    const result = await adapter.search({ text: "quantum blockchain espresso" }, ctx);
    expect(result.hits).toEqual([]);
  });

  it("filters visibility before ranking: internal docs are invisible without includeInternal", async () => {
    const { adapter } = await seeded();
    const blocked = await adapter.search({ text: "refund escalation runbook" }, ctx);
    expect(blocked.hits.every((hit) => hit.visibility === "public")).toBe(true);
    const trusted = await adapter.search({ text: "refund escalation runbook" }, { ...ctx, includeInternal: true });
    expect(trusted.hits[0]!.ref.docId).toBe("docs#internal-runbook.md");
  });

  it("treats deep intent as chat (honest no-op escalation for a lexical engine)", async () => {
    const { adapter } = await seeded();
    const chat = await adapter.search({ text: "refunds business days", intent: "chat" }, ctx);
    const deep = await adapter.search({ text: "refunds business days", intent: "deep" }, ctx);
    expect(deep).toEqual(chat);
  });

  it("schema intent is exact term lookup over glossary/api with honest not-found", async () => {
    const { adapter } = await seeded();
    const exact = await adapter.search({ text: "APR", intent: "schema" }, ctx);
    expect(exact.hits).toHaveLength(1);
    expect(exact.hits[0]!.ref.docId).toBe("glossary#terms.md#apr");
    // Case/slug-insensitive exactness, but never fuzzy.
    expect((await adapter.search({ text: "apr", intent: "schema" }, ctx)).hits).toHaveLength(1);
    expect((await adapter.search({ text: "annual percentage", intent: "schema" }, ctx)).hits).toEqual([]);
    // Prose docs never answer schema lookups.
    expect((await adapter.search({ text: "Refund policy", intent: "schema" }, ctx)).hits).toEqual([]);
  });

  it("an empty kinds array matches nothing; kinds filter applies in-query", async () => {
    const { adapter } = await seeded();
    expect((await adapter.search({ text: "refunds", kinds: [] }, ctx)).hits).toEqual([]);
    const glossaryOnly = await adapter.search({ text: "percentage rate balances", kinds: ["glossary"] }, ctx);
    expect(glossaryOnly.hits.every((hit) => hit.kind === "glossary")).toBe(true);
  });
});

describe("vendoKnowledge — fetch, store rows, and lifecycle", () => {
  it("fetch joins the cited chunk with its structural neighbors", async () => {
    const store = memoryStoreAdapter();
    const adapter = vendoKnowledge({ store });
    const long = doc({
      id: "docs#long.md",
      title: "Long guide",
      text: ["# Long guide", "Intro.", "## Alpha", "Alpha body.", "## Beta", "Beta body.", "## Gamma", "Gamma body."].join("\n"),
    });
    await adapter.upsert!([long]);
    const hit = (await adapter.search({ text: "beta body" }, ctx)).hits[0]!;
    const fetched = await adapter.fetch!(hit.ref, ctx);
    expect(fetched!.text).toContain("Alpha body.");
    expect(fetched!.text).toContain("Beta body.");
    expect(fetched!.text).toContain("Gamma body.");
    expect(fetched!.truncated).toBe(true); // the intro chunk stayed out
    // A doc-level ref (no chunkId) returns the whole text, untruncated.
    const whole = await adapter.fetch!({ docId: "docs#long.md" }, ctx);
    expect(whole!.text).toBe(long.text);
    expect(whole!.truncated).toBeUndefined();
  });

  it("populates refs per the ruling and carries no subject_id (subject-erase skips knowledge by design)", async () => {
    const { store } = await seeded();
    const docRows = (await store.records(KNOWLEDGE_DOCS_COLLECTION).list({ limit: 1000 })).records;
    expect(docRows.length).toBe(CORPUS.length);
    for (const row of docRows) expect(Object.keys(row.refs ?? {})).toEqual(["source"]);
    const chunkRows = (await store.records(KNOWLEDGE_CHUNKS_COLLECTION).list({ limit: 1000 })).records;
    expect(chunkRows.length).toBeGreaterThan(0);
    for (const row of chunkRows) expect(Object.keys(row.refs ?? {})).toEqual(["doc_id"]);
    // A subject-scoped erase query matches no knowledge rows: intended.
    expect((await store.records(KNOWLEDGE_DOCS_COLLECTION).list({ refs: { subject_id: "user_lexical_test" } })).records).toEqual([]);
    expect((await store.records(KNOWLEDGE_CHUNKS_COLLECTION).list({ refs: { subject_id: "user_lexical_test" } })).records).toEqual([]);
  });

  it("re-upsert replaces chunk rows without orphans; remove deletes doc and chunks", async () => {
    const { store, adapter } = await seeded();
    const chunks = store.records(KNOWLEDGE_CHUNKS_COLLECTION);
    const before = (await chunks.list({ refs: { doc_id: "docs#refunds.md" }, limit: 1000 })).records.length;
    expect(before).toBeGreaterThan(0);
    await adapter.upsert!([doc({ id: "docs#refunds.md", title: "Refund policy", text: "# Refund policy\nShorter now." })]);
    const after = (await chunks.list({ refs: { doc_id: "docs#refunds.md" }, limit: 1000 })).records;
    expect(after).toHaveLength(1);
    await adapter.remove!(["docs#refunds.md"]);
    expect((await chunks.list({ refs: { doc_id: "docs#refunds.md" }, limit: 1000 })).records).toEqual([]);
    expect(await store.records(KNOWLEDGE_DOCS_COLLECTION).get("docs#refunds.md")).toBeNull();
    expect((await adapter.search({ text: "refunds processed business days" }, ctx)).hits
      .every((hit) => hit.ref.docId !== "docs#refunds.md")).toBe(true);
  });

  it("status counts via paginated scan, by kind", async () => {
    const { adapter } = await seeded();
    expect(await adapter.status()).toEqual({ docs: 4, byKind: { docs: 3, glossary: 1 } });
  });

  it("fails loudly when no store is bound instead of reading as an empty corpus", async () => {
    const unbound = vendoKnowledge();
    await expect(unbound.search({ text: "anything" }, ctx)).rejects.toThrow(/no store bound/);
  });
});
