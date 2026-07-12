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
  name: "send_echo",
  description: "Send an echo through a write path.",
  inputSchema: {
    type: "object",
    properties: { value: { type: "string" } },
    required: ["value"],
    additionalProperties: false,
  },
  risk: "write",
};

describe("abandoned approval", () => {
  it("a fresh user turn after an undecided approval still streams", async () => {
    const model = scriptedModel([
      toolCallTurn(descriptor.name, { value: "hello" }, "call_abandoned"),
      textTurn("Moving on.", "text_moved_on"),
    ]);
    const guard = testGuard({ [descriptor.name]: "ask" });
    const tools = boundRegistry({
      [descriptor.name]: {
        descriptor,
        execute: async () => ({ never: true }),
      },
    }, guard);
    const agent = createAgent({ model, tools, guard });
    const threadId = "thr_abandoned";

    const first = await agent.stream({
      threadId,
      message: { id: "u1_msg", role: "user", parts: [{ type: "text", text: "Send it" }] },
      ctx: ctx(),
    });
    await readSse(first);

    const second = await agent.stream({
      threadId,
      message: { id: "u2_msg", role: "user", parts: [{ type: "text", text: "Never mind, just say hi" }] },
      ctx: ctx(),
    });
    const { parts } = await readSse(second);
    const errors = parts.filter((part) => part.type === "error");
    expect(errors).toEqual([]);
    expect(parts.some((part) => part.type === "text-delta" && part.delta === "Moving on.")).toBe(true);
    expect(tools.invocations.send_echo).toBe(0);

    const secondPrompt = model.prompts[1]!;
    const assistantToolCallIds = secondPrompt.flatMap((message) =>
      message.role === "assistant" && Array.isArray(message.content)
        ? message.content
          .filter((part) => part.type === "tool-call")
          .map((part) => part.toolCallId)
        : []);
    const toolResultIds = secondPrompt.flatMap((message) =>
      message.role === "tool" && Array.isArray(message.content)
        ? message.content
          .filter((part) => part.type === "tool-result")
          .map((part) => part.toolCallId)
        : []);
    expect(assistantToolCallIds.length).toBeGreaterThan(0);
    expect(assistantToolCallIds.every((id) => toolResultIds.includes(id))).toBe(true);
    expect(secondPrompt.every((message) => message.content.length > 0)).toBe(true);

    const stored = await agent.threads.get(threadId, ctx());
    const abandoned = stored?.messages
      .flatMap((message) => message.parts)
      .find((part) => part.type === "dynamic-tool" && part.toolCallId === "call_abandoned");
    expect(abandoned).toMatchObject({
      state: "approval-responded",
      approval: { approved: false, reason: "abandoned" },
    });
    expect(guard.pending()).toHaveLength(1);
  });
});
