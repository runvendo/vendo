import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { capturedPinBaselineSchema } from "@vendoai/actions";
import {
  VENDO_APP_FORMAT,
  VENDO_TREE_FORMAT_V2,
  VendoError,
  type AppDocument,
  type ComponentCatalog,
  type ComponentRegistry,
  type Principal,
  type RunContext,
} from "@vendoai/core";
import type { SandboxAdapter } from "@vendoai/apps";
import type { Connector } from "@vendoai/actions";
import type { ConnectionsService } from "./connections.js";
import { createStore, secretStore, storeSecrets, type VendoStore } from "@vendoai/store";
import { createHmac, randomBytes } from "node:crypto";
import type { LanguageModel } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { authJs, createVendo, nextVendoHandler, wellKnownVendoHandler, type CreateVendoConfig, type Vendo } from "./server.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** Temp-dir PGlite store with registered teardown. Teardown awaits schema
 * readiness first: createVendo fires ensureSchema() without awaiting it, and
 * closing PGlite mid-query hangs the process (bites tests that compose and
 * assert without ever touching the wire). */
async function tempStore(prefix: string): Promise<VendoStore> {
  const dataDir = await mkdtemp(join(tmpdir(), prefix));
  const store = createStore({ dataDir });
  cleanups.push(async () => {
    await store.ensureSchema().catch(() => undefined);
    await store.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  return store;
}

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
    formatVersion: VENDO_TREE_FORMAT_V2,
    root: "root",
    nodes: [{ id: "root", component: "Text", props: { text: "ok" } }],
  },
});

