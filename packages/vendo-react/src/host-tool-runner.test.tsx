// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { render, waitFor } from "@testing-library/react";
import type { Chat } from "@ai-sdk/react";
import type { ChatTransport, UIMessageChunk } from "ai";
import type { VendoUIMessage, HostToolDefinition } from "@vendoai/core";
import { VendoProvider, useVendoContext } from "./provider";

const listAccountsDef: HostToolDefinition = {
  name: "listAccounts",
  description: "List all accounts",
  inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  http: { method: "get", path: "/api/accounts", params: [], hasBody: false },
};

const createOrderDef: HostToolDefinition = {
  name: "createOrder",
  description: "Place a delivery order",
  inputSchema: {
    type: "object",
    properties: { body: { type: "object" } },
    required: ["body"],
    additionalProperties: false,
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
  http: { method: "post", path: "/api/orders", params: [], hasBody: true },
};

function chunkStream(chunks: UIMessageChunk[]): ReadableStream<UIMessageChunk> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

const textTurn: UIMessageChunk[] = [
  { type: "start" },
  { type: "start-step" },
  { type: "text-start", id: "t1" },
  { type: "text-delta", id: "t1", delta: "done" },
  { type: "text-end", id: "t1" },
  { type: "finish-step" },
  { type: "finish" },
] as UIMessageChunk[];

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/** Renders the provider and captures the shared Chat for driving the test. */
function setup(turns: UIMessageChunk[][], fetchImpl: typeof fetch) {
  const sendMessages = vi.fn(async () => chunkStream(turns[sendMessages.mock.calls.length - 1] ?? textTurn));
  const transport: ChatTransport<VendoUIMessage> = {
    sendMessages: sendMessages as unknown as ChatTransport<VendoUIMessage>["sendMessages"],
    reconnectToStream: async () => null,
  };

  let chat: Chat<VendoUIMessage> | undefined;
  function Probe() {
    chat = useVendoContext().chat;
    return null;
  }
  render(
    <VendoProvider
      transport={transport}
      components={[]}
      hostTools={{ definitions: [listAccountsDef, createOrderDef], fetchImpl }}
    >
      <Probe />
    </VendoProvider>,
  );
  if (!chat) throw new Error("chat not captured");
  return { chat, sendMessages };
}

describe("chat identity stability", () => {
  it("keeps the same Chat when a parent re-render passes a fresh inline hostTools object", () => {
    const transport: ChatTransport<VendoUIMessage> = {
      sendMessages: async () => chunkStream(textTurn),
      reconnectToStream: async () => null,
    };
    const definitions = [listAccountsDef, createOrderDef];

    const seen: unknown[] = [];
    function Probe() {
      seen.push(useVendoContext().chat);
      return null;
    }
    const ui = (nonce: number) => (
      <VendoProvider
        transport={transport}
        components={[]}
        // Fresh object literal every render — like VendoRoot does. Only the
        // definitions array is stable. A new Chat here would wipe SDK message
        // and approval state mid-turn.
        hostTools={{ definitions }}
        key="stable"
        data-nonce={nonce}
      >
        <Probe />
      </VendoProvider>
    );
    const { rerender } = render(ui(1));
    rerender(ui(2));
    rerender(ui(3));

    expect(seen.length).toBeGreaterThanOrEqual(3);
    expect(new Set(seen).size).toBe(1);
  });
});

describe("host tool runner", () => {
  it("executes an un-gated host tool in the browser and resubmits with the output", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ data: [{ id: "acct_1" }] }));
    const toolTurn = [
      { type: "start" },
      { type: "start-step" },
      { type: "tool-input-available", toolCallId: "c1", toolName: "listAccounts", input: {} },
      { type: "finish-step" },
      { type: "finish" },
    ] as UIMessageChunk[];

    const { chat, sendMessages } = setup([toolTurn, textTurn], fetchImpl as unknown as typeof fetch);
    await chat.sendMessage({ text: "show my accounts" });

    await waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    expect(fetchImpl).toHaveBeenCalledWith("/api/accounts", expect.objectContaining({ method: "GET" }));

    // The runner attached the output and the turn auto-resubmitted.
    await waitFor(() => expect(sendMessages).toHaveBeenCalledTimes(2));
    const resubmitted = sendMessages.mock.calls[1]![0] as unknown as {
      messages: VendoUIMessage[];
    };
    const toolPart = resubmitted.messages
      .at(-1)!
      .parts.find((p) => p.type === "tool-listAccounts") as { state: string; output: unknown };
    expect(toolPart.state).toBe("output-available");
    expect(toolPart.output).toEqual({
      status: 200,
      ok: true,
      data: { data: [{ id: "acct_1" }] },
    });
  });

  it("executes a gated host tool only after approval", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ data: { id: "txn_9" } }));
    const gatedTurn = [
      { type: "start" },
      { type: "start-step" },
      {
        type: "tool-input-available",
        toolCallId: "c2",
        toolName: "createOrder",
        input: { body: { merchant: "DoorDash" } },
      },
      { type: "tool-approval-request", approvalId: "ap1", toolCallId: "c2" },
      { type: "finish-step" },
      { type: "finish" },
    ] as UIMessageChunk[];

    const { chat, sendMessages } = setup([gatedTurn, textTurn], fetchImpl as unknown as typeof fetch);
    await chat.sendMessage({ text: "order my usual" });

    // Approval pending: nothing executed, nothing resubmitted.
    await new Promise((r) => setTimeout(r, 50));
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(sendMessages).toHaveBeenCalledTimes(1);

    await chat.addToolApprovalResponse({ id: "ap1", approved: true });

    await waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    expect(fetchImpl).toHaveBeenCalledWith(
      "/api/orders",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ merchant: "DoorDash" }) }),
    );
    await waitFor(() => expect(sendMessages).toHaveBeenCalledTimes(2));
  });

  it("declining a gated host tool resubmits without executing", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}));
    const gatedTurn = [
      { type: "start" },
      { type: "start-step" },
      { type: "tool-input-available", toolCallId: "c3", toolName: "createOrder", input: { body: {} } },
      { type: "tool-approval-request", approvalId: "ap2", toolCallId: "c3" },
      { type: "finish-step" },
      { type: "finish" },
    ] as UIMessageChunk[];

    const { chat, sendMessages } = setup([gatedTurn, textTurn], fetchImpl as unknown as typeof fetch);
    await chat.sendMessage({ text: "order again" });
    await chat.addToolApprovalResponse({ id: "ap2", approved: false });

    await waitFor(() => expect(sendMessages).toHaveBeenCalledTimes(2));
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("reports a transport failure as a tool error output", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("network down");
    });
    const toolTurn = [
      { type: "start" },
      { type: "start-step" },
      { type: "tool-input-available", toolCallId: "c4", toolName: "listAccounts", input: {} },
      { type: "finish-step" },
      { type: "finish" },
    ] as UIMessageChunk[];

    const { chat, sendMessages } = setup([toolTurn, textTurn], fetchImpl as unknown as typeof fetch);
    await chat.sendMessage({ text: "accounts" });

    await waitFor(() => expect(sendMessages).toHaveBeenCalledTimes(2));
    const resubmitted = sendMessages.mock.calls[1]![0] as unknown as {
      messages: VendoUIMessage[];
    };
    const toolPart = resubmitted.messages
      .at(-1)!
      .parts.find((p) => p.type === "tool-listAccounts") as { state: string; errorText?: string };
    expect(toolPart.state).toBe("output-error");
    expect(toolPart.errorText).toMatch(/network down/);
  });
});
