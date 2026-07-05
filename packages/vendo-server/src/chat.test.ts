import { describe, expect, it, vi } from "vitest";
import { createUIMessageStream, type UIMessageChunk } from "ai";
import type { VendoAgent, VendoUIMessage } from "@vendoai/core";
import { CLIENT_EXECUTOR_MARKER, createInMemoryStore, InMemoryThreadStore } from "@vendoai/runtime";
import { handleChat } from "./chat.js";
import { manifestToolsToHostTools } from "./manifest-tools.js";
import { createThreadIndex } from "./threads.js";
import { EMBEDDED_TENANT } from "./policy-stack.js";

const SCOPE = { tenantId: "vendo-embedded", subject: "vendo-default-user" };

function stubAgent() {
  const run = vi.fn(() => new ReadableStream());
  return { agent: { run } as unknown as VendoAgent, run };
}

/** A tiny, fully controlled agent: emits ONE assistant UIMessage (given id +
 *  text) through the real ai SDK UIMessage-chunk protocol, so
 *  `readUIMessageStream` reduces it exactly like a real turn. */
function chunkAgent(messageId: string, text: string) {
  const run = vi.fn(
    (): ReadableStream<UIMessageChunk> =>
      createUIMessageStream<VendoUIMessage>({
        execute: ({ writer }) => {
          writer.write({ type: "start", messageId });
          writer.write({ type: "text-start", id: "t1" });
          writer.write({ type: "text-delta", id: "t1", delta: text });
          writer.write({ type: "text-end", id: "t1" });
          writer.write({ type: "finish" });
        },
      }),
  );
  return { agent: { run } as unknown as VendoAgent, run };
}

/** Fully drains a Response's body — mirrors what a real client does, and lets
 *  the detached capture branch (the tee'd stream half) run to completion. */
async function drainResponse(res: Response): Promise<void> {
  const reader = res.body?.getReader();
  if (!reader) return;
  for (;;) {
    const { done } = await reader.read();
    if (done) break;
  }
}