async function setup(
  resolver = vi.fn(async () => principal),
  options: Pick<Partial<CreateVendoConfig>, "policy" | "development"> = {},
): Promise<{ vendo: Vendo; resolver: typeof resolver }> {
  const store = await tempStore("vendo-wire-");
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

  it("wires client disconnect to the agent turn: POST /threads hands the request signal to agent.stream (AGENT-3)", async () => {
    const { vendo } = await setup();
    stubRouteBlocks(vendo);
    const controller = new AbortController();
    const disconnectable = new Request("https://host.test/api/vendo/threads", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: { id: "m_abort", role: "user", parts: [] } }),
      signal: controller.signal,
    });
    await vendo.handler(disconnectable);
    const streamInput = vi.mocked(vendo.agent.stream).mock.calls[0]?.[0];
    expect(streamInput?.signal).toBeInstanceOf(AbortSignal);
    expect(streamInput?.signal?.aborted).toBe(false);
    // The handed signal is live-wired to the request: a client disconnect
    // (request abort) after the handler returned still cancels the loop.
    controller.abort();
    expect(streamInput?.signal?.aborted).toBe(true);
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

  it("does not read history for an unowned app on GET or undo", async () => {
    const { vendo } = await setup();
    stubRouteBlocks(vendo);
    vi.mocked(vendo.apps.get).mockResolvedValue(null);
    const history = vi.mocked(vendo.apps.history);

    for (const [method, body] of [
      ["GET", undefined],
      ["POST", { op: "undo" }],
    ] as const) {
      const response = await vendo.handler(request(method, "/apps/app_other/history", body));
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({
        error: { code: "not-found", message: "app not found: app_other" },
      });
    }
    expect(history).not.toHaveBeenCalled();
  });

  it("enforces history() ownership at the wire: cross-principal reads and undo are denied for real", async () => {
    // 06-apps: history(appId) is ownership-blind by frozen signature; THIS route
    // is the enforcement boundary. No mocks — a real store row, a real history
    // entry, and the real apps runtime behind the handler.
    let current: Principal = { kind: "user", subject: "user_owner" };
    const { vendo } = await setup(vi.fn(async () => current));
    expect((await vendo.handler(request("GET", "/status"))).status).toBe(200); // migrate the store
    const doc = app("app_hist");
    await vendo.store.records("vendo_apps").put({
      id: "app_hist",
      data: { subject: "user_owner", enabled: false, doc },
      refs: { subject: "user_owner" },
    });
    const previous = { ...doc, name: "Wire app v1" };
    await vendo.store.records("vendo:app-history:app_hist").put({
      id: "ver_wire_1",
      data: { doc: previous, entry: { at: new Date().toISOString(), intent: "rename", rung: 1 }, seq: 1 },
    });

    // The owner sees exactly the recorded entry.
    const ownerList = await vendo.handler(request("GET", "/apps/app_hist/history"));
    expect(ownerList.status).toBe(200);
    expect(await ownerList.json()).toEqual([expect.objectContaining({ intent: "rename", rung: 1 })]);

    // Another authenticated principal is told the app does not exist…
    current = { kind: "user", subject: "user_mallory" };
    for (const [method, body] of [["GET", undefined], ["POST", { op: "undo" }]] as const) {
      const denied = await vendo.handler(request(method, "/apps/app_hist/history", body));
      expect(denied.status).toBe(404);
      expect(await denied.json()).toEqual({
        error: { code: "not-found", message: "app not found: app_hist" },
      });
    }

    // …and the denied undo mutated NOTHING: the app row and history survive.
    current = { kind: "user", subject: "user_owner" };
    const row = await vendo.store.records("vendo_apps").get("app_hist");
    expect((row?.data as { doc: AppDocument }).doc).toEqual(doc);
    const listAfter = await vendo.handler(request("GET", "/apps/app_hist/history"));
    expect(await listAfter.json()).toHaveLength(1);

    // The owner's undo works, proving the 404s above were ownership, not routing.
    const undone = await vendo.handler(request("POST", "/apps/app_hist/history", { op: "undo" }));
    expect(undone.status).toBe(200);
    expect(await undone.json()).toMatchObject({ id: "app_hist", name: "Wire app v1" });
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
    vi.stubEnv("E2B_API_KEY", "");
    vi.stubEnv("MODAL_TOKEN_ID", "");
    vi.stubEnv("MODAL_TOKEN_SECRET", "");
    const { vendo, resolver } = await setup();
    const denied = await vendo.handler(request("POST", "/tick", undefined, { authorization: "Bearer wrong" }));
    expect(denied.status).toBe(401);
    expect(await denied.json()).toEqual({ error: { code: "blocked", message: "invalid tick credential" } });
    expect(resolver).not.toHaveBeenCalled();

    const status = await vendo.handler(request("GET", "/status"));
    expect(await status.json()).toEqual({
      posture: "unconfigured",
      version: "0.3.0",
      blocks: {
        store: true,
        agent: true,
        actions: true,
        guard: true,
        apps: true,
        automations: true,
        sandbox: false,
        // setup() passes an explicit model — the BYO rung of the inference seam.
        model: "custom",
        mcp: false,
        // 04-actions §3 — no BYO connector and no VENDO_API_KEY → no broker.
        connections: false,
      },
    });
  });

  it("selects explicit, E2B, Cloud, and dark venues with the required precedence", async () => {
    const custom: SandboxAdapter = {
      create: vi.fn(async () => { throw new Error("not called"); }),
      resume: vi.fn(async () => { throw new Error("not called"); }),
    };
    const store = await tempStore("vendo-wire-custom-");
    const statusFor = async (
      env: { E2B_API_KEY: string; VENDO_API_KEY: string },
      sandbox?: SandboxAdapter,
    ): Promise<unknown> => {
      for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
      const vendo = createVendo({
        model: {} as LanguageModel,
        principal: vi.fn(async () => principal),
        store,
        ...(sandbox === undefined ? {} : { sandbox }),
      });
      const status = await vendo.handler(request("GET", "/status"));
      return (await status.json() as { blocks: { sandbox: unknown } }).blocks.sandbox;
    };

    // Adapter rule (2026-07-17 cloud definition): the explicit adapter always
    // wins; BYO sandbox env beats the Vendo key (the Cloud default fills ONLY
    // the slot the host left unfilled); no key and no BYO env → dark.
    const allKeys = {
      E2B_API_KEY: "e2b-key",
      VENDO_API_KEY: "vnd_cloud_key",
    };
    expect(await statusFor(allKeys, custom)).toBe("custom");
    expect(await statusFor(allKeys)).toBe("e2b");
    expect(await statusFor({ ...allKeys, E2B_API_KEY: "" })).toBe("cloud");
    expect(await statusFor({ ...allKeys, E2B_API_KEY: "", VENDO_API_KEY: "" })).toBe(false);
    expect(custom.create).not.toHaveBeenCalled();
    expect(custom.resume).not.toHaveBeenCalled();
  });

  it("the VENDO_API_KEY sandbox default is a live Cloud adapter: fork reaches the console over HTTP", async () => {
    // Beyond the venue string above: prove the composed seam holds a REAL
    // console-bound adapter by driving apps.fork on a server app, whose
    // resume → snapshot → stop runs through config.sandbox only.
    vi.stubEnv("E2B_API_KEY", "");
    vi.stubEnv("MODAL_TOKEN_ID", "");
    vi.stubEnv("MODAL_TOKEN_SECRET", "");
    vi.stubEnv("VENDO_API_KEY", "vnd_cloud_key");
    vi.stubEnv("VENDO_CLOUD_URL", "https://cloud-rung.test");
    const machineId = `m_${"a".repeat(24)}`;
    const consoleCalls: Array<{ url: string; method: string; authorization: string | null }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const sent = new Request(input, init);
      consoleCalls.push({
        url: sent.url,
        method: sent.method,
        authorization: sent.headers.get("authorization"),
      });
      const url = new URL(sent.url);
      if (url.pathname === "/api/v1/sandboxes/resume") {
        return Response.json({ id: machineId, url: `https://${machineId}.m.vendo.run` });
      }
      if (url.pathname.endsWith("/snapshot")) {
        return Response.json({ ref: `vendo:snap_${"b".repeat(40)}` });
      }
      return Response.json({ ok: true });
    }));

    const { vendo } = await setup();
    expect((await vendo.handler(request("GET", "/status"))).status).toBe(200);
    await vendo.store.records("vendo_apps").put({
      id: "app_cloud",
      data: {
        subject: principal.subject,
        enabled: true,
        doc: { ...app("app_cloud"), ui: "http", server: `vendo:snap_${"c".repeat(40)}` },
      },
      refs: { subject: principal.subject },
    });

    const fork = await vendo.apps.fork("app_cloud", ctx);
    expect(fork.server).toBe(`vendo:snap_${"b".repeat(40)}`);
    expect(consoleCalls[0]).toEqual({
      url: "https://cloud-rung.test/api/v1/sandboxes/resume",
      method: "POST",
      authorization: "Bearer vnd_cloud_key",
    });
    expect(consoleCalls.map((call) => call.method === "DELETE"
      ? "DELETE"
      : new URL(call.url).pathname.split("/").at(-1))).toEqual(["resume", "snapshot", "DELETE"]);
  });

  it("selects the connections adapter with the adapter-rule precedence", async () => {
    // Adapter rule (2026-07-17 cloud definition): explicit adapter → BYO
    // brokers → VENDO_API_KEY defaults the Cloud adapter → unconfigured.
    vi.stubEnv("VENDO_API_KEY", "vnd_test_key");
    const dataDir = await mkdtemp(join(tmpdir(), "vendo-wire-connections-"));
    const store = createStore({ dataDir });
    cleanups.push(async () => { await store.close(); await rm(dataDir, { recursive: true, force: true }); });
    // Each composition is settled through one /status request (awaits that
    // vendo's schema readiness) so teardown never races an in-flight migration.
    const compose = async (config: Partial<CreateVendoConfig>): Promise<Vendo> => {
      const vendo = createVendo({
        model: {} as LanguageModel,
        principal: vi.fn(async () => principal),
        store,
        ...config,
      });
      await vendo.handler(request("GET", "/status"));
      return vendo;
    };

    const broker: Connector = {
      name: "composio",
      descriptors: async () => [],
      execute: async () => ({ status: "ok", output: {} }),
      connections: {
        list: async () => [],
        initiate: async () => ({ id: "ca_x", redirectUrl: "https://connect.test/x" }),
        status: async () => null,
        disconnect: async () => {},
      },
    };

    // An explicitly passed adapter wins over BOTH lower rungs at once: the
    // composition also carries a BYO broker and the key is set.
    const explicit: ConnectionsService = {
      posture: "byo",
      list: async () => [],
      initiate: async () => { throw new Error("unused"); },
      status: async () => null,
      disconnect: async () => {},
    };
    expect((await compose({ connections: explicit, connectors: [broker] })).connections).toBe(explicit);

    // A BYO connector's connections capability beats the key.
    expect((await compose({ connectors: [broker] })).connections.posture).toBe("byo");

    // The key alone defaults the Cloud adapter for the unfilled seam.
    expect((await compose({})).connections.posture).toBe("cloud");

    // Neither → the unconfigured fallback.
    vi.stubEnv("VENDO_API_KEY", "");
    expect((await compose({})).connections.posture).toBe(false);
  });

  it("selects the inference adapter with the adapter-rule precedence", async () => {
    // Adapter rule (2026-07-17 cloud definition) unified with install-dx v1's
    // model-optional createVendo: explicit model → the composed devModel
    // ladder (provider env key, then VENDO_API_KEY via the Cloud model
    // gateway, then honest failure — all resolved lazily INSIDE the ladder).
    vi.stubEnv("VENDO_API_KEY", "vnd_test_key");
    const dataDir = await mkdtemp(join(tmpdir(), "vendo-wire-model-"));
    const store = createStore({ dataDir });
    cleanups.push(async () => { await store.close(); await rm(dataDir, { recursive: true, force: true }); });
    const modelVenue = async (config: Partial<CreateVendoConfig>): Promise<unknown> => {
      const vendo = createVendo({
        principal: vi.fn(async () => principal),
        store,
        ...config,
      });
      const status = await vendo.handler(request("GET", "/status"));
      return (await status.json() as { blocks: { model: unknown } }).blocks.model;
    };

    // An explicitly passed model wins over every env credential.
    expect(await modelVenue({ model: {} as LanguageModel })).toBe("custom");

    // Otherwise the devModel ladder composes — with or without any key set
    // (rung resolution is lazy; the honest failure happens on first call).
    expect(await modelVenue({})).toBe("ladder");
    vi.stubEnv("VENDO_API_KEY", "");
    expect(await modelVenue({})).toBe("ladder");
  });

  it("selects the store with the adapter-rule precedence", async () => {
    // Adapter rule (2026-07-17 cloud definition), store seam (hosted-store
    // one-pager): explicit store → VENDO_API_KEY defaults the hosted store →
    // the local createStore default, byte-identical to pre-seam behavior.
    vi.stubEnv("VENDO_API_KEY", "vnd_store_key");
    vi.stubEnv("VENDO_CLOUD_URL", "https://cloud-store.test");
    const consoleCalls: Array<{ url: string; authorization: string | null }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const sent = new Request(input, init);
      consoleCalls.push({ url: sent.url, authorization: sent.headers.get("authorization") });
      return Response.json({ record: null });
    }));
    const compose = (config: Partial<CreateVendoConfig>): Vendo => createVendo({
      model: {} as LanguageModel,
      principal: vi.fn(async () => principal),
      ...config,
    });

    // An explicitly passed store wins over the key — the hard BYO rule.
    const dataDir = await mkdtemp(join(tmpdir(), "vendo-wire-store-"));
    const explicit = createStore({ dataDir });
    cleanups.push(async () => { await explicit.close(); await rm(dataDir, { recursive: true, force: true }); });
    const custom = compose({ store: explicit });
    await custom.handler(request("GET", "/status"));
    expect(custom.store).toBe(explicit);
    expect(consoleCalls).toHaveLength(0);

    // The key alone defaults the hosted store for the unfilled seam: a LIVE
    // console-bound adapter (VENDO_CLOUD_URL base, Bearer key), whose
    // ensureSchema is a client no-op — the service owns its migrations.
    const hosted = compose({});
    cleanups.push(async () => { await hosted.store.close(); });
    expect(await hosted.store.records("invoices").get("inv_1")).toBeNull();
    expect(consoleCalls).toEqual([{
      url: "https://cloud-store.test/api/v1/store/records/invoices/get",
      authorization: "Bearer vnd_store_key",
    }]);
    expect(() => hosted.store.raw()).toThrow(/no local database/);

    // No key → the local default engine, untouched: rows land on disk, raw()
    // hands back the live driver, and the console never hears about it.
    vi.stubEnv("VENDO_API_KEY", "");
    const localDir = await mkdtemp(join(tmpdir(), "vendo-wire-store-local-"));
    // The default engine roots its PGlite data dir in the cwd (.vendo/data) —
    // compose AND settle the first queries inside the temp dir so the test
    // never writes into the repo tree (vitest's fork pool keeps chdir local
    // to this worker process).
    const cwd = process.cwd();
    process.chdir(localDir);
    try {
      const local = compose({});
      cleanups.push(async () => { await local.store.close(); await rm(localDir, { recursive: true, force: true }); });
      // Settle the composition through /status (awaits schema readiness) so
      // the direct store access below never races the migration.
      await local.handler(request("GET", "/status"));
      await local.store.records("invoices").put({ id: "inv_local", data: { total: 3 } });
      expect((await local.store.records("invoices").get("inv_local"))?.data).toEqual({ total: 3 });
      expect(local.store.raw()).toBeDefined();
      expect(consoleCalls).toHaveLength(1);
    } finally {
      process.chdir(cwd);
    }
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
    // PUT is load-bearing for the box callback surface (execution-v2 Lane C):
    // /box/rows/:collection/:id writes are PUTs, and Next.js 405s any method
    // the route module does not export before the wire ever sees it.
    for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"] as const) expect(next[method]).toBeTypeOf("function");
    expect((await next.GET(request("GET", "/status"))).status).toBe(200);
    // PATCH is load-bearing even with no PATCH-only wire route left: without
    // this export Next.js would 405 a PATCH before it ever reached the wire's
    // own cloud-required seam (the /orgs routes match ANY method).
    expect((await next.PATCH(request("PATCH", "/orgs/org_1/members/user_1", { role: "admin" }))).status).toBe(402);
  });
});

