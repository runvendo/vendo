// @vitest-environment jsdom
// ENG-319 — the realtime tool-call bridge: a live voice session acts through
// Vendo. These tests drive the bridge directly (the driver funnels every model
// function call into onToolCall), stubbing the wire with SSE turns so the whole
// mint-view / park-approval / resume loop is exercised without a real model.
import type { ApprovalRequest } from "@vendoai/core";
import { createUIMessageStream, createUIMessageStreamResponse, type UIMessage, type UIMessageChunk } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createVendoClient } from "../../src/index.js";
import { createVoiceActBridge } from "../../src/voice/voice-act.js";
import type { VoiceSessionView } from "../../src/voice/driver.js";

const BASE = "https://wire.test/api/vendo";

function sseResponse(build: (writer: { write(chunk: UIMessageChunk): void }) => void, threadId = "thr_voice"): Response {
  const stream = createUIMessageStream<UIMessage>({
    originalMessages: [],
    generateId: () => "msg_act",
    execute: ({ writer }) => { build(writer); },
  });
  const response = createUIMessageStreamResponse({ stream });
  response.headers.set("x-vendo-thread-id", threadId);
  return response;
}

/** A scripted wire: each POST /threads pops the next turn builder; GET/POST
    /approvals reads/decides the pending queue. */
