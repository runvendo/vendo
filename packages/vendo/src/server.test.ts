import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  VENDO_APP_FORMAT,
  VENDO_TREE_FORMAT,
  VendoError,
  type AppDocument,
  type ComponentCatalog,
  type Principal,
  type RunContext,
} from "@vendoai/core";
import { createStore, secretStore, storeSecrets, type VendoStore } from "@vendoai/store";
import { randomBytes } from "node:crypto";
import type { LanguageModel } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createVendo, nextVendoHandler, type CreateVendoConfig, type Vendo } from "./server.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const principal: Principal = { kind: "user", subject: "user_wire" };
const ctx: RunContext = {
  principal,
  venue: "app",
  presence: "present",
  sessionId: "session_wire",
};

const app = (id = "app_wire"): AppDocument => ({
  format: VENDO_APP_FORMAT,
  id,
  name: "Wire app",
  ui: "tree",
  tree: {
    formatVersion: VENDO_TREE_FORMAT,
    root: "root",
    nodes: [{ id: "root", component: "Text", props: { text: "ok" } }],
  },
});

async function setup(
  resolver = vi.fn(async () => principal),
  options: Pick<Partial<CreateVendoConfig>, "policy"> = {},
): Promise<{ vendo: Vendo; resolver: typeof resolver }> {
  const dataDir = await mkdtemp(join(tmpdir(), "vendo-wire-"));
  const store = createStore({ dataDir });
  cleanups.push(async () => { await store.close(); await rm(dataDir, { recursive: true, force: true }); });
  const vendo = createVendo({
    model: {} as LanguageModel,
    principal: resolver,
    store,
    ...options,
  });
  return { vendo, resolver };
}

