import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  VENDO_APP_FORMAT,
  VENDO_TREE_FORMAT,
  VendoError,
  type AppDocument,
  type Principal,
  type RunContext,
} from "@vendoai/core";
import { createStore, type VendoStore } from "@vendoai/store";
import type { LanguageModel } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createVendo, nextVendoHandler, type Vendo } from "./server.js";

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

async function setup(resolver = vi.fn(async () => principal)): Promise<{ vendo: Vendo; resolver: typeof resolver }> {
  const dataDir = await mkdtemp(join(tmpdir(), "vendo-wire-"));
  const store = createStore({ dataDir });
  cleanups.push(async () => { await store.close(); await rm(dataDir, { recursive: true, force: true }); });
  const vendo = createVendo({
    model: {} as LanguageModel,
    principal: resolver,
    store,
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
      mcp: false,
      blocks: { store: true, agent: true, actions: true, guard: true, apps: true, automations: true },
    });
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

  it("uses one session-scoped ephemeral principal when the resolver returns null", async () => {
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
});
