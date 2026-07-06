import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { z } from "zod";
import type { ApprovalPolicy, RegisteredTool } from "@vendoai/runtime";
import { createVendoFetchHandler, resetVendoBootRegistry } from "./fetch-handler.js";

function req(pathname: string, init?: RequestInit): Request {
  return new Request(`http://localhost:3000${pathname}`, {
    headers: { host: "localhost:3000" },
    ...init,
  });
}

const ZERO_USAGE = {
  inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 0, text: 0, reasoning: 0 },
} as const;

const ALLOW_POLICY: ApprovalPolicy = {
  evaluate: () => "allow",
};

const NOOP_TOOL: RegisteredTool = {
  descriptor: {
    name: "noop",
    source: "caller",
    annotations: { readOnlyHint: true },
    hasExecute: true,
    kind: "function",
  },
  inputSchema: z.object({}),
  execute: async () => ({ ok: true, result: { ok: true } }),
};

function textChunks(id: string, text: string): LanguageModelV3StreamPart[] {
  return [
    { type: "text-start", id },
    { type: "text-delta", id, delta: text },
    { type: "text-end", id },
  ];
}

function promptHasToolCall(prompt: { role: string; content: unknown }[]): boolean {
  return prompt.some(
    (m) =>
      m.role === "assistant" &&
      Array.isArray(m.content) &&
      m.content.some((c) => (c as { type?: string }).type === "tool-call"),
  );
}

function createAutomationModel(event: string): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    doStream: async ({ prompt }) => {
      const chunks: LanguageModelV3StreamPart[] = promptHasToolCall(prompt)
        ? [
            ...textChunks("done", "Done."),
            { type: "finish", usage: ZERO_USAGE, finishReason: { unified: "stop", raw: undefined } },
          ]
        : [
            ...textChunks("start", "Creating automation."),
            {
              type: "tool-call",
              toolCallId: "call-create",
              toolName: "create_automation",
              input: JSON.stringify({
                spec: {
                  name: "Invoice automation",
                  description: "Run when invoice event arrives.",
                  prompt: "When an invoice is paid, run the no-op step.",
                  trigger: { type: "host_event", event },
                  execution: {
                    mode: "steps",
                    steps: [{ id: "noop_step", type: "tool", tool: "noop", input: {} }],
                  },
                  limits: { maxFiringsPerHour: 10 },
                },
                grantedTools: [],
              }),
            },
            { type: "finish", usage: ZERO_USAGE, finishReason: { unified: "tool-calls", raw: undefined } },
          ];
      return { stream: simulateReadableStream({ chunks }) };
    },
  });
}

async function readBody(res: Response): Promise<string> {
  return res.text();
}

// Point at an empty scratch dir so tests never read the repo's .vendo/.
function emptyDir(): string {
  return path.join(mkdtempSync(path.join(tmpdir(), "vendo-fetch-handler-")), ".vendo");
}

function vendoDirWithEvent(): string {
  const dir = path.join(mkdtempSync(path.join(tmpdir(), "vendo-fetch-handler-")), ".vendo");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "tools.json"),
    JSON.stringify({
      version: 1,
      tools: [],
      events: [
        {
          name: "invoice.paid",
          description: "An invoice was paid.",
          payloadSchema: {
            type: "object",
            properties: { invoiceId: { type: "string" } },
          },
        },
      ],
    }),
  );
  return dir;
}

function modelStub(): import("ai").LanguageModel {
  return { modelId: "stub" } as unknown as import("ai").LanguageModel;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  // Handlers claim the process-wide boot slot (first-wins); keep tests
  // order-independent.
  resetVendoBootRegistry();
});