function request(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Request {
  const isBinary = body instanceof Uint8Array;
  return new Request(`https://host.test/api/vendo${path}`, {
    method,
    headers: {
      ...(["POST", "PUT", "PATCH", "DELETE"].includes(method) && path !== "/apps/import"
        ? { "content-type": "application/json" }
        : {}),
      ...headers,
    },
    ...(body === undefined ? {} : {
      body: isBinary ? body as BodyInit : JSON.stringify(body),
    }),
  });
}

function stubRouteBlocks(vendo: Vendo): void {
  vi.spyOn(vendo.agent, "stream").mockResolvedValue(new Response("event: done\n\n", {
    headers: { "content-type": "text/event-stream" },
  }));
  vi.spyOn(vendo.agent.threads, "list").mockResolvedValue([]);
  vi.spyOn(vendo.agent.threads, "get").mockResolvedValue({
    id: "thr_x", subject: principal.subject, messages: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  });
  vi.spyOn(vendo.agent.threads, "delete").mockResolvedValue();
  vi.spyOn(vendo.guard.approvals, "pending").mockResolvedValue([]);
  vi.spyOn(vendo.guard.approvals, "decide").mockResolvedValue();
  vi.spyOn(vendo.guard.grants, "list").mockResolvedValue([]);
  vi.spyOn(vendo.guard.grants, "revoke").mockResolvedValue();
  vi.spyOn(vendo.guard.audit, "query").mockResolvedValue({ events: [] });
  vi.spyOn(vendo.apps, "list").mockResolvedValue([]);
  vi.spyOn(vendo.apps, "create").mockResolvedValue(app());
  vi.spyOn(vendo.apps, "get").mockResolvedValue(app());
  vi.spyOn(vendo.apps, "delete").mockResolvedValue();
  vi.spyOn(vendo.apps, "open").mockResolvedValue({ kind: "tree", payload: app().tree! });
  vi.spyOn(vendo.apps, "call").mockResolvedValue({ status: "ok", output: {} });
  vi.spyOn(vendo.apps, "edit").mockResolvedValue({
    app: app(), version: { at: new Date().toISOString(), intent: "edit", rung: 1 },
  });
  vi.spyOn(vendo.apps, "history").mockReturnValue({
    list: async () => [],
    undo: async () => app(),
  });
  vi.spyOn(vendo.apps, "exportApp").mockResolvedValue(new Uint8Array([1, 2, 3]));
  vi.spyOn(vendo.apps, "importApp").mockResolvedValue(app("app_imported"));
  vi.spyOn(vendo.apps, "fork").mockResolvedValue(app("app_forked"));
  vi.spyOn(vendo.automations, "list").mockResolvedValue([]);
  vi.spyOn(vendo.automations, "enable").mockResolvedValue({ enabled: true, missing: [] });
  vi.spyOn(vendo.automations, "disable").mockResolvedValue();
  vi.spyOn(vendo.automations, "dryRun").mockResolvedValue({ steps: [], grantsMissing: [] });
  vi.spyOn(vendo.automations.runs, "list").mockResolvedValue({ runs: [] });
  vi.spyOn(vendo.automations.runs, "get").mockResolvedValue({
    id: "run_x", appId: "app_wire", trigger: { kind: "schedule" }, status: "ok",
    startedAt: new Date().toISOString(), steps: [],
  });
  vi.spyOn(vendo.automations.runs, "stop").mockResolvedValue();
  vi.spyOn(vendo.automations, "tick").mockResolvedValue([]);
}

describe("09 §3 public wire", () => {
  it("routes every contracted method and path", async () => {
    vi.stubEnv("VENDO_TICK_SECRET", "tick-secret");
    const { vendo } = await setup();
    stubRouteBlocks(vendo);
    const routes: Request[] = [
      request("POST", "/threads", { message: { id: "m1", role: "user", parts: [] } }),
      request("GET", "/threads"),
      request("GET", "/threads/thr_x"),
      request("DELETE", "/threads/thr_x"),
      request("GET", "/approvals"),
      request("POST", "/approvals/decide", { ids: ["apr_x"], decision: { approve: true } }),
      request("GET", "/grants"),
      request("DELETE", "/grants/grt_x"),
      request("GET", "/apps"),
      request("POST", "/apps", { prompt: "build" }),
      request("GET", "/apps/app_wire"),
      request("DELETE", "/apps/app_wire"),
      request("GET", "/apps/app_wire/open"),
      request("POST", "/apps/app_wire/call", { ref: "host_x", args: {} }),
      request("POST", "/apps/app_wire/edit", { instruction: "edit" }),
      request("GET", "/apps/app_wire/history"),
      request("POST", "/apps/app_wire/history", { op: "undo" }),
      request("GET", "/apps/app_wire/export"),
      request("POST", "/apps/import", new Uint8Array([1, 2, 3]), { "content-type": "application/octet-stream" }),
      request("POST", "/apps/app_wire/fork", {}),
      request("GET", "/automations"),
      request("POST", "/automations/app_wire/enable", {}),
      request("POST", "/automations/app_wire/disable", {}),
      request("POST", "/automations/app_wire/dry-run", {}),
      request("GET", "/runs?status=ok"),
      request("GET", "/runs/run_x"),
      request("POST", "/runs/run_x/stop", {}),
      request("GET", "/activity?limit=10"),
      request("POST", "/tick", undefined, { authorization: "Bearer tick-secret" }),
      request("GET", "/status"),
    ];
    for (const route of routes) {
      const response = await vendo.handler(route);
      expect(response.status, `${route.method} ${route.url}: ${await response.clone().text()}`).toBeLessThan(400);
    }
  });

  it("maps every VendoError to the fixed envelope and status", async () => {
    const { vendo } = await setup();
    const cases = [
      ["validation", 400], ["not-found", 404], ["blocked", 403], ["conflict", 409],
      ["cloud-required", 402], ["sandbox-unavailable", 501], ["not-implemented", 501],
    ] as const;
    for (const [code, status] of cases) {
      vi.spyOn(vendo.apps, "get").mockRejectedValueOnce(new VendoError(code, `${code} message`));
      const response = await vendo.handler(request("GET", "/apps/app_wire"));
      expect(response.status).toBe(status);
      expect(await response.json()).toEqual({ error: { code, message: `${code} message` } });
    }
  });

  it("enforces JSON CSRF on mutations with only the three contracted exceptions", async () => {
    const { vendo, resolver } = await setup();
    stubRouteBlocks(vendo);
    for (const [method, path] of [["POST", "/threads"], ["POST", "/apps"], ["DELETE", "/apps/app_wire"]]) {
      const response = await vendo.handler(new Request(`https://host.test/api/vendo${path}`, { method, body: method === "POST" ? "{}" : undefined }));
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: { code: "validation", message: "content-type must be application/json" } });
    }
    expect(resolver).not.toHaveBeenCalled();

    expect((await vendo.handler(request("POST", "/apps/import", new Uint8Array([1]), { "content-type": "application/octet-stream" }))).status).toBe(200);

    // Import is CSRF-exempt for the JSON floor, so it must reject the CORS-safelisted
    // types that a cross-origin simple POST could send without a preflight.
    for (const ct of ["text/plain", "application/x-www-form-urlencoded", "multipart/form-data"]) {
      const rejected = await vendo.handler(request("POST", "/apps/import", new Uint8Array([1]), { "content-type": ct }));
      expect(rejected.status).toBe(400);
    }
  });

  it("routes webhook verification through automations and rejects without resolving a principal", async () => {
    const { vendo, resolver } = await setup();
    const response = await vendo.handler(new Request("https://host.test/api/vendo/webhooks/plain", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "{}",
    }));
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: { code: "blocked", message: "invalid webhook headers" } });
    expect(resolver).not.toHaveBeenCalled();
    const audit = await vendo.guard.audit.query({});
    expect(audit.events).toHaveLength(1);
    expect(audit.events[0]?.detail).toMatchObject({ status: "webhook-rejected" });
  });

  it("requires tick bearer auth and returns the doctor status shape", async () => {
    vi.stubEnv("VENDO_TICK_SECRET", "right");
    const { vendo, resolver } = await setup();
    const denied = await vendo.handler(request("POST", "/tick", undefined, { authorization: "Bearer wrong" }));
    expect(denied.status).toBe(401);
    expect(await denied.json()).toEqual({ error: { code: "blocked", message: "invalid tick credential" } });
    expect(resolver).not.toHaveBeenCalled();

    const status = await vendo.handler(request("GET", "/status"));
    expect(await status.json()).toEqual({
      posture: "unconfigured",
      version: "0.3.0",
      blocks: { store: true, agent: true, actions: true, guard: true, apps: true, automations: true, mcp: false },
    });
  });

  it("serves sync impact on dev servers and blocks it in production", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const { vendo } = await setup();

    const response = await vendo.handler(request("POST", "/sync/impact", { tools: ["host_get_widgets"] }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      impact: [{ tool: "host_get_widgets", apps: [], automations: [], grants: 0 }],
    });

    vi.stubEnv("NODE_ENV", "production");
    const blocked = await vendo.handler(request("POST", "/sync/impact", { tools: ["host_get_widgets"] }));
    expect(blocked.status).toBe(403);
    expect(await blocked.json()).toEqual({
      error: { code: "blocked", message: "sync impact is only available on a dev server" },
    });
  });

  it("validates sync impact tool arrays", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const { vendo } = await setup();

    const nonStrings = await vendo.handler(request("POST", "/sync/impact", { tools: ["host_ok", 7] }));
    expect(nonStrings.status).toBe(400);

    const tooMany = await vendo.handler(request("POST", "/sync/impact", {
      tools: Array.from({ length: 201 }, (_, index) => `host_${index}`),
    }));
    expect(tooMany.status).toBe(400);
  });

  it("adapts the same fetch handler to Next route exports", async () => {
    const { vendo } = await setup();
    const next = nextVendoHandler(vendo);
    for (const method of ["GET", "POST", "DELETE"] as const) expect(next[method]).toBeTypeOf("function");
    expect((await next.GET(request("GET", "/status"))).status).toBe(200);
  });
});

