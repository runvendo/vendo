import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
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
    expect(await fixed.json()).toEqual({ chat: true, integrations: false, voice: false });
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
