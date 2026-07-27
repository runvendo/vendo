import { vendoConnectPartSchema, type ToolDescriptor, type ToolOutcome, type ToolRegistry } from "@vendoai/core";
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { describe, expect, it, vi } from "vitest";
import { createAgent } from "./index.js";
import { ctx, readSse, scriptedModel, testGuard, textTurn, toolCallTurn } from "./test-helpers.js";

const descriptor: ToolDescriptor = {
  name: "gmail_GMAIL_SEND_EMAIL",
  description: "Send an email through the Composio gmail toolkit.",
  inputSchema: {
    type: "object",
    properties: { to: { type: "string" } },
    required: ["to"],
    additionalProperties: false,
  },
  risk: "write",
};

/** A connector-backed registry whose execution needs a per-user connection. */
const registry: ToolRegistry = {
  async descriptors() {
    return [descriptor];
  },
  async execute() {
    return {
      status: "connect-required",
      connect: {
        connector: "composio",
        toolkit: "gmail",
        message: "Connect your gmail account to run gmail_GMAIL_SEND_EMAIL.",
      },
    };
  },
};

describe("agent connect-required bridge", () => {
  it("emits a data-vendo-connect part beside the tool part (04-actions §3)", async () => {
    const agent = createAgent({
      model: scriptedModel([
        toolCallTurn(descriptor.name, { to: "ada@example.test" }, "call_connect"),
        textTurn("You need to connect gmail first.", "text_connect"),
      ]),
      tools: registry,
      guard: testGuard({}),
    });

    const response = await agent.stream({
      threadId: "thr_connect",
      message: { id: "user_1", role: "user", parts: [{ type: "text", text: "Email Ada" }] },
      ctx: ctx(),
    });
    const { parts } = await readSse(response);

    const connectPart = parts.find((part) => (part as { type?: string }).type === "data-vendo-connect") as
      | { type: string; data: Record<string, unknown> }
      | undefined;
    expect(connectPart).toBeDefined();
    expect(connectPart!.data).toMatchObject({
      toolCallId: "call_connect",
      connector: "composio",
      toolkit: "gmail",
    });
    expect(
      vendoConnectPartSchema.safeParse({ type: "data-vendo-connect", ...connectPart!.data }).success,
    ).toBe(true);

    // The model sees the typed outcome on the native tool channel.
    const outputAvailable = parts.find(
      (part) => (part as { type?: string }).type === "tool-output-available",
    ) as { output?: { status?: string } } | undefined;
    expect(outputAvailable?.output?.status).toBe("connect-required");
  });

  it("checker F3: two tools of the SAME unconnected service in one step render ONE card", async () => {
    // One connect action, one card — even though the model called two gmail
    // tools in the same step. The model still gets both connect-required
    // outcomes; only the duplicate card is suppressed.
    const fetchDescriptor: ToolDescriptor = {
      ...descriptor,
      name: "gmail_GMAIL_FETCH_EMAILS",
      description: "Fetch emails through the Composio gmail toolkit.",
      risk: "read",
    };
    const twoCallStep: LanguageModelV3StreamPart[] = [
      { type: "tool-call", toolCallId: "call_send", toolName: descriptor.name, input: JSON.stringify({ to: "a@b.c" }) },
      { type: "tool-call", toolCallId: "call_fetch", toolName: fetchDescriptor.name, input: JSON.stringify({}) },
      { type: "finish", usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, finishReason: { unified: "tool-calls", raw: undefined } },
    ];
    const twoToolRegistry: ToolRegistry = {
      descriptors: async () => [descriptor, fetchDescriptor],
      execute: async (call) => ({
        status: "connect-required",
        connect: {
          connector: "composio",
          toolkit: "gmail",
          message: `Connect your gmail account to run ${call.tool}.`,
        },
      }),
    };
    const agent = createAgent({
      model: scriptedModel([twoCallStep, textTurn("Connect gmail to continue.", "text_dedupe")]),
      tools: twoToolRegistry,
      guard: testGuard({}),
    });

    const response = await agent.stream({
      threadId: "thr_dedupe",
      message: { id: "user_1", role: "user", parts: [{ type: "text", text: "Email Ada and check my inbox" }] },
      ctx: ctx(),
    });
    const { parts } = await readSse(response);

    const connectParts = parts.filter((part) => (part as { type?: string }).type === "data-vendo-connect");
    expect(connectParts).toHaveLength(1);
    // Both calls still reported the typed outcome to the model.
    const outcomes = parts
      .filter((part) => (part as { type?: string }).type === "tool-output-available")
      .map((part) => (part as { output?: { status?: string } }).output?.status);
    expect(outcomes.filter((status) => status === "connect-required")).toHaveLength(2);
  });

  it("criterion 11 (chat path): preflight rules the call out BEFORE the guard — no approval minted", async () => {
    // The guard would ASK for this write tool; preflight (the connect gate)
    // already knows the service is unconnected, so the guard must never be
    // consulted and no approval part may reach the stream — only the card.
    const guard = testGuard({ [descriptor.name]: "ask" });
    const check = vi.spyOn(guard, "check");
    const preflightOutcome: ToolOutcome = {
      status: "connect-required",
      connect: { connector: "composio", toolkit: "gmail", message: "Connect your gmail account." },
    };
    const agent = createAgent({
      model: scriptedModel([
        toolCallTurn(descriptor.name, { to: "ada@example.test" }, "call_gated"),
        textTurn("Connect gmail to continue.", "text_gated"),
      ]),
      tools: registry,
      guard,
      preflight: async () => preflightOutcome,
    });

    const response = await agent.stream({
      threadId: "thr_gated",
      message: { id: "user_1", role: "user", parts: [{ type: "text", text: "Email Ada" }] },
      ctx: ctx(),
    });
    const { parts } = await readSse(response);

    expect(check).not.toHaveBeenCalled();
    expect(parts.some((part) => (part as { type?: string }).type === "data-vendo-approval")).toBe(false);
    const connectPart = parts.find((part) => (part as { type?: string }).type === "data-vendo-connect");
    expect(connectPart).toBeDefined();
  });
});
