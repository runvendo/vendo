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
    // AGENT-6: the guard's queue resolves with the thread — the abandoned
    // approval is denied guard-side, not left pending forever.
    expect(guard.pending()).toHaveLength(0);
    expect(guard.abandoned).toEqual(["apr_call_abandoned"]);
  });

  it("a failed guard abandon call retries on the next fresh turn", async () => {
    const model = scriptedModel([
      toolCallTurn(descriptor.name, { value: "hello" }, "call_retry"),
      textTurn("Second.", "text_second"),
      textTurn("Third.", "text_third"),
    ]);
    const guard = testGuard({ [descriptor.name]: "ask" });
    const realAbandon = guard.abandonApprovals!.bind(guard);
    let attempts = 0;
    guard.abandonApprovals = async (ids, abandonCtx) => {
      attempts += 1;
      if (attempts === 1) throw new Error("guard store down");
      return realAbandon(ids, abandonCtx);
    };
    const tools = boundRegistry({
      [descriptor.name]: { descriptor, execute: async () => ({ never: true }) },
    }, guard);
    const agent = createAgent({ model, tools, guard });
    const threadId = "thr_abandon_retry";

    await readSse(await agent.stream({
      threadId,
      message: { id: "u1_retry", role: "user", parts: [{ type: "text", text: "Send it" }] },
      ctx: ctx(),
    }));
    // Turn 2 flips the part; the guard call fails and is swallowed (the turn
    // must stream), so the approval stays pending guard-side...
    const second = await readSse(await agent.stream({
      threadId,
      message: { id: "u2_retry", role: "user", parts: [{ type: "text", text: "Never mind" }] },
      ctx: ctx(),
    }));
    expect(second.parts.filter((part) => part.type === "error")).toEqual([]);
    expect(guard.pending()).toHaveLength(1);
    // ...and turn 3 re-collects the already-flipped part and retries.
    await readSse(await agent.stream({
      threadId,
      message: { id: "u3_retry", role: "user", parts: [{ type: "text", text: "Hi again" }] },
      ctx: ctx(),
    }));
    expect(attempts).toBe(2);
    expect(guard.pending()).toHaveLength(0);
  });
});
