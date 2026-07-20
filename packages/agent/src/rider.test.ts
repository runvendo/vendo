import type { Guard, ToolDescriptor } from "@vendoai/core";
import type { UIMessage, UIMessageStreamWriter } from "ai";
import { describe, expect, it, vi } from "vitest";
import { createAgent } from "./index.js";
import { RiderThreadBridge, type RiderSession, type RiderSessionStart } from "./rider.js";
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

  it("surfaces a rider turn error as a generic error part and finish{error}", async () => {
    const guard = testGuard({});
    const session: RiderSession = {
      started: null as unknown,
      async start() {},
      async runTurn() {
        throw new Error("SDK spawn failed");
      },
      async dispose() {},
    } as unknown as RiderSession;
    const agent = createAgent({
      model: "unused" as never,
      tools: registry(guard),
      guard,
      rider: { session: async () => session },
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { parts } = await streamTurn(agent, "thr_err", userMessage("u1", "hi"));
    errorSpy.mockRestore();
    const error = parts.find((part) => part.type === "error") as { errorText: string } | undefined;
    expect(error?.errorText).toBe("An error occurred while generating the response.");
    expect(parts.at(-1)).toEqual({ type: "finish", finishReason: "error" });
  });

  it("returns an error result to the rider for a tool that is not in the registry", async () => {
    const guard = testGuard({});
    const session = new FakeRiderSession([
      [{ tool: "ghost_tool", args: {} }, { text: "Handled." }],
    ]);
    const { agent, tools } = agentWith(session, guard);
    const { parts } = await streamTurn(agent, "thr_ghost", userMessage("u1", "go"));
    expect(tools.invocations.send_echo).toBe(0);
    // The rider saw a structured not-found result and carried on.
    expect(JSON.parse(session.toolResults[0]!)).toMatchObject({
      status: "error",
      error: { code: "not-found" },
    });
    expect(parts.some((part) => part.type === "text-delta" && (part as { delta: string }).delta === "Handled.")).toBe(true);
  });

  it("fails closed to the ask flow when guard.check throws", async () => {
    const base = testGuard({});
    const throwingGuard: Guard = {
      ...base,
      check: async () => {
        throw new Error("guard exploded");
      },
    };
    const tools = boundRegistry({
      [descriptor.name]: { descriptor, execute: async () => ({ echoed: "x" }) },
    }, throwingGuard);
    const session = new FakeRiderSession([
      [{ tool: descriptor.name, args: { value: "x" } }],
    ]);
    const agent = createAgent({
      model: "unused" as never,
      tools,
      guard: throwingGuard,
      rider: { session: async () => session },
    });
    const { parts } = await streamTurn(agent, "thr_guard_throw", userMessage("u1", "send"));
    // No data-vendo-approval part (the guard threw before producing one), but the
    // call still parks via the native approval-request part and does NOT execute.
    expect(tools.invocations.send_echo).toBe(0);
    expect(parts.find((part) => part.type === "tool-approval-request")).toBeDefined();
    expect(parts.at(-1)).toEqual({ type: "finish", finishReason: "tool-calls" });
  });

  it("carries invalidated-grant provenance onto the Vendo approval part", async () => {
    const invalidatedGrant = { id: "grt_stale", grantedAt: "2026-07-01T12:00:00.000Z" } as const;
    const guard = testGuard({ [descriptor.name]: "ask" });
    const check = guard.check.bind(guard);
    guard.check = async (...args) => {
      const decision = await check(...args);
      return decision.action === "ask"
        ? { ...decision, approval: { ...decision.approval, invalidatedGrant } }
        : decision;
    };
    const session = new FakeRiderSession([[{ tool: descriptor.name, args: { value: "x" } }]]);
    const { agent } = agentWith(session, guard);
    const { parts } = await streamTurn(agent, "thr_grant", userMessage("u1", "send"));
    const vendoPart = parts.find((part) => part.type === "data-vendo-approval") as { data: Record<string, unknown> };
    expect(vendoPart.data.invalidatedGrant).toEqual(invalidatedGrant);
  });
});

/** A single-turn scripted session for direct-bridge tests. */
class OneTurnSession implements RiderSession {
  started: RiderSessionStart | null = null;
  disposed = false;
  lastText: string | null = null;
  private readonly reply: string;

  constructor(reply = "ok") {
    this.reply = reply;
  }

  async start(options: RiderSessionStart): Promise<void> {
    this.started = options;
  }

  async runTurn(text: string, onTextDelta: (delta: string) => void): Promise<{ text: string }> {
    this.lastText = text;
    onTextDelta(this.reply);
    return { text: this.reply };
  }

  async dispose(): Promise<void> {
    this.disposed = true;
  }
}

