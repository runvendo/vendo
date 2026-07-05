import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createVendoFetchHandler, resetVendoBootRegistry } from "./fetch-handler.js";

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
    expect(await fixed.json()).toEqual({ chat: true, integrations: false, voice: false, mcp: false, storage: false });
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
