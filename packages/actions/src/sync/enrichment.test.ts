import { describe, expect, it } from "vitest";
import type { ExtractedTool } from "../formats.js";
import { applyEnrichmentFields, carryEnrichment, clampEnrichment } from "./enrichment.js";

const baseline = (overrides: Partial<ExtractedTool> = {}): ExtractedTool => ({
  name: "host_listInvoices",
  description: "Use this to read or list invoices (GET /api/invoices).",
  inputSchema: { type: "object", properties: {} },
  risk: "read",
  binding: { kind: "route", method: "GET", path: "/api/invoices", argsIn: "query" },
  srcHash: "sha256:aaaa",
  ...overrides,
});

describe("clampEnrichment (restrictive-only, the hard rule)", () => {
  it("accepts description rewrites, risk raises, critical marks, disables, and audience narrowing", () => {
    const { fields, clamped } = clampEnrichment(baseline(), {
      description: "List the signed-in customer's invoices with paging.",
      risk: "write",
      critical: true,
      disabled: true,
      audience: "operator",
      semantics: { "data.amountCents": { kind: "money", unit: "cents" } },
    });
    expect(fields).toEqual({
      description: "List the signed-in customer's invoices with paging.",
      risk: "write",
      critical: true,
      disabled: true,
      audience: "operator",
      semantics: { "data.amountCents": { kind: "money", unit: "cents" } },
    });
    expect(clamped).toEqual([]);
  });

  it("refuses risk downgrades, audience widening, enabling, and un-critical — and reports each", () => {
    const { fields, clamped } = clampEnrichment(
      baseline({ risk: "destructive", critical: true, disabled: true, audience: "internal" }),
      { risk: "read", audience: "end-user", disabled: false, critical: false },
    );
    expect(fields).toEqual({});
    expect(clamped).toHaveLength(4);
    expect(clamped.join("\n")).toContain("risk");
    expect(clamped.join("\n")).toContain("audience");
    expect(clamped.join("\n")).toContain("overrides.json");
    expect(clamped.join("\n")).toContain("critical");
  });

  it("drops equal-value proposals silently (no violation, no churn)", () => {
    const { fields, clamped } = clampEnrichment(
      baseline({ risk: "write", critical: true, disabled: true, audience: "operator" }),
      { risk: "write", critical: true, disabled: true, audience: "operator", description: baseline().description },
    );
    // description equal to the baseline is a no-op, not a rewrite
    expect(fields).toEqual({});
    expect(clamped).toEqual([]);
  });

  it("a non-end-user audience grade also disables the tool (fail-closed exclusion)", () => {
    const { fields } = clampEnrichment(baseline(), { audience: "internal" });
    expect(fields).toEqual({ audience: "internal", disabled: true });
  });

  it("an end-user grade on an ungraded baseline is provenance, never a widen", () => {
    const { fields, clamped } = clampEnrichment(baseline(), { audience: "end-user" });
    expect(fields).toEqual({ audience: "end-user" });
    expect(clamped).toEqual([]);
  });

  it("accepts a title freely — presentation is never a loosening", () => {
    const { fields, clamped } = clampEnrichment(baseline({ title: "List invoices" }), { title: "Show my invoices" });
    expect(fields).toEqual({ title: "Show my invoices" });
    expect(clamped).toEqual([]);
  });

  it("drops an unchanged title silently like any other no-op", () => {
    const { fields, clamped } = clampEnrichment(baseline({ title: "List invoices" }), { title: "List invoices" });
    expect(fields).toEqual({});
    expect(clamped).toEqual([]);
  });
});

describe("applyEnrichmentFields", () => {
  it("merges accepted fields and stamps the enriched marker, leaving the skeleton untouched", () => {
    const tool = applyEnrichmentFields(baseline(), {
      description: "Better.",
      risk: "write",
      semantics: { "data.total": { kind: "money", unit: "cents" } },
    });
    expect(tool).toMatchObject({
      description: "Better.",
      risk: "write",
      enriched: true,
      binding: baseline().binding,
      inputSchema: baseline().inputSchema,
      srcHash: "sha256:aaaa",
    });
  });

  it("merges proposed semantics over existing keys instead of replacing the record", () => {
    const tool = applyEnrichmentFields(
      baseline({ semantics: { "data.dueAt": { kind: "date", format: "epoch" } } }),
      { semantics: { "data.total": { kind: "money", unit: "cents" } } },
    );
    expect(tool.semantics).toEqual({
      "data.dueAt": { kind: "date", format: "epoch" },
      "data.total": { kind: "money", unit: "cents" },
    });
  });
});

describe("carryEnrichment (structural syncs must not lose the AI layer)", () => {
  it("carries description, grades, and marker over a fresh baseline", () => {
    const previous = applyEnrichmentFields(baseline(), {
      description: "AI description.",
      risk: "write",
      audience: "end-user",
    });
    const fresh = baseline();
    const carried = carryEnrichment(fresh, previous);
    expect(carried).toMatchObject({
      description: "AI description.",
      risk: "write",
      audience: "end-user",
      enriched: true,
    });
  });

  it("never carries a stale grade BELOW a fresh, more-restrictive deterministic baseline", () => {
    const previous = applyEnrichmentFields(baseline({ risk: "write" }), { description: "AI.", risk: "write" });
    // the scanner now grades the handler destructive + disabled (fail-closed)
    const fresh = baseline({ risk: "destructive", disabled: true });
    const carried = carryEnrichment(fresh, previous);
    expect(carried.risk).toBe("destructive");
    expect(carried.disabled).toBe(true);
    expect(carried.description).toBe("AI.");
    expect(carried.enriched).toBe(true);
  });

  it("carries a previously written title over a fresh baseline that has none", () => {
    const previous = applyEnrichmentFields(baseline(), { title: "List invoices" });
    expect(carryEnrichment(baseline(), previous).title).toBe("List invoices");
  });

  it("keeps a previous AI disable even when the fresh scan would enable", () => {
    const previous = applyEnrichmentFields(baseline(), { disabled: true, audience: "internal" });
    const carried = carryEnrichment(baseline(), previous);
    expect(carried.disabled).toBe(true);
    expect(carried.audience).toBe("internal");
  });
});