describe("development runtime source capture", () => {
  async function captureRoot(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "vendo-runtime-capture-"));
    cleanups.push(async () => { await rm(root, { recursive: true, force: true }); });
    return root;
  }

  it("writes a schema-valid baseline for a runtime-only registration", async () => {
    const root = await captureRoot();
    const sourceFile = join(root, "src", "runtime-card.tsx");
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(sourceFile, "export const RuntimeCard = () => <article>runtime</article>;\n", "utf8");
    const { vendo } = await setup(vi.fn(async () => principal), { development: { root } });

    const response = await vendo.handler(request("POST", "/dev/remixable-source", {
      slot: "RuntimeCard",
      source: new URL(`file://${sourceFile}`).href,
      exportable: true,
    }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ slot: "RuntimeCard", status: "captured" });
    const baseline = JSON.parse(await readFile(join(root, ".vendo", "remixable", "RuntimeCard.json"), "utf8"));
    expect(capturedPinBaselineSchema.safeParse(baseline).success).toBe(true);
    expect(baseline).toMatchObject({ slot: "RuntimeCard", exportable: true });
  });

  it("rejects capture from an anonymous session without touching disk", async () => {
    const root = await captureRoot();
    const sourceFile = join(root, "src", "runtime-card.tsx");
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(sourceFile, "export const RuntimeCard = () => null;\n", "utf8");
    const { vendo } = await setup(vi.fn(async () => null), { development: { root } });

    const response = await vendo.handler(request("POST", "/dev/remixable-source", {
      slot: "RuntimeCard",
      source: sourceFile,
      exportable: false,
    }));
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: { code: "blocked", message: "runtime capture requires a host-resolved principal" },
    });
    await expect(access(join(root, ".vendo", "remixable", "RuntimeCard.json"))).rejects.toThrow();
  });

  it("does not mount the route outside development", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const { vendo } = await setup();
    const response = await vendo.handler(request("POST", "/dev/remixable-source", {
      slot: "Absent",
      source: "/tmp/absent.tsx",
      exportable: false,
    }));
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: { code: "not-found", message: "unknown Vendo route" } });
  });

  it("refuses sources outside the host root", async () => {
    const root = await captureRoot();
    const outside = await mkdtemp(join(tmpdir(), "vendo-runtime-outside-"));
    cleanups.push(async () => { await rm(outside, { recursive: true, force: true }); });
    const outsideFile = join(outside, "outside.tsx");
    await writeFile(outsideFile, "export const Outside = () => null;\n", "utf8");
    const { vendo } = await setup(vi.fn(async () => principal), { development: { root } });

    const response = await vendo.handler(request("POST", "/dev/remixable-source", {
      slot: "Outside",
      source: outsideFile,
      exportable: false,
    }));
    expect(response.status).toBe(400);
    await expect(access(join(root, ".vendo", "remixable", "Outside.json"))).rejects.toThrow();
  });

  it("preserves an existing static baseline", async () => {
    const root = await captureRoot();
    const sourceFile = join(root, "runtime-card.tsx");
    const baselineFile = join(root, ".vendo", "remixable", "RuntimeCard.json");
    await writeFile(sourceFile, "export const RuntimeCard = () => null;\n", "utf8");
    await mkdir(join(root, ".vendo", "remixable"), { recursive: true });
    const existing = {
      slot: "RuntimeCard",
      source: "export const RuntimeCard = () => <strong>static</strong>;",
      hash: `sha256:${"b".repeat(64)}`,
      exportable: true,
      capturedAt: new Date(Date.now() + 60_000).toISOString(),
    };
    await writeFile(baselineFile, `${JSON.stringify(existing, null, 2)}\n`, "utf8");
    const { vendo } = await setup(vi.fn(async () => principal), { development: { root } });

    const response = await vendo.handler(request("POST", "/dev/remixable-source", {
      slot: "RuntimeCard",
      source: sourceFile,
      exportable: false,
    }));
    expect(await response.json()).toMatchObject({ status: "preserved", hash: existing.hash });
    expect(JSON.parse(await readFile(baselineFile, "utf8"))).toEqual(existing);
  });
});

describe("06-apps §9 in-client venue over the wire", () => {
  const seedApp = async (vendo: Vendo, doc: AppDocument, subject = principal.subject) => {
    await vendo.store.ensureSchema();
    await vendo.store.records("vendo_apps").put({
      id: doc.id,
      data: { subject, enabled: true, doc },
      refs: { subject },
    });
  };

  it("serves the owner-scoped ship-diff for an app", async () => {
    const { vendo } = await setup();
    await seedApp(vendo, app("app_diff"));
    const response = await vendo.handler(request("GET", "/apps/app_diff/ship-diff"));
    expect(response.status).toBe(200);
    const shipDiff = await response.json();
    expect(shipDiff).toMatchObject({
      appId: "app_diff",
      versionHash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      pins: [],
      generated: [],
    });
  });

  it("keeps ship-diff owner-scoped — another subject sees not-found", async () => {
    const { vendo } = await setup(vi.fn(async () => ({ kind: "user", subject: "user_other" } as Principal)));
    await seedApp(vendo, app("app_diff"), principal.subject);
    const response = await vendo.handler(request("GET", "/apps/app_diff/ship-diff"));
    expect(response.status).toBe(404);
  });

  it("injects an approval in development and open() rides the hash-pinned verdict end to end", async () => {
    const { vendo } = await setup(vi.fn(async () => principal), { development: {} });
    const doc = app("app_venue");
    await seedApp(vendo, doc);

    // Default: no approval → the payload carries no inClient field (jail).
    const before = await (await vendo.handler(request("GET", "/apps/app_venue/open"))).json();
    expect(before.payload.inClient).toBeUndefined();

    const approve = await vendo.handler(request("POST", "/dev/inclient-approval", {
      appId: "app_venue",
      approvedBy: "demo-reviewer",
    }));
    expect(approve.status).toBe(200);
    const approval = await approve.json();
    expect(approval).toMatchObject({
      appId: "app_venue",
      approvedBy: "demo-reviewer",
      versionHash: expect.stringMatching(/^sha256:/),
    });

    const granted = await (await vendo.handler(request("GET", "/apps/app_venue/open"))).json();
    expect(granted.payload.inClient).toMatchObject({
      granted: true,
      versionHash: approval.versionHash,
      approvedBy: "demo-reviewer",
    });

    // A new version (any content change) drops the venue back, loudly.
    await seedApp(vendo, { ...doc, name: "Wire app v2" });
    const dropped = await (await vendo.handler(request("GET", "/apps/app_venue/open"))).json();
    expect(dropped.payload.inClient).toMatchObject({
      granted: false,
      reason: "version-changed",
    });
    expect(dropped.payload.inClient.versionHash).not.toBe(approval.versionHash);
  });

  it("rejects approval injection from an anonymous session", async () => {
    const { vendo } = await setup(vi.fn(async () => null), { development: {} });
    const response = await vendo.handler(request("POST", "/dev/inclient-approval", {
      appId: "app_venue",
    }));
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: { code: "blocked", message: "in-client approval injection requires a host-resolved principal" },
    });
  });

  it("does not mount the injection route outside development", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const { vendo } = await setup();
    const response = await vendo.handler(request("POST", "/dev/inclient-approval", {
      appId: "app_venue",
    }));
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: { code: "not-found", message: "unknown Vendo route" } });
  });
});

