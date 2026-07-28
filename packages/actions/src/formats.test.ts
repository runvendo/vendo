import { describe, expect, it } from "vitest";
import {
  VENDO_OVERRIDES_FORMAT,
  VENDO_TOOLS_FORMAT,
  compoundBindingSchema,
  compoundToolSchema,
  overridesFileSchema,
  toolBindingSchema,
  toolsFileSchema,
  type CompoundBinding,
  type ToolBinding,
} from "./formats.js";

const step = (id: string, tool = "host_things_list"): { id: string; tool: string } => ({ id, tool });

const compoundTool = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  name: "host_invoice_send_flow",
  description: "Create an invoice and email it",
  inputSchema: { type: "object" },
  risk: "write",
  binding: {
    kind: "compound",
    steps: [
      { id: "create", tool: "host_invoices_create", args: { amount: "args.amount" } },
      { id: "send", tool: "host_invoices_send", if: "args.email != null", args: { id: "steps.create.id" } },
    ],
  },
  ...overrides,
});

describe("compoundBindingSchema", () => {
  it("accepts ordered steps reusing the core Step shape", () => {
    const binding: CompoundBinding = {
      kind: "compound",
      steps: [
        { id: "a", tool: "host_x", args: { q: "args.q" } },
        { id: "b", tool: "host_y", if: "steps.a.total > 0", forEach: "steps.a.items" },
      ],
    };
    expect(compoundBindingSchema.parse(binding)).toEqual(binding);
    // Type-level: the ToolBinding union accepts compound.
    const asUnion: ToolBinding = binding;
    expect(toolBindingSchema.safeParse(asUnion).success).toBe(true);
  });

  it("rejects zero steps", () => {
    expect(compoundBindingSchema.safeParse({ kind: "compound", steps: [] }).success).toBe(false);
  });

  it("rejects more than 50 steps", () => {
    const steps = Array.from({ length: 51 }, (_, index) => step(`s${index}`));
    expect(compoundBindingSchema.safeParse({ kind: "compound", steps }).success).toBe(false);
  });

  it("rejects duplicate step ids", () => {
    const result = compoundBindingSchema.safeParse({ kind: "compound", steps: [step("a"), step("a")] });
    expect(result.success).toBe(false);
    expect(JSON.stringify(!result.success && result.error.issues)).toContain("unique");
  });

  it("keeps unknown keys (passthrough, additive evolution)", () => {
    const parsed = compoundBindingSchema.parse({ kind: "compound", steps: [step("a")], future: true });
    expect((parsed as Record<string, unknown>).future).toBe(true);
  });
});

describe("compoundToolSchema", () => {
  it("entries carry disabled and note", () => {
    const parsed = compoundToolSchema.parse(compoundTool({ disabled: true, note: "authored by vendo refine" }));
    expect(parsed.disabled).toBe(true);
    expect(parsed.note).toBe("authored by vendo refine");
  });

  it("keeps unknown keys on an agent-authored entry (passthrough)", () => {
    const parsed = compoundToolSchema.parse(compoundTool({ provenance: { model: "x" } }));
    expect((parsed as Record<string, unknown>).provenance).toEqual({ model: "x" });
  });
});

// --- the .vendo pair: two files split by author ---

const extractedTool = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  name: "host_invoices_list",
  description: "List invoices",
  inputSchema: { type: "object" },
  risk: "read",
  binding: { kind: "route", method: "GET", path: "/api/invoices", argsIn: "query" },
  ...overrides,
});

const toolsFile = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  format: VENDO_TOOLS_FORMAT,
  tools: [extractedTool()],
  ...overrides,
});

const overridesFile = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  format: VENDO_OVERRIDES_FORMAT,
  tools: { host_invoices_list: { risk: "read" } },
  ...overrides,
});

