import type { CapabilityMissEvent, ToolDescriptor } from "@vendoai/core";
import { describe, expect, it, vi } from "vitest";
import { CAPABILITY_MISS_TOOL_NAME } from "./capability-miss.js";
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

const surface = {
  format: "vendo/tools@1" as const,
  hash: `sha256:${"b".repeat(64)}`,
};

const failingDescriptor: ToolDescriptor = {
  name: "host_export_transactions",
  description: "Export transactions.",
  inputSchema: { type: "object" },
  risk: "read",
};

async function waitForOne(misses: CapabilityMissEvent[]): Promise<CapabilityMissEvent> {
  await vi.waitFor(() => expect(misses).toHaveLength(1));
  return misses[0]!;
}

describe("capability-miss detection", () => {
  it("exposes the internal report tool for a no-matching-tool miss", async () => {
    const misses: CapabilityMissEvent[] = [];
    const model = scriptedModel([
      toolCallTurn(CAPABILITY_MISS_TOOL_NAME, {
        kind: "no-matching-tool",
        toolsConsidered: ["host_transactions_list"],
      }, "call_report_missing"),
      textTurn("I cannot export CSV with the available tools.", "text_missing"),
    ]);
    const guard = testGuard({});
    const agent = createAgent({
      model,
      tools: boundRegistry({}, guard),
      guard,
      capabilityMiss: {
        hostId: "host_maple",
        surface: Promise.resolve(surface),
        emit: (event) => misses.push(event),
      },
    });

    await readSse(await agent.stream({
      threadId: "thr_missing",
      message: userMessage("user_missing", "Export my transactions to CSV"),
      ctx: ctx({ sessionId: "session_missing" }),
    }));

    expect(await waitForOne(misses)).toMatchObject({
      format: "vendo/capability-miss@1",
      id: expect.stringMatching(/^mis_/),
      hostId: "host_maple",
      sessionId: "session_missing",
      threadId: "thr_missing",
      intent: "Export my transactions to CSV",
      surface,
      trigger: {
        kind: "no-matching-tool",
        toolsConsidered: [],
      },
    });
  });

  it("emits once when the same tool fails twice, scrubbing failure text", async () => {
    const misses: CapabilityMissEvent[] = [];
    const model = scriptedModel([
      toolCallTurn(failingDescriptor.name, {}, "call_failure_1"),
      toolCallTurn(failingDescriptor.name, {}, "call_failure_2"),
      toolCallTurn(CAPABILITY_MISS_TOOL_NAME, {
        kind: "agent-give-up",
        toolsConsidered: [failingDescriptor.name],
      }, "call_duplicate_report"),
      textTurn("The export failed twice.", "text_failures"),
    ]);
    const guard = testGuard({ [failingDescriptor.name]: "run" });
    const tools = boundRegistry({
      [failingDescriptor.name]: {
        descriptor: failingDescriptor,
        execute: async () => {
          throw new Error("Authorization Bearer sk_live_super_secret failed for alice@example.com");
        },
      },
    }, guard);
    const agent = createAgent({
      model,
      tools,
      guard,
      capabilityMiss: {
        hostId: "host_maple",
        surface: Promise.resolve(surface),
        emit: (event) => misses.push(event),
      },
    });

    await readSse(await agent.stream({
      message: userMessage("user_failures", "Export transactions for alice@example.com"),
      ctx: ctx(),
    }));

    const miss = await waitForOne(misses);
    expect(miss.intent).toBe("Export transactions for [redacted-email]");
    expect(miss.trigger).toEqual({
      kind: "repeated-tool-failure",
      toolsConsidered: [failingDescriptor.name],
      attempts: [
        {
          tool: failingDescriptor.name,
          attempt: 1,
          failure: { code: "execution", message: "Authorization Bearer [redacted-secret] failed for [redacted-email]" },
        },
        {
          tool: failingDescriptor.name,
          attempt: 2,
          failure: { code: "execution", message: "Authorization Bearer [redacted-secret] failed for [redacted-email]" },
        },
      ],
    });
    expect(tools.invocations[failingDescriptor.name]).toBe(2);
  });

  it("records an explicit give-up with the tools actually attempted", async () => {
    const misses: CapabilityMissEvent[] = [];
    const model = scriptedModel([
      toolCallTurn(failingDescriptor.name, {}, "call_give_up_failure"),
      toolCallTurn(CAPABILITY_MISS_TOOL_NAME, {
        kind: "agent-give-up",
        toolsConsidered: [failingDescriptor.name, "host_transactions_list"],
      }, "call_give_up_report"),
      textTurn("I cannot finish this request.", "text_give_up"),
    ]);
    const guard = testGuard({ [failingDescriptor.name]: "run" });
    const tools = boundRegistry({
      [failingDescriptor.name]: {
        descriptor: failingDescriptor,
        execute: async () => { throw new Error("temporary failure"); },
      },
    }, guard);
    const agent = createAgent({
      model,
      tools,
      guard,
      capabilityMiss: {
        hostId: "host_maple",
        surface: Promise.resolve(surface),
        emit: (event) => misses.push(event),
      },
    });

    await readSse(await agent.stream({
      message: userMessage("user_give_up", "Export my transactions"),
      ctx: ctx(),
    }));

    expect((await waitForOne(misses)).trigger).toEqual({
      kind: "agent-give-up",
      toolsConsidered: [failingDescriptor.name],
      toolsAttempted: [failingDescriptor.name],
    });
  });
});
