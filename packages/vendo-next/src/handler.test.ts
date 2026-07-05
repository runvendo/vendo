import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { tool } from "ai";
import { z } from "zod";
import {
  createVendoDatabase,
  createDrizzleDecisionStore,
  createDrizzleThreadStore,
  getMeta,
} from "@vendoai/store";
import type { VendoUIMessage } from "@vendoai/core";
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";
import {
  automationSpecSchema,
  canonicalKey,
  createInMemoryCompiledRuleStore,
  createInMemoryGrantStore,
  InMemoryThreadStore,
  type RegisteredTool,
} from "@vendoai/runtime";
import { createVendoHandler, resetVendoBootRegistry, routeTail } from "./handler";
import { ensureVendoState, WORLD_SCOPE } from "@vendoai/server";

// An unannotated write tool: the default policy's fail-safe gates it behind
// approval (no readOnly/destructive hints, no Composio-shaped verb segments).
function writeTool() {
  return {
    create_thing: tool({
      description: "write a thing",
      inputSchema: z.object({ amount: z.number() }).passthrough(),
      execute: async (input: unknown) => ({ wrote: input }),
    }),
  };
}

function req(pathname: string, init?: RequestInit): Request {
  return new Request(`http://localhost:3000${pathname}`, {
    headers: { host: "localhost:3000" },
    ...init,
  });
}

// Point at an empty scratch dir so tests never read the repo's .vendo/.
function emptyDir(): string {
  return path.join(mkdtempSync(path.join(tmpdir(), "vendo-handler-")), ".vendo");
}

afterEach(() => {
  vi.unstubAllEnvs();
  // Handlers claim the process-wide boot slot (first-wins); keep tests
  // order-independent.
  resetVendoBootRegistry();
});

describe("routeTail", () => {
  it.each([
    ["/api/vendo/chat", "chat"],
    ["/api/vendo/webhooks/composio", "webhooks/composio"],
    ["/api/vendo/threads", "threads"],
    ["/api/vendo/threads/t1", "threads/t1"],
    ["/api/vendo/vendos/f1/delete", "vendos/f1/delete"],
    // Regression: the five existing endpoints still resolve under any mount.
    ["/api/vendo/action", "action"],
    ["/api/vendo/integrations", "integrations"],
    ["/api/vendo/capabilities", "capabilities"],
    ["/api/vendo/voice/session", "voice/session"],
    ["/api/vendo/tick", "tick"],
    ["/api/vendo/events/ingest", "events/ingest"],
  ])("resolves %s to %s", (pathname, expected) => {
    expect(routeTail(req(pathname))).toBe(expected);
  });

  it("resolves the tail regardless of where the catch-all is mounted", () => {
    expect(routeTail(req("/some/other/mount/threads/t1"))).toBe("threads/t1");
  });
});

