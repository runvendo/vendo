import { describe, expect, it } from "vitest";
import {
  VENDO_JUDGMENTS_FORMAT,
  VENDO_OVERRIDES_FORMAT,
  VENDO_TOOLS_FORMAT,
  compoundBindingSchema,
  compoundToolSchema,
  extractedToolSchema,
  judgmentsFileSchema,
  overridesFileSchema,
  toolBindingSchema,
  toolsFileSchema,
  type CompoundBinding,
  type JudgmentsFile,
  type ToolBinding,
} from "../src/formats.js";

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
      tools: [extractedTool({
        audience: "end-user",
        semantics: { "data.amountCents": { kind: "money", unit: "cents" } },
        srcHash: "sha256:abc123",
      })],
    }));
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

  it("stays deterministic: rejects compound bindings, pointing at overrides.json", () => {
    const result = toolsFileSchema.safeParse(toolsFile({ tools: [compoundTool()] }));
    expect(result.success).toBe(false);
    expect(JSON.stringify(!result.success && result.error.issues)).toContain("overrides.json");
  });
});

describe("overridesFileSchema", () => {
  it("parses the authored layer: per-tool overrides plus compounds, briefs, remix", () => {
    const parsed = overridesFileSchema.parse(overridesFile({
      tools: {
        host_invoices_list: {
          risk: "write",
          confirmEach: true,
          disabled: false,
          description: "List invoices for the signed-in client",
          audience: "end-user",
          semantics: { "data.amountCents": { kind: "money", unit: "cents", currency: "USD" } },
        },
      },
      compounds: [compoundTool()],
      briefs: [{ name: "bulk-paste", text: "call host_cells_update per row", tools: ["host_cells_update"] }],
      remix: { ignoreSlots: ["invoice-card"] },
    }));
    expect(parsed.tools.host_invoices_list?.audience).toBe("end-user");
    expect(parsed.compounds).toHaveLength(1);
    expect(parsed.briefs).toHaveLength(1);
    expect(parsed.remix).toEqual({ ignoreSlots: ["invoice-card"] });
  });

  it("stays strict: a typo at the file or per-tool level fails loudly", () => {
    expect(overridesFileSchema.safeParse(overridesFile({ compunds: [] })).success).toBe(false);
    expect(overridesFileSchema.safeParse(overridesFile({ tools: { host_x: { descriptin: "typo" } } })).success).toBe(false);
    // a REMOVED key is a typo now: the deleted domains manifest fails loudly
    // rather than being silently ignored.
    expect(overridesFileSchema.safeParse(overridesFile({ domains: { has: [] } })).success).toBe(false);
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


// --- the third file: .vendo/judgments.json (the AI layer) ---

const judgment = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  binding: "GET /api/invoices",
  evidence: "return NextResponse.json(await db.invoice.findMany())",
  fields: { description: "List the signed-in client's invoices", risk: "read" },
  ...overrides,
});

const judgmentsFile = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  format: VENDO_JUDGMENTS_FORMAT,
  tools: { host_invoices_list: judgment() },
  ...overrides,
});

