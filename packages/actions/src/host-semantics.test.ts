import { describe, expect, it } from "vitest";
import { VENDO_OVERRIDES_FORMAT, VENDO_TOOLS_FORMAT } from "./formats.js";
import { mergedSemanticsAndDomains } from "./host-semantics.js";

describe("mergedSemanticsAndDomains", () => {
  it("overlays override semantics field-by-field and unions domains over the .vendo pair", () => {
    const merged = mergedSemanticsAndDomains({
      tools: {
        format: VENDO_TOOLS_FORMAT,
        domains: { has: ["invoices"], hasNot: ["payroll"] },
        tools: [{
          name: "host_invoices_list",
          description: "List invoices",
          inputSchema: { type: "object" },
          risk: "read",
          binding: { kind: "route", method: "GET", path: "/api/invoices", argsIn: "query" },
          semantics: {
            "data.amountCents": { kind: "money", unit: "cents" },
            "data.dueAt": { kind: "date", format: "iso" },
          },
        }],
      },
      overrides: {
        format: VENDO_OVERRIDES_FORMAT,
        tools: {
          host_invoices_list: {
            semantics: {
              "data.amountCents": { kind: "money", unit: "cents", currency: "USD" },
              "data.progress": { kind: "percent", scale: "ratio" },
            },
          },
        },
        domains: { has: ["invoices", "projects"], hasNot: ["inventory"] },
      },
    });
    expect(merged?.semantics).toEqual({
      host_invoices_list: {
        "data.amountCents": { kind: "money", unit: "cents", currency: "USD" },
        "data.dueAt": { kind: "date", format: "iso" },
        "data.progress": { kind: "percent", scale: "ratio" },
      },
    });
    expect(merged?.domains).toEqual({ has: ["invoices", "projects"], hasNot: ["payroll", "inventory"] });
  });

  it("serves an overrides-only dir: authored annotations with no generated semantics", () => {
    const merged = mergedSemanticsAndDomains({
      overrides: {
        format: VENDO_OVERRIDES_FORMAT,
        tools: {
          host_invoices_list: { semantics: { "data.total": { kind: "money", unit: "dollars" } } },
        },
        domains: { has: ["invoices", "clients"], hasNot: ["payroll"] },
      },
    });
    expect(merged?.semantics?.host_invoices_list).toEqual({
      "data.total": { kind: "money", unit: "dollars" },
    });
    expect(merged?.domains).toEqual({ has: ["invoices", "clients"], hasNot: ["payroll"] });
  });

  it("lets an authored domain classification win over the opposite generated one (no HAS+has-NO contradiction)", () => {
    const merged = mergedSemanticsAndDomains({
      tools: {
        format: VENDO_TOOLS_FORMAT,
        tools: [],
        domains: { has: ["payroll", "invoices"], hasNot: ["inventory"] },
      },
      overrides: {
        format: VENDO_OVERRIDES_FORMAT,
        tools: {},
        // The host corrects a bad auto-derivation: payroll is NOT covered,
        // inventory IS. Neither may appear on both sides after the merge.
        domains: { has: ["inventory"], hasNot: ["payroll"] },
      },
    });
    expect(merged?.domains?.has).toEqual(expect.arrayContaining(["invoices", "inventory"]));
    expect(merged?.domains?.has).not.toContain("payroll");
    expect(merged?.domains?.hasNot).toEqual(["payroll"]);
    expect(merged?.domains?.hasNot).not.toContain("inventory");
  });

  it("returns undefined when nothing applies", () => {
    expect(mergedSemanticsAndDomains({ tools: { format: VENDO_TOOLS_FORMAT, tools: [] } })).toBeUndefined();
    expect(mergedSemanticsAndDomains({})).toBeUndefined();
  });

  it("throws loudly on a malformed file", () => {
    expect(() => mergedSemanticsAndDomains({ tools: { format: "vendo/tools@3", tools: [{ nope: true }] } })).toThrow();
  });
});
