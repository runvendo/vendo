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

/** A stub agent whose stream closes immediately — for tests that need to
 *  drain the response body (persistence races the response, fire-and-forget). */
function closingStubAgent() {
  const run = vi.fn(() => new ReadableStream({ start: (controller) => controller.close() }));
  return { agent: { run } as unknown as FlowletAgent, run };
}

function chatReq(body: unknown, host = "localhost:3000"): Request {
  return new Request(`http://${host}/api/flowlet/chat`, {
    method: "POST",
    headers: { host, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** Fresh Store-seam wiring for a test — mirrors what handler.ts assembles. */
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
    const res = await handleChat(chatReq({ messages: MESSAGES }), {
      getAgent: () => agent,
      hostTools: HOST_TOOLS,
      options: {},
      chatEnabled: true,
      ...storeDeps(),
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
    await handleChat(chatReq({ messages: MESSAGES }), {
      getAgent: () => agent,
      hostTools: [],
      options: {},
      chatEnabled: true,
      ...storeDeps(),
    });
    const input = run.mock.calls[0]![0] as Record<string, unknown>;
    expect(input["tools"]).toEqual({});
  });

  it("rejects an empty or malformed messages array with 400", async () => {
    const { agent } = stubAgent();
    const deps = { getAgent: () => agent, hostTools: [], options: {}, chatEnabled: true, ...storeDeps() };
    expect((await handleChat(chatReq({ messages: [] }), deps)).status).toBe(400);
    expect((await handleChat(chatReq({ messages: {} }), deps)).status).toBe(400);
    expect((await handleChat(chatReq("not json"), deps)).status).toBe(400);
  });

  it("blocks remote requests before touching the body", async () => {
    const { agent, run } = stubAgent();
    const res = await handleChat(chatReq({ messages: MESSAGES }, "myapp.example.com"), {
      getAgent: () => agent,
      hostTools: [],
      options: {},
      chatEnabled: true,
      ...storeDeps(),
    });
    expect(res.status).toBe(403);
    expect(run).not.toHaveBeenCalled();
  });

  it("returns 503 (not a mid-stream error) when chat is disabled — no model key", async () => {
    const { agent, run } = stubAgent();
    const res = await handleChat(chatReq({ messages: MESSAGES }), {
      getAgent: () => agent,
      hostTools: [],
      options: {},
      chatEnabled: false,
      ...storeDeps(),
    });
    expect(res.status).toBe(503);
    expect(run).not.toHaveBeenCalled();
  });

  it("persists the received turn to the threads store keyed by the client's chat id", async () => {
    const { agent } = closingStubAgent();
    const { threads, threadIndex } = storeDeps();
    const res = await handleChat(chatReq({ id: "chat-9", messages: MESSAGES }), {
      getAgent: () => agent,
      hostTools: [],
      options: {},
      chatEnabled: true,
      threads,
      threadIndex,
    });
    // Drain the response body fully so the fire-and-forget persistence (which
    // races the response) has settled.
    await res.text();
    const scope = { tenantId: EMBEDDED_TENANT, subject: "flowlet-default-user" };
    const threadId = await threadIndex.resolve(scope, "chat-9");
    const stored = await threads.getMessages(scope, threadId);
    expect(stored).toEqual(MESSAGES);
  });

  it("passes the resolved store thread id into agent.run as threadId", async () => {
    const { agent, run } = stubAgent();
    const { threads, threadIndex } = storeDeps();
    await handleChat(chatReq({ id: "chat-9", messages: MESSAGES }), {
      getAgent: () => agent,
      hostTools: [],
      options: {},
      chatEnabled: true,
      threads,
      threadIndex,
    });
    const scope = { tenantId: EMBEDDED_TENANT, subject: "flowlet-default-user" };
    const expectedThreadId = await threadIndex.resolve(scope, "chat-9");
    const input = run.mock.calls[0]![0] as Record<string, unknown>;
    expect(input["threadId"]).toBe(expectedThreadId);
  });
});
