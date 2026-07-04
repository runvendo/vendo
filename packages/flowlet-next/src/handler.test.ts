import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";
import { createInMemoryGrantStore, InMemoryThreadStore } from "@flowlet/runtime";
import { createFlowletHandler } from "./handler";

function req(pathname: string, init?: RequestInit): Request {
  return new Request(`http://localhost:3000${pathname}`, {
    headers: { host: "localhost:3000" },
    ...init,
  });
}

// Point at an empty scratch dir so tests never read the repo's .flowlet/.
function emptyDir(): string {
  return path.join(mkdtempSync(path.join(tmpdir(), "flowlet-handler-")), ".flowlet");
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("createFlowletHandler", () => {
  it("rejects unknown option keys at creation", () => {
    expect(() =>
      createFlowletHandler({ produtName: "typo" } as never),
    ).toThrow(/invalid options/);
  });

  it("serves capabilities from env-key presence", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-x");
    vi.stubEnv("COMPOSIO_API_KEY", "");
    vi.stubEnv("OPENAI_API_KEY", "");
    const { GET } = createFlowletHandler({ flowletDir: emptyDir() });
    const res = await GET(req("/api/flowlet/capabilities"));
    expect(await res.json()).toEqual({ chat: true, integrations: false, voice: false });
  });

  it("keeps integrations inert without a Composio key", async () => {
    vi.stubEnv("COMPOSIO_API_KEY", "");
    const { GET, POST } = createFlowletHandler({ flowletDir: emptyDir() });
    const list = await GET(req("/api/flowlet/integrations"));
    expect(await list.json()).toEqual({ enabled: false, integrations: [] });
    const connect = await POST(
      req("/api/flowlet/integrations", {
        method: "POST",
        body: JSON.stringify({ id: "gmail", action: "connect" }),
      }),
    );
    expect(connect.status).toBe(503);
  });

  it("routes unknown paths to 404 and disabled tick to 404", async () => {
    const { GET, POST } = createFlowletHandler({ flowletDir: emptyDir(), automations: false });
    expect((await GET(req("/api/flowlet/nope"))).status).toBe(404);
    expect((await POST(req("/api/flowlet/tick", { method: "POST" }))).status).toBe(404);
  });

  it("ticks the automations world when enabled", async () => {
    const { POST } = createFlowletHandler({ flowletDir: emptyDir() });
    const res = await POST(req("/api/flowlet/tick", { method: "POST" }));
    expect(await res.json()).toEqual({ ok: true });
  });

  it("503s a chat request when no model key is configured", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    const { POST } = createFlowletHandler({ flowletDir: emptyDir() });
    const res = await POST(
      req("/api/flowlet/chat", { method: "POST", body: JSON.stringify({ messages: [{ role: "user" }] }) }),
    );
    expect(res.status).toBe(503);
  });

  it("400s a chat request with no messages once a key is present", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-x");
    const { POST } = createFlowletHandler({ flowletDir: emptyDir() });
    const res = await POST(
      req("/api/flowlet/chat", { method: "POST", body: JSON.stringify({ messages: [] }) }),
    );
    expect(res.status).toBe(400);
  });

  it("REGRESSION: a consent POST for a just-streamed approval mints a grant (streamed turn persisted before consent)", async () => {
    // The failing sequence this guards against (review 2026-07-04): POST /chat
    // streams an assistant message with an approval-requested tool part; the
    // client POSTs /consent for that toolCallId BEFORE any next chat turn.
    // If only the client-SENT messages were persisted, the approval part is
    // missing from the ThreadStore and consent 404s on the happy path.
    const grants = createInMemoryGrantStore();
    const threads = new InMemoryThreadStore(() => new Date().toISOString());
    const zeroUsage = {
      inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 0, text: 0, reasoning: 0 },
    };
    // One turn: the model requests a gated (act-tier, mutating) tool call and
    // stops; the SDK pauses at approval-requested and the stream settles.
    const model = new MockLanguageModelV3({
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: [
            { type: "text-start", id: "t1" },
            { type: "text-delta", id: "t1", delta: "Sending." },
            { type: "text-end", id: "t1" },
            { type: "tool-call", toolCallId: "call-1", toolName: "send_email", input: "{}" },
            { type: "finish", usage: zeroUsage, finishReason: { unified: "tool-calls", raw: undefined } },
          ],
        }),
      }),
    });
    const { POST } = createFlowletHandler({
      flowletDir: emptyDir(),
      automations: false,
      model: model as never,
      tools: {
        send_email: {
          description: "send an email",
          inputSchema: z.object({}),
          annotations: { destructiveHint: false },
          execute: async () => "ok",
        } as never,
      },
      store: { grants, threads },
    });

    const chatRes = await POST(
      req("/api/flowlet/chat", {
        method: "POST",
        body: JSON.stringify({
          id: "chat-1",
          messages: [{ id: "m1", role: "user", parts: [{ type: "text", text: "send it" }] }],
        }),
      }),
    );
    expect(chatRes.status).toBe(200);
    await chatRes.text(); // drain the stream so the run settles

    // Persistence is fire-and-forget off the engine's onSettled — wait until
    // the streamed assistant turn (with the approval part) lands in the store.
    const scope = { tenantId: "flowlet-embedded", subject: "flowlet-default-user" };
    await vi.waitFor(async () => {
      const records = await threads.list(scope);
      expect(records).toHaveLength(1);
      const stored = await threads.getMessages(scope, records[0]!.id);
      expect(stored.length).toBeGreaterThanOrEqual(2); // user turn + streamed assistant turn
    });

    const consentRes = await POST(
      req("/api/flowlet/consent", {
        method: "POST",
        body: JSON.stringify({
          id: "chat-1",
          toolCallId: "call-1",
          toolName: "send_email",
          response: {
            id: "call-1",
            decision: "yes",
            grant: { tool: "send_email", scope: { kind: "tool" }, duration: "standing" },
          },
        }),
      }),
    );
    expect(consentRes.status).toBe(200);
    expect(await grants.findForTool(scope, "send_email")).toHaveLength(1);
  });

  it("guards every mutating endpoint against remote requests by default", async () => {
    // A key so chat reaches the guard rather than short-circuiting on 503.
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-x");
    vi.stubEnv("COMPOSIO_API_KEY", "ck_x");
    vi.stubEnv("NODE_ENV", "production"); // fail-closed in prod even for spoofed Host
    const { POST } = createFlowletHandler({ flowletDir: emptyDir() });
    for (const p of ["chat", "action", "tick", "integrations"]) {
      const res = await POST(
        new Request(`http://prod.example.com/api/flowlet/${p}`, {
          method: "POST",
          headers: { host: "prod.example.com" },
          body: JSON.stringify({}),
        }),
      );
      expect(res.status, p).toBe(403);
    }
  });
});