describe("09 §2 composition", () => {
  it("audits one structured warning when present auth cannot be forwarded", async () => {
    vi.stubEnv("VENDO_BASE_URL", "");
    const { vendo } = await setup();
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const target = input instanceof Request ? input : new Request(input, init);
      return vendo.handler(target);
    }));

    // Teach the zero-config route origin, then exercise the real present-forward
    // branch twice with inbound credentials. The learned origin is deliberately
    // untrusted, so both calls forward no auth but only one warning is recorded.
    expect((await vendo.handler(request("GET", "/status"))).status).toBe(200);
    for (let index = 0; index < 2; index += 1) {
      await vendo.handler(request("POST", "/doctor/present", {}, {
        authorization: "Bearer vendo-doctor-present",
        cookie: "vendo_doctor_present=1",
      }));
    }

    const events = await vendo.guard.audit.query({ principal });
    const warnings = events.events.filter((event) =>
      event.detail !== undefined
      && typeof event.detail === "object"
      && event.detail !== null
      && "warning" in event.detail);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({
      kind: "tool-call",
      presence: "present",
      detail: {
        warning: {
          code: "present-credentials-not-forwarded",
          reason: "untrusted-host-origin",
          action: "Set VENDO_BASE_URL to the host origin and restart the server.",
        },
      },
    });
  });

  it("09-vendo §2 install-dx wave 1.1: NODE_ENV=development trusts its own learned origin — present credentials forward with zero VENDO_BASE_URL", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("VENDO_BASE_URL", "");
    const { vendo } = await setup();
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const target = input instanceof Request ? input : new Request(input, init);
      return vendo.handler(target);
    }));

    // Teach the zero-config route origin, then run the real present-forward
    // branch: unlike the untrusted-origin case above, the credentials MUST
    // reach the doctor's own echo route.
    expect((await vendo.handler(request("GET", "/status"))).status).toBe(200);
    const probe = await vendo.handler(request("POST", "/doctor/present", {}, {
      authorization: "Bearer vendo-doctor-present",
      cookie: "vendo_doctor_present=1",
    }));
    expect(await probe.json()).toEqual({ ok: true });

    // No warning fires — nothing was dropped, so there is nothing to audit.
    const events = await vendo.guard.audit.query({ principal });
    const warnings = events.events.filter((event) =>
      event.detail !== undefined
      && typeof event.detail === "object"
      && event.detail !== null
      && "warning" in event.detail);
    expect(warnings).toHaveLength(0);
  });

  it("09-vendo §2 install-dx wave 1.1: logs one loud console.error at composition when NODE_ENV=production and VENDO_BASE_URL is unset", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("VENDO_BASE_URL", "");
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await setup();
    expect(error).toHaveBeenCalledOnce();
    expect(error.mock.calls[0]?.[0]).toContain("VENDO_BASE_URL");
    expect(error.mock.calls[0]?.[0]).toContain("production");
  });

  it("09-vendo §2 install-dx wave 1.1: no boot console.error when NODE_ENV=production and VENDO_BASE_URL is set", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("VENDO_BASE_URL", "https://app.example.com");
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await setup();
    expect(error).not.toHaveBeenCalled();
  });

  it("09-vendo §2 install-dx wave 1.1: no boot console.error outside production, VENDO_BASE_URL unset", async () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("VENDO_BASE_URL", "");
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await setup();
    expect(error).not.toHaveBeenCalled();
  });

  it("09-vendo §2 install-dx wave 1.1: /doctor/base-url reports a failing check when NODE_ENV=production and VENDO_BASE_URL is unset", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("VENDO_BASE_URL", "");
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { vendo } = await setup();

    const response = await vendo.handler(request("GET", "/doctor/base-url"));
    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.ok).toBe(false);
    expect(body.error.message).toContain("VENDO_BASE_URL");
  });

  it.each([
    ["NODE_ENV=production with VENDO_BASE_URL set", "production", "https://app.example.com"],
    ["NODE_ENV=development, unset", "development", ""],
    ["NODE_ENV=test, unset", "test", ""],
  ])("09-vendo §2 install-dx wave 1.1: /doctor/base-url reports ok — %s", async (_label, nodeEnv, baseUrl) => {
    vi.stubEnv("NODE_ENV", nodeEnv);
    vi.stubEnv("VENDO_BASE_URL", baseUrl);
    const { vendo } = await setup();

    const response = await vendo.handler(request("GET", "/doctor/base-url"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

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

  it("mints a fresh session when the cookie is not a well-formed session pointer", async () => {
    const seen: string[] = [];
    const resolver = vi.fn(async () => null);
    const { vendo } = await setup(resolver);
    vi.spyOn(vendo.apps, "list").mockImplementation(async (ctx) => {
      seen.push(ctx.principal.subject);
      return [];
    });

    const minted = await vendo.handler(request("GET", "/apps"));
    const id = anonCookieValue(minted)!;

    // The legacy signed form (`<id>.<sig>`), garbage, truncated, and non-hex
    // values are not pointers into vendo_sessions — each gets a fresh mint.
    for (const bad of [`${id}.deadbeef`, "not-a-valid-cookie", id.slice(0, 8), "Z".repeat(32)]) {
      const response = await vendo.handler(request("GET", "/apps", undefined, { cookie: `__Host-vendo_anon_session=${bad}` }));
      expect(setCookie(response)).toContain("__Host-vendo_anon_session="); // fresh mint
    }
    // Every malformed request got its own fresh subject, none equal to the original.
    const original = seen[0];
    for (const subject of seen.slice(1)) expect(subject).not.toBe(original);
  });

  it("treats any well-formed 128-bit id as the session pointer — the vendo_sessions row is the authority, not the cookie", async () => {
    // Kill-list B3 server half: the cookie carries no signature. An id the
    // server never minted (or one surviving a process restart) simply names
    // its own — empty — session: nothing to steal, and no re-mint churn.
    const seen: string[] = [];
    const resolver = vi.fn(async () => null);
    const { vendo } = await setup(resolver);
    vi.spyOn(vendo.apps, "list").mockImplementation(async (ctx) => {
      seen.push(ctx.principal.subject);
      return [];
    });

    const foreign = "0123456789abcdef0123456789abcdef";
    const response = await vendo.handler(request("GET", "/apps", undefined, {
      cookie: `__Host-vendo_anon_session=${foreign}`,
    }));
    expect(seen[0]).toBe(`anonymous_${foreign}`); // the pointer is honored as-is
    expect(setCookie(response)).toBeNull();        // no new cookie minted
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
      const cookieId = anonCookieValue(response)!;
      expect(cookieId).toMatch(/^[0-9a-f]{32}$/); // opaque pointer, no signature suffix
      expect(seen[i]).toBe(`anonymous_${cookieId}`);
    });
  });
});