describe("09 §2 composition", () => {
  it("adds app capability tools and executes them only through the guard binding", async () => {
    const { vendo } = await setup();
    expect((await vendo.handler(request("GET", "/status"))).status).toBe(200);
    await vendo.store.records("vendo_apps").put({
      id: "app_wire",
      data: { subject: principal.subject, enabled: true, doc: app() },
      refs: { subject: principal.subject },
    });
    expect((await vendo.actions.descriptors()).map((descriptor) => descriptor.name))
      .toEqual(expect.arrayContaining(["vendo_apps_create", "vendo_apps_edit", "vendo_apps_open"]));

    const outcome = await vendo.apps.call("app_wire", "vendo_apps_open", { appId: "app_wire" }, ctx);
    expect(outcome).toMatchObject({ status: "ok", output: { kind: "tree" } });
    const events = await vendo.guard.audit.query({ principal });
    expect(events.events.some((event) => event.kind === "tool-call" && event.tool === "vendo_apps_open")).toBe(true);
  });

  it("projects rung-1 app risk consistently across chat and MCP venues", async () => {
    const { vendo } = await setup(vi.fn(async () => principal), {
      policy: {
        rules: [
          { match: { risk: "write" }, action: "ask" },
          { match: { risk: "read" }, action: "run" },
        ],
      },
    });
    expect((await vendo.handler(request("GET", "/status"))).status).toBe(200);
    await vendo.store.records("vendo_apps").put({
      id: "app_wire",
      data: { subject: principal.subject, enabled: true, doc: app() },
      refs: { subject: principal.subject },
    });
    await vendo.store.records("vendo_apps").put({
      id: "app_http",
      data: {
        subject: principal.subject,
        enabled: true,
        doc: { ...app("app_http"), ui: "http", server: "fake:snap_http" },
      },
      refs: { subject: principal.subject },
    });
    const byName = new Map((await vendo.actions.descriptors()).map((descriptor) => [descriptor.name, descriptor]));
    expect(byName.get("vendo_apps_create")?.risk).toBe("read");
    expect(byName.get("vendo_apps_edit")?.risk).toBe("write");
    const edit = byName.get("vendo_apps_edit")!;
    const chat = { ...ctx, venue: "chat" as const };
    const mcp = { ...ctx, venue: "mcp" as const };
    const treeCall = {
      id: "call_tree_chat",
      tool: edit.name,
      args: { appId: "app_wire", instruction: "Make the heading blue" },
    };

    await expect(vendo.guard.check(treeCall, edit, chat)).resolves.toMatchObject({ action: "run" });
    await expect(vendo.guard.check({ ...treeCall, id: "call_tree_mcp" }, edit, mcp))
      .resolves.toMatchObject({ action: "run" });
    await expect(vendo.guard.check({
      id: "call_server_chat",
      tool: edit.name,
      args: { appId: "app_wire", instruction: "Persist this to the database" },
    }, edit, chat)).resolves.toMatchObject({ action: "ask" });
    await expect(vendo.guard.check({
      id: "call_server_mcp",
      tool: edit.name,
      args: { appId: "app_wire", instruction: "Persist this to the database" },
    }, edit, mcp)).resolves.toMatchObject({ action: "ask" });
    await expect(vendo.guard.check({
      id: "call_http",
      tool: edit.name,
      args: { appId: "app_http", instruction: "Make the heading blue" },
    }, edit, chat)).resolves.toMatchObject({ action: "ask" });
  });

  it("uses per-client session-scoped ephemeral principals when the resolver returns null", async () => {
    const resolver = vi.fn(async () => null);
    const { vendo } = await setup(resolver);
    await vendo.handler(request("GET", "/status"));
    await vendo.handler(request("GET", "/status"));
    expect(resolver).toHaveBeenCalledTimes(2);
    const apps = await vendo.apps.list({
      principal: { kind: "user", subject: "not-the-anonymous-session" },
      venue: "app",
      presence: "present",
      sessionId: "x",
    });
    expect(apps).toEqual([]);
  });
});

