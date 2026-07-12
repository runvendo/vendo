import {
  VENDO_APP_FORMAT,
  type AppDocument,
  type RunContext,
  type ToolDescriptor,
  type ToolRegistry,
} from "@vendoai/core";
import { describe, expect, it, vi } from "vitest";
import { createApps } from "./index.js";
import type { SandboxAdapter } from "./sandbox.js";
import {
  bindTools,
  basicLanguageModel,
  fakeSandbox,
  guardFixture,
  memoryStore,
  seedAppRow,
  scriptedLanguageModel,
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
  await seedAppRow(store, app, subject);
};

const emptyTools: ToolRegistry = {
  async descriptors() { return []; },
  async execute() { return { status: "error", error: { code: "not-found", message: "missing" } }; },
};

describe("apps execution", () => {
  it("never lets a query path reach Object.prototype", async () => {
    const rawTools: ToolRegistry = {
      async descriptors() {
        return [{ name: "host_ok", description: "Returns data", inputSchema: { type: "object" }, risk: "read" }];
      },
      async execute() { return { status: "ok", output: "POLLUTED" }; },
    };
    const guard = guardFixture();
    const store = memoryStore();
    const runtime = createApps({ store, guard, tools: bindTools(guard, rawTools), catalog: [], model });
    const created = await runtime.create({ prompt: "Hostile" }, ctx());
    // An app document is untrusted input: model-written, or imported from a .vendoapp artifact.
    await putApp(store, {
      ...created,
      tree: {
        formatVersion: "vendo-genui/v1",
        root: "root",
        nodes: [{ id: "root", component: "Text" }],
        queries: [
          { path: "/__proto__/polluted", tool: "host_ok" },
          { path: "/constructor/prototype/polluted", tool: "host_ok" },
        ],
      },
    });

    const surface = await runtime.open(created.id, ctx());

    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.prototype).not.toHaveProperty("polluted");
    if (surface.kind !== "tree") throw new Error("Expected tree surface");
    expect(surface.payload.data).toEqual({});
  });

  it("caps array query indices and safely replaces the whole data model", async () => {
    const replacement = JSON.parse(
      '{"fresh":true,"arr":[],"__proto__":{"polluted":true},"constructor":{"polluted":true}}',
    ) as Record<string, unknown>;
    const rawTools: ToolRegistry = {
      async descriptors() {
        return [
          { name: "host_replace", description: "Replace data", inputSchema: { type: "object" }, risk: "read" },
          { name: "host_sparse", description: "Write sparse data", inputSchema: { type: "object" }, risk: "read" },
        ];
      },
      async execute(call) {
        return { status: "ok", output: call.tool === "host_replace" ? replacement : "too-far" };
      },
    };
    const guard = guardFixture();
    const store = memoryStore();
    const runtime = createApps({ store, guard, tools: bindTools(guard, rawTools), catalog: [], model });
    const created = await runtime.create({ prompt: "Bounded data" }, ctx());
    await putApp(store, {
      ...created,
      tree: {
        formatVersion: "vendo-genui/v1",
        root: "root",
        nodes: [{ id: "root", component: "Text" }],
        data: { stale: true, arr: ["old"] },
        queries: [
          { path: "", tool: "host_replace" },
          { path: "/arr/999999999", tool: "host_sparse" },
        ],
      },
    });

    const surface = await runtime.open(created.id, ctx());

    if (surface.kind !== "tree") throw new Error("Expected tree surface");
    expect(surface.payload.data).toEqual({ fresh: true, arr: [] });
    expect((surface.payload.data as { arr: unknown[] }).arr).toHaveLength(0);
    expect(Object.getPrototypeOf(surface.payload.data as object)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

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

  it("serves rung 4 after background resume without inventing a cover", async () => {
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
    await expect(runtime.open(created.id, ctx())).resolves.toEqual({ kind: "resuming" });
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
    const store = memoryStore();
    const runtime = createApps({
      store,
      guard: guardFixture(),
      tools: emptyTools,
      sandbox,
      catalog: [],
      model: scriptedLanguageModel(
        JSON.stringify({ rung: 2, files: [{ path: "/app/server.js", content: "export const value = 1;" }] }),
      ),
    });
    await seedAppRow(
      store,
      {
        format: VENDO_APP_FORMAT,
        id: "app_egress",
        name: "Egress app",
        egress: ["api.stripe.com"],
      },
      "user_ada",
    );

    await runtime.edit("app_egress", "Add a server", ctx());

    expect(createSpec?.egress).toEqual(["api.stripe.com"]);
  });

  it("returns not-found for missing and foreign apps", async () => {
    const store = memoryStore();
    const runtime = createApps({ store, guard: guardFixture(), tools: emptyTools, catalog: [], model });
    const app = await runtime.create({ prompt: "Private" }, ctx());
    await expect(runtime.open("app_missing", ctx())).rejects.toMatchObject({ code: "not-found" });
    await expect(runtime.call(app.id, "host_ok", {}, ctx("user_other"))).rejects.toMatchObject({ code: "not-found" });
  });

  it("rejects tampered and expired run tokens at the proxy", async () => {
    const sandbox = fakeSandbox();
    const store = memoryStore();
    const runtime = createApps({
      store,
      guard: guardFixture(),
      tools: emptyTools,
      sandbox,
      proxyUrl: "https://proxy.test",
      catalog: [],
      model,
    });
    const app = await runtime.create({ prompt: "Token app" }, ctx());
    await seedAppRow(store, { ...app, ui: "http" }, "user_ada");
    await runtime.open(app.id, ctx());
    await vi.waitFor(() => expect(sandbox.machines.size).toBe(1));
    const token = [...sandbox.machines.values()].at(-1)?.env.VENDO_RUN_TOKEN;
    expect(token).toBeTypeOf("string");

    const stateRequest = (bearer: string): Request => new Request("https://proxy.test/state", {
      headers: { authorization: `Bearer ${bearer}` },
    });
    const valid = await runtime.proxy.handler(stateRequest(token as string));
    expect(valid.status).toBe(200);

    // Mutate a character in the middle of the token (not the trailing base64url char,
    // whose low bits can be unused so a swap may decode to the same bytes — a flaky no-op tamper).
    const mid = Math.floor((token as string).length / 2);
    const orig = (token as string)[mid];
    const tampered = `${(token as string).slice(0, mid)}${orig === "A" ? "B" : "A"}${(token as string).slice(mid + 1)}`;
    expect(tampered).not.toBe(token);
    expect((await runtime.proxy.handler(stateRequest(tampered))).status).toBe(401);

    vi.useFakeTimers();
    try {
      vi.setSystemTime(Date.now() + 16 * 60 * 1_000);
      expect((await runtime.proxy.handler(stateRequest(token as string))).status).toBe(401);
    } finally {
      vi.useRealTimers();
    }
  });
});
