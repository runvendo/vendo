import { describe, expect, it, vi } from "vitest";
import type { ToolSet } from "ai";
import type { ComposioClient } from "@vendoai/runtime";
import { createConnectionsStore } from "./connections.js";
import { handleVoiceToolsGet, handleVoiceToolsPost, type VoiceToolsDeps } from "./voice-tools.js";

const CATALOG = [
  { id: "gmail", name: "Gmail" },
  { id: "slack", name: "Slack" },
];

function tool(overrides: Record<string, unknown> = {}): unknown {
  return {
    description: "Fetch Gmail messages",
    inputSchema: { jsonSchema: { type: "object", properties: { query: { type: "string" } } } },
    execute: vi.fn(async () => ({ ok: true })),
    ...overrides,
  };
}

function deps(toolset: ToolSet): VoiceToolsDeps {
  const store = createConnectionsStore(CATALOG);
  const client: ComposioClient = {
    fetchTools: vi.fn(async () => toolset),
    authorize: async () => ({ redirectUrl: "https://oauth.example/x", connectedAccountId: "acc-1" }),
    connectionStatus: async () => "active",
    hasActiveConnection: async () => true,
  };
  return { store, enabled: true, principal: { userId: "user-1" }, client };
}

function get(): Request {
  return new Request("http://localhost:3000/api/vendo/voice/tools", { headers: { host: "localhost:3000" } });
}

function post(body: unknown): Request {
  return new Request("http://localhost:3000/api/vendo/voice/tools", {
    method: "POST",
    headers: { host: "localhost:3000", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("voice integration tools bridge", () => {
  it("lists connected Composio tool definitions with tier mapping", async () => {
    const d = deps({
      GMAIL_FETCH_EMAILS: tool(),
      GMAIL_DELETE_EMAIL: tool({ description: "Delete Gmail message" }),
    } as unknown as ToolSet);
    await d.store.connect("gmail");

    const res = await handleVoiceToolsGet(get(), d);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      tools: [
        {
          name: "GMAIL_FETCH_EMAILS",
          description: "Fetch Gmail messages",
          parameters: { type: "object", properties: { query: { type: "string" } } },
          tier: "read",
        },
        {
          name: "GMAIL_DELETE_EMAIL",
          description: "Delete Gmail message",
          parameters: { type: "object", properties: { query: { type: "string" } } },
          tier: "critical",
        },
      ],
      truncated: false,
    });
    expect(d.client?.fetchTools).toHaveBeenCalledWith(
      "user-1",
      expect.objectContaining({ toolkits: ["gmail"] }),
    );
  });

  it("executes connected tools server-side and caps voice output", async () => {
    const execute = vi.fn(async () => ({ body: "x".repeat(20_000) }));
    const d = deps({ GMAIL_FETCH_EMAILS: tool({ execute }) } as unknown as ToolSet);
    await d.store.connect("gmail");

    const res = await handleVoiceToolsPost(post({ tool: "GMAIL_FETCH_EMAILS", input: { query: "invoice" } }), d);
    const body = (await res.json()) as { result: { body?: string; _truncation?: string } };

    expect(res.status).toBe(200);
    expect(execute).toHaveBeenCalled();
    expect(JSON.stringify(body.result).length).toBeLessThan(8_000);
    expect(body.result.body).toContain("truncated");
    expect(body.result._truncation).toContain("Output truncated");
  });

  it("returns no tools when integrations are disabled", async () => {
    const d = deps({ GMAIL_FETCH_EMAILS: tool() } as unknown as ToolSet);
    const res = await handleVoiceToolsGet(get(), { ...d, enabled: false });
    expect(await res.json()).toEqual({ tools: [], truncated: false });
    expect(d.client?.fetchTools).not.toHaveBeenCalled();
  });
});
