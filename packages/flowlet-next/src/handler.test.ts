import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createFlowletHandler } from "./handler";
import { z } from "zod";
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";
import { createInMemoryCompiledRuleStore, createInMemoryGrantStore, InMemoryThreadStore } from "@flowlet/runtime";

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
    expect(await res.json()).toEqual({ chat: true, integrations: false, voice: false, mcp: false });
  });

  it("capabilities.mcp is true when mcpServers option is set", async () => {
    const { GET } = createFlowletHandler({
      flowletDir: emptyDir(),
      mcpServers: [{ name: "weather", url: "https://mcp.example.com/mcp" }],
    });
    const res = await GET(req("/api/flowlet/capabilities"));
    expect(((await res.json()) as { mcp: boolean }).mcp).toBe(true);
  });

  it("capabilities.mcp is true when .flowlet/mcp.json declares a server", async () => {
    const dir = emptyDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, "mcp.json"),
      JSON.stringify({ version: 1, servers: [{ name: "s", url: "https://x" }] }),
    );
    const { GET } = createFlowletHandler({ flowletDir: dir });
    const res = await GET(req("/api/flowlet/capabilities"));
    expect(((await res.json()) as { mcp: boolean }).mcp).toBe(true);
  });

  it("capabilities.mcp is false when the only mcp.json server is dropped by env substitution", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const dir = emptyDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, "mcp.json"),
      JSON.stringify({
        version: 1,
        servers: [
          {
            name: "s",
            url: "https://x",
            headers: { Authorization: "Bearer ${DEFINITELY_NOT_SET_VAR_42}" },
          },
        ],
      }),
    );
    const { GET } = createFlowletHandler({ flowletDir: dir });
    const res = await GET(req("/api/flowlet/capabilities"));
    expect(((await res.json()) as { mcp: boolean }).mcp).toBe(false);
    warn.mockRestore();
  });

  it("the mcpServers option overrides mcp.json entirely", async () => {
    const dir = emptyDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, "mcp.json"),
      JSON.stringify({ version: 1, servers: [{ name: "from-file", url: "https://file" }] }),
    );
    // Option present (even []) wins over the file: [] means MCP off.
    const { GET } = createFlowletHandler({ flowletDir: dir, mcpServers: [] });
    const res = await GET(req("/api/flowlet/capabilities"));
    expect(((await res.json()) as { mcp: boolean }).mcp).toBe(false);
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

  it("serves automation deliveries since a cursor (FlowletToasts)", async () => {
    const { GET } = createFlowletHandler({ flowletDir: emptyDir() });
    const res = await GET(req("/api/flowlet/deliveries?since=0"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deliveries: [] });
  });

  it("404s deliveries and resume when automations are disabled", async () => {
    const { GET, POST } = createFlowletHandler({ flowletDir: emptyDir(), automations: false });
    expect((await GET(req("/api/flowlet/deliveries?since=0"))).status).toBe(404);
    expect(
      (
        await POST(
          req("/api/flowlet/resume", {
            method: "POST",
            body: JSON.stringify({ runId: "r1", approved: true }),
          }),
        )
      ).status,
    ).toBe(404);
  });

  it("answers resume for an unknown run as stale instead of erroring", async () => {
    const { POST } = createFlowletHandler({ flowletDir: emptyDir() });
    const res = await POST(
      req("/api/flowlet/resume", {
        method: "POST",
        body: JSON.stringify({ runId: "nope", approved: true }),
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ stale: true });
  });

  it("400s a resume request without a runId", async () => {
    const { POST } = createFlowletHandler({ flowletDir: emptyDir() });
    const res = await POST(
      req("/api/flowlet/resume", { method: "POST", body: JSON.stringify({ approved: true }) }),
    );
    expect(res.status).toBe(400);
  });

  it("503s a chat request when no model key is configured", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    const { POST } = createFlowletHandler({ flowletDir: emptyDir() });
    const res = await POST(
      req("/api/flowlet/chat", { method: "POST", body: JSON.stringify({ messages: [{ role: "user" }] }) }),
    );
    expect(res.status).toBe(503);
  });

  it("treats an injected model as chat-enabled with zero provider keys", async () => {
    // Pins the wiring this exists for: options.model flows into assemble's
    // detectCapabilities as hasInjectedModel, and POST /chat gates on that
    // same capabilities.chat (no ad-hoc override).
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.stubEnv("OPENAI_API_KEY", "");
    vi.stubEnv("GOOGLE_GENERATIVE_AI_API_KEY", "");
    const model = { modelId: "stub" } as unknown as import("ai").LanguageModel;
    const { GET, POST } = createFlowletHandler({ flowletDir: emptyDir(), model });

    const caps = await GET(req("/api/flowlet/capabilities"));
    expect(await caps.json()).toEqual({ chat: true, integrations: false, voice: false, mcp: false });

    // The chatEnabled gate (503) fires before messages validation (400), so a
    // 400 on an empty messages array proves chat was NOT gated off.
    const res = await POST(
      req("/api/flowlet/chat", { method: "POST", body: JSON.stringify({ messages: [] }) }),
    );
    expect(res.status).toBe(400);
  });

  it("400s a chat request with no messages once a key is present", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-x");
    const { POST } = createFlowletHandler({ flowletDir: emptyDir() });
    const res = await POST(
      req("/api/flowlet/chat", { method: "POST", body: JSON.stringify({ messages: [] }) }),
    );
    expect(res.status).toBe(400);
  });

  it("500s a boot failure and retries assembly once the config is fixed", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-x");
    vi.stubEnv("FLOWLET_MODEL", "grok/whatever");
    const { GET } = createFlowletHandler({ flowletDir: emptyDir() });

    const broken = await GET(req("/api/flowlet/capabilities"));
    expect(broken.status).toBe(500);
    expect(((await broken.json()) as { error: string }).error).toMatch(/Flowlet/);

    // Fixing the env must NOT keep serving the cached rejection.
    vi.stubEnv("FLOWLET_MODEL", "");
    const fixed = await GET(req("/api/flowlet/capabilities"));
    expect(fixed.status).toBe(200);
    expect(await fixed.json()).toEqual({ chat: true, integrations: false, voice: false, mcp: false });
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

  it("REGRESSION: an approval streamed on a CONTINUATION turn is persisted, so consent mints its grant (live-verification 2026-07-04)", async () => {
    // The live failing sequence: turn 1 settles [user, assistant@v1]; turn 2
    // is a continuation (the transport resubmits ending with that assistant
    // message, and ai's onFinish returns [...original.slice(0,-1), revised] —
    // SAME length). The old prefix delta appended nothing, so the revised
    // message's approval-requested part never reached the store and the
    // consent POST 404'd. `replaceMessages` must persist the revision.
    const grants = createInMemoryGrantStore();
    const threads = new InMemoryThreadStore(() => new Date().toISOString());
    const zeroUsage = {
      inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 0, text: 0, reasoning: 0 },
    };
    let call = 0;
    const model = new MockLanguageModelV3({
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks:
            ++call === 1
              ? [
                  // Turn 1: a plain text turn — settles [user, assistant@v1].
                  { type: "text-start", id: "t1" },
                  { type: "text-delta", id: "t1", delta: "Looked it up." },
                  { type: "text-end", id: "t1" },
                  { type: "finish", usage: zeroUsage, finishReason: { unified: "stop", raw: undefined } },
                ]
              : [
                  // Turn 2 (continuation): the gated call pauses at approval.
                  { type: "tool-call", toolCallId: "call-2", toolName: "send_email", input: "{}" },
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
    const scope = { tenantId: "flowlet-embedded", subject: "flowlet-default-user" };
    const user = { id: "u1", role: "user", parts: [{ type: "text", text: "send it" }] };

    // Turn 1.
    await (
      await POST(req("/api/flowlet/chat", { method: "POST", body: JSON.stringify({ id: "chat-c1", messages: [user] }) }))
    ).text();
    let assistant: unknown;
    await vi.waitFor(async () => {
      const records = await threads.list(scope);
      expect(records).toHaveLength(1);
      const stored = await threads.getMessages(scope, records[0]!.id);
      expect(stored).toHaveLength(2);
      assistant = stored[1];
    });

    // Turn 2: resubmit ending with the stored assistant message — exactly what
    // DefaultChatTransport does on a continuation.
    await (
      await POST(
        req("/api/flowlet/chat", { method: "POST", body: JSON.stringify({ id: "chat-c1", messages: [user, assistant] }) }),
      )
    ).text();
    await vi.waitFor(async () => {
      const records = await threads.list(scope);
      const stored = await threads.getMessages(scope, records[0]!.id);
      expect(stored).toHaveLength(2); // continuation REVISED the assistant message, not appended
      const parts = stored[1]!.parts as Array<{ type: string; toolCallId?: string; state?: string }>;
      const part = parts.find((p) => p.toolCallId === "call-2");
      expect(part?.state).toBe("approval-requested");
    });

    const consentRes = await POST(
      req("/api/flowlet/consent", {
        method: "POST",
        body: JSON.stringify({
          id: "chat-c1",
          toolCallId: "call-2",
          toolName: "send_email",
          response: {
            id: "call-2",
            decision: "yes",
            grant: { tool: "send_email", scope: { kind: "tool" }, duration: "standing" },
          },
        }),
      }),
    );
    expect(consentRes.status).toBe(200);
    expect(await grants.findForTool(scope, "send_email")).toHaveLength(1);
  });

  it("GET /rules returns an empty list from a fresh handler (ENG-193 item 6)", async () => {
    const { GET } = createFlowletHandler({ flowletDir: emptyDir() });
    const res = await GET(req("/api/flowlet/rules"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ rules: [] });
  });

  it("POST /rules/revoke 404s an unknown rule id", async () => {
    const { POST } = createFlowletHandler({ flowletDir: emptyDir() });
    const res = await POST(
      req("/api/flowlet/rules/revoke", { method: "POST", body: JSON.stringify({ id: "nope" }) }),
    );
    expect(res.status).toBe(404);
  });

  it("REGRESSION (deviation #6): /grants/revoke revokes the GRANT and /rules/revoke revokes the RULE — never cross-wired", async () => {
    const scope = { tenantId: "flowlet-embedded", subject: "flowlet-default-user" };
    const grants = createInMemoryGrantStore();
    const rules = createInMemoryCompiledRuleStore();
    const grant = await grants.create(scope, {
      tool: "send_email", descriptorHash: "h1", scope: { kind: "tool" }, duration: "standing",
      source: { kind: "chat" },
    });
    const rule = await rules.create(scope, {
      kind: "always_ask", toolPattern: "send_email", plainText: "sending any email",
    });
    const { GET, POST } = createFlowletHandler({ flowletDir: emptyDir(), store: { grants, rules } });

    // Revoke the GRANT via /grants/revoke — the rule must survive.
    const grantRes = await POST(
      req("/api/flowlet/grants/revoke", { method: "POST", body: JSON.stringify({ id: grant.id }) }),
    );
    expect(grantRes.status).toBe(200);
    expect(await grants.findForTool(scope, "send_email")).toHaveLength(0);
    expect((await rules.list(scope)).filter((r) => r.revokedAt === undefined)).toHaveLength(1);

    // Revoke the RULE via /rules/revoke — drops from GET /rules.
    const ruleRes = await POST(
      req("/api/flowlet/rules/revoke", { method: "POST", body: JSON.stringify({ id: rule.id }) }),
    );
    expect(ruleRes.status).toBe(200);
    expect(await (await GET(req("/api/flowlet/rules"))).json()).toEqual({ rules: [] });
  });

  it("REVIEW FOLLOW-UP: a POST ending in /revoke that is neither /rules/revoke nor /grants/revoke 404s (never falls through to a grant revoke)", async () => {
    const { POST } = createFlowletHandler({ flowletDir: emptyDir() });
    const res = await POST(
      req("/api/flowlet/nope/revoke", { method: "POST", body: JSON.stringify({ id: "whatever" }) }),
    );
    expect(res.status).toBe(404);
  });

  it("REVIEW FOLLOW-UP: /grants/revoke and /rules/revoke both still resolve correctly (guards the fix above didn't regress the happy paths)", async () => {
    const scope = { tenantId: "flowlet-embedded", subject: "flowlet-default-user" };
    const grants = createInMemoryGrantStore();
    const rules = createInMemoryCompiledRuleStore();
    const grant = await grants.create(scope, {
      tool: "send_email", descriptorHash: "h1", scope: { kind: "tool" }, duration: "standing",
      source: { kind: "chat" },
    });
    const rule = await rules.create(scope, {
      kind: "always_ask", toolPattern: "send_email", plainText: "sending any email",
    });
    const { POST } = createFlowletHandler({ flowletDir: emptyDir(), store: { grants, rules } });
    const grantRes = await POST(
      req("/api/flowlet/grants/revoke", { method: "POST", body: JSON.stringify({ id: grant.id }) }),
    );
    expect(grantRes.status).toBe(200);
    const ruleRes = await POST(
      req("/api/flowlet/rules/revoke", { method: "POST", body: JSON.stringify({ id: rule.id }) }),
    );
    expect(ruleRes.status).toBe(200);
  });

  it("REVIEW FOLLOW-UP: a custom principal resolver (multi-user mount) withholds steering tools — stop_asking_about is absent", async () => {
    // stop_asking_about is critical tier (an invariants.test.ts pin), so its
    // absence from /critical-tools is a direct signal the whole
    // createSteeringTools() spread (which also registers always_ask_before,
    // act tier — not observable via THIS route) was skipped.
    const { GET } = createFlowletHandler({
      flowletDir: emptyDir(),
      principal: async () => ({ userId: "custom-user" }),
    });
    const res = await GET(req("/api/flowlet/critical-tools"));
    const body = (await res.json()) as { tools: { name: string }[] };
    const names = body.tools.map((t) => t.name);
    expect(names).not.toContain("stop_asking_about");
  });

  it("the default single-principal mount (no custom principal resolver) keeps steering tools", async () => {
    const { GET } = createFlowletHandler({ flowletDir: emptyDir() });
    const res = await GET(req("/api/flowlet/critical-tools"));
    const body = (await res.json()) as { tools: { name: string }[] };
    const names = body.tools.map((t) => t.name);
    expect(names).toContain("stop_asking_about");
  });
});