describe("judgmentsFileSchema", () => {
  it("parses a judgments file with fields, srcHash, and queued loosenings", () => {
    const parsed = judgmentsFileSchema.parse(judgmentsFile({
      tools: {
        host_invoices_list: judgment({
          srcHash: "sha256:abc123",
          fields: {
            description: "List the signed-in client's invoices",
            title: "List invoices",
            risk: "read",
            confirmEach: true,
            disabled: true,
            audience: "operator",
            semantics: { "data.amountCents": { kind: "money", unit: "cents" } },
          },
          pending: [
            { field: "disabled", value: false, evidence: "the handler filters by session.userId", reason: "safe for end users" },
            { field: "risk", value: "read", evidence: "no writes in the handler" },
          ],
        }),
      },
    }));
    const entry = parsed.tools.host_invoices_list!;
    expect(entry.binding).toBe("GET /api/invoices");
    expect(entry.srcHash).toBe("sha256:abc123");
    expect(entry.fields.semantics).toEqual({ "data.amountCents": { kind: "money", unit: "cents" } });
    expect(entry.pending).toHaveLength(2);
    expect(entry.pending?.[0]).toMatchObject({ field: "disabled", value: false });
    // Type-level: the declared interface is what the schema parses.
    const typed: JudgmentsFile = parsed;
    expect(typed.format).toBe("vendo/judgments@1");
  });

  it("requires evidence at BOTH levels — an unevidenced judgment or loosening fails loudly", () => {
    const { evidence: _dropped, ...noEvidence } = judgment();
    expect(judgmentsFileSchema.safeParse(judgmentsFile({ tools: { host_x: noEvidence } })).success).toBe(false);
    expect(judgmentsFileSchema.safeParse(judgmentsFile({ tools: { host_x: judgment({ evidence: "" }) } })).success).toBe(false);
    expect(judgmentsFileSchema.safeParse(judgmentsFile({
      tools: { host_x: judgment({ pending: [{ field: "disabled", value: false }] }) },
    })).success).toBe(false);
    expect(judgmentsFileSchema.safeParse(judgmentsFile({
      tools: { host_x: judgment({ pending: [{ field: "disabled", value: false, evidence: "" }] }) },
    })).success).toBe(false);
  });

  it("bounds evidence and prose so a model cannot smuggle a document into the file", () => {
    const long = "x".repeat(501);
    expect(judgmentsFileSchema.safeParse(judgmentsFile({ tools: { host_x: judgment({ evidence: long }) } })).success).toBe(false);
    expect(judgmentsFileSchema.safeParse(judgmentsFile({
      tools: { host_x: judgment({ pending: [{ field: "risk", value: "read", evidence: long }] }) },
    })).success).toBe(false);
    expect(judgmentsFileSchema.safeParse(judgmentsFile({
      tools: { host_x: judgment({ fields: { description: long } }) },
    })).success).toBe(false);
    expect(judgmentsFileSchema.safeParse(judgmentsFile({
      tools: { host_x: judgment({ fields: { title: "y".repeat(61) } }) },
    })).success).toBe(false);
    expect(judgmentsFileSchema.safeParse(judgmentsFile({
      tools: { host_x: judgment({ pending: [{ field: "risk", value: "read", evidence: "ok", reason: "z".repeat(301) }] }) },
    })).success).toBe(false);
  });

  it("only the four capability fields can be queued as a pending loosening", () => {
    for (const field of ["risk", "confirmEach", "disabled", "audience"]) {
      expect(judgmentsFileSchema.safeParse(judgmentsFile({
        tools: { host_x: judgment({ pending: [{ field, value: "x", evidence: "quoted handler line" }] }) },
      })).success).toBe(true);
    }
    // Prose is never a loosening — it routes with the hardenings.
    expect(judgmentsFileSchema.safeParse(judgmentsFile({
      tools: { host_x: judgment({ pending: [{ field: "description", value: "x", evidence: "quoted handler line" }] }) },
    })).success).toBe(false);
  });

  it("rejects a wrong format tag and a malformed field value", () => {
    expect(judgmentsFileSchema.safeParse(judgmentsFile({ format: "vendo/judgments@2" })).success).toBe(false);
    expect(judgmentsFileSchema.safeParse(judgmentsFile({ tools: { host_x: judgment({ fields: { risk: "nuclear" } }) } })).success).toBe(false);
    expect(judgmentsFileSchema.safeParse(judgmentsFile({ tools: { host_x: judgment({ fields: { disabled: "true" } }) } })).success).toBe(false);
    expect(judgmentsFileSchema.safeParse(judgmentsFile({ tools: { host_x: judgment({ binding: "" }) } })).success).toBe(false);
  });

  it("keeps unknown keys at the FILE level (generated-artifact convention, additive evolution)", () => {
    const parsed = judgmentsFileSchema.parse(judgmentsFile({ generatedAt: "2026-07-28" }));
    expect((parsed as Record<string, unknown>).generatedAt).toBe("2026-07-28");
  });

  it("stays strict inside `fields`: the deterministic skeleton is not expressible there", () => {
    // The whole safety story is that a judgment cannot touch identity, bindings
    // or schemas. `fields` is passthrough → a model smuggles `binding` in and
    // applyJudgment spreads it onto the tool. It must fail loudly instead.
    for (const smuggled of [
      { binding: { kind: "route", method: "DELETE", path: "/api/wipe", argsIn: "body" } },
      { inputSchema: { type: "object" } },
      { name: "host_something_else" },
      { descriptin: "typo" },
    ]) {
      expect(
        judgmentsFileSchema.safeParse(judgmentsFile({ tools: { host_x: judgment({ fields: smuggled }) } })).success,
        JSON.stringify(smuggled),
      ).toBe(false);
    }
  });
});

describe("schema source markers", () => {
  it("parses both markers and rejects an invented rung", () => {
    const base = {
      name: "host_items_list",
      description: "List items",
      inputSchema: { type: "object", properties: {} },
      risk: "read",
      binding: { kind: "route", method: "GET", path: "/api/items", argsIn: "query" },
    };
    const parsed = extractedToolSchema.parse({ ...base, inputSchemaSource: "declared", outputSchemaSource: "unknown" });
    expect(parsed).toMatchObject({ inputSchemaSource: "declared", outputSchemaSource: "unknown" });
    // Absence is legal — a pre-marker file still parses.
    expect(extractedToolSchema.safeParse(base).success).toBe(true);
    expect(extractedToolSchema.safeParse({ ...base, inputSchemaSource: "guessed" }).success).toBe(false);
  });
});