describe("09 §2.1 — host-identity presets (auth)", () => {
  const authJsSecret = "vendo-umbrella-auth-preset-secret";

  /** Mint a REAL Auth.js v5 session JWE (the actions preset tests' idiom). */
  async function mintSessionCookie(subject: string, claims: Record<string, unknown> = {}): Promise<string> {
    const { encode } = await import("@auth/core/jwt");
    const token = await encode({
      token: { sub: subject, ...claims },
      secret: authJsSecret,
      salt: "authjs.session-token",
      maxAge: 300,
    });
    return `authjs.session-token=${token}`;
  }

  it.each(["principal", "actAs", "oauth"] as const)(
    "throws VendoError(validation) at compose time when auth is combined with %s",
    async (key) => {
      const store = await tempStore("vendo-auth-mix-");
      const seams = {
        principal: { principal: async () => null },
        actAs: { actAs: async () => null },
        oauth: { oauth: { async principal() { return null; } } },
      } as const;
      let thrown: unknown;
      try {
        createVendo({
          model: {} as LanguageModel,
          store,
          auth: { principal: async () => null },
          ...seams[key],
        } as CreateVendoConfig);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(VendoError);
      expect((thrown as VendoError).code).toBe("validation");
      expect((thrown as VendoError).message).toContain(key);
    },
  );

  it("boots anonymous ephemeral sessions when neither auth nor principal is configured", async () => {
    const store = await tempStore("vendo-auth-none-");
    const vendo = createVendo({ model: {} as LanguageModel, store });
    const seen: string[] = [];
    vi.spyOn(vendo.apps, "list").mockImplementation(async (listCtx) => {
      seen.push(listCtx.principal.subject);
      return [];
    });
    const response = await vendo.handler(request("GET", "/apps"));
    expect(response.status).toBe(200);
    expect(seen[0]).toMatch(/^anonymous_[0-9a-f]{32}$/);
    expect(setCookie(response)).toContain("vendo_anon_session=");
  });

  it("auth fills the principal seam — one real wire request resolves the host session", async () => {
    vi.stubEnv("AUTH_SECRET", authJsSecret);
    const store = await tempStore("vendo-auth-principal-");
    const vendo = createVendo({ model: {} as LanguageModel, store, auth: authJs() });
    const seen: Principal[] = [];
    vi.spyOn(vendo.apps, "list").mockImplementation(async (listCtx) => {
      seen.push(listCtx.principal);
      return [];
    });
    const response = await vendo.handler(request("GET", "/apps", undefined, {
      cookie: await mintSessionCookie("user_auth_wire", { name: "Wire User" }),
    }));
    expect(response.status).toBe(200);
    expect(seen[0]).toEqual({ kind: "user", subject: "user_auth_wire", display: "Wire User" });
    expect(setCookie(response)).toBeNull(); // a resolved host session mints no anon cookie
  });

  it("auth's oauth half opens the MCP door — mcp: true needs no separate oauth key", async () => {
    vi.stubEnv("AUTH_SECRET", authJsSecret);
    const store = await tempStore("vendo-auth-door-");
    const vendo = createVendo({ model: {} as LanguageModel, store, auth: authJs(), mcp: true });
    await store.ensureSchema();
    const res = await vendo.handler(new Request("https://host.test/.well-known/oauth-protected-resource/api/vendo/mcp"));
    expect(res.status).toBe(200);
    expect((await res.json() as { resource?: string }).resource).toBe("https://host.test/api/vendo/mcp");
  });

  it("an auth preset WITHOUT an oauth half leaves the door seam unset — mcp: true still throws", async () => {
    const store = await tempStore("vendo-auth-no-oauth-");
    expect(() => createVendo({
      model: {} as LanguageModel,
      store,
      auth: { principal: async () => null },
      mcp: true,
    })).toThrowError(VendoError);
  });

  it("auth's actAs half is live — the doctor actAs probe round-trips a minted Auth.js session", async () => {
    vi.stubEnv("AUTH_SECRET", authJsSecret);
    const store = await tempStore("vendo-auth-actas-");
    const vendo = createVendo({ model: {} as LanguageModel, store, auth: authJs() });
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const target = input instanceof Request ? input : new Request(input, init);
      return vendo.handler(target);
    }));

    // Teach the zero-config route origin, then run the real away branch: the
    // probe mints through the preset's actAs and the echo route verifies the
    // minted cookie through the preset's own principal resolver.
    expect((await vendo.handler(request("GET", "/status"))).status).toBe(200);
    const probe = await vendo.handler(request("POST", "/doctor/act-as", {}));
    expect(await probe.json()).toEqual({ ok: true });
  });
});

describe("XCUT-3 — umbrella runtime store surface", () => {
  it("re-exports the store runtime so a production deploy needs only the umbrella", async () => {
    const server = await import("./server.js") as Record<string, unknown>;
    const store = await import("@vendoai/store") as Record<string, unknown>;
    for (const name of ["createStore", "envSecrets", "storeSecrets", "secretStore", "eraseStore"]) {
      expect(server[name], `${name} must be re-exported from @vendoai/vendo/server`).toBe(store[name]);
    }
  });
});