// Extract Set-Cookie attributes and the anon cookie value from a response.
// Secure (https / TLS-terminated) requests carry the fixation-proof __Host-
// name; insecure localhost http keeps the plain name.
function setCookie(response: Response): string | null {
  return response.headers.get("set-cookie");
}
function anonCookieValue(response: Response): string | null {
  const header = setCookie(response);
  if (header === null) return null;
  const match = /(?:__Host-)?vendo_anon_session=([^;]+)/.exec(header);
  return match?.[1] ?? null;
}
// Replay a Set-Cookie as the request Cookie header (browser cookie jar). The
// request() helper builds https URLs, so the secure __Host- name applies.
function cookieHeaderFrom(response: Response): Record<string, string> {
  const value = anonCookieValue(response);
  if (value === null) throw new Error("response carried no anon Set-Cookie");
  return { cookie: `__Host-vendo_anon_session=${value}` };
}

describe("00 overview / 01-core §2 — per-client anonymous sessions", () => {
  it("mints a distinct ephemeral principal + Set-Cookie for each cookieless client", async () => {
    const seen: string[] = [];
    const resolver = vi.fn(async () => null);
    const { vendo } = await setup(resolver);
    vi.spyOn(vendo.apps, "list").mockImplementation(async (ctx) => {
      seen.push(ctx.principal.subject);
      return [];
    });

    const first = await vendo.handler(request("GET", "/apps"));
    const second = await vendo.handler(request("GET", "/apps"));

    // Two cookieless clients → two different anonymous subjects.
    expect(seen).toHaveLength(2);
    expect(seen[0]).toMatch(/^anonymous_[0-9a-f]{32}$/);
    expect(seen[1]).toMatch(/^anonymous_[0-9a-f]{32}$/);
    expect(seen[0]).not.toBe(seen[1]);

    // Each response carries a hardened Set-Cookie — https requests get the
    // fixation-proof __Host- form (Secure + Path=/, no Domain).
    for (const response of [first, second]) {
      const header = setCookie(response);
      expect(header).toContain("__Host-vendo_anon_session=");
      expect(header).toContain("HttpOnly");
      expect(header).toContain("SameSite=Lax");
      expect(header).toContain("Path=/;");
      expect(header).toContain("Secure");
      expect(header).not.toContain("Domain");
    }
    // Distinct cookies for distinct clients.
    expect(anonCookieValue(first)).not.toBe(anonCookieValue(second));
  });

  it("reuses the subject and mints no new cookie when a valid cookie is replayed", async () => {
    const seen: string[] = [];
    const resolver = vi.fn(async () => null);
    const { vendo } = await setup(resolver);
    vi.spyOn(vendo.apps, "list").mockImplementation(async (ctx) => {
      seen.push(ctx.principal.subject);
      return [];
    });

    const minted = await vendo.handler(request("GET", "/apps"));
    const replayed = await vendo.handler(request("GET", "/apps", undefined, cookieHeaderFrom(minted)));

    expect(seen[0]).toBe(seen[1]);            // same subject across the round-trip
    expect(setCookie(replayed)).toBeNull();    // no new cookie on a valid replay
  });

  it("mints a fresh session when the cookie signature is tampered or garbage", async () => {
    const seen: string[] = [];
    const resolver = vi.fn(async () => null);
    const { vendo } = await setup(resolver);
    vi.spyOn(vendo.apps, "list").mockImplementation(async (ctx) => {
      seen.push(ctx.principal.subject);
      return [];
    });

    const minted = await vendo.handler(request("GET", "/apps"));
    const value = anonCookieValue(minted)!;
    const id = value.split(".")[0];

    for (const bad of [`${id}.deadbeef`, "not-a-valid-cookie", `${id}.`]) {
      const response = await vendo.handler(request("GET", "/apps", undefined, { cookie: `__Host-vendo_anon_session=${bad}` }));
      expect(setCookie(response)).toContain("__Host-vendo_anon_session="); // fresh mint
    }
    // Every tampered request got its own fresh subject, none equal to the original.
    const original = seen[0];
    for (const subject of seen.slice(1)) expect(subject).not.toBe(original);
  });

  it("uses Secure __Host- over https and the plain wire-scoped name over http", async () => {
    const resolver = vi.fn(async () => null);
    const { vendo } = await setup(resolver);
    vi.spyOn(vendo.apps, "list").mockResolvedValue([]);

    const https = await vendo.handler(request("GET", "/apps")); // request() builds https URLs
    expect(setCookie(https)).toContain("__Host-vendo_anon_session=");
    expect(setCookie(https)).toContain("Secure");
    expect(setCookie(https)).toContain("Path=/;");

    const httpReq = new Request("http://host.test/api/vendo/apps", { method: "GET" });
    const http = await vendo.handler(httpReq);
    expect(setCookie(http)).toContain("vendo_anon_session=");
    expect(setCookie(http)).not.toContain("__Host-");
    expect(setCookie(http)).not.toContain("Secure");
    expect(setCookie(http)).toContain("Path=/api/vendo");
  });

  it("ignores a valid cookie presented under the wrong name for the protocol", async () => {
    const seen: string[] = [];
    const resolver = vi.fn(async () => null);
    const { vendo } = await setup(resolver);
    vi.spyOn(vendo.apps, "list").mockImplementation(async (ctx) => {
      seen.push(ctx.principal.subject);
      return [];
    });

    // Mint over https (__Host- name), replay the VALID value under the PLAIN
    // name on another https request → lookup misses, fresh session minted.
    const minted = await vendo.handler(request("GET", "/apps"));
    const value = anonCookieValue(minted)!;
    const wrongName = await vendo.handler(request("GET", "/apps", undefined, {
      cookie: `vendo_anon_session=${value}`,
    }));
    expect(setCookie(wrongName)).toContain("__Host-vendo_anon_session="); // fresh mint
    expect(seen[1]).not.toBe(seen[0]);
  });

  it("treats requests as secure when the trusted VENDO_BASE_URL is https (TLS-terminating proxy)", async () => {
    // Behind a TLS terminator the request reaches this process as http; the
    // operator-set VENDO_BASE_URL (trusted origin channel, never x-forwarded-*)
    // being https must still yield the Secure __Host- cookie.
    vi.stubEnv("VENDO_BASE_URL", "https://app.example.com");
    const resolver = vi.fn(async () => null);
    const { vendo } = await setup(resolver);
    vi.spyOn(vendo.apps, "list").mockResolvedValue([]);

    const httpReq = new Request("http://host.test/api/vendo/apps", { method: "GET" });
    const response = await vendo.handler(httpReq);
    expect(setCookie(response)).toContain("__Host-vendo_anon_session=");
    expect(setCookie(response)).toContain("Secure");
    expect(setCookie(response)).toContain("Path=/;");
  });

  it("mints no anonymous cookie when the host resolver returns a principal", async () => {
    const { vendo } = await setup(); // resolver returns a real principal
    vi.spyOn(vendo.apps, "list").mockResolvedValue([]);
    const response = await vendo.handler(request("GET", "/apps"));
    expect(setCookie(response)).toBeNull();
  });

  it("REGRESSION: two independent anonymous clients never share a subject, and each request mints exactly one id", async () => {
    // Guards the per-process bug (#130): one anonymous principal reused across
    // the whole composition leaked threads/grants/apps between visitors.
    const seen: string[] = [];
    const resolver = vi.fn(async () => null);
    const { vendo } = await setup(resolver);
    vi.spyOn(vendo.apps, "list").mockImplementation(async (ctx) => {
      seen.push(ctx.principal.subject);
      return [];
    });
    const responses: Response[] = [];
    for (let i = 0; i < 5; i++) responses.push(await vendo.handler(request("GET", "/apps")));
    expect(new Set(seen).size).toBe(5);

    // At-most-one-mint invariant: each response carries exactly ONE
    // vendo_anon_session Set-Cookie, and its id is the SAME id embedded in the
    // subject the route observed. A double mint within one request (context()
    // resolved twice → second id overwrites the first's Set-Cookie) would make
    // the cookie id diverge from the observed subject and fail this pin.
    responses.forEach((response, i) => {
      const header = setCookie(response) ?? "";
      expect(header.match(/vendo_anon_session=/g)).toHaveLength(1);
      const cookieId = anonCookieValue(response)!.split(".")[0];
      expect(seen[i]).toBe(`anonymous_${cookieId}`);
    });
  });
});

