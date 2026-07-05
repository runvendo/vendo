import { describe, expect, it, vi } from "vitest";
import type { FlowletAgent } from "@flowlet/core";
import { CLIENT_EXECUTOR_MARKER } from "@flowlet/runtime";
import { handleChat } from "./chat";
import { manifestToolsToHostTools } from "./manifest-tools";

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
    });
    const input = run.mock.calls[0]![0] as Record<string, unknown>;
    expect(input["tools"]).toEqual({});
  });

  it("verifies a scoped envelope into pinBase for the resolved principal (remix fast-edits)", async () => {
    const { createRemixSealer, deriveSealKey } = await import("@flowlet/runtime");
    const sealer = createRemixSealer(deriveSealKey({ secret: "s" })!);
    const payload = {
      formatVersion: "flowlet-genui/v1" as const,
      root: "r",
      nodes: [{ id: "r", component: "C", source: "generated" as const }],
      components: { C: "export default function C(){return null}" },
    };
    const envelope = sealer.mint({
      anchorId: "widget",
      principalUserId: "flowlet-default-user",
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
    await handleChat(chatReq({ messages: scoped }), {
      getAgent: () => agent,
      hostTools: [],
      options: {},
      chatEnabled: true,
      remixSealer: sealer,
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
    const deps = { getAgent: () => agent, hostTools: [], options: {}, chatEnabled: true };
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
    });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      error:
        "chat is unavailable — set ANTHROPIC_API_KEY, OPENAI_API_KEY, or GOOGLE_GENERATIVE_AI_API_KEY",
    });
    expect(run).not.toHaveBeenCalled();
  });
});
