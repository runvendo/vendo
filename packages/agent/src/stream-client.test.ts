import {
  vendoApprovalPartSchema,
  vendoViewPartSchema,
  type ToolDescriptor,
} from "@vendoai/core";
import { readUIMessageStream, type UIMessage, type UIMessageChunk } from "ai";
import { simulateReadableStream } from "ai/test";
import { describe, expect, it } from "vitest";
import { createAgent } from "./index.js";
import {
  boundRegistry,
  ctx,
  memoryStore,
  partOfType,
  readSse,
  scriptedModel,
  testGuard,
  textTurn,
  toolCallTurn,
  userMessage,
} from "./test-helpers.js";

// 03-agent §4: "an ai-SDK UI message stream Response (SSE), consumable by
// ai-SDK clients (ui's useVendoThread rides this)". The other suites parse the
// SSE frames by hand; this one feeds the agent's ACTUAL Response bytes back
// through the SDK's own client reducer (readUIMessageStream) — the exact code
// path ui's hooks use — and asserts the assembled UIMessage. That is the E2E
// proof the wire is genuinely client-consumable, and that the Vendo data parts
// (core §16) survive the official reducer intact rather than only surviving a
// bespoke parser.
async function assembleClientMessage(response: Response): Promise<UIMessage> {
  const { parts } = await readSse(response);
  let last: UIMessage | undefined;
  for await (const message of readUIMessageStream({
    stream: simulateReadableStream({ chunks: parts as UIMessageChunk[] }),
  })) {
    last = message;
  }
  if (last === undefined) throw new Error("client reducer produced no message");
  return last;
}

function dynamicTool(message: UIMessage, toolCallId: string): Record<string, unknown> | undefined {
  return message.parts.find(
    (part) => part.type === "dynamic-tool" && (part as { toolCallId?: string }).toolCallId === toolCallId,
  ) as Record<string, unknown> | undefined;
}

describe("agent stream consumed by an ai-SDK client", () => {
  it("assembles a tool round trip and a Vendo view part into a client UIMessage and persists the turn", async () => {
    const view = {
      appId: "app_1",
      payload: {
        formatVersion: "vendo-genui/v1",
        root: "r",
        nodes: [{ id: "r", component: "Text", props: { text: "Ready" } }],
      },
    };
    const descriptor: ToolDescriptor = {
      name: "render_result",
      description: "Return a rendered app surface.",
      inputSchema: { type: "object", additionalProperties: false },
      risk: "read",
    };
    const model = scriptedModel([
      toolCallTurn("render_result", {}, "call_view"),
      textTurn("Rendered.", "text_view_done"),
    ]);
    const guard = testGuard({ render_result: "run" });
    const tools = boundRegistry({ render_result: { descriptor, execute: async () => view } }, guard);
    const store = memoryStore();
    const agent = createAgent({ model, tools, guard, store });
    const runCtx = ctx();

    const response = await agent.stream({
      threadId: "thr_client_view",
      message: userMessage("user_client_view", "Show the result"),
      ctx: runCtx,
    });
    const message = await assembleClientMessage(response);

    // The SDK reducer produces one assistant message with the tool resolved,
    // the Vendo view data part preserved, and the final text.
    expect(message.role).toBe("assistant");

    const toolPart = dynamicTool(message, "call_view");
    expect(toolPart).toMatchObject({
      type: "dynamic-tool",
      toolName: "render_result",
      state: "output-available",
      output: { status: "ok", output: view },
    });

    // Wire form: the ai-SDK data-chunk envelope carries the core part fields
    // under `data` — useChat's strict chunk schema rejects the flat form.
    const viewPart = partOfType(message, "data-vendo-view");
    expect(viewPart).toEqual({ type: "data-vendo-view", data: view });
    const viewData = (viewPart as { data: Record<string, unknown> }).data;
    expect(vendoViewPartSchema.safeParse({ type: "data-vendo-view", ...viewData }).success).toBe(true);

    const textPart = message.parts.find(
      (part) => part.type === "text" && (part as { text?: string }).text === "Rendered.",
    );
    expect(textPart).toBeDefined();

    // Real StoreAdapter side effect: the completed turn is persisted as one
    // vendo_threads row for this subject, carrying the assembled assistant
    // message the client just read.
    const rows = await store.records("vendo_threads").list({ refs: { subject: "u1" } });
    expect(rows.records).toHaveLength(1);
    const persisted = rows.records[0]!.data as { subject: string; messages: UIMessage[] };
    expect(persisted.subject).toBe("u1");
    expect(persisted.messages.some((entry) => entry.id === message.id && entry.role === "assistant")).toBe(true);
    expect(persisted.messages.some((entry) => entry.id === "user_client_view")).toBe(true);
  });

  it("surfaces the native approval request and the Vendo approval part to an ai-SDK client on pause", async () => {
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
    // A single scripted turn: the model calls the asked tool, the guard parks,
    // the turn pauses. No second turn is scripted — the client sees the pause.
    const model = scriptedModel([toolCallTurn("send_echo", { value: "hi" }, "call_ap")]);
    const guard = testGuard({ send_echo: "ask" });
    const tools = boundRegistry(
      { send_echo: { descriptor, execute: async () => ({ echoed: "hi" }) } },
      guard,
    );
    const agent = createAgent({ model, tools, guard });

    const response = await agent.stream({
      threadId: "thr_client_approval",
      message: userMessage("user_client_approval", "Send the echo"),
      ctx: ctx(),
    });
    const message = await assembleClientMessage(response);

    // The client reducer resolves the tool part to the SDK's native
    // approval-requested state (its own approval id, used for
    // addToolApprovalResponse) ...
    const toolPart = dynamicTool(message, "call_ap");
    expect(toolPart).toMatchObject({ type: "dynamic-tool", toolName: "send_echo", state: "approval-requested" });
    expect(typeof (toolPart?.approval as { id?: unknown } | undefined)?.id).toBe("string");

    // ... alongside the Vendo approval data part carrying the CORE approvalId
    // (used for guard.approvals.decide). Two ids, two flows, both on the wire.
    const approvalPart = partOfType(message, "data-vendo-approval");
    expect(approvalPart).toEqual({
      type: "data-vendo-approval",
      data: { toolCallId: "call_ap", risk: "write", approvalId: "apr_call_ap" },
    });
    const approvalData = (approvalPart as { data: Record<string, unknown> }).data;
    expect(vendoApprovalPartSchema.safeParse({ type: "data-vendo-approval", ...approvalData }).success).toBe(true);

    // The tool did not execute; the approval remains queued for the user.
    expect(tools.invocations.send_echo).toBe(0);
    expect(guard.pending()).toHaveLength(1);
  });
});