describe("09 §3 conversational turn against the real composed store", () => {
  it("streams a turn, persists the thread through the routed vendo_threads table, and reads it back", async () => {
    const { MockLanguageModelV3, simulateReadableStream } = await import("ai/test");
    const dataDir = await mkdtemp(join(tmpdir(), "vendo-turn-"));
    const store = createStore({ dataDir });
    cleanups.push(async () => { await store.close(); await rm(dataDir, { recursive: true, force: true }); });
    const model = new MockLanguageModelV3({
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: [
            { type: "text-start", id: "t1" },
            { type: "text-delta", id: "t1", delta: "All done." },
            { type: "text-end", id: "t1" },
            {
              type: "finish",
              usage: {
                inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
                outputTokens: { total: 0, text: 0, reasoning: 0 },
              },
              finishReason: { unified: "stop", raw: undefined },
            },
          ],
        }),
      }),
    });
    const vendo = createVendo({
      model: model as unknown as LanguageModel,
      principal: async () => principal,
      store,
    });

    const turn = await vendo.handler(request("POST", "/threads", {
      threadId: "thr_round_trip",
      message: { id: "m1", role: "user", parts: [{ type: "text", text: "Say done." }] },
    }));
    expect(turn.status).toBe(200);
    const raw = await turn.text();
    expect(raw).toContain("All done.");
    expect(raw.trimEnd().endsWith("data: [DONE]")).toBe(true);

    // The read-back is the regression: the routed table stores {subject, messages}
    // with id + timestamps on the record envelope; the agent must reconstruct
    // the thread from the envelope (this 404ed when it expected its own full
    // shape inside data).
    const fetched = await vendo.handler(request("GET", "/threads/thr_round_trip"));
    expect(fetched.status).toBe(200);
    const thread = await fetched.json() as { id: string; subject: string; messages: Array<{ role: string }> };
    expect(thread.id).toBe("thr_round_trip");
    expect(thread.subject).toBe(principal.subject);
    expect(thread.messages.map((message) => message.role)).toEqual(["user", "assistant"]);

    const listed = await vendo.handler(request("GET", "/threads"));
    const summaries = await listed.json() as Array<{ id: string; title: string }>;
    expect(summaries).toEqual([expect.objectContaining({ id: "thr_round_trip", title: "Say done." })]);

    const rows = await store.records("vendo_threads").list({ refs: { subject: principal.subject } });
    expect(rows.records).toHaveLength(1);
    expect(rows.records[0]?.id).toBe("thr_round_trip");
  });

  it("carries reconciled partial create views through the real HTTP SSE handler before open completes", async () => {
    const { MockLanguageModelV3, simulateReadableStream } = await import("ai/test");
    const usage = {
      inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 0, text: 0, reasoning: 0 },
    } as const;
    let agentCalls = 0;
    const model = new MockLanguageModelV3({
      doStream: async ({ prompt }) => {
        const serialized = JSON.stringify(prompt);
        if (serialized.includes("TASK: CREATE_APP")) {
          return {
            stream: simulateReadableStream({ chunks: [
              { type: "text-start", id: "generation" },
              {
                type: "text-delta",
                id: "generation",
                delta: '{"name":"SSE app","tree":{"formatVersion":"vendo-genui/v1","root":"root","nodes":[{"id":"root","component":"Stack","source":"prewired","children":["detail"]},',
              },
              {
                type: "text-delta",
                id: "generation",
                delta: '{"id":"detail","component":"Text","source":"prewired","props":{"text":"Ready"}}]}}',
              },
              { type: "text-end", id: "generation" },
              { type: "finish", usage, finishReason: { unified: "stop", raw: undefined } },
            ] }),
          };
        }

        agentCalls += 1;
        if (agentCalls === 1) {
          return {
            stream: simulateReadableStream({ chunks: [
              { type: "tool-call", toolCallId: "call_create_sse", toolName: "vendo_apps_create", input: JSON.stringify({ prompt: "Build an SSE app" }) },
              { type: "finish", usage, finishReason: { unified: "tool-calls", raw: undefined } },
            ] }),
          };
        }
        if (agentCalls === 2) {
          const appId = serialized.match(/app_[0-9a-f-]{36}/u)?.[0];
          if (appId === undefined) throw new Error("created app id missing from tool result");
          return {
            stream: simulateReadableStream({ chunks: [
              { type: "tool-call", toolCallId: "call_open_sse", toolName: "vendo_apps_open", input: JSON.stringify({ appId }) },
              { type: "finish", usage, finishReason: { unified: "tool-calls", raw: undefined } },
            ] }),
          };
        }
        return {
          stream: simulateReadableStream({ chunks: [
            { type: "text-start", id: "done" },
            { type: "text-delta", id: "done", delta: "Opened." },
            { type: "text-end", id: "done" },
            { type: "finish", usage, finishReason: { unified: "stop", raw: undefined } },
          ] }),
        };
      },
    });
    const dataDir = await mkdtemp(join(tmpdir(), "vendo-stream-turn-"));
    const store = createStore({ dataDir });
    cleanups.push(async () => { await store.close(); await rm(dataDir, { recursive: true, force: true }); });
    const vendo = createVendo({
      model: model as unknown as LanguageModel,
      principal: async () => principal,
      store,
      policy: { rules: [{ match: { tool: "vendo_apps_*", presence: "present" }, action: "run" }] },
    });

    const response = await vendo.handler(request("POST", "/threads", {
      threadId: "thr_stream_round_trip",
      message: { id: "m_stream", role: "user", parts: [{ type: "text", text: "Build it" }] },
    }));
    const raw = await response.text();
    const chunks = raw.split("\n")
      .filter((line) => line.startsWith("data: {") && line !== "data: [DONE]")
      .map((line) => JSON.parse(line.slice(6)) as Record<string, unknown>);
    const views = chunks.filter((chunk) => chunk.type === "data-vendo-view") as Array<{
      id: string;
      data: { appId: string; payload: { nodes: unknown[]; streaming?: boolean } };
    }>;

    expect(response.status).toBe(200);
    expect(views.length).toBeGreaterThanOrEqual(3);
    expect(views[0]?.data.payload).toMatchObject({ streaming: true, nodes: [{ id: "root" }] });
    expect(new Set(views.map((view) => view.id))).toEqual(new Set([`vendo-view:${views[0]?.data.appId}`]));
    expect(views.at(-1)?.data.payload.nodes).toHaveLength(2);
    expect(views.at(-1)?.data.payload.streaming).toBeUndefined();
  });
});

