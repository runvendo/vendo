import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
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

  it("400s a chat request with no messages once a key is present", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-x");
    const { POST } = createFlowletHandler({ flowletDir: emptyDir() });
    const res = await POST(
      req("/api/flowlet/chat", { method: "POST", body: JSON.stringify({ messages: [] }) }),
    );
    expect(res.status).toBe(400);
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