function chatReq(body: unknown, host = "localhost:3000"): Request {
  return new Request(`http://${host}/api/vendo/chat`, {
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
    expect(input["principal"]).toEqual({ userId: "vendo-default-user" });
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

  it("verifies a scoped envelope into pinBase for the resolved principal (remix fast-edits)", async () => {
    const { createRemixSealer, deriveSealKey } = await import("@vendoai/runtime");
    const sealer = createRemixSealer(deriveSealKey({ secret: "s" })!);
    const payload = {
      formatVersion: "vendo-genui/v1" as const,
      root: "r",
      nodes: [{ id: "r", component: "C", source: "generated" as const }],
      components: { C: "export default function C(){return null}" },
    };
    const envelope = sealer.mint({
      anchorId: "widget",
      principalUserId: "vendo-default-user",
      payload,
      sources: payload.components,
      sourceHash: "sh",
      baseHash: "bh",
      issuedAt: "2026-07-04T00:00:00.000Z",
    });
    const scoped = [
      {
        id: "m1",
        role: "user",
        parts: [{ type: "text", text: "edit it" }],
        metadata: { anchors: { scoped: { anchorId: "widget", envelope } } },
      },
    ];
    const { agent, run } = stubAgent();
    const { threadIndex } = storeDeps();
    await handleChat(chatReq({ messages: scoped }), {
      getAgent: () => agent,
      hostTools: [],
      options: {},
      chatEnabled: true,
      remixSealer: sealer,
      threadIndex,
    });
    const input = run.mock.calls[0]![0] as {
      messages: { metadata?: { anchors?: { scoped?: Record<string, unknown> } } }[];
    };
    const s = input.messages[0]!.metadata!.anchors!.scoped!;
    expect(s["envelope"]).toBeUndefined(); // opaque blob never reaches the engine
    expect((s["pinBase"] as { baseHash: string }).baseHash).toBe("bh");
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
    expect(await res.json()).toEqual({
      error:
        "chat is unavailable — set ANTHROPIC_API_KEY, OPENAI_API_KEY, or GOOGLE_GENERATIVE_AI_API_KEY",
    });
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
    const scope = { tenantId: EMBEDDED_TENANT, subject: "vendo-default-user" };
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
    const scope = { tenantId: EMBEDDED_TENANT, subject: "vendo-default-user" };
    const expectedThreadId = await threadIndex.resolve(scope, "chat-9");
    const input = run.mock.calls[0]![0] as Record<string, unknown>;
    expect(input["threadId"]).toBe(expectedThreadId);
  });
});

describe("handleChat — durable threads", () => {
  it("upserts the client's messages BEFORE streaming and the assistant turn AFTER it", async () => {
    const threads = createInMemoryStore().threads;
    const { agent } = chunkAgent("asst-1", "Hello from the store.");

    const res = await handleChat(chatReq({ messages: MESSAGES, threadId: "t1" }), {
      getAgent: () => agent,
      hostTools: [],
      options: {},
      chatEnabled: true,
      threadIndex: createThreadIndex(threads),
      threads,
    });
    expect(res.status).toBe(200);

    // Pre-stream: the incoming client message is already persisted by the
    // time handleChat resolves — before a single response byte is consumed.
    expect((await threads.getMessages(SCOPE, "t1")).map((m) => m.id)).toEqual(["m1"]);

    // Consume the response body fully (like a real client) — this is also
    // what lets the detached capture branch run to completion.
    await drainResponse(res);

    await vi.waitFor(async () => {
      const messages = await threads.getMessages(SCOPE, "t1");
      expect(messages.map((m) => m.id)).toEqual(["m1", "asst-1"]);
    });
    const [, assistant] = await threads.getMessages(SCOPE, "t1");
    expect(assistant?.role).toBe("assistant");
  });

  it("updates a resume's mutated message in place instead of duplicating it", async () => {
    // This exercises the upsert-by-id mechanics the real ai-SDK approval
    // resume relies on (client resends the full history, including a
    // previously-persisted assistant message id with mutated parts) — the
    // ai-SDK's own tool-approval loop is covered separately in
    // @vendoai/shell's approval-resume tests.
    const threads = createInMemoryStore().threads;
    const { agent: turn1 } = chunkAgent("asst-1", "Let me check on that.");
    const threadIndex = createThreadIndex(threads);
    const res1 = await handleChat(chatReq({ messages: MESSAGES, threadId: "t1" }), {
      getAgent: () => turn1,
      hostTools: [],
      options: {},
      chatEnabled: true,
      threadIndex,
      threads,
    });
    await drainResponse(res1);
    await vi.waitFor(async () => {
      expect((await threads.getMessages(SCOPE, "t1")).map((m) => m.id)).toEqual(["m1", "asst-1"]);
    });

    const [, persistedAssistant] = await threads.getMessages(SCOPE, "t1");
    // The client mutates the SAME message id (e.g. answering an approval)
    // and resends the whole history.
    const mutatedAssistant: VendoUIMessage = {
      ...persistedAssistant!,
      parts: [{ type: "text", text: "Let me check on that. (approved)" }],
    };
    const { agent: turn2 } = chunkAgent("asst-2", "Here you go.");
    const res2 = await handleChat(
      chatReq({ messages: [...MESSAGES, mutatedAssistant], threadId: "t1" }),
      { getAgent: () => turn2, hostTools: [], options: {}, chatEnabled: true, threadIndex, threads },
    );
    // Pre-stream upsert already ran by the time handleChat resolves.
    const afterPreStream = await threads.getMessages(SCOPE, "t1");
    expect(afterPreStream.map((m) => m.id)).toEqual(["m1", "asst-1"]);
    expect(afterPreStream[1]?.parts).toEqual(mutatedAssistant.parts);

    await drainResponse(res2);
    await vi.waitFor(async () => {
      const messages = await threads.getMessages(SCOPE, "t1");
      expect(messages.map((m) => m.id)).toEqual(["m1", "asst-1", "asst-2"]);
    });
  });

  it("falls back to the shared 'default' thread when the client sends no threadId", async () => {
    // Merged semantics (ENG-193 + durable threads): chat is ALWAYS
    // thread-attached — a client that sends neither `threadId` nor the ai-SDK
    // `id` lands on the fixed "default" thread rather than skipping
    // persistence.
    const threads = createInMemoryStore().threads;
    const { agent } = chunkAgent("asst-1", "hi");
    const res = await handleChat(chatReq({ messages: MESSAGES }), {
      getAgent: () => agent,
      hostTools: [],
      options: {},
      chatEnabled: true,
      threadIndex: createThreadIndex(threads),
      threads,
    });
    await drainResponse(res);
    expect((await threads.getMessages(SCOPE, "default")).map((m) => m.id)).toContain("m1");
  });

  it("still streams when the pre-stream upsert throws — a store blip must not break chat", async () => {
    const threads = createInMemoryStore().threads;
    const threadIndex = createThreadIndex(threads);
    const { agent } = chunkAgent("asst-1", "still here");
    const upsert = vi
      .spyOn(threads, "upsertMessages")
      .mockRejectedValue(new Error("store down"));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const res = await handleChat(chatReq({ messages: MESSAGES, threadId: "t1" }), {
        getAgent: () => agent,
        hostTools: [],
        options: {},
        chatEnabled: true,
        threadIndex,
        threads,
      });
      expect(res.status).toBe(200);
      await drainResponse(res);
      expect(upsert).toHaveBeenCalled();
      // Logged, not swallowed silently.
      expect(errSpy).toHaveBeenCalled();
    } finally {
      upsert.mockRestore();
      errSpy.mockRestore();
    }
  });

  it("persists nothing when no ThreadStore is wired, even with a threadId", async () => {
    const { agent, run } = stubAgent();
    const { threadIndex } = storeDeps();
    const res = await handleChat(chatReq({ messages: MESSAGES, threadId: "t1" }), {
      getAgent: () => agent,
      hostTools: [],
      options: {},
      chatEnabled: true,
      threadIndex,
    });
    expect(res.status).toBe(200);
    expect(run).toHaveBeenCalledOnce();
  });
});
