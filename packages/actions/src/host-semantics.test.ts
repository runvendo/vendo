import { describe, expect, it } from "vitest";
import { VENDO_OVERRIDES_FORMAT, VENDO_TOOLS_FORMAT } from "./formats.js";
import { mergedHostSemantics } from "./host-semantics.js";

describe("mergedHostSemantics", () => {
  it("overlays override semantics field-by-field over the .vendo pair", () => {
    const merged = mergedHostSemantics({
      tools: {
        format: VENDO_TOOLS_FORMAT,
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
      },
    });
    expect(merged).toEqual({
      host_invoices_list: {
        "data.amountCents": { kind: "money", unit: "cents", currency: "USD" },
        "data.dueAt": { kind: "date", format: "iso" },
        "data.progress": { kind: "percent", scale: "ratio" },
      },
    });
  });

  it("serves an overrides-only dir: authored annotations with no generated semantics", () => {
    const merged = mergedHostSemantics({
      overrides: {
        format: VENDO_OVERRIDES_FORMAT,
        tools: {
          host_invoices_list: { semantics: { "data.total": { kind: "money", unit: "dollars" } } },
        },
      },
    });
    expect(merged?.host_invoices_list).toEqual({
      "data.total": { kind: "money", unit: "dollars" },
    });
  });

  it("returns undefined when nothing applies", () => {
    expect(mergedHostSemantics({ tools: { format: VENDO_TOOLS_FORMAT, tools: [] } })).toBeUndefined();
    expect(mergedHostSemantics({})).toBeUndefined();
  });

  it("throws loudly on a malformed file", () => {
    expect(() => mergedHostSemantics({ tools: { format: "vendo/tools@3", tools: [{ nope: true }] } })).toThrow();
  });
});
