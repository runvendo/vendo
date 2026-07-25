import { describe, expect, it } from "vitest";
import type { SemanticsFile } from "@vendoai/core";
import {
  VENDO_OVERRIDES_FORMAT_V3,
  VENDO_TOOLS_FORMAT_V3,
  overridesFileV3Schema,
  toolsFileV3Schema,
  type CapabilitiesFile,
  type OverridesFile,
  type ToolsFile,
} from "./formats.js";
import { mergedSemanticsAndDomains, migrateLegacyVendoDir } from "./migrate.js";

// Realistic legacy fixtures, shaped by the v1 schemas the migration reads.

const legacyTools: ToolsFile = {
  format: "vendo/tools@1",
  tools: [
    {
      name: "host_invoices_list",
      description: "List invoices",
      inputSchema: { type: "object", properties: { status: { type: "string" } } },
      risk: "read",
      binding: { kind: "route", method: "GET", path: "/api/invoices", argsIn: "query" },
    },
    {
      name: "host_invoices_create",
      description: "Create an invoice",
      inputSchema: { type: "object" },
      risk: "write",
      binding: { kind: "trpc", procedure: "invoices.create", type: "mutation", mount: "/api/trpc" },
      disabled: true,
      note: "scanner could not classify auth",
    },
  ],
};

const legacyOverrides: OverridesFile = {
  format: "vendo/overrides@1",
  tools: {
    host_invoices_create: { risk: "destructive", critical: true, audience: "end-user" },
    host_invoices_list: { semantics: { "data.total": { kind: "money", unit: "dollars" } } },
  },
  remix: { ignoreSlots: ["invoice-card"] },
};

const legacyCapabilities: CapabilitiesFile = {
  format: "vendo/capabilities@1",
  tools: [{
    name: "host_invoice_send_flow",
    description: "Create an invoice and email it",
    inputSchema: { type: "object" },
    risk: "write",
    binding: {
      kind: "compound",
      steps: [{ id: "create", tool: "host_invoices_create", args: { amount: "args.amount" } }],
    },
    note: "authored by vendo refine",
  }],
  briefs: [{ name: "bulk-paste", text: "call host_cells_update per row", tools: ["host_invoices_create"] }],
};

const legacySemantics: SemanticsFile = {
  format: "vendo/semantics@1",
  tools: {
    host_invoices_list: { "data.amountCents": { kind: "money", unit: "cents" }, "data.dueAt": { kind: "date", format: "iso" } },
    host_removed_tool: { "data.id": { kind: "id", entity: "invoice" } },
  },
  domains: { has: ["invoices", "clients"], hasNot: ["payroll"] },
};