describe("09 §2 apps composition", () => {
  it("passes host-component catalog registrations to createApps", { timeout: 120_000 }, async () => {
    const { MockLanguageModelV3, simulateReadableStream } = await import("ai/test");
    const dataDir = await mkdtemp(join(tmpdir(), "vendo-catalog-"));
    const store = createStore({ dataDir });
    cleanups.push(async () => { await store.close(); await rm(dataDir, { recursive: true, force: true }); });
    const generated = JSON.stringify({
      name: "Catalog app",
      tree: {
        formatVersion: VENDO_TREE_FORMAT,
        root: "metric",
        nodes: [{
          id: "metric",
          component: "MetricCard",
          source: "host",
          props: { label: "Revenue" },
        }],
      },
    });
    const model = new MockLanguageModelV3({
      doStream: async () => ({
        stream: simulateReadableStream({ chunks: [
          { type: "text-start", id: "generation" },
          { type: "text-delta", id: "generation", delta: generated },
          { type: "text-end", id: "generation" },
          {
            type: "finish",
            usage: {
              inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
              outputTokens: { total: 0, text: 0, reasoning: 0 },
            },
            finishReason: { unified: "stop", raw: undefined },
          },
        ] }),
      }),
    });
    const catalog: ComponentCatalog = [{
      name: "MetricCard",
      description: "Use for a single headline metric.",
      propsSchema: { "~standard": { validate: (value: unknown) => ({ value }) } },
    }];
    const vendo = createVendo({
      model,
      principal: async () => principal,
      store,
      catalog,
    });
    await store.ensureSchema();

    await expect(vendo.apps.create({ prompt: "Show revenue" }, ctx)).resolves.toMatchObject({
      tree: { nodes: [{ component: "MetricCard", source: "host" }] },
    });
  });
});