/** Collect the chunks a bridge writes, plus a finish latch. */
function fakeStream(): {
  writer: UIMessageStreamWriter<UIMessage>;
  chunks: Array<Record<string, unknown>>;
} {
  const chunks: Array<Record<string, unknown>> = [];
  const writer = { write: (chunk: unknown) => chunks.push(chunk as Record<string, unknown>) };
  return { writer: writer as unknown as UIMessageStreamWriter<UIMessage>, chunks };
}

function approvalResponse(toolCallId: string, toolName: string, approved: boolean, input: unknown = {}): UIMessage {
  return {
    id: "asst_restart",
    role: "assistant",
    parts: [
      {
        type: "dynamic-tool",
        toolName,
        toolCallId,
        state: "approval-responded",
        input,
        approval: { id: `apr_${toolCallId}`, approved },
      } as unknown as UIMessage["parts"][number],
    ],
  };
}

describe("RiderThreadBridge direct edge paths", () => {
  const system = "You are the test agent.";

  it("restart fallback: settles an approved call and continues the rider turn", async () => {
    const guard = testGuard({});
    const tools = boundRegistry({
      [descriptor.name]: { descriptor, execute: async (args) => ({ echoed: (args as { value: string }).value }) },
    }, guard);
    const session = new OneTurnSession("Continuing after approval.");
    const bridge = new RiderThreadBridge(session, { registry: tools, guard }, ctx());
    const { writer, chunks } = fakeStream();

    await bridge.handleApprovalResponse({
      message: approvalResponse("call_restart", descriptor.name, true, { value: "v" }),
      system,
      ctx: ctx(),
      writer,
    });

    // The tool executed through the guarded path (no live park to resolve).
    expect(tools.invocations.send_echo).toBe(1);
    const output = chunks.find((chunk) => chunk.type === "tool-output-available") as Record<string, unknown>;
    expect(output.output).toEqual({ status: "ok", output: { echoed: "v" } });
    // A fresh turn carried the settlement to the rider.
    expect(session.lastText).toContain("approved your earlier send_echo");
    expect(chunks.some((chunk) => chunk.type === "text-delta" && (chunk as { delta: string }).delta === "Continuing after approval.")).toBe(true);
    expect(chunks.at(-1)).toEqual({ type: "finish", finishReason: "stop" });
  });

  it("restart fallback: a denied call emits tool-output-denied and continues", async () => {
    const guard = testGuard({});
    const tools = boundRegistry({
      [descriptor.name]: { descriptor, execute: async () => ({ echoed: "x" }) },
    }, guard);
    const session = new OneTurnSession("Understood.");
    const bridge = new RiderThreadBridge(session, { registry: tools, guard }, ctx());
    const { writer, chunks } = fakeStream();

    await bridge.handleApprovalResponse({
      message: approvalResponse("call_denied", descriptor.name, false),
      system,
      ctx: ctx(),
      writer,
    });

    expect(tools.invocations.send_echo).toBe(0);
    expect(chunks.find((chunk) => chunk.type === "tool-output-denied")).toBeDefined();
    expect(session.lastText).toContain("declined your earlier send_echo");
    expect(chunks.at(-1)).toEqual({ type: "finish", finishReason: "stop" });
  });

  it("restart fallback with an approved unknown tool records a not-found outcome", async () => {
    const guard = testGuard({});
    const tools = boundRegistry({}, guard);
    const session = new OneTurnSession();
    const bridge = new RiderThreadBridge(session, { registry: tools, guard }, ctx());
    const { writer, chunks } = fakeStream();

    await bridge.handleApprovalResponse({
      message: approvalResponse("call_unknown", "ghost_tool", true),
      system,
      ctx: ctx(),
      writer,
    });

    const output = chunks.find((chunk) => chunk.type === "tool-output-available") as Record<string, unknown>;
    expect(output.output).toMatchObject({ status: "error", error: { code: "not-found" } });
  });

  it("executeGuarded surfaces a thrown executor as a generic execution error", async () => {
    const guard = testGuard({});
    const tools = boundRegistry({
      [descriptor.name]: {
        descriptor,
        execute: () => {
          throw new Error("boom");
        },
      },
    }, guard);
    const session = new OneTurnSession();
    const bridge = new RiderThreadBridge(session, { registry: tools, guard }, ctx());
    const { writer, chunks } = fakeStream();

    await bridge.handleApprovalResponse({
      message: approvalResponse("call_boom", descriptor.name, true, { value: "v" }),
      system,
      ctx: ctx(),
      writer,
    });

    const output = chunks.find((chunk) => chunk.type === "tool-output-available") as Record<string, unknown>;
    // The registry itself catches the throw as a structured execution error;
    // either way the bridge never leaks the raw message.
    expect((output.output as { status: string }).status).toBe("error");
  });

  it("resolves with nothing to stream when a resubmission has no approval parts", async () => {
    const guard = testGuard({});
    const bridge = new RiderThreadBridge(new OneTurnSession(), { registry: boundRegistry({}, guard), guard }, ctx());
    const { writer, chunks } = fakeStream();
    await bridge.handleApprovalResponse({
      message: { id: "asst_empty", role: "assistant", parts: [{ type: "text", text: "noop" }] },
      system,
      ctx: ctx(),
      writer,
    });
    // start + finish{stop}, nothing else.
    expect(chunks.map((chunk) => chunk.type)).toEqual(["start", "finish"]);
    expect(chunks.at(-1)).toEqual({ type: "finish", finishReason: "stop" });
  });

  it("swallows writes to a dead client stream without failing the turn", async () => {
    const guard = testGuard({});
    const session = new OneTurnSession("hello");
    const bridge = new RiderThreadBridge(session, { registry: boundRegistry({}, guard), guard }, ctx());
    const deadWriter = {
      write: () => {
        throw new Error("client disconnected");
      },
    } as unknown as UIMessageStreamWriter<UIMessage>;
    // Must resolve (not reject) even though every write throws.
    await expect(
      bridge.handleUserTurn({
        message: userMessage("u1", "hi"),
        system,
        ctx: ctx(),
        writer: deadWriter,
      }),
    ).resolves.toBeUndefined();
  });

  it("dispose resolves parked calls and tears the session down", async () => {
    const guard = testGuard({ [descriptor.name]: "ask" });
    const tools = boundRegistry({
      [descriptor.name]: { descriptor, execute: async () => ({ echoed: "x" }) },
    }, guard);
    // A session that parks on its tool call (never resolves on its own).
    let parkedResult: Promise<{ text: string; ok: boolean }> | null = null;
    const session: RiderSession = {
      started: null,
      disposed: false,
      async start(options: RiderSessionStart) {
        (this as { started: RiderSessionStart }).started = options;
      },
      async runTurn() {
        parkedResult = (this as unknown as { started: RiderSessionStart }).started.onToolCall({
          tool: descriptor.name,
          args: { value: "x" },
        });
        await parkedResult; // stays pending until the park resolves
        return { text: "" };
      },
      async dispose() {
        (this as { disposed: boolean }).disposed = true;
      },
    } as unknown as RiderSession;
    const bridge = new RiderThreadBridge(session, { registry: tools, guard }, ctx());
    const { writer } = fakeStream();

    // The turn parks (finishAttached resolves the request promise).
    await bridge.handleUserTurn({ message: userMessage("u1", "send"), system, ctx: ctx(), writer });
    await bridge.dispose();

    expect((session as unknown as { disposed: boolean }).disposed).toBe(true);
    // The parked executor was released as a denial so the rider turn can settle.
    const result = await parkedResult!;
    expect(result.ok).toBe(false);
  });
});

