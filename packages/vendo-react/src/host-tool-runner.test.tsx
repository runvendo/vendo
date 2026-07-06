// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { render, waitFor } from "@testing-library/react";
import type { Chat } from "@ai-sdk/react";
import type { ChatTransport, UIMessageChunk } from "ai";
import type { VendoUIMessage, HostToolDefinition } from "@vendoai/core";
import { VendoProvider, useVendoContext } from "./provider.js";

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

  it("keeps the same Chat when the same tool set is rebuilt in a different order", () => {
    const transport: ChatTransport<VendoUIMessage> = {
      sendMessages: async () => chunkStream(textTurn),
      reconnectToStream: async () => null,
    };
    const seen: unknown[] = [];
    function Probe() {
      seen.push(useVendoContext().chat);
      return null;
    }
    const ui = (definitions: HostToolDefinition[]) => (
      <VendoProvider transport={transport} components={[]} hostTools={{ definitions }} key="stable">
        <Probe />
      </VendoProvider>
    );
    // Same tool SET, different array order — a host assembling definitions
    // from an unordered source (object keys, a Map, a fetch) must not mint a
    // new Chat (wiping the conversation) just because iteration order moved.
    const { rerender } = render(ui([listAccountsDef, createOrderDef]));
    rerender(ui([createOrderDef, listAccountsDef]));

    expect(seen.length).toBeGreaterThanOrEqual(2);
    expect(new Set(seen).size).toBe(1);
  });

  it("mints a NEW Chat when the tool set genuinely changes", () => {
    const transport: ChatTransport<VendoUIMessage> = {
      sendMessages: async () => chunkStream(textTurn),
      reconnectToStream: async () => null,
    };
    const seen: unknown[] = [];
    function Probe() {
      seen.push(useVendoContext().chat);
      return null;
    }
    const ui = (definitions: HostToolDefinition[]) => (
      <VendoProvider transport={transport} components={[]} hostTools={{ definitions }} key="stable">
        <Probe />
      </VendoProvider>
    );
    const { rerender } = render(ui([listAccountsDef, createOrderDef]));
    rerender(ui([listAccountsDef]));

    expect(seen.length).toBeGreaterThanOrEqual(2);
    expect(new Set(seen).size).toBe(2);
  });

  it("keeps the same Chat when the definitions ARRAY identity changes but its content does not", () => {
    const transport: ChatTransport<VendoUIMessage> = {
      sendMessages: async () => chunkStream(textTurn),
      reconnectToStream: async () => null,
    };

    const seen: unknown[] = [];
    function Probe() {
      seen.push(useVendoContext().chat);
      return null;
    }
    const ui = (nonce: number) => (
      <VendoProvider
        transport={transport}
        components={[]}
        // A fresh definitions ARRAY every render — a host that builds it
        // inline (e.g. `hostTools={{ definitions: toHostTools(tools) }}`
        // without memoizing) re-renders with a new identity but identical
        // content. Keying the Chat on array identity wipes the ENTIRE
        // conversation on such a re-render.
        hostTools={{ definitions: [{ ...listAccountsDef }, { ...createOrderDef }] }}
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

describe("thread rehydration (loadHistory)", () => {
  const restoredMessages: VendoUIMessage[] = [
    { id: "m1", role: "user", parts: [{ type: "text", text: "what did I spend?" }] },
    { id: "m2", role: "assistant", parts: [{ type: "text", text: "You spent $87." }] },
  ] as VendoUIMessage[];

  function probeSetup(loadHistory: () => Promise<VendoUIMessage[]>) {
    const transport: ChatTransport<VendoUIMessage> = {
      sendMessages: async () => chunkStream(textTurn),
      reconnectToStream: async () => null,
    };
    let chat: Chat<VendoUIMessage> | undefined;
    function Probe() {
      chat = useVendoContext().chat;
      return null;
    }
    render(
      <VendoProvider transport={transport} components={[]} loadHistory={loadHistory}>
        <Probe />
      </VendoProvider>,
    );
    if (!chat) throw new Error("chat not captured");
    return chat;
  }

  it("seeds an empty chat with the persisted thread messages", async () => {
    const chat = probeSetup(async () => restoredMessages);
    await waitFor(() => expect(chat.messages.length).toBe(2));
    expect(chat.messages[0]!.id).toBe("m1");
    expect(chat.messages[1]!.id).toBe("m2");
  });

  it("never clobbers a conversation that started before the history resolved", async () => {
    let resolveHistory!: (m: VendoUIMessage[]) => void;
    const gate = new Promise<VendoUIMessage[]>((resolve) => {
      resolveHistory = resolve;
    });
    const chat = probeSetup(() => gate);

    await chat.sendMessage({ text: "fresh question" });
    await waitFor(() => expect(chat.status).toBe("ready"));
    const liveIds = chat.messages.map((m) => m.id);
    expect(liveIds.length).toBeGreaterThan(0);

    resolveHistory(restoredMessages);
    // Give the (skipped) seeding a chance to run; the live turn must survive.
    await new Promise((r) => setTimeout(r, 10));
    expect(chat.messages.map((m) => m.id)).toEqual(liveIds);
  });

  it("ignores a failed history load", async () => {
    const chat = probeSetup(async () => {
      throw new Error("boom");
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(chat.messages.length).toBe(0);
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
