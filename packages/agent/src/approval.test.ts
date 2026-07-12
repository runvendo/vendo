import { vendoApprovalPartSchema, type ApprovalRequest, type ToolDescriptor } from "@vendoai/core";
import type { UIMessage } from "ai";
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
  type TestGuard,
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

const input = { value: "hello" };
const threadId = "thr_approval";
const toolCallId = "call_approval";

function setup() {
  const model = scriptedModel([
    toolCallTurn(descriptor.name, input, toolCallId),
    textTurn("Approval handled.", "text_after_approval"),
  ]);
  const guard = testGuard({ [descriptor.name]: "ask" });
  const tools = boundRegistry({
    [descriptor.name]: {
      descriptor,
      execute: async (args) => ({ echoed: (args as { value: string }).value }),
    },
  }, guard);
  const agent = createAgent({ model, tools, guard });
  return { agent, guard, model, tools };
}

function firstPending(guard: TestGuard): ApprovalRequest {
  const pending = guard.pending();
  expect(pending).toHaveLength(1);
  return pending[0]!;
}

function lastAssistant(messages: UIMessage[]): UIMessage {
  const assistant = [...messages].reverse().find((message) => message.role === "assistant");
  expect(assistant).toBeDefined();
  return assistant!;
}

function respondToApproval(
  message: UIMessage,
  nativeApprovalId: string,
  approved: boolean,
): UIMessage {
  let updated = false;
  const parts = message.parts.map((part) => {
    const candidate = part as unknown as Record<string, unknown>;
    if (candidate.type !== "dynamic-tool" || candidate.toolCallId !== toolCallId) return part;
    updated = true;
    return {
      type: "dynamic-tool",
      toolName: descriptor.name,
      toolCallId,
      state: "approval-responded",
      input,
      approval: { id: nativeApprovalId, approved },
    } as unknown as UIMessage["parts"][number];
  });
  expect(updated).toBe(true);
  return { ...message, parts };
}

async function pause(agent: ReturnType<typeof createAgent>) {
  const response = await agent.stream({
    threadId,
    message: {
      id: "user_approval",
      role: "user",
      parts: [{ type: "text", text: "Send the echo" }],
    },
    ctx: ctx(),
  });
  return readSse(response);
}

async function storedAssistant(agent: ReturnType<typeof createAgent>): Promise<UIMessage> {
  const thread = await agent.threads.get(threadId, ctx());
  expect(thread).not.toBeNull();
  return lastAssistant(thread!.messages);
}

describe("agent approval round trip", () => {
  it("pauses on ask with native and Vendo approval parts without executing the tool", async () => {
    const { agent, guard, tools } = setup();
    const { parts } = await pause(agent);
    const approval = firstPending(guard);

    expect(parts.find((part) => part.type === "tool-approval-request")).toEqual({
      type: "tool-approval-request",
      approvalId: expect.any(String),
      toolCallId,
    });
    const vendoPart = parts.find((part) => part.type === "data-vendo-approval");
    expect(vendoPart).toEqual({
      type: "data-vendo-approval",
      toolCallId,
      risk: "write",
      approvalId: approval.id,
    });
    expect(vendoApprovalPartSchema.safeParse(vendoPart).success).toBe(true);
    expect(approval.id).toBe(`apr_${toolCallId}`);
    expect(approval.inputPreview).toBe(JSON.stringify(input));
    expect(Object.isFrozen(approval.descriptor)).toBe(true);
    expect(tools.invocations.send_echo).toBe(0);
    expect(parts.some((part) => String(part.type).startsWith("tool-output-"))).toBe(false);
    expect(parts.at(-1)).toEqual({ type: "finish", finishReason: "tool-calls" });
  });

  it("resumes the same assistant message after approval and executes exactly once", async () => {
    const { agent, guard, tools } = setup();
    const first = await pause(agent);
    const native = first.parts.find((part) => part.type === "tool-approval-request");
    expect(native).toBeDefined();
    const nativeApprovalId = native?.approvalId;
    expect(typeof nativeApprovalId).toBe("string");
    const coreApproval = firstPending(guard);
    const assistant = await storedAssistant(agent);

    guard.decide(coreApproval.id, true);
    const response = await agent.stream({
      threadId,
      message: respondToApproval(assistant, nativeApprovalId as string, true),
      ctx: ctx(),
    });
    const { parts } = await readSse(response);

    expect(tools.invocations.send_echo).toBe(1);
    expect(parts.find((part) => part.type === "tool-output-available")).toEqual({
      type: "tool-output-available",
      toolCallId,
      output: { status: "ok", output: { echoed: "hello" } },
      dynamic: true,
    });
    expect(parts.some((part) => part.type === "text-delta" && part.delta === "Approval handled.")).toBe(true);
    expect(parts.at(-1)).toEqual({ type: "finish", finishReason: "stop" });
  });

  it("turns a denied approval into the SDK denied output and still completes a model turn", async () => {
    const { agent, guard, tools } = setup();
    const first = await pause(agent);
    const native = first.parts.find((part) => part.type === "tool-approval-request");
    expect(native).toBeDefined();
    const nativeApprovalId = native?.approvalId;
    expect(typeof nativeApprovalId).toBe("string");
    const coreApproval = firstPending(guard);
    const assistant = await storedAssistant(agent);

    guard.decide(coreApproval.id, false);
    const response = await agent.stream({
      threadId,
      message: respondToApproval(assistant, nativeApprovalId as string, false),
      ctx: ctx(),
    });
    const { parts } = await readSse(response);

    expect(tools.invocations.send_echo).toBe(0);
    expect(parts.find((part) => part.type === "tool-output-denied")).toEqual({
      type: "tool-output-denied",
      toolCallId,
    });
    expect(parts.some((part) => part.type === "text-delta" && part.delta === "Approval handled.")).toBe(true);
    expect(parts.at(-1)).toEqual({ type: "finish", finishReason: "stop" });
  });
});
