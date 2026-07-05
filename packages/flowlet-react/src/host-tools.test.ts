import { describe, expect, it } from "vitest";
import type { FlowletUIMessage } from "@flowlet/core";
import {
  pendingHostToolCalls,
  hostAwareSendAutomaticallyWhen,
} from "./host-tools";

const HOST = new Set(["listAccounts", "createOrder"]);

type Part = Record<string, unknown> & { type: string };

function assistant(parts: Part[]): FlowletUIMessage {
  return { id: "a1", role: "assistant", parts } as unknown as FlowletUIMessage;
}

function user(text: string): FlowletUIMessage {
  return {
    id: "u1",
    role: "user",
    parts: [{ type: "text", text }],
  } as unknown as FlowletUIMessage;
}

const stepStart: Part = { type: "step-start" };

describe("pendingHostToolCalls", () => {
  it("returns nothing for a missing or user message", () => {
    expect(pendingHostToolCalls(undefined, HOST)).toEqual([]);
    expect(pendingHostToolCalls(user("hi"), HOST)).toEqual([]);
  });

  it("selects un-gated host tool calls that finished streaming", () => {
    const msg = assistant([
      stepStart,
      { type: "tool-listAccounts", toolCallId: "c1", state: "input-available", input: {} },
    ]);
    expect(pendingHostToolCalls(msg, HOST)).toEqual([
      { toolCallId: "c1", toolName: "listAccounts", input: {} },
    ]);
  });

  it("never routes a dynamic (MCP) part to the browser executor, even with a host-matching name", () => {
    const msg = assistant([
      stepStart,
      {
        type: "dynamic-tool",
        toolName: "listAccounts",
        toolCallId: "c-spoof",
        state: "input-available",
        input: {},
      },
    ]);
    expect(pendingHostToolCalls(msg, HOST)).toEqual([]);
  });

  it("selects approved host tool calls awaiting client execution", () => {
    const msg = assistant([
      stepStart,
      {
        type: "tool-createOrder",
        toolCallId: "c2",
        state: "approval-responded",
        input: { body: { merchant: "DoorDash" } },
        approval: { id: "ap1", approved: true },
      },
    ]);
    expect(pendingHostToolCalls(msg, HOST)).toEqual([
      { toolCallId: "c2", toolName: "createOrder", input: { body: { merchant: "DoorDash" } } },
    ]);
  });

  it("ignores approval-requested, declined, completed, and non-host parts", () => {
    const msg = assistant([
      stepStart,
      { type: "tool-createOrder", toolCallId: "c3", state: "approval-requested", input: {}, approval: { id: "ap" } },
      { type: "tool-createOrder", toolCallId: "c4", state: "approval-responded", input: {}, approval: { id: "ap2", approved: false } },
      { type: "tool-listAccounts", toolCallId: "c5", state: "output-available", input: {}, output: {} },
      { type: "tool-get_transactions", toolCallId: "c6", state: "input-available", input: {} },
      { type: "text", text: "hello" },
    ]);
    expect(pendingHostToolCalls(msg, HOST)).toEqual([]);
  });
});

describe("hostAwareSendAutomaticallyWhen", () => {
  const when = hostAwareSendAutomaticallyWhen(HOST);

  it("is false with no messages or a non-assistant last message", () => {
    expect(when({ messages: [] })).toBe(false);
    expect(when({ messages: [user("hi")] })).toBe(false);
  });

  it("is false for a text-only assistant turn", () => {
    expect(when({ messages: [assistant([stepStart, { type: "text", text: "hi" }])] })).toBe(false);
  });

  it("holds resubmission while a host tool awaits client execution", () => {
    const pendingUngated = assistant([
      stepStart,
      { type: "tool-listAccounts", toolCallId: "c1", state: "input-available", input: {} },
    ]);
    expect(when({ messages: [pendingUngated] })).toBe(false);

    const pendingApproved = assistant([
      stepStart,
      {
        type: "tool-createOrder",
        toolCallId: "c2",
        state: "approval-responded",
        input: {},
        approval: { id: "ap", approved: true },
      },
    ]);
    expect(when({ messages: [pendingApproved] })).toBe(false);
  });

  it("fires once the client executor delivered the host tool output", () => {
    const done = assistant([
      stepStart,
      {
        type: "tool-createOrder",
        toolCallId: "c2",
        state: "output-available",
        input: {},
        output: { status: 200, ok: true, data: {} },
        approval: { id: "ap", approved: true },
      },
    ]);
    expect(when({ messages: [done] })).toBe(true);
  });

  it("fires on a declined approval (the server synthesises the denial)", () => {
    const declined = assistant([
      stepStart,
      {
        type: "tool-createOrder",
        toolCallId: "c2",
        state: "approval-responded",
        input: {},
        approval: { id: "ap", approved: false },
      },
    ]);
    expect(when({ messages: [declined] })).toBe(true);
  });

  it("never treats a dynamic part named like a host tool as host-owed (spoof guard)", () => {
    // An MCP tool whose full name collides with a host tool must not stall
    // resubmission waiting for a browser executor that will never run it.
    const spoofed = assistant([
      stepStart,
      {
        type: "dynamic-tool",
        toolName: "createOrder",
        toolCallId: "c10",
        state: "approval-responded",
        input: {},
        approval: { id: "ap-x", approved: true },
      },
    ]);
    expect(when({ messages: [spoofed] })).toBe(true);
  });

  it("fires on an approved DYNAMIC server tool (MCP tools stream as dynamic-tool parts)", () => {
    const dynamicApproved = assistant([
      stepStart,
      {
        type: "dynamic-tool",
        toolName: "everything_echo",
        toolCallId: "c9",
        state: "approval-responded",
        input: { message: "hi" },
        approval: { id: "ap-d", approved: true },
      },
    ]);
    expect(when({ messages: [dynamicApproved] })).toBe(true);
  });

  it("keeps the existing server-tool approval behaviour", () => {
    const serverApproved = assistant([
      stepStart,
      {
        type: "tool-GMAIL_SEND_EMAIL",
        toolCallId: "c7",
        state: "approval-responded",
        input: {},
        approval: { id: "ap", approved: true },
      },
    ]);
    expect(when({ messages: [serverApproved] })).toBe(true);
  });

  it("mixed step: waits for the approved host tool, then fires", () => {
    const serverPart: Part = {
      type: "tool-GMAIL_SEND_EMAIL",
      toolCallId: "c7",
      state: "approval-responded",
      input: {},
      approval: { id: "ap-s", approved: true },
    };
    const hostPending: Part = {
      type: "tool-createOrder",
      toolCallId: "c8",
      state: "approval-responded",
      input: {},
      approval: { id: "ap-h", approved: true },
    };
    expect(when({ messages: [assistant([stepStart, serverPart, hostPending])] })).toBe(false);

    const hostDone: Part = {
      ...hostPending,
      state: "output-available",
      output: { status: 200, ok: true, data: {} },
    };
    expect(when({ messages: [assistant([stepStart, serverPart, hostDone])] })).toBe(true);
  });

  it("only considers the last step's tool parts", () => {
    const msg = assistant([
      stepStart,
      { type: "tool-listAccounts", toolCallId: "c1", state: "output-available", input: {}, output: {} },
      stepStart,
      { type: "text", text: "all done" },
    ]);
    expect(when({ messages: [msg] })).toBe(false);
  });
});
