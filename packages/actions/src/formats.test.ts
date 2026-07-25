import { describe, expect, it } from "vitest";
import {
  VENDO_OVERRIDES_FORMAT_V3,
  VENDO_TOOLS_FORMAT_V3,
  capabilitiesFileSchema,
  compoundBindingSchema,
  compoundToolSchema,
  overridesFileV3Schema,
  toolBindingSchema,
  toolsFileSchema,
  toolsFileV3Schema,
  vendoFileVersion,
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

const capabilitiesFile = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  format: "vendo/capabilities@1",
  tools: [compoundTool()],
  briefs: [{ name: "bulk-paste", text: "call host_cells_update per row", tools: ["host_cells_update"] }],
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

describe("capabilitiesFileSchema", () => {
  it("parses a valid capabilities file", () => {
    const parsed = capabilitiesFileSchema.parse(capabilitiesFile());
    expect(parsed.tools).toHaveLength(1);
    expect(parsed.briefs).toHaveLength(1);
  });

  it("rejects any other format string", () => {
    expect(capabilitiesFileSchema.safeParse(capabilitiesFile({ format: "vendo/capabilities@2" })).success).toBe(false);
    expect(capabilitiesFileSchema.safeParse(capabilitiesFile({ format: "vendo/tools@1" })).success).toBe(false);
  });

  it("briefs are optional and validated", () => {
    expect(capabilitiesFileSchema.safeParse(capabilitiesFile({ briefs: undefined })).success).toBe(true);
    expect(capabilitiesFileSchema.safeParse(capabilitiesFile({ briefs: [{ name: "", text: "x" }] })).success).toBe(false);
    expect(capabilitiesFileSchema.safeParse(capabilitiesFile({ briefs: [{ name: "x", text: "" }] })).success).toBe(false);
  });

  it("accepts unknown extra keys on file and entries (passthrough)", () => {
    const parsed = capabilitiesFileSchema.parse(capabilitiesFile({
      generatedBy: "vendo refine",
      tools: [compoundTool({ provenance: { model: "x" } })],
    }));
    expect((parsed as Record<string, unknown>).generatedBy).toBe("vendo refine");
    expect((parsed.tools[0] as Record<string, unknown>).provenance).toEqual({ model: "x" });
  });

  it("entries carry disabled and note", () => {
    const parsed = compoundToolSchema.parse(compoundTool({ disabled: true, note: "authored by vendo refine" }));
    expect(parsed.disabled).toBe(true);
    expect(parsed.note).toBe("authored by vendo refine");
  });
});

describe("toolsFileSchema stays deterministic", () => {
  it("rejects a tools.json entry with a compound binding, pointing at capabilities.json", () => {
    const result = toolsFileSchema.safeParse({
      format: "vendo/tools@1",
      tools: [compoundTool()],
    });
    expect(result.success).toBe(false);
    expect(JSON.stringify(!result.success && result.error.issues)).toContain("capabilities.json");
  });

  it("still accepts route and openapi bindings", () => {
    const result = toolsFileSchema.safeParse({
      format: "vendo/tools@1",
      tools: [{
        name: "host_things_list",
        description: "List things",
        inputSchema: { type: "object" },
        risk: "read",
        binding: { kind: "route", method: "GET", path: "/api/things", argsIn: "query" },
      }],
    });
    expect(result.success).toBe(true);
  });
});

// --- format v3 (cse lane 1): two files split by author ---

const extractedToolV3 = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  name: "host_invoices_list",
  description: "List invoices",
  inputSchema: { type: "object" },
  risk: "read",
  binding: { kind: "route", method: "GET", path: "/api/invoices", argsIn: "query" },
  ...overrides,
});

const toolsFileV3 = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  format: VENDO_TOOLS_FORMAT_V3,
  tools: [extractedToolV3()],
  ...overrides,
});

const overridesFileV3 = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  format: VENDO_OVERRIDES_FORMAT_V3,
  tools: { host_invoices_list: { risk: "read" } },
  ...overrides,
});