describe("03 §3 prompt wiring (AGENT-1/2)", () => {
  it("feeds .vendo/brief.md and the catalog+theme summary into the composed system prompt", async () => {
    const { MockLanguageModelV3, simulateReadableStream } = await import("ai/test");
    const root = await mkdtemp(join(tmpdir(), "vendo-prompt-"));
    const dataDir = join(root, "store-data");
    await mkdir(join(root, ".vendo"), { recursive: true });
    await writeFile(join(root, ".vendo", "brief.md"), "Maple is a neobank for freelancers.\n");
    await writeFile(join(root, ".vendo", "theme.json"), JSON.stringify({
      colors: {
        background: "#fff", surface: "#fff", text: "#111", muted: "#777",
        accent: "#00f", accentText: "#fff", danger: "#f00", border: "#ddd",
      },
      typography: { fontFamily: "Inter", baseSize: "16px" },
      radius: { small: "4px", medium: "8px", large: "16px" },
      density: "comfortable",
      motion: "reduced",
    }));
    const originalCwd = process.cwd();
    process.chdir(root);
    cleanups.push(async () => {
      process.chdir(originalCwd);
      await rm(root, { recursive: true, force: true });
    });

    const prompts: Array<Array<{ role: string; content: unknown }>> = [];
    const model = new MockLanguageModelV3({
      doStream: async ({ prompt }) => {
        prompts.push(structuredClone(prompt) as never);
        return {
          stream: simulateReadableStream({
            chunks: [
              { type: "text-start", id: "t1" },
              { type: "text-delta", id: "t1", delta: "Hi." },
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
        };
      },
    });
    const store = createStore({ dataDir });
    cleanups.push(async () => { await store.close(); });
    const vendo = createVendo({
      model: model as unknown as LanguageModel,
      principal: async () => principal,
      store,
      catalog: [{
        name: "InvoiceTable",
        description: "Renders invoice line items with totals.",
        propsSchema: { "~standard": { validate: (value: unknown) => ({ value }) } } as never,
      }],
    });

    const turn = await vendo.handler(request("POST", "/threads", {
      threadId: "thr_prompt_wiring",
      message: { id: "m_prompt", role: "user", parts: [{ type: "text", text: "Hello" }] },
    }));
    expect(turn.status).toBe(200);
    await turn.text();

    const system = prompts[0]?.find((message) => message.role === "system");
    expect(system).toBeDefined();
    const content = typeof system!.content === "string" ? system!.content : JSON.stringify(system!.content);
    // AGENT-2: the host product brief rides as the Product section.
    expect(content).toContain("Product\nMaple is a neobank for freelancers.");
    // AGENT-1: catalog + theme summary assembled per 03 §3 item (4).
    expect(content).toContain("InvoiceTable: Renders invoice line items with totals.");
    expect(content).toContain("comfortable");
    expect(content).toContain("Inter");
  });
});

describe("09 §3 conversational turn against the real composed store", () => {
  it("streams a turn, persists the thread through the routed vendo_threads table, and reads it back", async () => {
    const { MockLanguageModelV3, simulateReadableStream } = await import("ai/test");
    const store = await tempStore("vendo-turn-");
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
                delta: '<App name="SSE app"><Stack>',
              },
              {
                type: "text-delta",
                id: "generation",
                delta: '<Text text="Ready"/></Stack></App>',
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
    const store = await tempStore("vendo-stream-turn-");
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
    expect(views[0]?.data.payload).toMatchObject({ streaming: true, nodes: [{ id: "root" }, { id: "stack-1" }] });
    expect(new Set(views.map((view) => view.id))).toEqual(new Set([`vendo-view:${views[0]?.data.appId}`]));
    expect(views.at(-1)?.data.payload.nodes).toHaveLength(3);
    expect(views.at(-1)?.data.payload.streaming).toBeUndefined();
  });
});

describe("09 §2 apps composition", () => {
  it("passes host-component catalog registrations to createApps", { timeout: 120_000 }, async () => {
    const { MockLanguageModelV3, simulateReadableStream } = await import("ai/test");
    const store = await tempStore("vendo-catalog-");
    const generated = '<App name="Catalog app"><MetricCard label="Revenue"/></App>';
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
      tree: { nodes: [{ component: "Stack" }, { component: "MetricCard", source: "host" }] },
    });
  });

  it("accepts the name-keyed registry catalog form and ignores component references", { timeout: 120_000 }, async () => {
    const { MockLanguageModelV3, simulateReadableStream } = await import("ai/test");
    const store = await tempStore("vendo-registry-catalog-");
    const generated = '<App name="Registry app"><MetricCard label="Revenue"/></App>';
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
    // 01 §14: the server MUST IGNORE the component reference — a trap proves
    // it is never touched or executed.
    const registry: ComponentRegistry = {
      MetricCard: {
        get component(): unknown {
          throw new Error("the server must never read component references");
        },
        description: "Use for a single headline metric.",
      },
    };
    const vendo = createVendo({
      model,
      principal: async () => principal,
      store,
      catalog: registry,
    });
    await store.ensureSchema();

    await expect(vendo.apps.create({ prompt: "Show revenue" }, ctx)).resolves.toMatchObject({
      tree: {
        nodes: expect.arrayContaining([
          expect.objectContaining({ component: "MetricCard", source: "host" }),
        ]),
      },
    });
  });

  it("loads catalog@1 from .vendo and plumbs it through to createApps", { timeout: 120_000 }, async () => {
    const { MockLanguageModelV3, simulateReadableStream } = await import("ai/test");
    const root = await mkdtemp(join(tmpdir(), "vendo-disk-catalog-"));
    const dataDir = join(root, "data");
    await mkdir(join(root, ".vendo"), { recursive: true });
    await writeFile(join(root, ".vendo", "catalog.json"), JSON.stringify({
      format: "vendo/catalog@1",
      entries: [{
        name: "DiskMetric",
        exportPath: "./src/disk-metric.tsx#DiskMetric",
        propsSchema: { type: "object", properties: { value: { type: "number" } }, required: ["value"], additionalProperties: false },
        description: "Use for a metric loaded from the generated catalog.",
        source: "scanned",
      }],
    }));
    const store = createStore({ dataDir });
    cleanups.push(async () => { await store.close(); await rm(root, { recursive: true, force: true }); });
    const generated = '<App name="Disk catalog app"><DiskMetric value={42}/></App>';
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
    const previousCwd = process.cwd();
    const vendo = (() => {
      try {
        process.chdir(root);
        return createVendo({ model, principal: async () => principal, store });
      } finally {
        process.chdir(previousCwd);
      }
    })();
    await store.ensureSchema();

    await expect(vendo.apps.create({ prompt: "Show the disk metric" }, ctx)).resolves.toMatchObject({
      tree: { nodes: [{ component: "Stack" }, { component: "DiskMetric", source: "host", props: { value: 42 } }] },
    });
  });

  it("exempts runtime bindings from a disk entry's ajv-backed schema while still rejecting real violations", { timeout: 120_000 }, async () => {
    // 04 §1 gap closure end-to-end: ajvIssuePath → standardIssuePath →
    // pathTargetsRuntimeBinding. The disk schema says value must be a number;
    // a {$path} binding at that prop must be exempted, a plain wrong type not.
    const { MockLanguageModelV3, simulateReadableStream } = await import("ai/test");
    const root = await mkdtemp(join(tmpdir(), "vendo-disk-catalog-binding-"));
    const dataDir = join(root, "data");
    await mkdir(join(root, ".vendo"), { recursive: true });
    await writeFile(join(root, ".vendo", "catalog.json"), JSON.stringify({
      format: "vendo/catalog@1",
      entries: [{
        name: "DiskMetric",
        exportPath: "./src/disk-metric.tsx#DiskMetric",
        propsSchema: { type: "object", properties: { value: { type: "number" } }, required: ["value"], additionalProperties: false },
        description: "Use for a metric loaded from the generated catalog.",
        source: "scanned",
      }],
    }));
    const store = createStore({ dataDir });
    cleanups.push(async () => { await store.close(); await rm(root, { recursive: true, force: true }); });
    // v2 JSX wire: `value={metrics.value}` compiles to the runtime binding
    // { $path: "/metrics/value" } (a ghost binding renders as absent data —
    // wire-v2/compile.ts); the bad case is a plain string attribute.
    // The query names a REAL registry tool: query tools are now validated
    // against the live descriptor list at create (verify-v2 fixes).
    const bound = '<App name="Disk binding app"><Query id="metrics" tool="vendo_apps_data_list"/><DiskMetric value={metrics.value}/></App>';
    const bad = '<App name="Disk binding app"><DiskMetric value="not a number"/></App>';
    const outputs = [
      bound,
      // The second bad output feeds the engine's 2-attempt repair loop so the
      // second create fails on both attempts.
      bad,
      bad,
    ];
    const model = new MockLanguageModelV3({
      doStream: async () => ({
        stream: simulateReadableStream({ chunks: [
          { type: "text-start", id: "generation" },
          { type: "text-delta", id: "generation", delta: outputs.shift() ?? "" },
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
    const previousCwd = process.cwd();
    const vendo = (() => {
      try {
        process.chdir(root);
        return createVendo({ model, principal: async () => principal, store });
      } finally {
        process.chdir(previousCwd);
      }
    })();
    await store.ensureSchema();

    // A binding where the schema wants a number is exempt: create succeeds.
    await expect(vendo.apps.create({ prompt: "Show the bound metric" }, ctx)).resolves.toMatchObject({
      tree: {
        nodes: expect.arrayContaining([
          expect.objectContaining({
            component: "DiskMetric",
            source: "host",
            props: { value: { $path: "/metrics/value" } },
          }),
        ]),
      },
    });
    // A genuine type violation against the same disk schema still fails.
    await expect(vendo.apps.create({ prompt: "Show the broken metric" }, ctx)).rejects.toMatchObject({
      code: "validation",
      detail: expect.arrayContaining([
        expect.stringContaining('props invalid for host component "DiskMetric"'),
      ]),
    });
  });

  it("warns loudly when createVendo finds a malformed .vendo/catalog.json", async () => {
    const root = await mkdtemp(join(tmpdir(), "vendo-malformed-disk-catalog-"));
    const dataDir = join(root, "data");
    await mkdir(join(root, ".vendo"), { recursive: true });
    await writeFile(join(root, ".vendo", "catalog.json"), JSON.stringify({
      format: "vendo/catalog@1",
      entries: [],
      typo: true,
    }));
    const store = createStore({ dataDir });
    cleanups.push(async () => { await store.close(); await rm(root, { recursive: true, force: true }); });
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const previousCwd = process.cwd();
    try {
      process.chdir(root);
      createVendo({ model: {} as LanguageModel, principal: async () => principal, store });
    } finally {
      process.chdir(previousCwd);
    }
    await store.ensureSchema();

    expect(error).toHaveBeenCalledOnce();
    expect(error.mock.calls[0]?.[0]).toContain(".vendo/catalog.json");
    expect(error.mock.calls[0]?.[0]).toContain("Unrecognized key");
    expect(error.mock.calls[0]?.[0]).toContain("vendo sync");
  });
});

describe("10-mcp §5 — door claims only its four exact well-known paths (FIX H)", () => {
  async function mcpVendo(mcp: CreateVendoConfig["mcp"] = true): Promise<Vendo> {
    const store = await tempStore("vendo-door-");
    const vendo = createVendo({
      model: {} as LanguageModel,
      principal: async () => null,
      store,
      mcp,
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

  /** Compact HS256 JWS, enough to speak the 10-mcp §3.2 handshake in-test. */
  function signHs256(secret: string, payload: Record<string, unknown>): string {
    const part = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64url");
    const signingInput = `${part({ alg: "HS256", typ: "JWT" })}.${part(payload)}`;
    const signature = createHmac("sha256", secret).update(signingInput).digest("base64url");
    return `${signingInput}.${signature}`;
  }

  it("serves protected-resource metadata at the door's exact path-inserted URL", async () => {
    const vendo = await mcpVendo();
    const res = await vendo.handler(root("/.well-known/oauth-protected-resource/api/vendo/mcp"));
    expect(res.status).toBe(200);
    expect((await res.json() as { resource?: string }).resource).toBe("https://host.test/api/vendo/mcp");
  });

  it("derives door metadata from VENDO_BASE_URL, not the proxy-internal request origin (ENG-333)", async () => {
    // Behind a reverse proxy (Railway, Fly) the request URL reaching the
    // process carries the proxy-INTERNAL origin; the operator-set
    // VENDO_BASE_URL — the same trusted origin channel actions already use —
    // is what discovery must advertise and what tokens must bind to.
    vi.stubEnv("VENDO_BASE_URL", "https://app.example.com");
    const vendo = await mcpVendo();
    const res = await vendo.handler(new Request(
      "http://10.0.3.7:8080/.well-known/oauth-protected-resource/api/vendo/mcp",
    ));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      resource: "https://app.example.com/api/vendo/mcp",
      authorization_servers: ["https://app.example.com/api/vendo/mcp"],
    });

    const as = await vendo.handler(new Request(
      "http://10.0.3.7:8080/.well-known/oauth-authorization-server/api/vendo/mcp",
    ));
    expect(await as.json()).toMatchObject({
      issuer: "https://app.example.com/api/vendo/mcp",
      token_endpoint: "https://app.example.com/api/vendo/mcp/token",
    });
  });

  it("lets mcp.baseUrl override the VENDO_BASE_URL default for split-origin compositions", async () => {
    vi.stubEnv("VENDO_BASE_URL", "https://host-routes.example.com");
    const vendo = await mcpVendo({ baseUrl: "https://door.example.com" });
    const res = await vendo.handler(new Request(
      "http://10.0.3.7:8080/.well-known/oauth-protected-resource/api/vendo/mcp",
    ));
    expect((await res.json() as { resource?: string }).resource).toBe("https://door.example.com/api/vendo/mcp");
  });

  it("plumbs mcp.remoteAs and mcp.federation through to the door (ENG-286)", async () => {
    // A broker-fronted host trusts the external authorization server and
    // answers its signed login handshake — both ride the `mcp` object form.
    const issuer = "https://maple.mcp.vendo.run";
    const secret = "umbrella-federation-secret-with-entropy";
    const vendo = await mcpVendo({
      remoteAs: { issuer, audience: `${issuer}/mcp` },
      federation: { secret },
    });

    // Remote-AS mode: metadata names the external issuer, and the door stops
    // serving its own authorization-server surface (10-mcp §3.1).
    const prm = await vendo.handler(root("/.well-known/oauth-protected-resource/api/vendo/mcp"));
    expect(prm.status).toBe(200);
    expect((await prm.json() as { authorization_servers?: string[] }).authorization_servers).toEqual([issuer]);
    expect((await vendo.handler(root("/.well-known/oauth-authorization-server/api/vendo/mcp"))).status).toBe(404);

    // The login-federation handshake is live at the door's mount (10-mcp §3.2).
    const now = Math.floor(Date.now() / 1_000);
    const request = signHs256(secret, {
      iss: issuer,
      aud: "https://host.test/api/vendo/mcp",
      exp: now + 300,
      jti: "umbrella-federation-nonce",
      redirect_uri: `${issuer}/federation/callback`,
      scopes: ["tools"],
      client_name: "Vendo broker",
    });
    const federated = await vendo.handler(root(`/api/vendo/mcp/federate?request=${request}`));
    expect(federated.status).toBe(302);
    const assertion = new URL(federated.headers.get("location")!).searchParams.get("assertion")!;
    const payload = JSON.parse(Buffer.from(assertion.split(".")[1]!, "base64url").toString()) as Record<string, unknown>;
    expect(payload).toMatchObject({ sub: "user_door", jti: "umbrella-federation-nonce", aud: issuer });
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

describe("10-mcp §5 — wellKnownVendoHandler (the Next.js app/.well-known/[...vendo]/route.ts adapter)", () => {
  async function mcpVendo(mcp: CreateVendoConfig["mcp"] = true): Promise<Vendo> {
    const store = await tempStore("vendo-well-known-");
    const vendo = createVendo({
      model: {} as LanguageModel,
      principal: async () => null,
      store,
      mcp,
      oauth: {
        async authorize() { return { subject: "user_door" }; },
        async principal(subject) { return { kind: "user", subject }; },
      },
    });
    // See the identical comment on the door describe block above: a test
    // whose requests all resolve before `await ready` would otherwise close
    // the store mid-schema-creation (the known PGlite close-race hang).
    await store.ensureSchema();
    return vendo;
  }
  const root = (path: string): Request => new Request(`https://host.test${path}`);

  it("forwards each of the door's four exact well-known paths to vendo.handler", async () => {
    const vendo = await mcpVendo();
    const route = wellKnownVendoHandler(vendo);
    for (const method of ["GET", "POST"] as const) expect(route[method]).toBeTypeOf("function");

    const prm = await route.GET(root("/.well-known/oauth-protected-resource/api/vendo/mcp"));
    expect(prm.status).toBe(200);
    expect((await prm.json() as { resource?: string }).resource).toBe("https://host.test/api/vendo/mcp");

    const as = await route.GET(root("/.well-known/oauth-authorization-server/api/vendo/mcp"));
    expect(as.status).toBe(200);
    expect((await as.json() as { issuer?: string }).issuer).toBe("https://host.test/api/vendo/mcp");

    const card = await route.GET(root("/.well-known/mcp/server-card.json"));
    expect(card.status).toBe(200);

    const alias = await route.GET(root("/.well-known/mcp-server-card"));
    expect(alias.status).toBe(200);
  });

  it("404s empty-body on a well-known path outside the door's four (mirrors the hand-written route it replaces)", async () => {
    const vendo = await mcpVendo();
    const route = wellKnownVendoHandler(vendo);
    const res = await route.GET(root("/.well-known/openid-configuration"));
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("");
  });

  it("does NOT 500 on the door's four paths when mcp is left unconfigured — falls through to the wire's ordinary not-found", async () => {
    // wellKnownVendoHandler's own path check only decides which requests
    // reach vendo.handler at all; with no `door` composed, vendo.handler's
    // isDoorPath branch never fires (it also requires deps.door), so the
    // request falls through to relativePath (which returns null for an
    // origin-root path) and the wire answers its ordinary not-found — a JSON
    // 404, not a crash.
    const vendo = await mcpVendo(false);
    const route = wellKnownVendoHandler(vendo);
    const res = await route.GET(root("/.well-known/oauth-protected-resource/api/vendo/mcp"));
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: { code: "not-found" } });
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

// ENG-290 M4 — the umbrella mounts the apps machine proxy (06-apps §4.4–4.5) at
// /proxy/*: the egress route the in-sandbox fetch shim targets exists on the
// wire and enforces its run-token gate. Substitution mechanics are proven in
// @vendoai/apps (proxy suites + live lanes); this pins the composition seam.
describe("the machine proxy mount", () => {
  it("routes /proxy/egress to the apps proxy, which refuses a request without a run token", async () => {
    const { vendo } = await setup();
    const response = await vendo.handler(request("POST", "/proxy/egress", { url: "https://api.stripe.com/v1/charges" }));
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: { code: "unauthorized" } });
  });

  it("routes /proxy/tools/<name> the same way", async () => {
    const { vendo } = await setup();
    const response = await vendo.handler(request("POST", "/proxy/tools/host_tool", { args: {} }));
    expect(response.status).toBe(401);
  });
});

describe("01-core §2 — the wire rejects resolver-minted reserved/org principals (ENG-263)", () => {
  it("rejects a resolver-produced vendo:* subject loudly", async () => {
    const { vendo } = await setup(vi.fn(async () => ({ kind: "user" as const, subject: "vendo:webhook:stripe" })));
    const response = await vendo.handler(request("GET", "/threads"));
    expect(response.status).toBe(400);
    const body = await response.json() as { error: { code: string; message: string } };
    expect(body.error.code).toBe("validation");
    expect(body.error.message).toContain("reserved subject");
  });

  it("rejects a resolver-produced org-kind principal (org context is membership-derived)", async () => {
    const { vendo } = await setup(vi.fn(async () => ({ kind: "org" as const, subject: "acme" })));
    const response = await vendo.handler(request("GET", "/threads"));
    expect(response.status).toBe(400);
    const body = await response.json() as { error: { code: string; message: string } };
    expect(body.error.code).toBe("validation");
    expect(body.error.message).toContain("kind:\"user\"");
  });

  it("still accepts ordinary user principals whose subject merely CONTAINS 'vendo'", async () => {
    const { vendo } = await setup(vi.fn(async () => ({ kind: "user" as const, subject: "user_vendofan" })));
    stubRouteBlocks(vendo);
    const response = await vendo.handler(request("GET", "/threads"));
    expect(response.status).toBe(200);
  });
});

describe("kill-list A5 — orgs are a Vendo Cloud capability, not an OSS wire route", () => {
  it.each([
    ["without a VENDO_API_KEY", undefined],
    ["with a VENDO_API_KEY set", `vnd_${"f".repeat(40)}`],
  ])("returns cloud-required for every /orgs route, %s", async (_label, key) => {
    if (key !== undefined) vi.stubEnv("VENDO_API_KEY", key);
    const { vendo } = await setup();
    const list = await vendo.handler(request("GET", "/orgs"));
    expect(list.status).toBe(402);
    const body = await list.json() as { error: { code: string } };
    expect(body.error.code).toBe("cloud-required");

    const create = await vendo.handler(request("POST", "/orgs", { name: "Acme" }));
    expect(create.status).toBe(402);

    const get = await vendo.handler(request("GET", "/orgs/org_1"));
    expect(get.status).toBe(402);

    const addMember = await vendo.handler(request("POST", "/orgs/org_1/members", { subject: "user_1" }));
    expect(addMember.status).toBe(402);

    // A trailing slash still lands on the "orgs" head segment (routeSegments
    // filters empty parts), so it gets the same seam instead of falling
    // through to the generic 404.
    const trailingSlash = await vendo.handler(request("GET", "/orgs/"));
    expect(trailingSlash.status).toBe(402);

    // No shadowing: matching on the whole first path segment means a
    // lookalike route is untouched by the seam.
    const lookalike = await vendo.handler(request("GET", "/organizations"));
    expect(lookalike.status).toBe(404);
  });

  it.each([
    ["without a VENDO_API_KEY", undefined],
    ["with a VENDO_API_KEY set", `vnd_${"f".repeat(40)}`],
  ])("returns cloud-required for any request carrying an org param, %s", async (_label, key) => {
    if (key !== undefined) vi.stubEnv("VENDO_API_KEY", key);
    const { vendo } = await setup();
    expect((await vendo.handler(request("GET", "/approvals?org=org_x"))).status).toBe(402);
    expect((await vendo.handler(request("POST", "/approvals/decide", { ids: ["a"], decision: { approve: true }, org: "org_x" }))).status).toBe(402);
    expect((await vendo.handler(request("GET", "/grants?org=org_x"))).status).toBe(402);
    expect((await vendo.handler(request("DELETE", "/grants/grant_1?org=org_x"))).status).toBe(402);
  });
});

describe("ENG-353 — turn liveness: heartbeat-armed idle abort for disconnects the runtime never surfaces", () => {
  // Generous margins: CI runners under coverage load stall for hundreds of
  // milliseconds, and a spurious idle-abort here would flake the suite.
  const IDLE_MS = 1_000;

  /** agent.stream stub whose SSE body stays open until the handed signal
   *  aborts — a long-generating turn. */
  function streamingTurnStub(vendo: Vendo, threadId = "thr_live"): { signals: AbortSignal[] } {
    const signals: AbortSignal[] = [];
    vi.spyOn(vendo.agent, "stream").mockImplementation(async (input: { signal?: AbortSignal }) => {
      signals.push(input.signal!);
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("data: {\"type\":\"start\"}\n\n"));
          input.signal?.addEventListener("abort", () => {
            try {
              controller.close();
            } catch {
              /* already closed */
            }
          }, { once: true });
        },
      });
      const response = new Response(stream, {
        headers: { "content-type": "text/event-stream", "x-vendo-thread-id": threadId },
      });
      return response;
    });
    return { signals };
  }

  const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
  const turnBody = { message: { id: "m_live", role: "user", parts: [] } };
  const beat = (vendo: Vendo, id = "thr_live"): Promise<Response> =>
    vendo.handler(request("POST", `/threads/${id}/heartbeat`, {}));

  it("aborts a turn whose heartbeats stop; beats keep it alive; never-beating turns run to completion", async () => {
    vi.stubEnv("VENDO_TURN_IDLE_ABORT_MS", String(IDLE_MS));
    try {
      const { vendo } = await setup();
      const { signals } = streamingTurnStub(vendo);

      await vendo.handler(request("POST", "/threads", turnBody));
      const signal = signals[0]!;

      // Beats keep the turn alive well past the idle window…
      for (let i = 0; i < 4; i += 1) {
        expect(await (await beat(vendo)).json()).toEqual({ active: true });
        await wait(IDLE_MS / 2);
        expect(signal.aborted).toBe(false);
      }
      // …then silence idle-aborts it.
      await wait(IDLE_MS * 3);
      expect(signal.aborted).toBe(true);
      // A beat after the turn ended reports it inactive.
      expect(await (await beat(vendo)).json()).toEqual({ active: false });

      // Opt-in by construction: a turn whose client NEVER beats is untouched.
      const second = await vendo.handler(request("POST", "/threads", turnBody));
      expect(second.status).toBe(200);
      await wait(IDLE_MS * 3);
      expect(signals[1]!.aborted).toBe(false);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("a foreign principal's beat neither refreshes nor reveals another's turn", async () => {
    vi.stubEnv("VENDO_TURN_IDLE_ABORT_MS", String(IDLE_MS));
    try {
      const resolver = vi.fn(async () => principal);
      const { vendo } = await setup(resolver);
      const { signals } = streamingTurnStub(vendo);

      await vendo.handler(request("POST", "/threads", turnBody));
      // Arm the watchdog as the owner.
      expect(await (await beat(vendo)).json()).toEqual({ active: true });

      // The attacker keeps beating the same thread id — as someone else.
      resolver.mockResolvedValue({ kind: "user", subject: "user_mallory" });
      const foreign = await (await beat(vendo)).json();
      expect(foreign).toEqual({ active: false });
      for (let i = 0; i < 3; i += 1) {
        await wait(IDLE_MS / 2);
        await beat(vendo);
      }
      // Foreign beats did NOT keep the owner's turn alive.
      expect(signals[0]!.aborted).toBe(true);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("keeps the fast path: the request signal still aborts the turn immediately", async () => {
    const { vendo } = await setup();
    const { signals } = streamingTurnStub(vendo);
    const controller = new AbortController();
    const disconnectable = new Request("https://host.test/api/vendo/threads", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(turnBody),
      signal: controller.signal,
    });
    await vendo.handler(disconnectable);
    expect(signals[0]!.aborted).toBe(false);
    controller.abort();
    expect(signals[0]!.aborted).toBe(true);
  });

  it("a completed turn unregisters: beats after the stream drained report inactive", async () => {
    const { vendo } = await setup();
    vi.spyOn(vendo.agent, "stream").mockResolvedValue(new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
          controller.close();
        },
      }),
      { headers: { "content-type": "text/event-stream", "x-vendo-thread-id": "thr_done" } },
    ));
    const response = await vendo.handler(request("POST", "/threads", turnBody));
    expect(await (await beat(vendo, "thr_done")).json()).toEqual({ active: true });
    const reader = response.body!.getReader();
    while (!(await reader.read()).done) { /* drain */ }
    expect(await (await beat(vendo, "thr_done")).json()).toEqual({ active: false });
  });
});
