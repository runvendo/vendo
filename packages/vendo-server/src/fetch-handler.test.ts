import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createVendoFetchHandler, resetVendoBootRegistry } from "./fetch-handler";

function req(pathname: string, init?: RequestInit): Request {
  return new Request(`http://localhost:3000${pathname}`, {
    headers: { host: "localhost:3000" },
    ...init,
  });
}

// Point at an empty scratch dir so tests never read the repo's .vendo/.
function emptyDir(): string {
  return path.join(mkdtempSync(path.join(tmpdir(), "vendo-fetch-handler-")), ".vendo");
}

afterEach(() => {
  vi.unstubAllEnvs();
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
    expect(await res.json()).toEqual({ chat: true, integrations: false, voice: false, mcp: false, storage: false });
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
    expect(await caps.json()).toEqual({ chat: true, integrations: false, voice: false, mcp: false, storage: false });

    // The chatEnabled gate (503) fires before messages validation (400), so a
    // 400 on an empty messages array proves chat was NOT gated off.
    const res = await handler(
      req("/api/vendo/chat", { method: "POST", body: JSON.stringify({ messages: [] }) }),
    );
    expect(res.status).toBe(400);
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
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-x");
    vi.stubEnv("VENDO_MODEL", "grok/whatever");
    const handler = createVendoFetchHandler({ vendoDir: emptyDir() });

    const broken = await handler(req("/api/vendo/capabilities"));
    expect(broken.status).toBe(500);
    expect(((await broken.json()) as { error: string }).error).toMatch(/Vendo/);

    // Fixing the env must NOT keep serving the cached rejection.
    vi.stubEnv("VENDO_MODEL", "");
    const fixed = await handler(req("/api/vendo/capabilities"));
    expect(fixed.status).toBe(200);
    expect(await fixed.json()).toEqual({ chat: true, integrations: false, voice: false, mcp: false, storage: false });
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
    for (const p of ["chat", "action", "tick", "integrations"]) {
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