describe("createVendoFetchHandler", () => {
  it("does not throw at creation with no env/keys/.vendo dir (safe at module-import time)", () => {
    expect(() => createVendoFetchHandler()).not.toThrow();
  });

  it("rejects unknown option keys at creation", () => {
    expect(() =>
      createVendoFetchHandler({ produtName: "typo" } as never),
    ).toThrow(/invalid options/);
  });

  it("serves capabilities from env-key presence", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-x");
    vi.stubEnv("COMPOSIO_API_KEY", "");
    vi.stubEnv("OPENAI_API_KEY", "");
    const handler = createVendoFetchHandler({ vendoDir: emptyDir() });
    const res = await handler(req("/api/vendo/capabilities"));
    expect(await res.json()).toEqual({ chat: true, integrations: false, voice: false, mcp: false, storage: false, automations: true });
  });

  it("reports automations:false when the host disables automations", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-x");
    const handler = createVendoFetchHandler({ vendoDir: emptyDir(), automations: false });
    const res = await handler(req("/api/vendo/capabilities"));
    expect(((await res.json()) as { automations: boolean }).automations).toBe(false);
  });

  it("keeps integrations inert without a Composio key", async () => {
    vi.stubEnv("COMPOSIO_API_KEY", "");
    const handler = createVendoFetchHandler({ vendoDir: emptyDir() });
    const list = await handler(req("/api/vendo/integrations"));
    expect(await list.json()).toEqual({ enabled: false, integrations: [] });
    const connect = await handler(
      req("/api/vendo/integrations", {
        method: "POST",
        body: JSON.stringify({ id: "gmail", action: "connect" }),
      }),
    );
    expect(connect.status).toBe(503);
  });

  it("requires a passing principal for capabilities once a principal resolver is configured", async () => {
    // Configuration disclosure (which providers/keys/integrations are live)
    // must not leak to an unauthenticated caller when the host HAS wired auth.
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-x");
    const denied = createVendoFetchHandler({
      vendoDir: emptyDir(),
      principal: async () => null,
    });
    expect((await denied(req("/api/vendo/capabilities"))).status).toBe(403);

    const allowed = createVendoFetchHandler({
      vendoDir: emptyDir(),
      principal: async () => ({ userId: "u1" }),
    });
    const ok = await allowed(req("/api/vendo/capabilities"));
    expect(ok.status).toBe(200);
    expect((await ok.json()) as { chat: boolean }).toMatchObject({ chat: true });
  });

  it("keeps capabilities open for zero-config installs (client needs it pre-auth)", async () => {
    // No principal resolver: the local dev / BYO-keys mode where the client
    // reads capabilities before any auth exists. This must stay open.
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-x");
    const handler = createVendoFetchHandler({ vendoDir: emptyDir() });
    expect((await handler(req("/api/vendo/capabilities"))).status).toBe(200);
  });

  it("routes unknown paths to 404 and disabled tick to 404", async () => {
    const handler = createVendoFetchHandler({ vendoDir: emptyDir(), automations: false });
    expect((await handler(req("/api/vendo/nope"))).status).toBe(404);
    expect((await handler(req("/api/vendo/tick", { method: "POST" }))).status).toBe(404);
  });

  it("404s wrong-method combinations (GET chat)", async () => {
    const handler = createVendoFetchHandler({ vendoDir: emptyDir() });
    expect((await handler(req("/api/vendo/chat"))).status).toBe(404);
  });

  it("ticks the automations world when enabled", async () => {
    const handler = createVendoFetchHandler({ vendoDir: emptyDir() });
    const res = await handler(req("/api/vendo/tick", { method: "POST" }));
    expect(await res.json()).toEqual({ ok: true });
  });

  it("flows tools.json events into the automation world closed-world validation", async () => {
    const createHandler = (event: string) =>
      createVendoFetchHandler({
        vendoDir: vendoDirWithEvent(),
        model: createAutomationModel(event),
        policy: ALLOW_POLICY,
        automations: { tools: { noop: NOOP_TOOL } },
        maxSteps: 3,
      });

    const declared = await createHandler("invoice.paid")(
      req("/api/vendo/chat", {
        method: "POST",
        body: JSON.stringify({
          messages: [{ id: "u1", role: "user", parts: [{ type: "text", text: "create it" }] }],
        }),
      }),
    );
    expect(declared.status).toBe(200);
    expect(await readBody(declared)).toContain('"ok":true');

    resetVendoBootRegistry();
    const undeclared = await createHandler("invoice.sent")(
      req("/api/vendo/chat", {
        method: "POST",
        body: JSON.stringify({
          messages: [{ id: "u1", role: "user", parts: [{ type: "text", text: "create it" }] }],
        }),
      }),
    );
    expect(undeclared.status).toBe(200);
    const body = await readBody(undeclared);
    expect(body).toContain('host event \\"invoice.sent\\" is not declared');
    expect(body).toContain("available: invoice.paid");
  });

  it("503s a chat request when no model key is configured", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    const handler = createVendoFetchHandler({ vendoDir: emptyDir() });
    const res = await handler(
      req("/api/vendo/chat", { method: "POST", body: JSON.stringify({ messages: [{ role: "user" }] }) }),
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
    const handler = createVendoFetchHandler({ vendoDir: emptyDir(), model });

    const caps = await handler(req("/api/vendo/capabilities"));
    expect(await caps.json()).toEqual({ chat: true, integrations: false, voice: false, mcp: false, storage: false, automations: true });

    // The chatEnabled gate (503) fires before messages validation (400), so a
    // 400 on an empty messages array proves chat was NOT gated off.
    const res = await handler(
      req("/api/vendo/chat", { method: "POST", body: JSON.stringify({ messages: [] }) }),
    );
    expect(res.status).toBe(400);
  });

  it("mints an OpenAI Realtime client secret for POST /voice/session", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-voice");
    vi.stubEnv("OPENAI_REALTIME_MODEL", "gpt-realtime-preview");
    vi.stubEnv("OPENAI_REALTIME_VOICE", "alloy");
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ value: "eph_secret" }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const handler = createVendoFetchHandler({ vendoDir: emptyDir(), model: modelStub() });

    const res = await handler(req("/api/vendo/voice/session", { method: "POST" }));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      clientSecret: "eph_secret",
      model: "gpt-realtime-preview",
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.openai.com/v1/realtime/client_secrets");
    expect((init as RequestInit).method).toBe("POST");
    expect((init as RequestInit).headers).toMatchObject({
      Authorization: "Bearer sk-voice",
      "Content-Type": "application/json",
    });
    expect(((init as RequestInit).headers as Record<string, string>)["OpenAI-Safety-Identifier"]).toMatch(
      /^vendo_[a-f0-9]{64}$/,
    );
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({
      session: {
        type: "realtime",
        model: "gpt-realtime-preview",
        audio: { output: { voice: "alloy" } },
      },
    });
  });

  it("502s /voice/session when the OpenAI mint fails", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-voice");
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ error: { message: "bad key with account detail" } }), {
        status: 401,
        headers: { "x-request-id": "req_voice_123" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const handler = createVendoFetchHandler({ vendoDir: emptyDir(), model: modelStub() });

    const res = await handler(req("/api/vendo/voice/session", { method: "POST" }));

    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "mint failed" });
    expect(fetchMock).toHaveBeenCalledOnce();
    const logged = err.mock.calls
      .flat()
      .map((arg) => (typeof arg === "object" ? JSON.stringify(arg) : String(arg)))
      .join(" ");
    expect(logged).toContain("401");
    expect(logged).toContain("req_voice_123");
    expect(logged).not.toContain("bad key");
    expect(logged).not.toContain("account detail");
    err.mockRestore();
  });

  it("binds /voice/session mints to the guarded principal, not a browser-supplied safety id", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-voice");
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ value: "eph_secret" }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const handler = createVendoFetchHandler({
      vendoDir: emptyDir(),
      model: modelStub(),
      principal: async () => ({ userId: "user-42" }),
    });

    const res = await handler(
      req("/api/vendo/voice/session", {
        method: "POST",
        headers: { host: "localhost:3000", "OpenAI-Safety-Identifier": "browser-forged" },
      }),
    );

    expect(res.status).toBe(200);
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers["OpenAI-Safety-Identifier"]).toMatch(/^vendo_[a-f0-9]{64}$/);
    expect(headers["OpenAI-Safety-Identifier"]).not.toBe("browser-forged");
    expect(headers["OpenAI-Safety-Identifier"]).not.toContain("user-42");
  });

  it("503s /voice/session without OPENAI_API_KEY and does not call upstream", async () => {
    vi.stubEnv("OPENAI_API_KEY", "");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const handler = createVendoFetchHandler({ vendoDir: emptyDir(), model: modelStub() });

    const res = await handler(req("/api/vendo/voice/session", { method: "POST" }));

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "voice not configured (OPENAI_API_KEY missing)" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("guards /voice/session with the same production default request guard as other spend routes", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-voice");
    vi.stubEnv("NODE_ENV", "production");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const handler = createVendoFetchHandler({
      vendoDir: emptyDir(),
      model: modelStub(),
      storage: false,
    });

    const res = await handler(
      new Request("http://prod.example.com/api/vendo/voice/session", {
        method: "POST",
        headers: { host: "prod.example.com" },
      }),
    );

    expect(res.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("guards /voice/tools with the same production default request guard as other spend routes", async () => {
    vi.stubEnv("COMPOSIO_API_KEY", "ck_x");
    vi.stubEnv("NODE_ENV", "production");
    const handler = createVendoFetchHandler({
      vendoDir: emptyDir(),
      model: modelStub(),
      storage: false,
    });

    const get = await handler(
      new Request("http://prod.example.com/api/vendo/voice/tools", {
        headers: { host: "prod.example.com" },
      }),
    );
    const post = await handler(
      new Request("http://prod.example.com/api/vendo/voice/tools", {
        method: "POST",
        headers: { host: "prod.example.com", "content-type": "application/json" },
        body: JSON.stringify({ tool: "GMAIL_FETCH_EMAILS", input: {} }),
      }),
    );

    expect(get.status).toBe(403);
    expect(post.status).toBe(403);
  });

  it("400s a chat request with no messages once a key is present", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-x");
    const handler = createVendoFetchHandler({ vendoDir: emptyDir() });
    const res = await handler(
      req("/api/vendo/chat", { method: "POST", body: JSON.stringify({ messages: [] }) }),
    );
    expect(res.status).toBe(400);
  });

  it("500s a boot failure and retries assembly once the config is fixed", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-x");
    vi.stubEnv("VENDO_MODEL", "grok/whatever");
    const handler = createVendoFetchHandler({ vendoDir: emptyDir() });

    // A deliberately-constructed, developer-actionable message ("Vendo: …")
    // still reaches a LOCAL dev request verbatim — it's static text our own
    // code wrote, and localhost-in-dev is the developer's own terminal.
    const broken = await handler(req("/api/vendo/capabilities"));
    expect(broken.status).toBe(500);
    expect(((await broken.json()) as { error: string }).error).toMatch(/Vendo.*VENDO_MODEL/);

    // Fixing the env must NOT keep serving the cached rejection.
    vi.stubEnv("VENDO_MODEL", "");
    const fixed = await handler(req("/api/vendo/capabilities"));
    expect(fixed.status).toBe(200);
    expect(await fixed.json()).toEqual({ chat: true, integrations: false, voice: false, mcp: false, storage: false, automations: true });
    error.mockRestore();
  });

  it("answers a REMOTE caller's boot failure with a generic message, even a developer-actionable one", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-x");
    vi.stubEnv("VENDO_MODEL", "grok/whatever");
    const handler = createVendoFetchHandler({ vendoDir: emptyDir() });

    // Boot failures happen BEFORE any principal guard runs, so this path is
    // reachable by unauthenticated remote callers — nothing but the generic
    // message may cross; the detail goes to the server log.
    const res = await handler(
      new Request("http://prod.example.com/api/vendo/capabilities", {
        headers: { host: "prod.example.com" },
      }),
    );
    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: string }).error).toBe(
      "vendo failed to start — see server logs",
    );
    expect(
      error.mock.calls.some((call) =>
        call.some((arg) => arg instanceof Error && arg.message.includes("VENDO_MODEL")),
      ),
    ).toBe(true);
    error.mockRestore();
  });

  it("answers a throw inside a route handler with a generic JSON 500, never an escaped rejection", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    // A throwing host `principal` resolver is a realistic route-dep failure
    // (host auth backend down). Before the route-level boundary this escaped
    // createVendoFetchHandler entirely — the framework rendered an HTML 500,
    // which the sandbox then parsed as JSON into a raw SyntaxError.
    const handler = createVendoFetchHandler({
      vendoDir: emptyDir(),
      principal: async () => {
        throw new Error("pg://user:s3cretpw@auth-db.internal:5432 connection refused");
      },
    });
    const res = await handler(req("/api/vendo/grants"));
    expect(res.status).toBe(500);
    expect(res.headers.get("content-type")).toMatch(/application\/json/);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("internal error");
    // The detail (connection string and all) goes to the server log only.
    expect(
      error.mock.calls.some((call) =>
        call.some((arg) => arg instanceof Error && arg.message.includes("s3cretpw")),
      ),
    ).toBe(true);
    error.mockRestore();
  });

  it("fails closed on parked-actions for a non-world principal, exactly like /deliveries (single-tenant world)", async () => {
    // Under a custom multi-user `principal` resolver, subjects other than the
    // world's own fixed subject must not read or resolve the world's parked
    // drafts — same 403 the /deliveries and /resume routes answer.
    const handler = createVendoFetchHandler({
      vendoDir: emptyDir(),
      principal: async () => ({ userId: "not-the-world-subject" }),
    });

    const list = await handler(req("/api/vendo/parked-actions"));
    expect(list.status).toBe(403);
    expect(((await list.json()) as { error: string }).error).toMatch(/single-tenant/);

    const resolve = await handler(
      req("/api/vendo/parked-actions/resolve", {
        method: "POST",
        body: JSON.stringify({ actionId: "a1", decision: "yes" }),
      }),
    );
    expect(resolve.status).toBe(403);
    expect(((await resolve.json()) as { error: string }).error).toMatch(/single-tenant/);
  });

  it("still serves parked-actions to the world's own subject", async () => {
    const handler = createVendoFetchHandler({
      vendoDir: emptyDir(),
      principal: async () => ({ userId: "vendo-default-user" }),
    });
    const list = await handler(req("/api/vendo/parked-actions"));
    expect(list.status).toBe(200);
    expect(await list.json()).toEqual({ actions: [] });
  });

  // Every browser-credentialed mutating POST route (not chat/tick/webhooks,
  // which have their own auth or no ambient-cookie surface).
  const CSRF_GATED_POSTS = [
    "integrations",
    "action",
    "consent",
    "fade-proposal",
    "resume",
    "parked-actions/resolve",
    "grants/revoke",
    "rules/revoke",
    "vendos",
  ];

  it("rejects a cross-site POST to every browser-credentialed mutating route", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-x");
    const handler = createVendoFetchHandler({ vendoDir: emptyDir(), storage: false });
    for (const tail of CSRF_GATED_POSTS) {
      const res = await handler(
        new Request(`http://localhost:3000/api/vendo/${tail}`, {
          method: "POST",
          headers: { host: "localhost:3000", origin: "https://evil.example", "content-type": "application/json" },
          body: JSON.stringify({}),
        }),
      );
      expect(res.status, tail).toBe(403);
      expect(((await res.json()) as { error: string }).error, tail).toMatch(/cross-site/);
    }
  });

  it("lets a same-origin POST (host page fetch) past the CSRF gate on every gated route", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-x");
    const handler = createVendoFetchHandler({ vendoDir: emptyDir(), storage: false });
    for (const tail of CSRF_GATED_POSTS) {
      const res = await handler(
        new Request(`http://localhost:3000/api/vendo/${tail}`, {
          method: "POST",
          headers: { host: "localhost:3000", origin: "http://localhost:3000", "content-type": "application/json" },
          body: JSON.stringify({}),
        }),
      );
      // Route logic runs (may 400/503) — it must NOT be the CSRF 403.
      if (res.status === 403) {
        expect(((await res.json()) as { error: string }).error, tail).not.toMatch(/cross-site/);
      }
    }
  });

  it("guards every mutating endpoint against remote requests by default", async () => {
    // A key so chat reaches the guard rather than short-circuiting on 503.
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-x");
    vi.stubEnv("COMPOSIO_API_KEY", "ck_x");
    vi.stubEnv("NODE_ENV", "production"); // fail-closed in prod even for spoofed Host
    // storage:false keeps this guard test off the durable path: NODE_ENV=production
    // otherwise trips resolveStorage's real PGlite boot (the test-env safety net is
    // NODE_ENV==="test"-only), whose WASM first-init is flaky here and would 500 the
    // first request before it reaches the remote guard. This test is about the guard.
    const handler = createVendoFetchHandler({ vendoDir: emptyDir(), storage: false });
    for (const p of ["chat", "action", "tick", "events/ingest", "integrations"]) {
      const res = await handler(
        new Request(`http://prod.example.com/api/vendo/${p}`, {
          method: "POST",
          headers: { host: "prod.example.com" },
          body: JSON.stringify({}),
        }),
      );
      expect(res.status, p).toBe(403);
    }
  });
});