describe("toolsFileSchema", () => {
  it("parses a v3 tools file with the new machine-layer fields", () => {
    const parsed = toolsFileSchema.parse(toolsFile({
      watermark: "3d1f2ab90c7e5f6a8b4d0e1c2a3b4c5d6e7f8091",
      domains: { has: ["invoices", "clients"], hasNot: ["payroll"] },
      tools: [extractedTool({
        audience: "end-user",
        semantics: { "data.amountCents": { kind: "money", unit: "cents" } },
        srcHash: "sha256:abc123",
      })],
    }));
    expect(parsed.watermark).toBe("3d1f2ab90c7e5f6a8b4d0e1c2a3b4c5d6e7f8091");
    expect(parsed.domains).toEqual({ has: ["invoices", "clients"], hasNot: ["payroll"] });
    expect(parsed.tools[0]?.audience).toBe("end-user");
    expect(parsed.tools[0]?.semantics).toEqual({ "data.amountCents": { kind: "money", unit: "cents" } });
    expect(parsed.tools[0]?.srcHash).toBe("sha256:abc123");
  });

  it("every new field is optional (a minimal generated file parses)", () => {
    expect(toolsFileSchema.safeParse(toolsFile()).success).toBe(true);
  });

  it("rejects any other format tag and bad audiences/semantics", () => {
    expect(toolsFileSchema.safeParse(toolsFile({ format: "vendo/tools@1" })).success).toBe(false);
    expect(toolsFileSchema.safeParse(toolsFile({ format: "vendo/tools@2" })).success).toBe(false);
    expect(toolsFileSchema.safeParse(toolsFile({ tools: [extractedTool({ audience: "everyone" })] })).success).toBe(false);
    expect(toolsFileSchema.safeParse(toolsFile({ tools: [extractedTool({ semantics: { x: { kind: "money" } } })] })).success).toBe(false);
  });

  it("keeps unknown keys (generated artifact, additive evolution)", () => {
    const parsed = toolsFileSchema.parse(toolsFile({ generatedBy: "vendo sync" }));
    expect((parsed as Record<string, unknown>).generatedBy).toBe("vendo sync");
  });

  it("keeps unknown keys inside the generated domains manifest too (the authored copy stays strict)", () => {
    const parsed = toolsFileSchema.parse(toolsFile({
      domains: { has: ["invoices"], hasNot: [], derivedFrom: "tool-names" },
    }));
    expect((parsed.domains as Record<string, unknown>).derivedFrom).toBe("tool-names");
  });

  it("stays deterministic: rejects compound bindings, pointing at overrides.json", () => {
    const result = toolsFileSchema.safeParse(toolsFile({ tools: [compoundTool()] }));
    expect(result.success).toBe(false);
    expect(JSON.stringify(!result.success && result.error.issues)).toContain("overrides.json");
  });
});

describe("overridesFileSchema", () => {
  it("parses the authored layer: per-tool overrides plus domains, compounds, briefs, remix", () => {
    const parsed = overridesFileSchema.parse(overridesFile({
      tools: {
        host_invoices_list: {
          risk: "write",
          critical: true,
          disabled: false,
          description: "List invoices for the signed-in client",
          audience: "end-user",
          semantics: { "data.amountCents": { kind: "money", unit: "cents", currency: "USD" } },
        },
      },
      domains: { has: ["projects"], hasNot: ["inventory"] },
      compounds: [compoundTool()],
      briefs: [{ name: "bulk-paste", text: "call host_cells_update per row", tools: ["host_cells_update"] }],
      remix: { ignoreSlots: ["invoice-card"] },
    }));
    expect(parsed.tools.host_invoices_list?.audience).toBe("end-user");
    expect(parsed.domains).toEqual({ has: ["projects"], hasNot: ["inventory"] });
    expect(parsed.compounds).toHaveLength(1);
    expect(parsed.briefs).toHaveLength(1);
    expect(parsed.remix).toEqual({ ignoreSlots: ["invoice-card"] });
  });

  it("stays strict: a typo at the file or per-tool level fails loudly", () => {
    expect(overridesFileSchema.safeParse(overridesFile({ compunds: [] })).success).toBe(false);
    expect(overridesFileSchema.safeParse(overridesFile({ tools: { host_x: { descriptin: "typo" } } })).success).toBe(false);
    expect(overridesFileSchema.safeParse(overridesFile({ domains: { has: [], hasNot: [], hasMaybe: [] } })).success).toBe(false);
    expect(overridesFileSchema.safeParse(overridesFile({ format: "vendo/overrides@1" })).success).toBe(false);
  });

  it("compounds and briefs keep their passthrough behavior (agent-authored entries)", () => {
    const parsed = overridesFileSchema.parse(overridesFile({
      compounds: [compoundTool({ provenance: { model: "x" } })],
      briefs: [{ name: "bulk", text: "do the thing", future: true }],
    }));
    expect((parsed.compounds?.[0] as Record<string, unknown>).provenance).toEqual({ model: "x" });
    expect((parsed.briefs?.[0] as Record<string, unknown>).future).toBe(true);
  });
});

