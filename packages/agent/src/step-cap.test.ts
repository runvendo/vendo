import { VendoError, vendoStepLimitPartSchema, type ToolDescriptor } from "@vendoai/core";
import { describe, expect, it } from "vitest";
import { createAgent } from "./index.js";
import {
  boundRegistry,
  ctx,
  readSse,
  scriptedModel,
  testGuard,
  textTurn,
  toolCallTurn,
  userMessage,
} from "./test-helpers.js";

const descriptor: ToolDescriptor = {
  name: "echo",
  description: "Return the supplied value.",
  inputSchema: {
    type: "object",
    properties: { value: { type: "string" } },
    required: ["value"],
    additionalProperties: false,
  },
  risk: "read",
};

function echoRegistry(guard = testGuard({})) {
  return boundRegistry({
    echo: { descriptor, execute: async (args) => args },
  }, guard);
}

function toolCallTurns(count: number) {
  return Array.from({ length: count }, (_, index) =>
    toolCallTurn("echo", { value: `v${index}` }, `call_step_${index}`));
}

describe("step cap (AGENT-7)", () => {
  it("stops at the configured cap and streams a visible step-limit notice", async () => {
    const model = scriptedModel(toolCallTurns(2));
    const guard = testGuard({});
    const agent = createAgent({
      model,
      tools: echoRegistry(guard),
      guard,
      context: { maxSteps: 2 },
    });

    const response = await agent.stream({
      threadId: "thr_step_cap",
      message: userMessage("user_step_cap", "Loop forever"),
      ctx: ctx(),
    });
    const { parts } = await readSse(response);

    expect(parts.filter((part) => part.type === "error")).toEqual([]);
    const notice = parts.find((part) => part.type === "data-vendo-step-limit");
    expect(notice).toBeDefined();
    const data = (notice as { data: Record<string, unknown> }).data;
    expect(data.limit).toBe(2);
    expect(typeof data.message).toBe("string");
    expect(vendoStepLimitPartSchema.safeParse({ type: "data-vendo-step-limit", ...data }).success).toBe(true);
    // The scripted model only carries `maxSteps` turns — reaching this point
    // without "scripted model exhausted" proves the loop stopped at the cap.
    expect(model.prompts).toHaveLength(2);
  });

  it("defaults to 20 steps and still surfaces exhaustion visibly", async () => {
    const model = scriptedModel(toolCallTurns(20));
    const guard = testGuard({});
    const agent = createAgent({ model, tools: echoRegistry(guard), guard });

    const response = await agent.stream({
      threadId: "thr_step_cap_default",
      message: userMessage("user_step_cap_default", "Loop forever"),
      ctx: ctx(),
    });
    const { parts } = await readSse(response);

    const notice = parts.find((part) => part.type === "data-vendo-step-limit");
    expect((notice as { data: { limit: number } } | undefined)?.data.limit).toBe(20);
    expect(model.prompts).toHaveLength(20);
  });

  it("a naturally finishing run emits no step-limit notice", async () => {
    const model = scriptedModel([
      toolCallTurn("echo", { value: "once" }, "call_natural"),
      textTurn("Done.", "text_natural"),
    ]);
    const guard = testGuard({});
    const agent = createAgent({
      model,
      tools: echoRegistry(guard),
      guard,
      context: { maxSteps: 5 },
    });

    const response = await agent.stream({
      threadId: "thr_step_natural",
      message: userMessage("user_step_natural", "Echo once"),
      ctx: ctx(),
    });
    const { parts } = await readSse(response);

    expect(parts.some((part) => part.type === "data-vendo-step-limit")).toBe(false);
  });

  it("rejects a non-positive or fractional maxSteps at construction", () => {
    const guard = testGuard({});
    for (const maxSteps of [0, -1, 1.5]) {
      expect(() => createAgent({
        model: scriptedModel([]),
        tools: echoRegistry(guard),
        guard,
        context: { maxSteps },
      })).toThrow(VendoError);
    }
  });
});
