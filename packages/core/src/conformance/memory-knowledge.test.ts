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
    expect(await adapter.fetch?.({ docId: "doc_int" }, ctx)).toBeNull();
    const fetchedInternal = await adapter.fetch?.({ docId: "doc_int" }, { ...ctx, includeInternal: true });
    expect(fetchedInternal?.text).toContain("escalation contacts");
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
