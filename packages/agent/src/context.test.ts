import type { ToolDescriptor, ToolRegistry } from "@vendoai/core";
import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it } from "vitest";
import { createAgent } from "./index.js";
import {
  boundRegistry,
  ctx,
  memoryStore,
  readSse,
  scriptedModel,
  testGuard,
  textTurn,
  toolCallTurn,
  userMessage,
} from "./test-helpers.js";

const descriptor: ToolDescriptor = {
  name: "dump",
  description: "Return a large payload.",
  inputSchema: { type: "object", additionalProperties: false },
  risk: "read",
};

describe("context engineering", () => {
  it("truncates ok tool outputs past toolOutputCap before they reach the model", async () => {
    const bigValue = "x".repeat(500);
    const model = scriptedModel([
      toolCallTurn(descriptor.name, {}, "call_dump"),
      textTurn("Summarized.", "text_dump_done"),
    ]);
    const guard = testGuard({ [descriptor.name]: "run" });
    const tools = boundRegistry({
      [descriptor.name]: { descriptor, execute: async () => ({ bigValue }) },
    }, guard);
    const agent = createAgent({ model, tools, guard, context: { toolOutputCap: 100 } });

    const response = await agent.stream({
      threadId: "thr_cap",
      message: { id: "user_cap", role: "user", parts: [{ type: "text", text: "Dump it" }] },
      ctx: ctx(),
    });
    const { parts } = await readSse(response);

    const output = parts.find((part) => part.type === "tool-output-available")?.output as {
      status: string;
      output: { truncated: boolean; chars: number; preview: string };
    };
    expect(output.status).toBe("ok");
    expect(output.output.truncated).toBe(true);
    expect(output.output.chars).toBeGreaterThan(500);
    expect(output.output.preview).toHaveLength(100);
    expect(JSON.stringify(model.prompts[1])).not.toContain(bigValue);
  });

  it("masks a thrown model error on the wire instead of leaking its message", async () => {
    const model = new MockLanguageModelV3({
      doStream: async () => {
        throw new Error("SECRET_INTERNAL_DETAIL");
      },
    });
    const guard = testGuard({});
    const agent = createAgent({ model, tools: boundRegistry({}, guard), guard });

    const response = await agent.stream({
      threadId: "thr_error",
      message: { id: "user_error", role: "user", parts: [{ type: "text", text: "Hi" }] },
      ctx: ctx(),
    });
    const raw = await response.text();

    expect(raw).not.toContain("SECRET_INTERNAL_DETAIL");
    const errorFrames = raw
      .split("\n\n")
      .filter((block) => block.startsWith("data: {") && (JSON.parse(block.slice(6)) as { type?: string }).type === "error");
    expect(errorFrames.length).toBeGreaterThan(0);
  });

  it("masks a thrown registry error on the wire and in subsequent model context", async () => {
    const model = scriptedModel([
      toolCallTurn(descriptor.name, {}, "call_secret"),
      textTurn("Recovered safely.", "text_after_secret"),
    ]);
    const guard = testGuard({ [descriptor.name]: "run" });
    const tools: ToolRegistry = {
      async descriptors() {
        return [descriptor];
      },
      async execute() {
        throw new Error("SECRET_GUARD_DB_URL");
      },
    };
    const agent = createAgent({ model, tools, guard });

    const response = await agent.stream({
      threadId: "thr_registry_error",
      message: { id: "user_registry_error", role: "user", parts: [{ type: "text", text: "Dump it" }] },
      ctx: ctx(),
    });
    const { rawFrames, parts } = await readSse(response);

    expect(rawFrames.join("")).not.toContain("SECRET_GUARD_DB_URL");
    expect(JSON.stringify(model.prompts)).not.toContain("SECRET_GUARD_DB_URL");
    expect(parts.find((part) => part.type === "tool-output-available")).toMatchObject({
      toolCallId: "call_secret",
      output: {
        status: "error",
        error: { code: "execution", message: "Tool execution failed." },
      },
    });
    expect(JSON.stringify(model.prompts[1])).toContain("Tool execution failed.");
  });

  it("fails chat and runner turns closed when guard directions fail", async () => {
    const model = scriptedModel([]);
    const guard = testGuard({});
    guard.directions = async () => {
      throw new Error("directions unavailable");
    };
    const tools = boundRegistry({}, guard);
    const agent = createAgent({ model, tools, guard });

    await expect(agent.stream({
      threadId: "thr_directions_error",
      message: { id: "user_directions_error", role: "user", parts: [{ type: "text", text: "Hi" }] },
      ctx: ctx(),
    })).rejects.toThrow("directions unavailable");

    const report = await agent.asRunner()(
      { prompt: "Run without directions", tools },
      ctx({ venue: "automation", presence: "away" }),
    );
    expect(report.status).toBe("error");
    expect(report.toolCalls).toEqual([]);
    expect(model.doStreamCalls).toEqual([]);
    expect(model.doGenerateCalls).toEqual([]);
  });

  it("trims leading assistant messages from windowed history so the request does not start with an assistant role", async () => {
    const store = memoryStore();
    const guard = testGuard({});
    const tools = boundRegistry({}, guard);
    const model = scriptedModel([
      textTurn("Reply to final turn.", "text_final"),
    ]);

    // Prepopulate thread with: user, assistant, user, assistant
    const threadId = "thr_window_trim";
    await store.records("vendo_threads").put({
      id: threadId,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      data: {
        subject: "u1",
        messages: [
          userMessage("user_1", "Hello"),
          { id: "assistant_1", role: "assistant", parts: [{ type: "text", text: "Hi there" }] },
          userMessage("user_2", "Second question"),
          { id: "assistant_2", role: "assistant", parts: [{ type: "text", text: "Answer to second" }] },
        ],
      },
    });

    const agent = createAgent({
      model,
      tools,
      guard,
      store,
      context: { historyWindow: 2 }, // window of 2 elements. With user_3 added, thread becomes 5 elements.
      // Slicing last 2 elements gives: assistant_2, user_3.
      // This is trimmed by trimInvalidHistoryStart to just: user_3.
    });

    const response = await agent.stream({
      threadId,
      message: userMessage("user_3", "Final message"),
      ctx: ctx(),
    });
    await readSse(response);

    // Verify model received the correct messages starting with a valid role.
    const prompts = model.prompts;
    expect(prompts).toHaveLength(1);
    const sentMessages = prompts[0];

    // sentMessages[0] is the system message.
    expect(sentMessages[0]?.role).toBe("system");
    // sentMessages[1] should be the trimmed history, starting with user_3's user message.
    expect(sentMessages[1]?.role).toBe("user");
    expect(sentMessages[1]?.content).toEqual([{ type: "text", text: "Final message" }]);
    expect(sentMessages).toHaveLength(2); // System + User (user_3)
  });
});