describe("10-mcp §5 — door claims only its four exact well-known paths (FIX H)", () => {
  async function mcpVendo(): Promise<Vendo> {
    const dataDir = await mkdtemp(join(tmpdir(), "vendo-door-"));
    const store = createStore({ dataDir });
    cleanups.push(async () => { await store.close(); await rm(dataDir, { recursive: true, force: true }); });
    const vendo = createVendo({
      model: {} as LanguageModel,
      principal: async () => null,
      store,
      mcp: true,
      oauth: {
        async authorize() { return { subject: "user_door" }; },
        async principal(subject) { return { kind: "user", subject }; },
      },
    });
    // createVendo kicks off ensureSchema() without blocking; a test whose
    // requests all 404 before `await ready` would otherwise close the store
    // mid-schema-creation (the known PGlite close-race hang).
    await store.ensureSchema();
    return vendo;
  }
  const root = (path: string): Request => new Request(`https://host.test${path}`);

  it("serves protected-resource metadata at the door's exact path-inserted URL", async () => {
    const vendo = await mcpVendo();
    const res = await vendo.handler(root("/.well-known/oauth-protected-resource/api/vendo/mcp"));
    expect(res.status).toBe(200);
    expect((await res.json() as { resource?: string }).resource).toBe("https://host.test/api/vendo/mcp");
  });

  it("does NOT route boundary-adjacent or foreign well-known paths to the door", async () => {
    const vendo = await mcpVendo();
    // A boundary-free prefix would have matched all of these; the exact-path set
    // does not, so they fall through to the wire and get no door metadata.
    for (const path of [
      "/.well-known/oauth-protected-resourceX",
      "/.well-known/oauth-protected-resource/other",
      "/.well-known/oauth-authorization-server/other",
      "/.well-known/openid-configuration",
    ]) {
      const res = await vendo.handler(root(path));
      const body = await res.json() as { resource?: unknown; issuer?: unknown; error?: unknown };
      expect(res.status, path).toBe(404);
      expect(body.resource, path).toBeUndefined();
      expect(body.issuer, path).toBeUndefined();
    }
  });
});

