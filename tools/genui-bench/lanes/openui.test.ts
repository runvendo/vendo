/**
 * Contract test for the OpenUI adapter. Canned model responses (hand-authored
 * openui-lang, NOT live recordings — no key was burned on fixtures) play back
 * through the real extract → parse → findings path via the generate seam; the
 * parser is @openuidev/lang-core's real one over the real react-ui library.
 * No live API calls, ever.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createOpenUIAdapter,
  extractProgram,
  shapeToJsonSchema,
  toToolSpecs,
  type OpenUIGenerate,
  type OpenUIRaw,
} from "./openui";
import type { HostFixture } from "../runner/types";
import { stubHostFixture } from "../fixtures/stub";

const PROGRAM = [
  'clients = Query("host_listClients", {}, [])',
  'tbl = Table([Col("Business", clients.businessName), Col("Status", clients.status)])',
  'root = Stack([CardHeader("Clients"), tbl])',
].join("\n");

const host: HostFixture = stubHostFixture("cadence", {
  tools: [
    { name: "host_listClients", description: "List the firm's clients", risk: "read" },
    { name: "host_sendClientMessage", description: "Message a client", risk: "medium" },
  ],
  shapes: {
    host_listClients: {
      kind: "array",
      items: {
        kind: "object",
        fields: { businessName: { kind: "string" }, status: { kind: "string" } },
      },
    },
  },
  execute: vi.fn(async () => []),
});

describe("openui adapter", () => {
  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = "test-key";
  });
  afterEach(() => {
    delete process.env.ANTHROPIC_API_KEY;
    vi.restoreAllMocks();
  });

  it("returns no-key without ANTHROPIC_API_KEY", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const adapter = createOpenUIAdapter({ generate: async () => PROGRAM });
    await expect(adapter.generate("hi", host)).resolves.toEqual({ status: "no-key" });
  });

  it("prompts with their library + the fixture's tools, and parses the returned program", async () => {
    const generate = vi.fn<OpenUIGenerate>(async () => PROGRAM);
    const adapter = createOpenUIAdapter({ generate });
    const result = await adapter.generate("show my clients", host);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;

    // The system prompt is their library's own prompt() with our tools in it.
    const call = generate.mock.calls[0]![0];
    expect(call.prompt).toBe("show my clients");
    expect(call.system).toContain("host_listClients");
    expect(call.system).toContain("host_sendClientMessage");

    const raw = result.raw as OpenUIRaw;
    expect(raw.program).toBe(PROGRAM);
    expect(raw.toolsReferenced).toEqual(["host_listClients"]);
    expect(raw.toolsUnknown).toEqual([]);
    expect(result.findings).toEqual([]);
  });

  it("strips markdown fences from a chatty response", () => {
    expect(extractProgram("Here is the app:\n```openui-lang\n" + PROGRAM + "\n```\nEnjoy!")).toBe(PROGRAM);
    expect(extractProgram(PROGRAM)).toBe(PROGRAM);
  });

  it("reports a bound tool the host does not expose as a warn finding, still ok", async () => {
    const hallucinated = [
      'spend = Query("host_getSpending", {}, [])',
      'root = Stack([CardHeader("Spending"), Table([Col("Amount", spend.amount)])])',
    ].join("\n");
    const adapter = createOpenUIAdapter({ generate: async () => hallucinated });
    const result = await adapter.generate("spending", host);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect((result.raw as OpenUIRaw).toolsUnknown).toEqual(["host_getSpending"]);
    expect(result.findings).toHaveLength(1);
    expect(result.findings?.[0]).toMatchObject({ severity: "warn", where: 'tool "host_getSpending"' });
  });

  it("fails when their parser rejects the program (unknown component)", async () => {
    const adapter = createOpenUIAdapter({ generate: async () => 'root = NotAComponent("x")' });
    const result = await adapter.generate("hi", host);
    expect(result.status).toBe("failed");
    if (result.status !== "failed") return;
    expect(result.error).toContain("their parser rejected the program");
    expect(result.error).toContain("NotAComponent");
  });

  it("never throws: a generation crash becomes status failed", async () => {
    const adapter = createOpenUIAdapter({
      generate: async () => {
        throw new Error("529 overloaded");
      },
    });
    const result = await adapter.generate("hi", host);
    expect(result.status).toBe("failed");
    if (result.status === "failed") expect(result.error).toContain("529 overloaded");
  });

  it("translates shape cards to JSON Schema with optionality", () => {
    expect(
      shapeToJsonSchema({
        kind: "object",
        fields: { id: { kind: "string" }, note: { kind: "string" } },
        optional: ["note"],
      }),
    ).toEqual({
      type: "object",
      properties: { id: { type: "string" }, note: { type: "string" } },
      required: ["id"],
    });
    const specs = toToolSpecs(host);
    expect(specs.map((spec) => spec.name)).toEqual(["host_listClients", "host_sendClientMessage"]);
    expect(specs[0]?.annotations).toEqual({ readOnlyHint: true });
    expect(specs[1]?.annotations).toEqual({ readOnlyHint: false });
    expect(specs[1]?.outputSchema).toEqual({});
  });
});