describe("createVendoHandler", () => {
  it("rejects unknown option keys at creation", () => {
    expect(() =>
      createVendoHandler({ produtName: "typo" } as never),
    ).toThrow(/invalid options/);
  });

  it("serves capabilities from env-key presence", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-x");
    vi.stubEnv("COMPOSIO_API_KEY", "");
    vi.stubEnv("OPENAI_API_KEY", "");
    const { GET } = createVendoHandler({ vendoDir: emptyDir() });
    const res = await GET(req("/api/vendo/capabilities"));
    expect(await res.json()).toEqual({ chat: true, integrations: false, voice: false, mcp: false, storage: false });
  });

  it("capabilities.mcp is true when mcpServers option is set", async () => {
    const { GET } = createVendoHandler({
      vendoDir: emptyDir(),
      mcpServers: [{ name: "weather", url: "https://mcp.example.com/mcp" }],
    });
    const res = await GET(req("/api/vendo/capabilities"));
    expect(((await res.json()) as { mcp: boolean }).mcp).toBe(true);
  });

  it("capabilities.mcp is true when .vendo/mcp.json declares a server", async () => {
    const dir = emptyDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, "mcp.json"),
      JSON.stringify({ version: 1, servers: [{ name: "s", url: "https://x" }] }),
    );
    const { GET } = createVendoHandler({ vendoDir: dir });
    const res = await GET(req("/api/vendo/capabilities"));
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
    const { GET } = createVendoHandler({ vendoDir: dir });
    const res = await GET(req("/api/vendo/capabilities"));
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
    const { GET } = createVendoHandler({ vendoDir: dir, mcpServers: [] });
    const res = await GET(req("/api/vendo/capabilities"));
    expect(((await res.json()) as { mcp: boolean }).mcp).toBe(false);
  });

  it("keeps integrations inert without a Composio key", async () => {
    vi.stubEnv("COMPOSIO_API_KEY", "");
    const { GET, POST } = createVendoHandler({ vendoDir: emptyDir() });
    const list = await GET(req("/api/vendo/integrations"));
    expect(await list.json()).toEqual({ enabled: false, integrations: [] });
    const connect = await POST(
      req("/api/vendo/integrations", {
        method: "POST",
        body: JSON.stringify({ id: "gmail", action: "connect" }),
      }),
    );
    expect(connect.status).toBe(503);
  });

  it("routes unknown paths to 404 and disabled tick to 404", async () => {
    const { GET, POST } = createVendoHandler({ vendoDir: emptyDir(), automations: false });
    expect((await GET(req("/api/vendo/nope"))).status).toBe(404);
    expect((await POST(req("/api/vendo/tick", { method: "POST" }))).status).toBe(404);
  });

  it("ticks the automations world when enabled", async () => {
    const { POST } = createVendoHandler({ vendoDir: emptyDir() });
    const res = await POST(req("/api/vendo/tick", { method: "POST" }));
    expect(await res.json()).toEqual({ ok: true });
  });

  it("serves automation deliveries since a cursor (VendoToasts)", async () => {
    const { GET } = createVendoHandler({ vendoDir: emptyDir() });
    const res = await GET(req("/api/vendo/deliveries?since=0"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deliveries: [] });
  });

  it("404s deliveries and resume when automations are disabled", async () => {
    const { GET, POST } = createVendoHandler({ vendoDir: emptyDir(), automations: false });
    expect((await GET(req("/api/vendo/deliveries?since=0"))).status).toBe(404);
    expect(
      (
        await POST(
          req("/api/vendo/resume", {
            method: "POST",
            body: JSON.stringify({ runId: "r1", approved: true }),
          }),
        )
      ).status,
    ).toBe(404);
  });

  it("answers resume for an unknown run as stale instead of erroring", async () => {
    const { POST } = createVendoHandler({ vendoDir: emptyDir() });
    const res = await POST(
      req("/api/vendo/resume", {
        method: "POST",
        body: JSON.stringify({ runId: "nope", approved: true }),
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ stale: true });
  });

  it("400s a resume request without a runId", async () => {
    const { POST } = createVendoHandler({ vendoDir: emptyDir() });
    const res = await POST(
      req("/api/vendo/resume", { method: "POST", body: JSON.stringify({ approved: true }) }),
    );
    expect(res.status).toBe(400);
  });

  it("503s a chat request when no model key is configured", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    const { POST } = createVendoHandler({ vendoDir: emptyDir() });
    const res = await POST(
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
    const { GET, POST } = createVendoHandler({ vendoDir: emptyDir(), model });

    const caps = await GET(req("/api/vendo/capabilities"));
    expect(await caps.json()).toEqual({ chat: true, integrations: false, voice: false, mcp: false, storage: false });

    // The chatEnabled gate (503) fires before messages validation (400), so a
    // 400 on an empty messages array proves chat was NOT gated off.
    const res = await POST(
      req("/api/vendo/chat", { method: "POST", body: JSON.stringify({ messages: [] }) }),
    );
    expect(res.status).toBe(400);
  });

  it("400s a chat request with no messages once a key is present", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-x");
    const { POST } = createVendoHandler({ vendoDir: emptyDir() });
    const res = await POST(
      req("/api/vendo/chat", { method: "POST", body: JSON.stringify({ messages: [] }) }),
    );
    expect(res.status).toBe(400);
  });

  it("500s a boot failure and retries assembly once the config is fixed", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-x");
    vi.stubEnv("VENDO_MODEL", "grok/whatever");
    const { GET } = createVendoHandler({ vendoDir: emptyDir() });

    const broken = await GET(req("/api/vendo/capabilities"));
    expect(broken.status).toBe(500);
    expect(((await broken.json()) as { error: string }).error).toMatch(/Vendo/);

    // Fixing the env must NOT keep serving the cached rejection.
    vi.stubEnv("VENDO_MODEL", "");
    const fixed = await GET(req("/api/vendo/capabilities"));
    expect(fixed.status).toBe(200);
    expect(await fixed.json()).toEqual({ chat: true, integrations: false, voice: false, mcp: false, storage: false });
  });

  it("resolves GET /capabilities after async assembly (async ripple smoke test)", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-x");
    const { GET } = createVendoHandler({ vendoDir: emptyDir(), storage: false });
    const res = await GET(req("/api/vendo/capabilities"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ chat: true, integrations: false, voice: false, mcp: false, storage: false });
  });

  it("reports storage:true once durable storage actually assembles (not just from an env key)", async () => {
    const { GET } = createVendoHandler({
      vendoDir: emptyDir(),
      storage: { pglite: { dataDir: `memory://vendo-next-capabilities-storage-${Date.now()}` } },
    });
    const res = await GET(req("/api/vendo/capabilities"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ chat: false, integrations: false, voice: false, mcp: false, storage: true });
  });

  it("warns once, no matter how many requests, when running without durable storage in production", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-x");
    const { GET } = createVendoHandler({ vendoDir: emptyDir(), storage: false, principal: async () => null });
    await GET(req("/api/vendo/capabilities"));
    await GET(req("/api/vendo/capabilities"));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toMatch(/in-memory/);
    warn.mockRestore();
  });

  it("warns once when durable storage is configured alongside a custom principal resolver (single-tenant)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { GET } = createVendoHandler({
      vendoDir: emptyDir(),
      storage: { pglite: { dataDir: "memory://vendo-next-handler-test" } },
      principal: async () => ({ userId: "u1" }),
    });
    await GET(req("/api/vendo/capabilities"));
    await GET(req("/api/vendo/capabilities"));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toMatch(/single-tenant/);
    warn.mockRestore();
  });

  it("allows a tick with the correct bearer secret WITHOUT resolving a principal", async () => {
    vi.stubEnv("VENDO_TICK_SECRET", "s3cret");
    // A principal resolver that rejects EVERYONE proves the bearer path
    // bypasses resolvePrincipal entirely.
    const { POST } = createVendoHandler({ vendoDir: emptyDir(), principal: async () => null });
    const res = await POST(
      req("/api/vendo/tick", {
        method: "POST",
        headers: { host: "localhost:3000", authorization: "Bearer s3cret" },
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("401s a wrong bearer when the tick secret is set (no fall-through)", async () => {
    vi.stubEnv("VENDO_TICK_SECRET", "s3cret");
    // Even a localhost dev request (which resolvePrincipal would allow) must
    // be rejected: presenting a bad service credential is never a fall-through.
    const { POST } = createVendoHandler({ vendoDir: emptyDir() });
    const res = await POST(
      req("/api/vendo/tick", {
        method: "POST",
        headers: { host: "localhost:3000", authorization: "Bearer wrong" },
      }),
    );
    expect(res.status).toBe(401);
  });

  it("falls through to resolvePrincipal when the secret is set but no bearer is presented", async () => {
    vi.stubEnv("VENDO_TICK_SECRET", "s3cret");
    const { POST } = createVendoHandler({ vendoDir: emptyDir(), principal: async () => null });
    const res = await POST(req("/api/vendo/tick", { method: "POST" }));
    expect(res.status).toBe(403);
  });

  it("ignores a bearer entirely when no tick secret is configured (existing path unchanged)", async () => {
    const { POST } = createVendoHandler({ vendoDir: emptyDir() });
    const res = await POST(
      req("/api/vendo/tick", {
        method: "POST",
        headers: { host: "localhost:3000", authorization: "Bearer anything" },
      }),
    );
    expect(res.status).toBe(200);
  });

  it("writes a scheduler heartbeat meta row after a successful tick with durable storage", async () => {
    const dataDir = `memory://vendo-next-heartbeat-${Date.now()}`;
    const { POST } = createVendoHandler({
      vendoDir: emptyDir(),
      storage: { pglite: { dataDir } },
    });
    const res = await POST(req("/api/vendo/tick", { method: "POST" }));
    expect(res.status).toBe(200);

    // Heartbeat is fire-and-forget; poll the shared (memoized) handle.
    const handle = await createVendoDatabase({ pglite: { dataDir } });
    await vi.waitFor(async () => {
      const heartbeat = (await getMeta(handle, "scheduler_heartbeat")) as { at?: string } | undefined;
      expect(heartbeat?.at).toBeTruthy();
      expect(Number.isNaN(Date.parse(heartbeat!.at!))).toBe(false);
    });
  });

  it("GET /threads and /threads/<id> are principal-scoped (per-user isolation)", async () => {
    const dataDir = `memory://vendo-next-threads-${Date.now()}`;
    const { GET } = createVendoHandler({
      vendoDir: emptyDir(),
      storage: { pglite: { dataDir } },
      principal: async (r) => {
        const userId = r.headers.get("x-user");
        return userId ? { userId } : null;
      },
    });

    // Assembly (and its boot migration) is lazy — trigger it before seeding
    // directly against the same durable handle, or the seed write races the
    // migration that creates `vendo.threads`.
    await GET(req("/api/vendo/capabilities", { headers: { host: "localhost:3000", "x-user": "alice" } }));
    const handle = await createVendoDatabase({ pglite: { dataDir } });
    const threads = createDrizzleThreadStore(handle);
    const msg = (id: string, text: string): VendoUIMessage =>
      ({ id, role: "user", parts: [{ type: "text", text }] }) as VendoUIMessage;
    await threads.upsertMessages({ tenantId: "vendo-embedded", subject: "alice" }, "t-alice", [
      msg("m1", "hi from alice"),
    ]);
    await threads.upsertMessages({ tenantId: "vendo-embedded", subject: "bob" }, "t-bob", [
      msg("m2", "hi from bob"),
    ]);

    const aliceList = await GET(
      req("/api/vendo/threads", { headers: { host: "localhost:3000", "x-user": "alice" } }),
    );
    const aliceThreads = (await aliceList.json()) as Array<{ id: string }>;
    expect(aliceThreads.map((t) => t.id)).toEqual(["t-alice"]);

    const bobList = await GET(
      req("/api/vendo/threads", { headers: { host: "localhost:3000", "x-user": "bob" } }),
    );
    const bobThreads = (await bobList.json()) as Array<{ id: string }>;
    expect(bobThreads.map((t) => t.id)).toEqual(["t-bob"]);

    const aliceMessages = await GET(
      req("/api/vendo/threads/t-alice", { headers: { host: "localhost:3000", "x-user": "alice" } }),
    );
    expect(await aliceMessages.json()).toEqual([msg("m1", "hi from alice")]);

    // Isolation: bob reading alice's thread id sees nothing, not her data.
    const bobReadsAlice = await GET(
      req("/api/vendo/threads/t-alice", { headers: { host: "localhost:3000", "x-user": "bob" } }),
    );
    expect(await bobReadsAlice.json()).toEqual([]);

    // No principal (resolver returns null) → 403, never a bare list.
    const anon = await GET(req("/api/vendo/threads", { headers: { host: "localhost:3000" } }));
    expect(anon.status).toBe(403);
  });

  it("GET/POST /vendos are wired end-to-end (save, list, load, delete, 404, principal isolation)", async () => {
    const dataDir = `memory://vendo-next-vendos-handler-${Date.now()}`;
    const principalOf = (r: Request) => {
      const userId = r.headers.get("x-user");
      return userId ? { userId } : null;
    };
    const { GET, POST } = createVendoHandler({
      vendoDir: emptyDir(),
      storage: { pglite: { dataDir } },
      principal: async (r) => principalOf(r),
    });
    const withUser = (user: string) => ({ headers: { host: "localhost:3000", "x-user": user } });
    const node = { kind: "component", id: "n1", name: "Text", props: {} };

    const saved = await POST(
      req("/api/vendo/vendos", {
        method: "POST",
        body: JSON.stringify({ id: "f1", name: "first", node }),
        ...withUser("alice"),
      }),
    );
    expect(saved.status).toBe(200);
    const savedBody = (await saved.json()) as { id: string; createdAt: number; updatedAt: number };
    expect(savedBody.id).toBe("f1");
    expect(typeof savedBody.createdAt).toBe("number");
    expect(typeof savedBody.updatedAt).toBe("number");

    const aliceList = await GET(req("/api/vendo/vendos", withUser("alice")));
    expect((await aliceList.json()) as Array<{ id: string }>).toEqual([savedBody]);

    // Isolation: a different user sees nothing.
    const bobList = await GET(req("/api/vendo/vendos", withUser("bob")));
    expect(await bobList.json()).toEqual([]);

    const one = await GET(req("/api/vendo/vendos/f1", withUser("alice")));
    expect(await one.json()).toEqual(savedBody);

    const missing = await GET(req("/api/vendo/vendos/nope", withUser("alice")));
    expect(missing.status).toBe(404);

    const bobReadsAlice = await GET(req("/api/vendo/vendos/f1", withUser("bob")));
    expect(bobReadsAlice.status).toBe(404);

    const del = await POST(req("/api/vendo/vendos/f1/delete", { method: "POST", ...withUser("alice") }));
    expect(del.status).toBe(200);
    const gone = await GET(req("/api/vendo/vendos/f1", withUser("alice")));
    expect(gone.status).toBe(404);

    // No principal (resolver returns null) → 403, never a bare list.
    const anon = await GET(req("/api/vendo/vendos", { headers: { host: "localhost:3000" } }));
    expect(anon.status).toBe(403);
  });

  it("guards every mutating endpoint against remote requests by default", async () => {
    // A key so chat reaches the guard rather than short-circuiting on 503.
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-x");
    vi.stubEnv("COMPOSIO_API_KEY", "ck_x");
    vi.stubEnv("NODE_ENV", "production"); // fail-closed in prod even for spoofed Host
    // storage: false — NODE_ENV is stubbed away from "test", so the handler's
    // test-env safety net doesn't apply; this test doesn't care about
    // durability and must not touch disk.
    const { POST } = createVendoHandler({ vendoDir: emptyDir(), storage: false });
    for (const p of ["chat", "action", "tick", "events/ingest", "integrations", "vendos"]) {
      const res = await POST(
        new Request(`http://prod.example.com/api/vendo/${p}`, {
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
    const { POST } = createVendoHandler({
      vendoDir: emptyDir(),
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
      req("/api/vendo/chat", {
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
    const scope = { tenantId: "vendo-embedded", subject: "vendo-default-user" };
    await vi.waitFor(async () => {
      const records = await threads.list(scope);
      expect(records).toHaveLength(1);
      const stored = await threads.getMessages(scope, records[0]!.id);
      expect(stored.length).toBeGreaterThanOrEqual(2); // user turn + streamed assistant turn
    });

    const consentRes = await POST(
      req("/api/vendo/consent", {
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
    const { POST } = createVendoHandler({
      vendoDir: emptyDir(),
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
    const scope = { tenantId: "vendo-embedded", subject: "vendo-default-user" };
    const user = { id: "u1", role: "user", parts: [{ type: "text", text: "send it" }] };

    // Turn 1.
    await (
      await POST(req("/api/vendo/chat", { method: "POST", body: JSON.stringify({ id: "chat-c1", messages: [user] }) }))
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
        req("/api/vendo/chat", { method: "POST", body: JSON.stringify({ id: "chat-c1", messages: [user, assistant] }) }),
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
      req("/api/vendo/consent", {
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
    const { GET } = createVendoHandler({ vendoDir: emptyDir() });
    const res = await GET(req("/api/vendo/rules"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ rules: [] });
  });

  it("POST /rules/revoke 404s an unknown rule id", async () => {
    const { POST } = createVendoHandler({ vendoDir: emptyDir() });
    const res = await POST(
      req("/api/vendo/rules/revoke", { method: "POST", body: JSON.stringify({ id: "nope" }) }),
    );
    expect(res.status).toBe(404);
  });

  it("REGRESSION (deviation #6): /grants/revoke revokes the GRANT and /rules/revoke revokes the RULE — never cross-wired", async () => {
    const scope = { tenantId: "vendo-embedded", subject: "vendo-default-user" };
    const grants = createInMemoryGrantStore();
    const rules = createInMemoryCompiledRuleStore();
    const grant = await grants.create(scope, {
      tool: "send_email", descriptorHash: "h1", scope: { kind: "tool" }, duration: "standing",
      source: { kind: "chat" },
    });
    const rule = await rules.create(scope, {
      kind: "always_ask", toolPattern: "send_email", plainText: "sending any email",
    });
    const { GET, POST } = createVendoHandler({ vendoDir: emptyDir(), store: { grants, rules } });

    // Revoke the GRANT via /grants/revoke — the rule must survive.
    const grantRes = await POST(
      req("/api/vendo/grants/revoke", { method: "POST", body: JSON.stringify({ id: grant.id }) }),
    );
    expect(grantRes.status).toBe(200);
    expect(await grants.findForTool(scope, "send_email")).toHaveLength(0);
    expect((await rules.list(scope)).filter((r) => r.revokedAt === undefined)).toHaveLength(1);

    // Revoke the RULE via /rules/revoke — drops from GET /rules.
    const ruleRes = await POST(
      req("/api/vendo/rules/revoke", { method: "POST", body: JSON.stringify({ id: rule.id }) }),
    );
    expect(ruleRes.status).toBe(200);
    expect(await (await GET(req("/api/vendo/rules"))).json()).toEqual({ rules: [] });
  });

  it("REVIEW FOLLOW-UP: a POST ending in /revoke that is neither /rules/revoke nor /grants/revoke 404s (never falls through to a grant revoke)", async () => {
    const { POST } = createVendoHandler({ vendoDir: emptyDir() });
    const res = await POST(
      req("/api/vendo/nope/revoke", { method: "POST", body: JSON.stringify({ id: "whatever" }) }),
    );
    expect(res.status).toBe(404);
  });

  it("REVIEW FOLLOW-UP: /grants/revoke and /rules/revoke both still resolve correctly (guards the fix above didn't regress the happy paths)", async () => {
    const scope = { tenantId: "vendo-embedded", subject: "vendo-default-user" };
    const grants = createInMemoryGrantStore();
    const rules = createInMemoryCompiledRuleStore();
    const grant = await grants.create(scope, {
      tool: "send_email", descriptorHash: "h1", scope: { kind: "tool" }, duration: "standing",
      source: { kind: "chat" },
    });
    const rule = await rules.create(scope, {
      kind: "always_ask", toolPattern: "send_email", plainText: "sending any email",
    });
    const { POST } = createVendoHandler({ vendoDir: emptyDir(), store: { grants, rules } });
    const grantRes = await POST(
      req("/api/vendo/grants/revoke", { method: "POST", body: JSON.stringify({ id: grant.id }) }),
    );
    expect(grantRes.status).toBe(200);
    const ruleRes = await POST(
      req("/api/vendo/rules/revoke", { method: "POST", body: JSON.stringify({ id: rule.id }) }),
    );
    expect(ruleRes.status).toBe(200);
  });

  it("REVIEW FOLLOW-UP: a custom principal resolver (multi-user mount) withholds steering tools — stop_asking_about is absent", async () => {
    // stop_asking_about is critical tier (an invariants.test.ts pin), so its
    // absence from /critical-tools is a direct signal the whole
    // createSteeringTools() spread (which also registers always_ask_before,
    // act tier — not observable via THIS route) was skipped.
    const { GET } = createVendoHandler({
      vendoDir: emptyDir(),
      principal: async () => ({ userId: "custom-user" }),
    });
    const res = await GET(req("/api/vendo/critical-tools"));
    const body = (await res.json()) as { tools: { name: string }[] };
    const names = body.tools.map((t) => t.name);
    expect(names).not.toContain("stop_asking_about");
  });

  it("the default single-principal mount (no custom principal resolver) keeps steering tools", async () => {
    const { GET } = createVendoHandler({ vendoDir: emptyDir() });
    const res = await GET(req("/api/vendo/critical-tools"));
    const body = (await res.json()) as { tools: { name: string }[] };
    const names = body.tools.map((t) => t.name);
    expect(names).toContain("stop_asking_about");
  });

  describe("ask-once-remember wired end-to-end through assembly", () => {
    it("an approved-and-executed /action call is remembered durably, surviving an assembly rebuild over the same PGlite dir", async () => {
      const dataDir = `memory://vendo-next-remember-durable-${Date.now()}`;
      const opts = { vendoDir: emptyDir(), storage: { pglite: { dataDir } }, tools: writeTool };

      const first = createVendoHandler(opts);
      const gate = await first.POST(
        req("/api/vendo/action", {
          method: "POST",
          body: JSON.stringify({ action: "create_thing", payload: { amount: 5 } }),
        }),
      );
      const { approvalToken } = (await gate.json()) as { approvalToken: string };
      const executed = await first.POST(
        req("/api/vendo/action", {
          method: "POST",
          body: JSON.stringify({ action: "create_thing", payload: { amount: 5 }, approvalToken }),
        }),
      );
      expect(((await executed.json()) as { decision: string }).decision).toBe("approve");

      // Simulate a process restart: reset the handler's own boot slot (a
      // fresh module/process would have none), but reuse the SAME PGlite
      // dataDir — @vendoai/store memoizes the underlying handle by cacheKey,
      // so this is the durable-rebuild-equivalent without an actual restart.
      resetVendoBootRegistry();
      const second = createVendoHandler(opts);
      const remembered = await second.POST(
        req("/api/vendo/action", {
          method: "POST",
          body: JSON.stringify({ action: "create_thing", payload: { amount: 5 } }),
        }),
      );
      expect(await remembered.json()).toEqual({
        decision: "allow",
        result: { wrote: { amount: 5 } },
      });
    });

    it("keeps the same remember semantics in-memory when storage is off", async () => {
      const { POST } = createVendoHandler({ vendoDir: emptyDir(), storage: false, tools: writeTool });
      const gate = await POST(
        req("/api/vendo/action", {
          method: "POST",
          body: JSON.stringify({ action: "create_thing", payload: { amount: 5 } }),
        }),
      );
      const { approvalToken } = (await gate.json()) as { approvalToken: string };
      await POST(
        req("/api/vendo/action", {
          method: "POST",
          body: JSON.stringify({ action: "create_thing", payload: { amount: 5 }, approvalToken }),
        }),
      );
      const remembered = await POST(
        req("/api/vendo/action", {
          method: "POST",
          body: JSON.stringify({ action: "create_thing", payload: { amount: 5 } }),
        }),
      );
      expect(await remembered.json()).toEqual({
        decision: "allow",
        result: { wrote: { amount: 5 } },
      });
    });

    it("a remembered /action approval never auto-allows an automation step — the world's policy is UNWRAPPED and grants stay the sole unattended authorizer", async () => {
      const dataDir = `memory://vendo-next-remember-world-${Date.now()}`;
      // The world-registered twin of /action's create_thing: same name, same
      // input, same principal (everything is DEFAULT_PRINCIPAL single-tenant),
      // so the remember memo's canonicalKey ([userId, toolName, input,
      // version]) collides EXACTLY across the two surfaces.
      const registeredCreateThing: RegisteredTool = {
        descriptor: {
          name: "create_thing",
          source: "caller",
          annotations: {},
          hasExecute: true,
          kind: "function",
        },
        execute: async (input) => ({ ok: true, result: { wrote: input } }),
      };
      const opts = {
        vendoDir: emptyDir(),
        storage: { pglite: { dataDir } },
        tools: writeTool,
        automations: { tools: { create_thing: registeredCreateThing } },
      };
      const { POST } = createVendoHandler(opts);

      // Interactive surface: approve + execute once through /action.
      const gate = await POST(
        req("/api/vendo/action", {
          method: "POST",
          body: JSON.stringify({ action: "create_thing", payload: { amount: 7 } }),
        }),
      );
      const { approvalToken } = (await gate.json()) as { approvalToken: string };
      const executed = await POST(
        req("/api/vendo/action", {
          method: "POST",
          body: JSON.stringify({ action: "create_thing", payload: { amount: 7 }, approvalToken }),
        }),
      );
      expect(((await executed.json()) as { decision: string }).decision).toBe("approve");

      // The memo genuinely exists — so the pause asserted below can only come
      // from the world's policy being unwrapped, never from a missing memo.
      const handle = await createVendoDatabase({ pglite: { dataDir } });
      const decisionStore = createDrizzleDecisionStore(handle, WORLD_SCOPE);
      const key = canonicalKey(
        {
          toolName: "create_thing",
          input: { amount: 7 },
          descriptor: undefined as never,
          principal: { userId: "vendo-default-user" },
        },
        "v1",
      );
      expect(await decisionStore.get(key)).toBe("approve");

      // Unattended surface: an automation step calling the IDENTICAL
      // tool+input with NO grant. It must pause waiting_approval — a chat-time
      // human approval never green-lights an unattended run; grants are the
      // sole unattended authorization mechanism (interpreter runs its grant
      // machinery only on "approve", so a leaked "allow" would skip it).
      const state = await ensureVendoState(opts);
      const world = state.world!;
      const spec = automationSpecSchema.parse({
        dslVersion: 1,
        name: "Memo leak probe",
        description: "t",
        prompt: "t",
        trigger: { type: "host_event", event: "thing.requested" },
        execution: {
          mode: "steps",
          steps: [{ id: "s1", type: "tool", tool: "create_thing", input: { amount: 7 } }],
        },
      });
      const { automation } = await world.store.create(WORLD_SCOPE, { spec, grants: [] });
      const run = await world.runner.fire(WORLD_SCOPE, automation.id, {
        source: "host",
        eventId: "e1",
        subject: WORLD_SCOPE.subject,
        occurredAt: new Date().toISOString(),
        payload: {},
      });
      expect(run?.outcome).toBe("waiting_approval");
      expect(run?.pendingApproval).toMatchObject({ tool: "create_thing" });
    });
  });

  describe("durable connections — webhook routing survives a restart", () => {
    it("a connected toolkit and its connected-account mapping survive an assembly rebuild over the same PGlite dir", async () => {
      const dataDir = `memory://vendo-next-connections-durable-${Date.now()}`;
      const opts = { vendoDir: emptyDir(), storage: { pglite: { dataDir } } };

      // Simulate the integrations status-poll capture: the OAuth flow landed
      // and the poll branch calls setConnectedAccount(toolkit, accountId).
      const first = await ensureVendoState(opts);
      await first.connections.setConnectedAccount("gmail", "acct-durable-1");
      expect(await first.connections.connectedToolkits()).toContain("gmail");

      // Simulate a process restart: reset the boot slot but reuse the SAME
      // PGlite dataDir (the durable-rebuild-equivalent — see the /action
      // test above for the same pattern).
      resetVendoBootRegistry();
      const second = await ensureVendoState(opts);

      // (a) the connected toolkit is still connected...
      expect(await second.connections.connectedToolkits()).toContain("gmail");
      // (b) ...and webhook routing can still resolve the connected-account →
      // principal mapping a redelivered/live Composio webhook depends on.
      await expect(second.connections.findByConnectedAccount("acct-durable-1")).resolves.toEqual({
        toolkit: "gmail",
        principal: WORLD_SCOPE,
      });
    });

    it("keeps the same in-memory (non-durable) behavior when storage is off", async () => {
      const opts = { vendoDir: emptyDir(), storage: false as const };
      const state = await ensureVendoState(opts);
      await state.connections.setConnectedAccount("gmail", "acct-1");
      expect(await state.connections.connectedToolkits()).toContain("gmail");
      await expect(state.connections.findByConnectedAccount("acct-1")).resolves.toEqual({
        toolkit: "gmail",
        principal: WORLD_SCOPE,
      });
    });
  });
});

describe("bootKey — cross-module-graph boot-slot sharing", () => {
  // Regression: Next.js compiles instrumentation.ts and a route file into
  // SEPARATE module graphs, so a `vendoOptions` module shared between them
  // is evaluated TWICE — the object landing in ensureVendoState() and the
  // one landing in createVendoHandler() are `!==` even though every field
  // is identical. Before `bootKey`, that mismatch made createVendoHandler
  // fork a private world whose scheduler was never started.
  it("shares one assembled world between ensureVendoState and createVendoHandler when both pass the same bootKey on DIFFERENT option objects", async () => {
    const dir = emptyDir();
    const schedulerOpts = { vendoDir: dir, bootKey: "shared-key" };
    const routeOpts = { vendoDir: dir, bootKey: "shared-key", storage: false as const, tools: writeTool };
    expect(schedulerOpts).not.toBe(routeOpts);

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const schedulerState = await ensureVendoState(schedulerOpts);
    const { POST } = createVendoHandler(routeOpts);
    expect(warn).not.toHaveBeenCalled();

    const gate = await POST(
      req("/api/vendo/action", {
        method: "POST",
        body: JSON.stringify({ action: "create_thing", payload: { amount: 5 } }),
      }),
    );
    const { approvalToken } = (await gate.json()) as { approvalToken: string };

    // Proof the route landed on the SAME assembled state as the scheduler
    // side: the scheduler-side approvals store (a private in-memory Map)
    // recognizes the token the route just issued.
    expect(
      schedulerState.approvals.consume(
        approvalToken,
        "create_thing",
        JSON.stringify({ amount: 5 }),
        "vendo-default-user",
      ),
    ).toBe(true);
  });

  it("forks a private world (with a warning) when bootKeys differ and options aren't otherwise shared", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const first = createVendoHandler({ vendoDir: emptyDir(), bootKey: "world-a", storage: false });
    await first.GET(req("/api/vendo/capabilities"));

    const second = createVendoHandler({ vendoDir: emptyDir(), bootKey: "world-b", storage: false });
    await second.GET(req("/api/vendo/capabilities"));

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toMatch(/private world/i);
    expect(warn.mock.calls[0]?.[0]).toMatch(/bootKey/);
  });
});
