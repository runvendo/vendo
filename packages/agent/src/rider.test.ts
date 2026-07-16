import type { ToolDescriptor } from "@vendoai/core";
import type { UIMessage } from "ai";
import { describe, expect, it } from "vitest";
import { createAgent } from "./index.js";
import type { RiderSession, RiderSessionStart } from "./rider.js";
import { boundRegistry, ctx, readSse, testGuard, type TestGuard } from "./test-helpers.js";

/**
 * ENG-338: the rider path must be wire-indistinguishable from the native
 * streamText loop — same chunk sequences, same approval semantics, same
 * guard/registry execution path. The expected sequences below were captured
 * from the native loop with a scripted model.
 */

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

type FakeStep = { text: string } | { tool: string; args: unknown };

/** A scripted rider harness: each turn emits text deltas and/or tool calls,
 *  awaiting the bridge's guarded executor exactly like a live harness would. */
class FakeRiderSession implements RiderSession {
  started: RiderSessionStart | null = null;
  disposed = false;
  toolResults: string[] = [];
  private readonly script: FakeStep[][];

  constructor(script: FakeStep[][]) {
    this.script = script.map((turn) => [...turn]);
  }

  async start(options: RiderSessionStart): Promise<void> {
    this.started = options;
  }

  async runTurn(_text: string, onTextDelta: (delta: string) => void): Promise<{ text: string }> {
    const steps = this.script.shift();
    if (steps === undefined) throw new Error("fake rider script exhausted");
    let text = "";
    for (const step of steps) {
      if ("text" in step) {
        onTextDelta(step.text);
        text += step.text;
      } else {
        const result = await this.started!.onToolCall({ tool: step.tool, args: step.args });
        this.toolResults.push(result.text);
      }
    }
    return { text };
  }

  async dispose(): Promise<void> {
    this.disposed = true;
  }
}

function agentWith(session: FakeRiderSession, guard: TestGuard, tools = registry(guard)) {
  return {
    agent: createAgent({
      // The model is unused on rider threads; any LanguageModel satisfies the config.
      model: "unused-on-rider-threads" as never,
      tools,
      guard,
      rider: { session: async () => session },
    }),
    tools,
  };
}

function registry(guard: TestGuard) {
  return boundRegistry({
    [descriptor.name]: {
      descriptor,
      execute: async (args) => ({ echoed: (args as { value: string }).value }),
    },
  }, guard);
}

function userMessage(id: string, text: string): UIMessage {
  return { id, role: "user", parts: [{ type: "text", text }] };
}

async function streamTurn(
  agent: ReturnType<typeof createAgent>,
  threadId: string,
  message: UIMessage,
) {
  const response = await agent.stream({ threadId, message, ctx: ctx() });
  return readSse(response);
}

function types(parts: Array<Record<string, unknown>>): string[] {
  return parts.map((part) => part.type as string);
}

async function storedAssistant(agent: ReturnType<typeof createAgent>, threadId: string): Promise<UIMessage> {
  const thread = await agent.threads.get(threadId, ctx());
  expect(thread).not.toBeNull();
  const assistant = [...thread!.messages].reverse().find((message) => message.role === "assistant");
  expect(assistant).toBeDefined();
  return assistant!;
}

function respondToApproval(message: UIMessage, approved: boolean): UIMessage {
  const parts = message.parts.map((part) => {
    const candidate = part as Record<string, unknown>;
    if (candidate.type !== "dynamic-tool" || candidate.state !== "approval-requested") return part;
    return {
      ...candidate,
      state: "approval-responded",
      approval: { ...(candidate.approval as Record<string, unknown>), approved },
    } as UIMessage["parts"][number];
  });
  return { ...message, parts };
}

