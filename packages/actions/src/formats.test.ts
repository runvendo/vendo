import { describe, expect, it } from "vitest";
import {
  capabilitiesFileSchema,
  compoundBindingSchema,
  compoundToolSchema,
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
