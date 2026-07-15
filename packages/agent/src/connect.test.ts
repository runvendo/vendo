import { vendoConnectPartSchema, type ToolDescriptor, type ToolRegistry } from "@vendoai/core";
import { describe, expect, it } from "vitest";
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
});
