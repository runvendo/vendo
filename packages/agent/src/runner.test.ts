import { agentRunReportSchema, type ToolDescriptor } from "@vendoai/core";
import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it } from "vitest";
import { createAgent } from "./index.js";
import {
  boundRegistry,
  ctx,
  scriptedModel,
  testGuard,
  textTurn,
  toolCallTurn,
} from "./test-helpers.js";

const descriptor: ToolDescriptor = {
  name: "automation_echo",
  description: "Echo a value during an automation.",
  inputSchema: {
    type: "object",
    properties: { value: { type: "string" } },
    required: ["value"],
    additionalProperties: false,
  },
  risk: "write",
};

const awayCtx = ctx({ venue: "automation", presence: "away", sessionId: "run_session_1" });

describe("headless AgentRunner", () => {
  it("passes abortSignal to the model and reports an aborted generation as stopped", async () => {
    let started!: () => void;
    const didStart = new Promise<void>((resolve) => { started = resolve; });
    const model = new MockLanguageModelV3({
      doGenerate: async ({ abortSignal }) => await new Promise((_, reject) => {
        started();
        abortSignal?.addEventListener("abort", () => reject(abortSignal.reason), { once: true });
      }),
    });
    const guard = testGuard({});
    const tools = boundRegistry({}, guard);
    const agent = createAgent({ model, tools, guard });
    const controller = new AbortController();

    const running = agent.asRunner()(
      { prompt: "Wait until stopped", tools, abortSignal: controller.signal },
      awayCtx,
    );
    await didStart;
    controller.abort();

    await expect(running).resolves.toMatchObject({ status: "stopped" });
    expect(guard.events.at(-1)?.detail).toMatchObject({ status: "stopped" });
  });

  it("fails soft when an away tool call parks for approval", async () => {
    const model = scriptedModel([
      toolCallTurn(descriptor.name, { value: "later" }, "call_away"),
      textTurn("The action is pending approval.", "text_away_done"),
    ]);
    const guard = testGuard({ [descriptor.name]: "ask" });
    const tools = boundRegistry({
      [descriptor.name]: {
        descriptor,
        execute: async (args) => ({ echoed: args }),
      },
    }, guard);
    const agent = createAgent({ model, tools, guard });

    const report = await agent.asRunner()(
      { prompt: "Echo later", tools },
      awayCtx,
    );

    expect(agentRunReportSchema.safeParse(report).success).toBe(true);
    expect(report.status).toBe("ok");
    expect(report.toolCalls).toEqual([
      {
        call: { id: "call_away", tool: descriptor.name, args: { value: "later" } },
        outcome: "pending-approval",
      },
    ]);
    expect(report.summary).toContain("pending approval");
    expect(guard.pending()).toHaveLength(1);
    expect(guard.pending()[0]).toMatchObject({
      id: "apr_call_away",
      call: { id: "call_away", tool: descriptor.name, args: { value: "later" } },
      ctx: { principal: { subject: "u1" }, venue: "automation", presence: "away" },
    });
    expect(tools.invocations.automation_echo).toBe(0);
  });

  it("gates parallel tool calls before execution when maxToolCalls is exhausted", async () => {
    const firstCall = toolCallTurn(descriptor.name, { value: "one" }, "call_budget_1");
    const secondCall = toolCallTurn(descriptor.name, { value: "two" }, "call_budget_2");
    const model = scriptedModel([
      [...firstCall.slice(0, -1), ...secondCall],
    ]);
    const guard = testGuard({ [descriptor.name]: "run" });
    const tools = boundRegistry({
      [descriptor.name]: {
        descriptor,
        execute: async (args) => ({ echoed: args }),
      },
    }, guard);
    const agent = createAgent({ model, tools, guard });

    const report = await agent.asRunner()(
      { prompt: "Keep echoing", tools, budget: { maxToolCalls: 1 } },
      awayCtx,
    );

    expect(report.status).toBe("stopped");
    expect(report.toolCalls).toEqual([
      {
        call: { id: "call_budget_1", tool: descriptor.name, args: { value: "one" } },
        outcome: "ok",
      },
      {
        call: { id: "call_budget_2", tool: descriptor.name, args: { value: "two" } },
        outcome: "error",
      },
    ]);
    expect(tools.invocations.automation_echo).toBe(1);
  });

  it("passes maxOutputTokens to the runner model call", async () => {
    const model = scriptedModel([textTurn("Bounded output.", "text_bounded")]);
    const guard = testGuard({});
    const tools = boundRegistry({}, guard);
    const agent = createAgent({
      model,
      tools,
      guard,
      context: { maxOutputTokens: 256 },
    });

    const report = await agent.asRunner()(
      { prompt: "Keep this short", tools },
      awayCtx,
    );

    expect(report.status).toBe("ok");
    expect(model.doGenerateCalls).toHaveLength(1);
    expect(model.doGenerateCalls[0]?.maxOutputTokens).toBe(256);
  });

  it("reports exactly one run audit event", async () => {
    const model = scriptedModel([textTurn("Run complete.", "text_run_done")]);
    const guard = testGuard({});
    const tools = boundRegistry({}, guard);
    const agent = createAgent({ model, tools, guard });

    const report = await agent.asRunner()(
      { prompt: "Summarize the run", tools },
      awayCtx,
    );
    const runEvents = guard.events.filter((event) => event.kind === "run");

    expect(report.status).toBe("ok");
    expect(runEvents).toHaveLength(1);
    expect(runEvents[0]).toMatchObject({
      id: expect.stringMatching(/^aud_/),
      kind: "run",
      principal: { kind: "user", subject: "u1" },
      venue: "automation",
      presence: "away",
      detail: { status: "ok", toolCallCount: 0 },
    });
  });
});