describe("rider bridge wire parity", () => {
  it("streams a plain text turn with the native chunk sequence", async () => {
    const guard = testGuard({});
    const session = new FakeRiderSession([[{ text: "Hello " }, { text: "there." }]]);
    const { agent } = agentWith(session, guard);

    const { parts } = await streamTurn(agent, "thr_text", userMessage("u1", "hi"));

    expect(types(parts)).toEqual([
      "start", "start-step", "text-start", "text-delta", "text-delta", "text-end", "finish-step", "finish",
    ]);
    expect(parts.at(-1)).toEqual({ type: "finish", finishReason: "stop" });
    expect(session.started?.system).toContain("Vendo's agent");
    expect(session.started?.tools.map((tool) => tool.name)).toEqual([descriptor.name]);

    const assistant = await storedAssistant(agent, "thr_text");
    const text = assistant.parts.find((part) => part.type === "text") as { text: string };
    expect(text.text).toBe("Hello there.");
  });

  it("executes a run-class tool through the guarded registry with native parts", async () => {
    const guard = testGuard({ [descriptor.name]: "run" });
    const session = new FakeRiderSession([
      [{ tool: descriptor.name, args: { value: "x" } }, { text: "Done." }],
    ]);
    const { agent, tools } = agentWith(session, guard);

    const { parts } = await streamTurn(agent, "thr_run", userMessage("u1", "run it"));

    expect(tools.invocations.send_echo).toBe(1);
    expect(types(parts)).toEqual([
      "start", "start-step", "tool-input-available", "tool-output-available", "finish-step",
      "start-step", "text-start", "text-delta", "text-end", "finish-step", "finish",
    ]);
    const output = parts.find((part) => part.type === "tool-output-available") as Record<string, unknown>;
    expect(output.output).toEqual({ status: "ok", output: { echoed: "x" } });
    expect(output.dynamic).toBe(true);
    // The rider's model saw the same serialized outcome the native loop feeds.
    expect(JSON.parse(session.toolResults[0]!)).toEqual({ status: "ok", output: { echoed: "x" } });
    expect(parts.at(-1)).toEqual({ type: "finish", finishReason: "stop" });
  });

  it("pauses on ask with native + Vendo approval parts, without executing", async () => {
    const guard = testGuard({ [descriptor.name]: "ask" });
    const session = new FakeRiderSession([
      [{ tool: descriptor.name, args: { value: "x" } }, { text: "After approval." }],
    ]);
    const { agent, tools } = agentWith(session, guard);

    const { parts } = await streamTurn(agent, "thr_ask", userMessage("u1", "send it"));

    expect(tools.invocations.send_echo).toBe(0);
    expect(types(parts)).toEqual([
      "start", "data-vendo-approval", "start-step", "tool-input-available",
      "tool-approval-request", "finish-step", "finish",
    ]);
    expect(parts.at(-1)).toEqual({ type: "finish", finishReason: "tool-calls" });

    const vendoPart = parts.find((part) => part.type === "data-vendo-approval") as { data: Record<string, unknown> };
    const native = parts.find((part) => part.type === "tool-approval-request") as Record<string, unknown>;
    expect(vendoPart.data.risk).toBe("write");
    expect(vendoPart.data.toolCallId).toBe(native.toolCallId);
    const pending = guard.pending();
    expect(pending).toHaveLength(1);
    expect(vendoPart.data.approvalId).toBe(pending[0]!.id);

    const assistant = await storedAssistant(agent, "thr_ask");
    const toolPart = assistant.parts.find((part) => (part as { type: string }).type === "dynamic-tool") as Record<string, unknown>;
    expect(toolPart.state).toBe("approval-requested");
  });

  it("resumes the same assistant message after approval and executes exactly once", async () => {
    const guard = testGuard({ [descriptor.name]: "ask" });
    const session = new FakeRiderSession([
      [{ tool: descriptor.name, args: { value: "x" } }, { text: "After approval." }],
    ]);
    const { agent, tools } = agentWith(session, guard);

    const first = await streamTurn(agent, "thr_resume", userMessage("u1", "send it"));
    const startId = (first.parts.find((part) => part.type === "start") as { messageId: string }).messageId;
    const assistant = await storedAssistant(agent, "thr_resume");
    expect(assistant.id).toBe(startId);

    guard.decide(guard.pending()[0]!.id, true);
    const resume = await streamTurn(agent, "thr_resume", respondToApproval(assistant, true));

    expect(tools.invocations.send_echo).toBe(1);
    expect(types(resume.parts)).toEqual([
      "start", "tool-output-available", "start-step", "text-start", "text-delta", "text-end", "finish-step", "finish",
    ]);
    expect((resume.parts[0] as { messageId: string }).messageId).toBe(startId);
    const output = resume.parts.find((part) => part.type === "tool-output-available") as Record<string, unknown>;
    expect(output.output).toEqual({ status: "ok", output: { echoed: "x" } });
    expect(resume.parts.some((part) => part.type === "text-delta" && (part as { delta: string }).delta === "After approval.")).toBe(true);
    expect(resume.parts.at(-1)).toEqual({ type: "finish", finishReason: "stop" });
    // The parked rider call resolved with the executed outcome.
    expect(JSON.parse(session.toolResults[0]!)).toEqual({ status: "ok", output: { echoed: "x" } });

    const persisted = await agent.threads.get("thr_resume", ctx());
    const persistedAssistant = persisted!.messages.find((message) => message.role === "assistant")!;
    const persistedTool = persistedAssistant.parts.find((part) => (part as { type: string }).type === "dynamic-tool") as Record<string, unknown>;
    expect(persistedTool.state).toBe("output-available");
  });

  it("turns a denied approval into tool-output-denied without executing", async () => {
    const guard = testGuard({ [descriptor.name]: "ask" });
    const session = new FakeRiderSession([
      [{ tool: descriptor.name, args: { value: "x" } }, { text: "Understood." }],
    ]);
    const { agent, tools } = agentWith(session, guard);

    await streamTurn(agent, "thr_deny", userMessage("u1", "send it"));
    const assistant = await storedAssistant(agent, "thr_deny");
    guard.decide(guard.pending()[0]!.id, false);
    const resume = await streamTurn(agent, "thr_deny", respondToApproval(assistant, false));

    expect(tools.invocations.send_echo).toBe(0);
    expect(resume.parts.find((part) => part.type === "tool-output-denied")).toBeDefined();
    expect(resume.parts.some((part) => part.type === "text-delta" && (part as { delta: string }).delta === "Understood.")).toBe(true);
    expect(resume.parts.at(-1)).toEqual({ type: "finish", finishReason: "stop" });
    expect(JSON.parse(session.toolResults[0]!)).toMatchObject({ status: "denied" });
  });

  it("abandons a parked approval when the user sends a new message", async () => {
    const guard = testGuard({ [descriptor.name]: "ask" });
    const session = new FakeRiderSession([
      // Turn 1 parks, then (after abandonment) replies to the denial — that
      // trailing text must never reach a stream.
      [{ tool: descriptor.name, args: { value: "x" } }, { text: "DROPPED" }],
      [{ text: "Fresh turn." }],
    ]);
    const { agent, tools } = agentWith(session, guard);

    await streamTurn(agent, "thr_abandon", userMessage("u1", "send it"));
    const second = await streamTurn(agent, "thr_abandon", userMessage("u2", "never mind"));

    expect(tools.invocations.send_echo).toBe(0);
    expect(JSON.parse(session.toolResults[0]!)).toMatchObject({ status: "denied" });
    expect(second.parts.some((part) => (part as { delta?: string }).delta === "DROPPED")).toBe(false);
    expect(second.parts.some((part) => (part as { delta?: string }).delta === "Fresh turn.")).toBe(true);

    const thread = await agent.threads.get("thr_abandon", ctx());
    const abandoned = thread!.messages
      .flatMap((message) => message.parts)
      .find((part) => (part as { type: string }).type === "dynamic-tool"
        && (part as { state?: string }).state === "approval-responded") as Record<string, unknown> | undefined;
    expect(abandoned).toBeDefined();
    expect((abandoned!.approval as { reason?: string }).reason).toBe("abandoned");
  });

  it("falls back to the native loop when the provider returns null", async () => {
    const guard = testGuard({});
    const tools = registry(guard);
    const agent = createAgent({
      model: "model-id-triggers-gateway-error" as never,
      tools,
      guard,
      rider: { session: async () => null },
    });
    // The native loop with a bare string model id fails inside the stream
    // machinery (no gateway configured) — but the point is that it took the
    // native path instead of the rider path (no rider session was consulted).
    const response = await agent.stream({
      threadId: "thr_native",
      message: userMessage("u1", "hi"),
      ctx: ctx(),
    });
    const { parts } = await readSse(response);
    expect(parts.some((part) => part.type === "error")).toBe(true);
  });
});