function scriptedWire(turns: Array<(w: { write(c: UIMessageChunk): void }) => void>) {
  let pending: ApprovalRequest[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? "GET";
    if (url.endsWith("/threads") && method === "POST") {
      const build = turns.shift();
      if (!build) throw new Error("no scripted turn left");
      return sseResponse(build);
    }
    if (url.endsWith("/approvals") && method === "GET") {
      return Response.json(pending);
    }
    throw new Error(`unexpected request: ${method} ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return {
    fetchMock,
    setPending: (requests: ApprovalRequest[]) => { pending = requests; },
    decide: (id: string) => { pending = pending.filter((request) => request.id !== id); },
  };
}

const VIEW_PAYLOAD = { formatVersion: "vendo-genui/v2", root: "r", nodes: [{ id: "r", component: "Text", props: { text: "Outstanding: $18,420" } }] };

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("voice act bridge (ENG-319)", () => {
  it("runs a plain turn and speaks the assistant text", async () => {
    scriptedWire([
      (w) => {
        w.write({ type: "text-start", id: "t1" });
        w.write({ type: "text-delta", id: "t1", delta: "You have six outstanding invoices." });
        w.write({ type: "text-end", id: "t1" });
      },
    ]);
    const bridge = createVoiceActBridge({ client: createVendoClient({ baseUrl: BASE }) });
    const views: VoiceSessionView[] = [];
    const result = await bridge.onToolCall(
      { callId: "c1", name: "vendo_act", args: { request: "what's outstanding?" } },
      { emitView: (view) => views.push(view) },
    ) as { result: string; viewsShown: number };
    expect(result.result).toBe("You have six outstanding invoices.");
    expect(result.viewsShown).toBe(0);
    expect(views).toHaveLength(0);
  });

  it("mints a view into the session feed", async () => {
    scriptedWire([
      (w) => {
        w.write({ type: "data-vendo-view", data: { appId: "app_1", payload: VIEW_PAYLOAD } } as unknown as UIMessageChunk);
        w.write({ type: "text-start", id: "t1" });
        w.write({ type: "text-delta", id: "t1", delta: "Here's the view." });
        w.write({ type: "text-end", id: "t1" });
      },
    ]);
    const bridge = createVoiceActBridge({ client: createVendoClient({ baseUrl: BASE }) });
    const views: VoiceSessionView[] = [];
    const result = await bridge.onToolCall(
      { callId: "c1", name: "vendo_act", args: { request: "show outstanding" } },
      { emitView: (view) => views.push(view) },
    ) as { viewsShown: number };
    expect(result.viewsShown).toBe(1);
    expect(views[0]?.appId).toBe("app_1");
    expect(views[0]?.payload).toMatchObject({ formatVersion: "vendo-genui/v2" });
  });

  it("parks an approval, waits for the consent bar to decide, then resumes", async () => {
    const wire = scriptedWire([
      // Turn 1: an approval-requested tool part + the guard's data-vendo-approval.
      (w) => {
        w.write({ type: "tool-input-available", toolCallId: "call_send", toolName: "host_email_send", input: { to: "a@x.com" }, dynamic: true });
        w.write({ type: "tool-approval-request", toolCallId: "call_send", approvalId: "apr_g" });
        w.write({ type: "data-vendo-approval", data: { toolCallId: "call_send", risk: "write", approvalId: "apr_g" } } as unknown as UIMessageChunk);
        w.write({ type: "text-start", id: "t1" });
        w.write({ type: "text-delta", id: "t1", delta: "This needs your approval." });
        w.write({ type: "text-end", id: "t1" });
      },
      // Turn 2 (resume): the executed continuation.
      (w) => {
        w.write({ type: "text-start", id: "t2" });
        w.write({ type: "text-delta", id: "t2", delta: "Reminder sent." });
        w.write({ type: "text-end", id: "t2" });
      },
    ]);
    wire.setPending([{
      id: "apr_g",
      call: { id: "call_send", tool: "host_email_send", args: { to: "a@x.com" } },
      descriptor: { name: "host_email_send", description: "Send email", inputSchema: {}, risk: "write" },
      inputPreview: "to a@x.com",
      ctx: { principal: { kind: "user", subject: "u" }, venue: "voice", presence: "present" },
      createdAt: "2026-07-11T12:00:00.000Z",
    }]);
    const bridge = createVoiceActBridge({
      client: createVendoClient({ baseUrl: BASE }),
      decidePollMs: 10,
      approvalTimeoutMs: 2_000,
    });
    // The consent bar decides shortly after the poll starts.
    setTimeout(() => wire.decide("apr_g"), 40);
    const result = await bridge.onToolCall(
      { callId: "c1", name: "vendo_act", args: { request: "send the reminder" } },
      { emitView: () => undefined },
    ) as { result: string; note?: string };
    expect(result.result).toBe("Reminder sent.");
    expect(result.note).toBeUndefined();
    // Two turn POSTs: the initial turn and the resume.
    const posts = wire.fetchMock.mock.calls.filter(([url, init]) => {
      const href = typeof url === "string" ? url : (url as URL | Request).toString?.() ?? "";
      return (init as RequestInit | undefined)?.method === "POST" && href.endsWith("/threads");
    });
    expect(posts).toHaveLength(2);
  });

  it("reports an unanswered approval when the decision times out", async () => {
    const wire = scriptedWire([
      (w) => {
        w.write({ type: "tool-input-available", toolCallId: "call_send", toolName: "host_email_send", input: {}, dynamic: true });
        w.write({ type: "tool-approval-request", toolCallId: "call_send", approvalId: "apr_g" });
        w.write({ type: "data-vendo-approval", data: { toolCallId: "call_send", risk: "write", approvalId: "apr_g" } } as unknown as UIMessageChunk);
        w.write({ type: "text-start", id: "t1" });
        w.write({ type: "text-delta", id: "t1", delta: "Waiting on you." });
        w.write({ type: "text-end", id: "t1" });
      },
      // The resume turn still runs (the guard blocks execution server-side).
      (w) => {
        w.write({ type: "text-start", id: "t2" });
        w.write({ type: "text-delta", id: "t2", delta: "Nothing was sent." });
        w.write({ type: "text-end", id: "t2" });
      },
    ]);
    wire.setPending([{
      id: "apr_g",
      call: { id: "call_send", tool: "host_email_send", args: {} },
      descriptor: { name: "host_email_send", description: "Send email", inputSchema: {}, risk: "write" },
      inputPreview: "",
      ctx: { principal: { kind: "user", subject: "u" }, venue: "voice", presence: "present" },
      createdAt: "2026-07-11T12:00:00.000Z",
    }]);
    const bridge = createVoiceActBridge({
      client: createVendoClient({ baseUrl: BASE }),
      decidePollMs: 5,
      approvalTimeoutMs: 30,
    });
    const result = await bridge.onToolCall(
      { callId: "c1", name: "vendo_act", args: { request: "send it" } },
      { emitView: () => undefined },
    ) as { note?: string };
    expect(result.note).toContain("unanswered");
  });

  it("rejects an unknown tool and an empty request", async () => {
    scriptedWire([]);
    const bridge = createVoiceActBridge({ client: createVendoClient({ baseUrl: BASE }) });
    expect(await bridge.onToolCall({ callId: "c", name: "other", args: {} }, { emitView: () => undefined }))
      .toMatchObject({ error: expect.stringContaining("Unknown tool") });
    expect(await bridge.onToolCall({ callId: "c", name: "vendo_act", args: { request: "  " } }, { emitView: () => undefined }))
      .toMatchObject({ error: expect.stringContaining("needs a request") });
  });
});
