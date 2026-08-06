/**
 * The declaration is the producer of `toolShapes`.
 *
 * Both halves of the seam are real: a `ToolRegistry` descriptor carrying the
 * host's own `outputSchema` travels the SHIPPED path (`generationToolContext`)
 * and is read back through the SHIPPED reader (`AppsRuntime.toolShapeBrief`),
 * with no stub on either side — so the two cannot agree by construction.
 */
import type { RunContext, ToolCall, ToolDescriptor, ToolOutcome, ToolRegistry } from "@vendoai/core";
import { describe, expect, it } from "vitest";
import { createApps } from "./index.js";
import { guardFixture, memoryStore, scriptedLanguageModel } from "./testing/index.js";

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
});