describe("02-store §4 default-on encryption composition", () => {
  it("createVendo reads VENDO_STORE_ENCRYPTION_KEY from the environment when no store is passed", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vendo-default-store-"));
    const prior = process.cwd();
    vi.stubEnv("VENDO_STORE_ENCRYPTION_KEY", randomBytes(32).toString("base64"));
    process.chdir(dir);
    try {
      // No `store` in the config: the composed default store must come up with
      // encryption on, so stored secrets work with zero extra wiring.
      const vendo = createVendo({ model: {} as LanguageModel, principal: async () => principal });
      cleanups.push(async () => {
        await vendo.store.close();
        await rm(dir, { recursive: true, force: true });
      });
      await vendo.store.ensureSchema();
      await secretStore(vendo.store).set("API_TOKEN", "secret-value");
      expect(await storeSecrets(vendo.store).get("API_TOKEN")).toBe("secret-value");
    } finally {
      process.chdir(prior);
    }
  });

  it("an explicitly configured store always wins over the environment key", async () => {
    vi.stubEnv("VENDO_STORE_ENCRYPTION_KEY", randomBytes(32).toString("base64"));
    // setup() passes an explicit store created WITHOUT encryption — createVendo
    // must not silently rewrap it, so stored secrets stay unavailable.
    const { vendo } = await setup();
    // Let createVendo's eager schema init finish before teardown closes the
    // store (closing PGlite mid-initialization wedges the driver).
    await vendo.store.ensureSchema();
    await expect(secretStore(vendo.store).set("API_TOKEN", "value"))
      .rejects.toMatchObject({ code: "not-implemented" });
  });
});
