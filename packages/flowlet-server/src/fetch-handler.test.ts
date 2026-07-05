import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createFlowletFetchHandler, resetFlowletBootRegistry } from "./fetch-handler";

function req(pathname: string, init?: RequestInit): Request {
  return new Request(`http://localhost:3000${pathname}`, {
    headers: { host: "localhost:3000" },
    ...init,
  });
}

// Point at an empty scratch dir so tests never read the repo's .flowlet/.
function emptyDir(): string {
  return path.join(mkdtempSync(path.join(tmpdir(), "flowlet-fetch-handler-")), ".flowlet");
}

afterEach(() => {
  vi.unstubAllEnvs();
  // Handlers claim the process-wide boot slot (first-wins); keep tests
  // order-independent.
  resetFlowletBootRegistry();
});

describe("createFlowletFetchHandler", () => {
  it("does not throw at creation with no env/keys/.flowlet dir (safe at module-import time)", () => {
    expect(() => createFlowletFetchHandler()).not.toThrow();
  });

  it("rejects unknown option keys at creation", () => {
    expect(() =>
      createFlowletFetchHandler({ produtName: "typo" } as never),
    ).toThrow(/invalid options/);
  });

  it("serves capabilities from env-key presence", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-x");
    vi.stubEnv("COMPOSIO_API_KEY", "");
    vi.stubEnv("OPENAI_API_KEY", "");
    const handler = createFlowletFetchHandler({ flowletDir: emptyDir() });
    const res = await handler(req("/api/flowlet/capabilities"));
    expect(await res.json()).toEqual({ chat: true, integrations: false, voice: false, mcp: false, storage: false });
  });

  it("keeps integrations inert without a Composio key", async () => {
    vi.stubEnv("COMPOSIO_API_KEY", "");
    const handler = createFlowletFetchHandler({ flowletDir: emptyDir() });
    const list = await handler(req("/api/flowlet/integrations"));
    expect(await list.json()).toEqual({ enabled: false, integrations: [] });
    const connect = await handler(
      req("/api/flowlet/integrations", {
        method: "POST",
        body: JSON.stringify({ id: "gmail", action: "connect" }),
      }),
    );
    expect(connect.status).toBe(503);
  });

  it("routes unknown paths to 404 and disabled tick to 404", async () => {
    const handler = createFlowletFetchHandler({ flowletDir: emptyDir(), automations: false });
    expect((await handler(req("/api/flowlet/nope"))).status).toBe(404);
    expect((await handler(req("/api/flowlet/tick", { method: "POST" }))).status).toBe(404);
  });

  it("404s wrong-method combinations (GET chat)", async () => {
    const handler = createFlowletFetchHandler({ flowletDir: emptyDir() });
    expect((await handler(req("/api/flowlet/chat"))).status).toBe(404);
  });

  it("ticks the automations world when enabled", async () => {
    const handler = createFlowletFetchHandler({ flowletDir: emptyDir() });
    const res = await handler(req("/api/flowlet/tick", { method: "POST" }));
    expect(await res.json()).toEqual({ ok: true });
  });

  it("503s a chat request when no model key is configured", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    const handler = createFlowletFetchHandler({ flowletDir: emptyDir() });
    const res = await handler(
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
    const handler = createFlowletFetchHandler({ flowletDir: emptyDir(), model });

    const caps = await handler(req("/api/flowlet/capabilities"));
    expect(await caps.json()).toEqual({ chat: true, integrations: false, voice: false, mcp: false, storage: false });

    // The chatEnabled gate (503) fires before messages validation (400), so a
    // 400 on an empty messages array proves chat was NOT gated off.
    const res = await handler(
      req("/api/flowlet/chat", { method: "POST", body: JSON.stringify({ messages: [] }) }),
    );
    expect(res.status).toBe(400);
  });

  it("400s a chat request with no messages once a key is present", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-x");
    const handler = createFlowletFetchHandler({ flowletDir: emptyDir() });
    const res = await handler(
      req("/api/flowlet/chat", { method: "POST", body: JSON.stringify({ messages: [] }) }),
    );
    expect(res.status).toBe(400);
  });

  it("500s a boot failure and retries assembly once the config is fixed", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-x");
    vi.stubEnv("FLOWLET_MODEL", "grok/whatever");
    const handler = createFlowletFetchHandler({ flowletDir: emptyDir() });

    const broken = await handler(req("/api/flowlet/capabilities"));
    expect(broken.status).toBe(500);
    expect(((await broken.json()) as { error: string }).error).toMatch(/Flowlet/);

    // Fixing the env must NOT keep serving the cached rejection.
    vi.stubEnv("FLOWLET_MODEL", "");
    const fixed = await handler(req("/api/flowlet/capabilities"));
    expect(fixed.status).toBe(200);
    expect(await fixed.json()).toEqual({ chat: true, integrations: false, voice: false, mcp: false, storage: false });
  });

  it("guards every mutating endpoint against remote requests by default", async () => {
    // A key so chat reaches the guard rather than short-circuiting on 503.
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-x");
    vi.stubEnv("COMPOSIO_API_KEY", "ck_x");
    vi.stubEnv("NODE_ENV", "production"); // fail-closed in prod even for spoofed Host
    const handler = createFlowletFetchHandler({ flowletDir: emptyDir() });
    for (const p of ["chat", "action", "tick", "integrations"]) {
      const res = await handler(
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
