import { describe, expect, it, vi } from "vitest";
import type { FlowletAgent } from "@flowlet/core";
import { CLIENT_EXECUTOR_MARKER, InMemoryThreadStore } from "@flowlet/runtime";
import { handleChat } from "./chat";
import { manifestToolsToHostTools } from "./manifest-tools";
import { createThreadIndex } from "./threads";
import { EMBEDDED_TENANT } from "./policy-stack";

function stubAgent() {
  const run = vi.fn(() => new ReadableStream());
  return { agent: { run } as unknown as FlowletAgent, run };
}

function chatReq(body: unknown, host = "localhost:3000"): Request {
  return new Request(`http://${host}/api/flowlet/chat`, {
    method: "POST",
    headers: { host, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** Fresh thread-index wiring for a test — mirrors what handler.ts assembles.
 *  Note: chat.ts does NOT persist messages itself (the engine's onSettled
 *  hook, registered in handler.ts, is the single writer — see the handler
 *  regression test); chat only resolves the thread id. */
function storeDeps() {
  const threads = new InMemoryThreadStore(() => "2026-07-04T00:00:00Z");
  const threadIndex = createThreadIndex(threads);
  return { threads, threadIndex };
}

const HOST_TOOLS = manifestToolsToHostTools([
  {
    name: "list_things",
    description: "List things",
    inputSchema: { type: "object", properties: {} },
    annotations: { mutating: false, dangerous: false },
    binding: { type: "http", method: "GET", path: "/api/things" },
  },
]);

const MESSAGES = [{ id: "m1", role: "user", parts: [{ type: "text", text: "hi" }] }];

describe("handleChat", () => {
  it("streams a run with host tools, principal and abort signal", async () => {
    const { agent, run } = stubAgent();
    const { threadIndex } = storeDeps();
    const res = await handleChat(chatReq({ messages: MESSAGES }), {
      getAgent: () => agent,
      hostTools: HOST_TOOLS,
      options: {},
      chatEnabled: true,
      threadIndex,
    });
    expect(res.status).toBe(200);
    expect(run).toHaveBeenCalledOnce();
    const input = run.mock.calls[0]![0] as Record<string, unknown>;
    expect(input["principal"]).toEqual({ userId: "flowlet-default-user" });
    expect(input["signal"]).toBeInstanceOf(AbortSignal);
    const tools = input["tools"] as Record<string, Record<string, unknown>>;
    expect(tools["list_things"]?.[CLIENT_EXECUTOR_MARKER]).toBe("client");
  });

  it("passes an empty caller toolset when the manifest has no tools", async () => {
    const { agent, run } = stubAgent();
    const { threadIndex } = storeDeps();
    await handleChat(chatReq({ messages: MESSAGES }), {
      getAgent: () => agent,
      hostTools: [],
      options: {},
      chatEnabled: true,
      threadIndex,
    });
    const input = run.mock.calls[0]![0] as Record<string, unknown>;
    expect(input["tools"]).toEqual({});
  });

  it("rejects an empty or malformed messages array with 400", async () => {
    const { agent } = stubAgent();
    const { threadIndex } = storeDeps();
    const deps = { getAgent: () => agent, hostTools: [], options: {}, chatEnabled: true, threadIndex };
    expect((await handleChat(chatReq({ messages: [] }), deps)).status).toBe(400);
    expect((await handleChat(chatReq({ messages: {} }), deps)).status).toBe(400);
    expect((await handleChat(chatReq("not json"), deps)).status).toBe(400);
  });

  it("blocks remote requests before touching the body", async () => {
    const { agent, run } = stubAgent();
    const { threadIndex } = storeDeps();
    const res = await handleChat(chatReq({ messages: MESSAGES }, "myapp.example.com"), {
      getAgent: () => agent,
      hostTools: [],
      options: {},
      chatEnabled: true,
      threadIndex,
    });
    expect(res.status).toBe(403);
    expect(run).not.toHaveBeenCalled();
  });

  it("returns 503 (not a mid-stream error) when chat is disabled — no model key", async () => {
    const { agent, run } = stubAgent();
    const { threadIndex } = storeDeps();
    const res = await handleChat(chatReq({ messages: MESSAGES }), {
      getAgent: () => agent,
      hostTools: [],
      options: {},
      chatEnabled: false,
      threadIndex,
    });
    expect(res.status).toBe(503);
    expect(run).not.toHaveBeenCalled();
  });

  it("does NOT persist the request body itself — the engine's onSettled hook is the single writer", async () => {
    // The old design persisted the client-sent messages here, which meant the
    // STREAMED assistant turn (carrying approval-requested parts) was missing
    // from the store when a consent POST arrived (review 2026-07-04). Chat now
    // only resolves the thread id; the settled-run hook in handler.ts writes.
    const { agent } = stubAgent();
    const { threads, threadIndex } = storeDeps();
    await handleChat(chatReq({ id: "chat-9", messages: MESSAGES }), {
      getAgent: () => agent,
      hostTools: [],
      options: {},
      chatEnabled: true,
      threadIndex,
    });
    const scope = { tenantId: EMBEDDED_TENANT, subject: "flowlet-default-user" };
    const threadId = await threadIndex.resolve(scope, "chat-9");
    expect(await threads.getMessages(scope, threadId)).toEqual([]);
  });

  it("passes the resolved store thread id into agent.run as threadId", async () => {
    const { agent, run } = stubAgent();
    const { threadIndex } = storeDeps();
    await handleChat(chatReq({ id: "chat-9", messages: MESSAGES }), {
      getAgent: () => agent,
      hostTools: [],
      options: {},
      chatEnabled: true,
      threadIndex,
    });
    const scope = { tenantId: EMBEDDED_TENANT, subject: "flowlet-default-user" };
    const expectedThreadId = await threadIndex.resolve(scope, "chat-9");
    const input = run.mock.calls[0]![0] as Record<string, unknown>;
    expect(input["threadId"]).toBe(expectedThreadId);
  });
});
