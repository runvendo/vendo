import {
  VENDO_VIEW_STREAM,
  vendoViewStreamId,
  vendoApprovalPartSchema,
  vendoViewPartSchema,
  type ToolDescriptor,
  type VendoViewStreamingToolCall,
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
    // The app runtime's open tool returns an OpenSurface; the view part's appId
    // comes from the call args (OpenSurface itself carries none).
    const openSurface = { kind: "tree" as const, payload: view.payload };
    const descriptor: ToolDescriptor = {
      name: "vendo_apps_open",
      description: "Open the latest serving surface for a Vendo app.",
      inputSchema: { type: "object", properties: { appId: { type: "string" } }, required: ["appId"] },
      risk: "read",
    };
    const model = scriptedModel([
      toolCallTurn("vendo_apps_open", { appId: "app_1" }, "call_view"),
      textTurn("Rendered.", "text_view_done"),
    ]);
    const guard = testGuard({ vendo_apps_open: "run" });
    const tools = boundRegistry({ vendo_apps_open: { descriptor, execute: async () => openSurface } }, guard);
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
      toolName: "vendo_apps_open",
      state: "output-available",
      output: { status: "ok", output: openSurface },
    });

    // Wire form: the ai-SDK data-chunk envelope carries the core part fields
    // under `data` — useChat's strict chunk schema rejects the flat form.
    const viewPart = partOfType(message, "data-vendo-view");
    expect(viewPart).toEqual({ type: "data-vendo-view", id: vendoViewStreamId("app_1"), data: view });
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

  it("reconciles partial create views and the final open view by stable id on the stock client", async () => {
    const appId = "app_stream";
    const stableId = vendoViewStreamId(appId);
    const partialOne = {
      formatVersion: "vendo-genui/v1",
      root: "r",
      nodes: [{ id: "r", component: "Stack", children: ["later"] }],
      streaming: true,
    };
    const partialTwo = {
      ...partialOne,
      nodes: [...partialOne.nodes, { id: "later", component: "Text", props: { text: "Loading data" } }],
    };
    const finalPayload = {
      formatVersion: "vendo-genui/v1",
      root: "r",
      nodes: [...partialTwo.nodes],
      data: { ready: true },
    };
    const createDescriptor: ToolDescriptor = {
      name: "vendo_apps_create",
      description: "Create an app.",
      inputSchema: { type: "object", properties: { prompt: { type: "string" } }, required: ["prompt"] },
      risk: "write",
    };
    const openDescriptor: ToolDescriptor = {
      name: "vendo_apps_open",
      description: "Open an app.",
      inputSchema: { type: "object", properties: { appId: { type: "string" } }, required: ["appId"] },
      risk: "read",
    };
    const model = scriptedModel([
      toolCallTurn("vendo_apps_create", { prompt: "Stream it" }, "call_create_stream"),
      toolCallTurn("vendo_apps_open", { appId }, "call_open_stream"),
      textTurn("Ready.", "text_stream_done"),
    ]);
    const guard = testGuard({ vendo_apps_create: "run", vendo_apps_open: "run" });
    const tools = boundRegistry({
      vendo_apps_create: {
        descriptor: createDescriptor,
        execute: async (_args, _ctx, call) => {
          const stream = (call as VendoViewStreamingToolCall)[VENDO_VIEW_STREAM];
          if (stream === undefined) throw new Error("create stream hook missing");
          stream({ id: stableId, part: { type: "data-vendo-view", appId, payload: partialOne } });
          stream({ id: stableId, part: { type: "data-vendo-view", appId, payload: partialTwo } });
          return { format: "vendo/app@1", id: appId, name: "Streamed", ui: "tree", tree: finalPayload };
        },
      },
      vendo_apps_open: {
        descriptor: openDescriptor,
        execute: async () => ({ kind: "tree", payload: finalPayload }),
      },
    }, guard);
    const agent = createAgent({ model, tools, guard });

    const response = await agent.stream({
      threadId: "thr_client_stream",
      message: userMessage("user_client_stream", "Build the view"),
      ctx: ctx(),
    });
    const [wire, message] = await Promise.all([
      readSse(response.clone()),
      assembleClientMessage(response),
    ]);

    const wireViews = wire.parts.filter((part) => part.type === "data-vendo-view");
    expect(wireViews).toHaveLength(3);
    expect(wireViews.map((part) => part.id)).toEqual([stableId, stableId, stableId]);
    const clientViews = message.parts.filter((part) => part.type === "data-vendo-view");
    expect(clientViews).toEqual([{
      type: "data-vendo-view",
      id: stableId,
      data: { appId, payload: finalPayload },
    }]);
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