describe("migrateLegacyVendoDir", () => {
  it("folds the legacy four files into the v3 pair", () => {
    const migrated = migrateLegacyVendoDir({
      tools: legacyTools,
      overrides: legacyOverrides,
      capabilities: legacyCapabilities,
      semantics: legacySemantics,
    });

    expect(migrated.tools.format).toBe(VENDO_TOOLS_FORMAT_V3);
    expect(migrated.tools.tools).toHaveLength(2);
    // semantics.json tool entries fold onto the matching tools@3 entries...
    expect(migrated.tools.tools[0]).toMatchObject({
      name: "host_invoices_list",
      semantics: { "data.amountCents": { kind: "money", unit: "cents" }, "data.dueAt": { kind: "date", format: "iso" } },
    });
    // ...tools without an entry stay bare, and stale entries drop.
    expect(migrated.tools.tools[1]?.semantics).toBeUndefined();
    expect(migrated.tools.tools[1]).toMatchObject({ name: "host_invoices_create", disabled: true, note: "scanner could not classify auth" });
    // semantics.json domains become the generated manifest.
    expect(migrated.tools.domains).toEqual({ has: ["invoices", "clients"], hasNot: ["payroll"] });

    expect(migrated.overrides.format).toBe(VENDO_OVERRIDES_FORMAT_V3);
    expect(migrated.overrides.tools).toEqual(legacyOverrides.tools);
    expect(migrated.overrides.remix).toEqual({ ignoreSlots: ["invoice-card"] });
    expect(migrated.overrides.compounds).toEqual(legacyCapabilities.tools);
    expect(migrated.overrides.briefs).toEqual(legacyCapabilities.briefs);
  });

  it("round-trips through the v3 schemas", () => {
    const migrated = migrateLegacyVendoDir({
      tools: legacyTools,
      overrides: legacyOverrides,
      capabilities: legacyCapabilities,
      semantics: legacySemantics,
    });
    expect(toolsFileV3Schema.safeParse(migrated.tools).success).toBe(true);
    expect(overridesFileV3Schema.safeParse(migrated.overrides).success).toBe(true);
  });

  it("accepts any subset of the legacy files", () => {
    const empty = migrateLegacyVendoDir({});
    expect(empty.tools).toEqual({ format: VENDO_TOOLS_FORMAT_V3, tools: [] });
    expect(empty.overrides).toEqual({ format: VENDO_OVERRIDES_FORMAT_V3, tools: {} });

    const capabilitiesOnly = migrateLegacyVendoDir({ capabilities: legacyCapabilities });
    expect(capabilitiesOnly.overrides.compounds).toEqual(legacyCapabilities.tools);
    expect(capabilitiesOnly.overrides.briefs).toEqual(legacyCapabilities.briefs);
    expect(capabilitiesOnly.tools.tools).toEqual([]);

    const semanticsOnly = migrateLegacyVendoDir({ semantics: legacySemantics });
    expect(semanticsOnly.tools.domains).toEqual(legacySemantics.domains);
    expect(semanticsOnly.tools.tools).toEqual([]);
  });

  it("omits empty compounds/briefs so the authored file stays clean", () => {
    const migrated = migrateLegacyVendoDir({
      capabilities: { format: "vendo/capabilities@1", tools: [] },
    });
    expect(migrated.overrides.compounds).toBeUndefined();
    expect(migrated.overrides.briefs).toBeUndefined();
  });
});

describe("mergedSemanticsAndDomains", () => {
  it("overlays override semantics field-by-field and unions domains over a v3 pair", () => {
    const merged = mergedSemanticsAndDomains({
      tools: {
        format: VENDO_TOOLS_FORMAT_V3,
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
        format: VENDO_OVERRIDES_FORMAT_V3,
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

  it("serves a legacy dir: semantics.json map + domains, with v1 override annotations on top", () => {
    const merged = mergedSemanticsAndDomains({
      tools: legacyTools,
      overrides: legacyOverrides,
      semantics: legacySemantics,
    });
    expect(merged?.semantics?.host_invoices_list).toEqual({
      "data.amountCents": { kind: "money", unit: "cents" },
      "data.dueAt": { kind: "date", format: "iso" },
      "data.total": { kind: "money", unit: "dollars" },
    });
    expect(merged?.domains).toEqual({ has: ["invoices", "clients"], hasNot: ["payroll"] });
  });

  it("lets an authored domain classification win over the opposite generated one (no HAS+has-NO contradiction)", () => {
    const merged = mergedSemanticsAndDomains({
      tools: {
        format: VENDO_TOOLS_FORMAT_V3,
        tools: [],
        domains: { has: ["payroll", "invoices"], hasNot: ["inventory"] },
      },
      overrides: {
        format: VENDO_OVERRIDES_FORMAT_V3,
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

  it("ignores a stale semantics.json once tools.json is v3, and returns undefined when nothing applies", () => {
    const staleOnly = mergedSemanticsAndDomains({
      tools: { format: VENDO_TOOLS_FORMAT_V3, tools: [] },
      semantics: legacySemantics,
    });
    expect(staleOnly).toBeUndefined();
    expect(mergedSemanticsAndDomains({})).toBeUndefined();
  });

  it("throws loudly on a malformed file", () => {
    expect(() => mergedSemanticsAndDomains({ tools: { format: "vendo/tools@3", tools: [{ nope: true }] } })).toThrow();
  });
});