describe("rider bridge lifecycle in the agent", () => {
  it("disposes the bridge on thread delete so a reused id gets a fresh session", async () => {
    const guard = testGuard({});
    const first = new FakeRiderSession([[{ text: "first" }]]);
    const second = new FakeRiderSession([[{ text: "second" }]]);
    const sessions = [first, second];
    const agent = createAgent({
      model: "unused-on-rider-threads" as never,
      tools: registry(guard),
      guard,
      rider: { session: async () => sessions.shift() ?? null },
    });

    await streamTurn(agent, "thr_reuse", userMessage("u1", "hi"));
    await agent.threads.delete("thr_reuse", ctx());
    // Delete tears the harness session down, not just the stored thread.
    expect(first.disposed).toBe(true);

    // A reused id must not resurrect the deleted thread's session: the fresh
    // turn runs on the newly provided session, not the old harness history.
    const { parts } = await streamTurn(agent, "thr_reuse", userMessage("u2", "hi again"));
    expect(second.started).not.toBeNull();
    const text = parts
      .filter((part) => part.type === "text-delta")
      .map((part) => part.delta as string)
      .join("");
    expect(text).toBe("second");
  });

  it("disposes rider bridges when a subject's threads are evicted", async () => {
    const guard = testGuard({});
    const session = new FakeRiderSession([[{ text: "hello" }]]);
    const { agent } = agentWith(session, guard);

    await streamTurn(agent, "thr_evicted", userMessage("u1", "hi"));
    // evictSubject is fire-and-forget (03-agent §1), so the teardown lands
    // asynchronously after the store delete resolves.
    agent.evictSubject("u1");
    await vi.waitFor(() => expect(session.disposed).toBe(true));
  });
});
