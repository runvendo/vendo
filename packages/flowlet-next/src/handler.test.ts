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

  it("400s a chat request with no messages (zero-config, no key needed)", async () => {
    const { POST } = createFlowletHandler({ flowletDir: emptyDir() });
    const res = await POST(
      req("/api/flowlet/chat", { method: "POST", body: JSON.stringify({ messages: [] }) }),
    );
    expect(res.status).toBe(400);
  });

  it("guards every mutating endpoint against remote requests by default", async () => {
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
