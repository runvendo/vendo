import {
  VENDO_APP_FORMAT,
  type AppDocument,
  type RunContext,
  type ToolDescriptor,
  type ToolRegistry,
} from "@vendoai/core";
import { describe, expect, it, vi } from "vitest";
import { createApps, mintRunToken, verifyRunToken } from "./index.js";
import { createMachineSessions } from "./machine.js";
import type { SandboxAdapter } from "./sandbox.js";
import {
  bindTools,
  basicLanguageModel,
  fakeSandbox,
  guardFixture,
  memoryStore,
  type MachineApp,
} from "./testing/index.js";

const model = basicLanguageModel();
const decoder = new TextDecoder();

const ctx = (subject = "user_ada", presence: RunContext["presence"] = "present"): RunContext => ({
  principal: { kind: "user", subject },
  venue: "chat",
  presence,
  sessionId: `session_${subject}`,
});

const jsonResponse = (value: unknown, status = 200) => ({
  status,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(value),
});

const putApp = async (
  store: ReturnType<typeof memoryStore>,
  app: AppDocument,
  subject = "user_ada",
): Promise<void> => {
  await store.records("vendo_apps").put({ id: app.id, data: app, refs: { subject } });
};

const emptyTools: ToolRegistry = {
  async descriptors() { return []; },
  async execute() { return { status: "error", error: { code: "not-found", message: "missing" } }; },
};

