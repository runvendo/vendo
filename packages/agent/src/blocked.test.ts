import type { ToolDescriptor } from "@vendoai/core";
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
} from "./test-helpers.js";

const descriptor: ToolDescriptor = {
  name: "blocked_write",
  description: "A write blocked by test policy.",
  inputSchema: {
    type: "object",
    properties: { value: { type: "string" } },
    required: ["value"],
    additionalProperties: false,
  },
  risk: "write",
};

describe("blocked tool outcomes", () => {
  it("streams the blocked outcome verbatim and includes its reason in the next model prompt", async () => {
    const model = scriptedModel([
      toolCallTurn(descriptor.name, { value: "unsafe" }, "call_blocked"),
      textTurn("I cannot perform that action.", "text_blocked_done"),
    ]);
    const guard = testGuard({ [descriptor.name]: "block" });
    const tools = boundRegistry({
      [descriptor.name]: {
        descriptor,
        execute: async () => ({ shouldNotRun: true }),
      },
    }, guard);
    const agent = createAgent({ model, tools, guard });

    const response = await agent.stream({
      threadId: "thr_blocked",
      message: {
        id: "user_blocked",
        role: "user",
        parts: [{ type: "text", text: "Do the blocked write" }],
      },
      ctx: ctx(),
    });
    const { parts } = await readSse(response);

    expect(parts.find((part) => part.type === "tool-output-available")).toEqual({
      type: "tool-output-available",
      toolCallId: "call_blocked",
      output: { status: "blocked", reason: "blocked" },
      dynamic: true,
    });
    expect(tools.invocations.blocked_write).toBe(0);
    expect(model.prompts).toHaveLength(2);
    expect(JSON.stringify(model.prompts[1])).toContain("blocked");
    expect(parts.some((part) => part.type === "text-delta" && part.delta === "I cannot perform that action.")).toBe(true);
    expect(parts.at(-1)).toEqual({ type: "finish", finishReason: "stop" });
  });
});