describe("toolsFileV3Schema", () => {
  it("parses a v3 tools file with the new machine-layer fields", () => {
    const parsed = toolsFileV3Schema.parse(toolsFileV3({
      watermark: "3d1f2ab90c7e5f6a8b4d0e1c2a3b4c5d6e7f8091",
      domains: { has: ["invoices", "clients"], hasNot: ["payroll"] },
      tools: [extractedToolV3({
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
    expect(toolsFileV3Schema.safeParse(toolsFileV3()).success).toBe(true);
  });

  it("rejects the v1 format tag and bad audiences/semantics", () => {
    expect(toolsFileV3Schema.safeParse(toolsFileV3({ format: "vendo/tools@1" })).success).toBe(false);
    expect(toolsFileV3Schema.safeParse(toolsFileV3({ tools: [extractedToolV3({ audience: "everyone" })] })).success).toBe(false);
    expect(toolsFileV3Schema.safeParse(toolsFileV3({ tools: [extractedToolV3({ semantics: { x: { kind: "money" } } })] })).success).toBe(false);
  });

  it("keeps unknown keys (generated artifact, additive evolution)", () => {
    const parsed = toolsFileV3Schema.parse(toolsFileV3({ generatedBy: "vendo sync" }));
    expect((parsed as Record<string, unknown>).generatedBy).toBe("vendo sync");
  });

  it("stays deterministic: rejects compound bindings, pointing at overrides.json", () => {
    const result = toolsFileV3Schema.safeParse(toolsFileV3({ tools: [compoundTool()] }));
    expect(result.success).toBe(false);
    expect(JSON.stringify(!result.success && result.error.issues)).toContain("overrides.json");
  });
});

describe("overridesFileV3Schema", () => {
  it("parses the authored layer: per-tool overrides plus domains, compounds, briefs, remix", () => {
    const parsed = overridesFileV3Schema.parse(overridesFileV3({
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
    expect(overridesFileV3Schema.safeParse(overridesFileV3({ compunds: [] })).success).toBe(false);
    expect(overridesFileV3Schema.safeParse(overridesFileV3({ tools: { host_x: { descriptin: "typo" } } })).success).toBe(false);
    expect(overridesFileV3Schema.safeParse(overridesFileV3({ domains: { has: [], hasNot: [], hasMaybe: [] } })).success).toBe(false);
    expect(overridesFileV3Schema.safeParse(overridesFileV3({ format: "vendo/overrides@1" })).success).toBe(false);
  });

  it("compounds and briefs keep their passthrough behavior (agent-authored entries)", () => {
    const parsed = overridesFileV3Schema.parse(overridesFileV3({
      compounds: [compoundTool({ provenance: { model: "x" } })],
      briefs: [{ name: "bulk", text: "do the thing", future: true }],
    }));
    expect((parsed.compounds?.[0] as Record<string, unknown>).provenance).toEqual({ model: "x" });
    expect((parsed.briefs?.[0] as Record<string, unknown>).future).toBe(true);
  });
});

describe("vendoFileVersion", () => {
  it("classifies v1 and v3 tools/overrides files by format tag", () => {
    expect(vendoFileVersion({ format: "vendo/tools@1", tools: [] })).toBe(1);
    expect(vendoFileVersion({ format: "vendo/overrides@1", tools: {} })).toBe(1);
    expect(vendoFileVersion(toolsFileV3())).toBe(3);
    expect(vendoFileVersion(overridesFileV3())).toBe(3);
  });

  it("returns undefined for unknown tags and non-objects", () => {
    expect(vendoFileVersion({ format: "vendo/tools@2" })).toBeUndefined();
    expect(vendoFileVersion({ format: "vendo/catalog@1" })).toBeUndefined();
    expect(vendoFileVersion({})).toBeUndefined();
    expect(vendoFileVersion(null)).toBeUndefined();
    expect(vendoFileVersion("vendo/tools@3")).toBeUndefined();
  });
});
