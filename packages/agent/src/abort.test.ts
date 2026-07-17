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

describe("cancellation (AGENT-3)", () => {
  it("an aborted turn stops the provider loop and leaves the thread resumable", async () => {
    const controller = new AbortController();
    const guard = testGuard({});
    const tools = boundRegistry({
      echo: {
        descriptor,
        // Aborting DURING tool execution: the loop must not start another
        // provider step afterwards (the scripted model would throw if it did).
        execute: async (args) => {
          controller.abort();
          return args;
        },
      },
    }, guard);
    const model = scriptedModel([
      toolCallTurn("echo", { value: "first" }, "call_aborted"),
      textTurn("Resumed fine.", "text_resumed"),
    ]);
    const agent = createAgent({ model, tools, guard });
    const threadId = "thr_abort";

    const first = await agent.stream({
      threadId,
      message: userMessage("u1_abort", "Echo something"),
      ctx: ctx(),
      signal: controller.signal,
    });
    const firstRead = await readSse(first).catch(() => null);
    // Exactly one provider call happened: the abort stopped the loop before
    // step 2 (a second call would have consumed the scripted resume turn).
    expect(model.prompts).toHaveLength(1);

    // The aborted turn must not corrupt thread state: a fresh turn streams
    // cleanly and every persisted assistant tool call stays result-paired.
    const second = await agent.stream({
      threadId,
      message: userMessage("u2_abort", "Still there?"),
      ctx: ctx(),
    });
    const { parts } = await readSse(second);
    expect(parts.filter((part) => part.type === "error")).toEqual([]);
    expect(parts.some((part) => part.type === "text-delta" && part.delta === "Resumed fine.")).toBe(true);

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
    expect(assistantToolCallIds.every((id) => toolResultIds.includes(id))).toBe(true);
    expect(firstRead === null || firstRead.parts.every((part) => part.type !== "error")).toBe(true);
  });

  it("an already-aborted signal never reaches the provider", async () => {
    const controller = new AbortController();
    controller.abort();
    const guard = testGuard({});
    const tools = boundRegistry({ echo: { descriptor, execute: async (args) => args } }, guard);
    const model = scriptedModel([textTurn("never", "text_never")]);
    const agent = createAgent({ model, tools, guard });

    const response = await agent.stream({
      threadId: "thr_abort_pre",
      message: userMessage("u1_pre", "Echo"),
      ctx: ctx(),
      signal: controller.signal,
    });
    await readSse(response).catch(() => null);
    expect(model.prompts).toHaveLength(0);
  });
});