describe("apps execution", () => {
  it("calls fn refs through the machine and contains envelope violations", async () => {
    const sandbox = fakeSandbox();
    const machineApp: MachineApp = (request) => {
      if (request.path === "/fn/total") return jsonResponse({ result: 42 });
      if (request.path === "/fn/both") return jsonResponse({ result: 1, ui: { formatVersion: "vendo-genui/v1" } });
      if (request.path === "/fn/bare") return jsonResponse({ total: 42 });
      if (request.path === "/fn/result_ui") return jsonResponse({ result: { ui: "ordinary data" } });
      return jsonResponse({ error: { code: "missing", message: "No function" } }, 404);
    };
    const seed = await sandbox.create({ env: {} });
    seed.setApp(machineApp);
    const server = await seed.snapshot();
    const store = memoryStore();
    const runtime = createApps({ store, guard: guardFixture(), tools: emptyTools, sandbox, catalog: [], model });
    const created = await runtime.create({ prompt: "Calculator" }, ctx());
    await putApp(store, { ...created, server });

    await expect(runtime.call(created.id, "fn:total", {}, ctx())).resolves.toEqual({ status: "ok", output: 42 });
    await expect(runtime.call(created.id, "fn:both", {}, ctx())).resolves.toMatchObject({
      status: "error",
      error: { code: "validation" },
    });
    await expect(runtime.call(created.id, "fn:bare", {}, ctx())).resolves.toMatchObject({
      status: "error",
      error: { code: "validation" },
    });
    await expect(runtime.call(created.id, "fn:result_ui", {}, ctx())).resolves.toEqual({
      status: "ok",
      output: { ui: "ordinary data" },
    });
    const request = [...sandbox.machines.values()].at(-1)?.requests[0];
    expect(request).toMatchObject({
      method: "POST",
      path: "/fn/total",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ args: {} }),
    });
    expect(request?.headers?.authorization).toMatch(/^Bearer /);
    const resumed = [...sandbox.machines.values()].at(-1);
    const authorizations = resumed?.requests.map((item) => item.headers?.authorization);
    expect(new Set(authorizations).size).toBe(resumed?.requests.length);
  });

  it("accepts a validated rung-3 ui result while open stays on the instant path", async () => {
    const ui = {
      formatVersion: "vendo-genui/v1",
      root: "view",
      nodes: [{ id: "view", component: "Text", props: { text: "Computed" } }],
    } as const;
    const sandbox = fakeSandbox({
      app: (request) => request.path === "/fn/view"
        ? jsonResponse({ ui })
        : jsonResponse({ error: { code: "missing", message: "No function" } }, 404),
    });
    const seed = await sandbox.create({ env: {} });
    const server = await seed.snapshot();
    const store = memoryStore();
    const runtime = createApps({ store, guard: guardFixture(), tools: emptyTools, sandbox, catalog: [], model });
    const created = await runtime.create({ prompt: "Computed view" }, ctx());
    await putApp(store, { ...created, server });

    await expect(runtime.call(created.id, "fn:view", {}, ctx())).resolves.toEqual({
      status: "ok",
      output: { ui },
    });
    await expect(runtime.open(created.id, ctx())).resolves.toMatchObject({
      kind: "tree",
      payload: created.tree,
    });
  });

  it("resolves tree queries through bound tools and fails soft on pending approval", async () => {
    const descriptors: ToolDescriptor[] = [
      { name: "host_ok", description: "Returns data", inputSchema: { type: "object" }, risk: "read" },
      { name: "host_away", description: "Needs approval", inputSchema: { type: "object" }, risk: "read" },
    ];
    const rawTools: ToolRegistry = {
      async descriptors() { return descriptors; },
      async execute(call) { return { status: "ok", output: { tool: call.tool, args: call.args } }; },
    };
    const guard = guardFixture({ rules: { host_away: "ask" } });
    const tools = bindTools(guard, rawTools);
    const store = memoryStore();
    const runtime = createApps({ store, guard, tools, catalog: [], model });
    const created = await runtime.create({ prompt: "Queried" }, ctx());
    await putApp(store, {
      ...created,
      tree: {
        formatVersion: "vendo-genui/v1",
        root: "root",
        nodes: [{ id: "root", component: "Text" }],
        data: { retained: true, invoices: [{ total: 0 }] },
        queries: [
          { path: "/answer", tool: "host_ok", input: { n: 1 } },
          { path: "/invoices/0/total", tool: "host_ok", input: { n: 2 } },
          { path: "/private", tool: "host_away", input: {} },
        ],
      },
    });

    const surface = await runtime.open(created.id, ctx("user_ada", "away"));
    expect(surface.kind).toBe("tree");
    if (surface.kind !== "tree") throw new Error("Expected tree surface");
    expect(surface.payload.data).toEqual({
      retained: true,
      answer: { tool: "host_ok", args: { n: 1 } },
      invoices: [{ total: { tool: "host_ok", args: { n: 2 } } }],
    });
    expect(guard.approvals).toHaveLength(1);
  });

  it("contains a query fn ui envelope instead of replacing the open surface", async () => {
    const sandbox = fakeSandbox({
      app: () => jsonResponse({
        ui: { formatVersion: "vendo-genui/v1", root: "new", nodes: [{ id: "new", component: "Text" }] },
      }),
    });
    const seed = await sandbox.create({ env: {} });
    const server = await seed.snapshot();
    const store = memoryStore();
    const runtime = createApps({ store, guard: guardFixture(), tools: emptyTools, sandbox, catalog: [], model });
    const created = await runtime.create({ prompt: "Stable" }, ctx());
    await putApp(store, {
      ...created,
      server,
      tree: {
        formatVersion: "vendo-genui/v1",
        root: "root",
        nodes: [{ id: "root", component: "Text" }],
        data: { retained: true },
        queries: [{ path: "/replacement", tool: "fn:view", input: {} }],
      },
    });

    const surface = await runtime.open(created.id, ctx());
    expect(surface).toMatchObject({ kind: "tree", payload: { data: { retained: true } } });
  });

  it("serves rung 4 after background resume and returns the persisted cover while waking", async () => {
    const base = fakeSandbox();
    const seed = await base.create({ env: {} });
    const server = await seed.snapshot();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => { started = resolve; });
    const delayed: SandboxAdapter = {
      create: (spec) => base.create(spec),
      async resume(ref) {
        started();
        await gate;
        return base.resume(ref);
      },
    };
    const store = memoryStore();
    const runtime = createApps({ store, guard: guardFixture(), tools: emptyTools, sandbox: delayed, catalog: [], model });
    const created = await runtime.create({ prompt: "HTTP app" }, ctx());
    await putApp(store, { ...created, ui: "http", server });
    const cover = new Uint8Array([137, 80, 78, 71]);
    await store.blobs(`app:${created.id}`).put("cover.png", cover, { contentType: "image/png" });

    await expect(runtime.open(created.id, ctx())).resolves.toEqual({
      kind: "resuming",
      cover: `data:image/png;base64,${globalThis.btoa(String.fromCharCode(...cover))}`,
    });
    await startedPromise;
    release();
    await Promise.resolve();
    await Promise.resolve();
    await expect(runtime.open(created.id, ctx())).resolves.toEqual({
      kind: "http",
      url: expect.stringContaining("fake-machine"),
    });
  });

  it("rejects rung 4 when a resumed machine cannot produce a serving URL", async () => {
    const base = fakeSandbox();
    const seed = await base.create({ env: {} });
    const server = await seed.snapshot();
    const withoutUrl: SandboxAdapter = {
      create: (spec) => base.create(spec),
      async resume(ref) {
        const machine = await base.resume(ref);
        return {
          id: machine.id,
          request: (request) => machine.request(request),
          exec: (command, options) => machine.exec(command, options),
          files: machine.files,
          snapshot: () => machine.snapshot(),
          screenshot: () => machine.screenshot(),
          stop: () => machine.stop(),
        };
      },
    };
    const store = memoryStore();
    const runtime = createApps({ store, guard: guardFixture(), tools: emptyTools, sandbox: withoutUrl, catalog: [], model });
    const created = await runtime.create({ prompt: "No URL" }, ctx());
    await putApp(store, { ...created, ui: "http", server });

    await expect(runtime.open(created.id, ctx())).resolves.toEqual({ kind: "resuming" });
    await vi.waitFor(() => expect(base.machines.size).toBe(2));
    await expect(runtime.open(created.id, ctx())).rejects.toMatchObject({
      code: "sandbox-unavailable",
      message: "adapter cannot serve http apps",
    });
  });

  it("distinguishes missing adapters from fn calls on apps without servers", async () => {
    const store = memoryStore();
    const createdRuntime = createApps({ store, guard: guardFixture(), tools: emptyTools, catalog: [], model });
    const created = await createdRuntime.create({ prompt: "No server" }, ctx());
    await expect(createdRuntime.call(created.id, "fn:work", {}, ctx())).rejects.toMatchObject({
      code: "sandbox-unavailable",
    });

    const runtimeWithAdapter = createApps({
      store,
      guard: guardFixture(),
      tools: emptyTools,
      sandbox: fakeSandbox(),
      catalog: [],
      model,
    });
    await expect(runtimeWithAdapter.call(created.id, "fn:work", {}, ctx())).resolves.toMatchObject({
      status: "error",
      error: { code: "validation" },
    });
  });

  it("passes each app's egress allowlist through fresh machine creation", async () => {
    const base = fakeSandbox();
    let createSpec: Parameters<SandboxAdapter["create"]>[0] | undefined;
    const sandbox: SandboxAdapter = {
      create: async (spec) => {
        createSpec = spec;
        return base.create(spec);
      },
      resume: (ref) => base.resume(ref),
    };
    const sessions = createMachineSessions({
      store: memoryStore(),
      tokenSecret: "machine-test-secret",
      sandbox,
    });
    await sessions.withFork({
      format: VENDO_APP_FORMAT,
      id: "app_egress",
      name: "Egress app",
      egress: ["api.stripe.com"],
    }, ctx(), async ({ machine }) => machine.stop());

    expect(createSpec?.egress).toEqual(["api.stripe.com"]);
  });

  it("returns not-found for missing and foreign apps", async () => {
    const store = memoryStore();
    const runtime = createApps({ store, guard: guardFixture(), tools: emptyTools, catalog: [], model });
    const app = await runtime.create({ prompt: "Private" }, ctx());
    await expect(runtime.open("app_missing", ctx())).rejects.toMatchObject({ code: "not-found" });
    await expect(runtime.call(app.id, "host_ok", {}, ctx("user_other"))).rejects.toMatchObject({ code: "not-found" });
  });

  it("verifies signed run tokens and rejects tampering and expiry", async () => {
    const key = crypto.getRandomValues(new Uint8Array(32));
    const payload = {
      appId: "app_token",
      subject: "user_ada",
      runId: "run_token",
      presence: "away" as const,
      expiresAt: Date.now() + 60_000,
    };
    const token = await mintRunToken(key, payload);
    await expect(verifyRunToken(key, token)).resolves.toEqual(payload);
    const replacement = token.endsWith("x") ? "y" : "x";
    await expect(verifyRunToken(key, `${token.slice(0, -1)}${replacement}`)).resolves.toBeNull();
    const expired = await mintRunToken(key, { ...payload, expiresAt: Date.now() - 1 });
    await expect(verifyRunToken(key, expired)).resolves.toBeNull();
  });
});
