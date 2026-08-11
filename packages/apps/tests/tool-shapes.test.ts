/**
 * The declaration is the producer of `toolShapes`.
 *
 * Both halves of the seam are real: a `ToolRegistry` descriptor carrying the
 * host's own `outputSchema` travels the SHIPPED path (`generationToolContext`)
 * and is read back through the SHIPPED reader (`AppsRuntime.toolShapeBrief`),
 * with no stub on either side — so the two cannot agree by construction.
 */
import {
  UNKNOWN_INPUT_SCHEMA_NOTE,
  UNKNOWN_OUTPUT_SHAPE_NOTE,
  type RunContext,
  type ToolCall,
  type ToolDescriptor,
  type ToolOutcome,
  type ToolRegistry,
} from "@vendoai/core";
import { describe, expect, it } from "vitest";
import { toolLine } from "../src/server/automation/plan.js";
import { createApps } from "../src/server/index.js";
import { guardFixture } from "../src/server/testing/guard-fixture.js";
import { memoryStore } from "../src/server/testing/memory-store.js";
import { scriptedLanguageModel } from "../src/server/testing/scripted-model.js";

const ctx: RunContext = {
  principal: { kind: "user", subject: "user_shapes" },
  venue: "chat",
  presence: "present",
  sessionId: "session_shapes",
};

class FixtureTools implements ToolRegistry {
  readonly executed: string[] = [];

  constructor(private readonly available: ToolDescriptor[]) {}

  async descriptors(): Promise<ToolDescriptor[]> {
    return this.available;
  }

  async execute(call: ToolCall): Promise<ToolOutcome> {
    this.executed.push(call.tool);
    return { status: "ok", output: { rows: [] } };
  }
}

const runtimeWith = (tools: ToolRegistry) => createApps({
  store: memoryStore(),
  guard: guardFixture(),
  tools,
  catalog: [],
  model: scriptedLanguageModel(() => '<App name="unused"/>'),
});

describe("declared output schemas produce the shape cards", () => {
  it("builds a tool's shape from its declared outputSchema, enum intact", async () => {
    const tools = new FixtureTools([{
      name: "host_getSpendingInsights",
      description: "Spending by category",
      risk: "read",
      inputSchema: { type: "object", properties: {} },
      outputSchema: {
        type: "object",
        properties: {
          data: {
            type: "array",
            items: {
              type: "object",
              properties: {
                category: { type: "string", enum: ["dining", "groceries"] },
                amount: { type: "integer" },
              },
              required: ["category", "amount"],
            },
          },
        },
        required: ["data"],
      },
    }]);
    const brief = await runtimeWith(tools).toolShapeBrief(ctx);
    expect(brief).toContain("host_getSpendingInsights");
    expect(brief).toContain('category: "dining" | "groceries"');
    expect(brief).toContain("amount: number");
  });

  it("lists EVERY tool: a schema'd one by shape, a blind one by the unknown sentence", async () => {
    const tools = new FixtureTools([
      {
        name: "host_listItems",
        description: "List items",
        risk: "read",
        inputSchema: { type: "object", properties: {} },
        outputSchema: { type: "object", properties: { data: { type: "array", items: { type: "string" } } }, required: ["data"] },
      },
      {
        name: "host_voice_create",
        description: "POST /api/voice",
        risk: "write",
        inputSchema: { type: "object", properties: {}, additionalProperties: true },
      },
    ]);
    const brief = await runtimeWith(tools).toolShapeBrief(ctx);

    expect(brief).toContain("host_listItems");
    expect(brief).toContain("{ data: string[] }");
    expect(brief).toContain("host_voice_create");
    expect(brief).toContain(UNKNOWN_OUTPUT_SHAPE_NOTE);
  });

  it("returns a section even when the product has no tools at all", async () => {
    const brief = await runtimeWith(new FixtureTools([])).toolShapeBrief(ctx);
    expect(typeof brief).toBe("string");
    expect(brief.length).toBeGreaterThan(0);
  });
});

describe("the automation planner's tool line", () => {
  it("distinguishes a declared no-argument tool from a blind one", () => {
    const declared = toolLine(
      { name: "host_listGoals", description: "Goals", risk: "read", inputSchema: { type: "object", properties: {} } },
      { kind: "object", fields: { data: { kind: "array", items: { kind: "string" } } } },
    );
    const blind = toolLine(
      { name: "host_voice_create", description: "Voice", risk: "write", inputSchema: { type: "object", properties: {}, additionalProperties: true } },
      undefined,
    );

    expect(declared).toContain("takes no arguments");
    expect(declared).not.toContain(UNKNOWN_INPUT_SCHEMA_NOTE);
    expect(declared).toContain("result shape: { data: string[] }");
    expect(blind).toContain(UNKNOWN_INPUT_SCHEMA_NOTE);
    expect(blind).toContain(UNKNOWN_OUTPUT_SHAPE_NOTE);
  });
});
