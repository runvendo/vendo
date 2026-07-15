import {
  validateTree,
  type AppDocument,
  type ComponentCatalog,
  type RunContext,
  type ToolRegistry,
} from "@vendoai/core";
import { describe, expect, it } from "vitest";
import { createApps } from "./index.js";
import type { SandboxAdapter } from "./sandbox.js";
import {
  fakeSandbox,
  guardFixture,
  memoryStore,
  seedAppRow,
  scriptedLanguageModel,
} from "./testing/index.js";

const ctx: RunContext = {
  principal: { kind: "user", subject: "user_engine" },
  venue: "chat",
  presence: "present",
  sessionId: "session_engine",
};

const tools: ToolRegistry = {
  async descriptors() { return []; },
  async execute() { return { status: "error", error: { code: "not-found", message: "missing" } }; },
};

const catalog: ComponentCatalog = [{
  name: "MetricCard",
  description: "A branded card for a label, value, and trend.",
  propsSchema: { "~standard": { validate: (value: unknown) => value } },
}];

const validCreate = (name = "Revenue dashboard") => JSON.stringify({
  name,
  description: "Shows the revenue headline.",
  tree: {
    formatVersion: "vendo-genui/v1",
    root: "metric",
    nodes: [{
      id: "metric",
      component: "MetricCard",
      source: "host",
      props: { label: "Revenue", value: "$42k" },
    }],
  },
});

const invalidCreate = JSON.stringify({
  name: "Broken",
  tree: {
    formatVersion: "vendo-genui/v1",
    root: "missing",
    nodes: [{ id: "root", component: "MetricCard", source: "host" }],
  },
});

const putApp = async (
  store: ReturnType<typeof memoryStore>,
  app: AppDocument,
): Promise<void> => {
  await seedAppRow(store, app, ctx.principal.subject);
};

describe("generation engine through createApps", () => {
  it("creates a validated rung-1 document with a catalog host component", async () => {
    const store = memoryStore();
    const runtime = createApps({
      store,
      guard: guardFixture(),
      tools,
      catalog,
      model: scriptedLanguageModel(validCreate()),
      designRules: "Use concise labels and the accent color for positive trends.",
    });

    const app = await runtime.create({ prompt: "Build a revenue dashboard" }, ctx);

    expect(app.name).toBe("Revenue dashboard");
    expect(app.server).toBeUndefined();
    expect(app.tree).toMatchObject({
      nodes: [{ component: "MetricCard", source: "host" }],
    });
    expect(validateTree({ ...app.tree, components: app.components }).ok).toBe(true);
  });

  it("repairs one invalid create and rejects two invalid attempts without persisting", async () => {
    const repairedStore = memoryStore();
    const repaired = createApps({
      store: repairedStore,
      guard: guardFixture(),
      tools,
      catalog,
      model: scriptedLanguageModel(invalidCreate, validCreate("Repaired")),
    });
    await expect(repaired.create({ prompt: "Repair me" }, ctx)).resolves.toMatchObject({ name: "Repaired" });

    const failedStore = memoryStore();
    const failed = createApps({
      store: failedStore,
      guard: guardFixture(),
      tools,
      catalog,
      model: scriptedLanguageModel(invalidCreate, invalidCreate),
    });
    await expect(failed.create({ prompt: "Still broken" }, ctx)).rejects.toMatchObject({
      code: "validation",
      detail: expect.arrayContaining([expect.stringContaining("root")]),
    });
    await expect(failed.list(ctx)).resolves.toEqual([]);
  });

  it("applies tree ops, records rung 1, and undo restores the previous document", async () => {
    const store = memoryStore();
    const runtime = createApps({
      store,
      guard: guardFixture(),
      tools,
      catalog,
      model: scriptedLanguageModel(
        validCreate(),
        JSON.stringify({ ops: [{ op: "set-prop", nodeId: "metric", prop: "value", value: "$84k" }] }),
      ),
    });
    const original = await runtime.create({ prompt: "Dashboard" }, ctx);

    const result = await runtime.edit(original.id, "Double the displayed revenue", ctx);

    expect(result.app.tree).toMatchObject({ nodes: [{ props: { value: "$84k" } }] });
    expect(result.version.rung).toBe(1);
    expect(await runtime.history(original.id).list()).toEqual([result.version]);
    await expect(runtime.history(original.id).undo()).resolves.toEqual(original);
  });

  it("contains twice-broken tree ops and leaves the original document untouched", async () => {
    const store = memoryStore();
    const brokenOps = JSON.stringify({
      ops: [{ op: "set-prop", nodeId: "missing", prop: "value", value: 1 }],
    });
    const runtime = createApps({
      store,
      guard: guardFixture(),
      tools,
      catalog,
      model: scriptedLanguageModel(validCreate(), brokenOps, brokenOps),
    });
    const original = await runtime.create({ prompt: "Dashboard" }, ctx);

    const result = await runtime.edit(original.id, "Break the missing card", ctx);

    expect(result.app).toEqual(original);
    expect(result.issues).toEqual(expect.arrayContaining([expect.stringContaining("missing") ]));
    expect(await runtime.get(original.id, ctx)).toEqual(original);
    expect(await runtime.history(original.id).list()).toEqual([]);
  });

  it("rejects moving a node under its own descendant without changing the document", async () => {
    const store = memoryStore();
    const moveCycle = JSON.stringify({
      ops: [{ op: "move-node", nodeId: "section", parentId: "leaf" }],
    });
    const runtime = createApps({
      store,
      guard: guardFixture(),
      tools,
      catalog,
      model: scriptedLanguageModel(moveCycle, moveCycle),
    });
    const original: AppDocument = {
      format: "vendo/app@1",
      id: "app_cycle",
      name: "Cycle guard",
      ui: "tree",
      tree: {
        formatVersion: "vendo-genui/v1",
        root: "root",
        nodes: [
          { id: "root", component: "Text", children: ["section"] },
          { id: "section", component: "Text", children: ["leaf"] },
          { id: "leaf", component: "Text" },
        ],
      },
    };
    await putApp(store, original);

    const result = await runtime.edit(original.id, "Move the section", ctx);

    expect(result.issues).toEqual(expect.arrayContaining([expect.stringContaining("descendant")]));
    expect(result.app).toEqual(original);
    expect(await runtime.get(original.id, ctx)).toEqual(original);
  });

  it("edits server files in a fork, syntax-checks, and rotates the snapshot", async () => {
    const sandbox = fakeSandbox();
    const seed = await sandbox.create({ env: {}, files: { "/app/server.js": "export const value = 1;" } });
    const server = await seed.snapshot();
    const store = memoryStore();
    const runtime = createApps({
      store,
      guard: guardFixture(),
      tools,
      sandbox,
      catalog,
      model: scriptedLanguageModel(
        validCreate(),
        JSON.stringify({ rung: 2, files: [{ path: "/app/server.js", content: "export const value = 2;" }] }),
      ),
    });
    const created = await runtime.create({ prompt: "Dashboard" }, ctx);
    const original = { ...created, server };
    await putApp(store, original);

    const result = await runtime.edit(created.id, "Change the server code", ctx);
    const editedMachine = [...sandbox.machines.values()].at(-1);

    expect(new TextDecoder().decode(await editedMachine?.files.read("/app/server.js"))).toBe("export const value = 2;");
    expect(editedMachine?.commands).toContainEqual({ cmd: "node --check '/app/server.js'", opts: { cwd: "/app", timeoutMs: 10_000 } });
    expect(result.app.server).not.toBe(server);
    expect(result.version.rung).toBe(2);
  });

  it("records a tree edit on a server-backed app as rung 2", async () => {
    const store = memoryStore();
    const original: AppDocument = {
      format: "vendo/app@1",
      id: "app_server_tree",
      name: "Server tree",
      ui: "tree",
      tree: {
        formatVersion: "vendo-genui/v1",
        root: "root",
        nodes: [{ id: "root", component: "Text" }],
      },
      server: "fake:snap_existing",
    };
    await putApp(store, original);
    const runtime = createApps({
      store,
      guard: guardFixture(),
      tools,
      catalog,
      model: scriptedLanguageModel(JSON.stringify({ ops: [{ op: "set-name", name: "Renamed" }] })),
    });

    const result = await runtime.edit(original.id, "Rename the title", ctx);

    expect(result.version.rung).toBe(2);
  });

  it("honors a model-declared rung 3 on a code edit with a generic instruction", async () => {
    const sandbox = fakeSandbox();
    const seed = await sandbox.create({ env: {}, files: { "/app/server.js": "export const value = 1;" } });
    const server = await seed.snapshot();
    const store = memoryStore();
    const runtime = createApps({
      store,
      guard: guardFixture(),
      tools,
      sandbox,
      catalog,
      model: scriptedLanguageModel(
        validCreate(),
        // rung 3 declared by the model; the instruction text does NOT match the
        // server-computed heuristic, so the old code recorded rung 2.
        JSON.stringify({ rung: 3, files: [{ path: "/app/server.js", content: "export const value = 3;" }] }),
      ),
    });
    const created = await runtime.create({ prompt: "Dashboard" }, ctx);
    await putApp(store, { ...created, server });

    const result = await runtime.edit(created.id, "Update the backend", ctx);

    expect(result.version.rung).toBe(3);
  });

  it("accepts a model-declared rung 4 for a tree app and flips the document ui", async () => {
    const sandbox = fakeSandbox();
    const store = memoryStore();
    const runtime = createApps({
      store,
      guard: guardFixture(),
      tools,
      sandbox,
      catalog,
      model: scriptedLanguageModel(
        validCreate(),
        JSON.stringify({ rung: 4, files: [{ path: "/app/custom.js", content: "export const ready = true;" }] }),
      ),
    });
    const original = await runtime.create({ prompt: "Dashboard" }, ctx);

    const result = await runtime.edit(original.id, "Update the backend", ctx);

    expect(result.issues).toBeUndefined();
    expect(result.version.rung).toBe(4);
    expect(result.app.ui).toBe("http");
    expect(result.app.tree).toEqual(original.tree);
    expect(result.app.server).toMatch(/^fake:snap_/);
    expect(await runtime.get(original.id, ctx)).toEqual(result.app);
  });

  it("keeps the first graduated version on the scaffold and repairs reserved-file edits", async () => {
    const sandbox = fakeSandbox();
    const store = memoryStore();
    const runtime = createApps({
      store,
      guard: guardFixture(),
      tools,
      sandbox,
      catalog,
      model: scriptedLanguageModel(
        validCreate(),
        JSON.stringify({
          rung: 4,
          files: [{ path: "/app/start.sh", content: "exec node /app/custom.js" }],
        }),
        JSON.stringify({
          rung: 4,
          files: [{ path: "/app/custom.js", content: "export const ready = true;" }],
        }),
      ),
    });
    const original = await runtime.create({ prompt: "Dashboard" }, ctx);

    const result = await runtime.edit(original.id, "Turn this into a full web app", ctx);

    expect(result.issues).toBeUndefined();
    const graduatedMachine = [...sandbox.machines.values()].at(-1);
    expect(new TextDecoder().decode(await graduatedMachine?.files.read("/app/.vendo/scaffold-server.cjs")))
      .toContain("process.env.PORT");
    expect(new TextDecoder().decode(await graduatedMachine?.files.read("/app/start.sh")))
      .toContain("/app/.vendo/scaffold-server.cjs");
    expect(new TextDecoder().decode(await graduatedMachine?.files.read("/app/custom.js")))
      .toBe("export const ready = true;");
  });

  it("evicts a snapshotted code-edit machine before the next fn call", async () => {
    const base = fakeSandbox();
    const seed = await base.create({ env: {} });
    const server = await seed.snapshot();
    const sandbox: SandboxAdapter = {
      create: (spec) => base.create(spec),
      async resume(ref) {
        const machine = await base.resume(ref);
        const snapshot = machine.snapshot.bind(machine);
        machine.snapshot = async () => {
          const nextRef = await snapshot();
          machine.stopped = true;
          return nextRef;
        };
        return machine;
      },
    };
    const store = memoryStore();
    const original: AppDocument = {
      format: "vendo/app@1",
      id: "app_pausing_snapshot",
      name: "Pausing snapshot",
      server,
    };
    await putApp(store, original);
    const runtime = createApps({
      store,
      guard: guardFixture(),
      tools,
      sandbox,
      catalog,
      model: scriptedLanguageModel(JSON.stringify({
        rung: 2,
        files: [{ path: "/app/server.js", content: "export const ready = true;" }],
      })),
    });

    await runtime.edit(original.id, "Change the server function", ctx);

    await expect(runtime.call(original.id, "fn:ready", {}, ctx)).resolves.toMatchObject({
      status: "ok",
      output: { name: "ready" },
    });
  });

  it("captures a rung-4 cover during a real code edit and returns it while resuming", async () => {
    const sandbox = fakeSandbox();
    const seed = await sandbox.create({ env: {} });
    const server = await seed.snapshot();
    const store = memoryStore();
    const original: AppDocument = {
      format: "vendo/app@1",
      id: "app_http_cover",
      name: "HTTP cover",
      ui: "http",
      server,
    };
    await putApp(store, original);
    const runtime = createApps({
      store,
      guard: guardFixture(),
      tools,
      sandbox,
      catalog,
      model: scriptedLanguageModel(JSON.stringify({
        rung: 4,
        files: [{ path: "/app/server.js", content: "export const ready = true;" }],
      })),
    });

    await runtime.edit(original.id, "Change the served web app", ctx);

    expect(await store.blobs(`app:${original.id}`).get("cover.png")).not.toBeNull();
    await expect(runtime.open(original.id, ctx)).resolves.toEqual({
      kind: "resuming",
      cover: expect.stringMatching(/^data:image\/png;base64,/),
    });
  });

  it("rejects an edit computed from a document changed before persistence", async () => {
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const startedPromise = new Promise<void>((resolve) => { started = resolve; });
    const store = memoryStore();
    const original: AppDocument = {
      format: "vendo/app@1",
      id: "app_stale_edit",
      name: "Original",
      ui: "tree",
      tree: {
        formatVersion: "vendo-genui/v1",
        root: "root",
        nodes: [{ id: "root", component: "Text" }],
      },
    };
    await putApp(store, original);
    const runtime = createApps({
      store,
      guard: guardFixture(),
      tools,
      catalog,
      model: scriptedLanguageModel(async () => {
        started();
        await gate;
        return JSON.stringify({ ops: [{ op: "set-name", name: "Model edit" }] });
      }),
    });

    const editing = runtime.edit(original.id, "Rename it", ctx);
    await startedPromise;
    const concurrent = { ...original, name: "Concurrent edit" };
    await putApp(store, concurrent);
    release();

    await expect(editing).rejects.toMatchObject({ code: "conflict" });
    await expect(runtime.get(original.id, ctx)).resolves.toEqual(concurrent);
  });

  it("discards a syntax-error code fork and leaves the document and prior machine untouched", async () => {
    const base = fakeSandbox();
    const seed = await base.create({ env: {}, files: { "/app/server.js": "export const value = 1;" } });
    const server = await seed.snapshot();
    const sandbox: SandboxAdapter = {
      create: (spec) => base.create(spec),
      async resume(ref) {
        const machine = await base.resume(ref);
        machine.programExec({ code: 1, stdout: "", stderr: "SyntaxError: Unexpected token" });
        return machine;
      },
    };
    const store = memoryStore();
    const runtime = createApps({
      store,
      guard: guardFixture(),
      tools,
      sandbox,
      catalog,
      model: scriptedLanguageModel(
        validCreate(),
        JSON.stringify({ rung: 2, files: [{ path: "/app/server.js", content: "export const = ;" }] }),
      ),
    });
    const created = await runtime.create({ prompt: "Dashboard" }, ctx);
    const original = { ...created, server };
    await putApp(store, original);

    const result = await runtime.edit(created.id, "Change the server code", ctx);

    expect(result.app).toEqual(original);
    expect(result.issues).toEqual(expect.arrayContaining([expect.stringContaining("SyntaxError") ]));
    expect(new TextDecoder().decode(await seed.files.read("/app/server.js"))).toBe("export const value = 1;");
    expect(await runtime.get(created.id, ctx)).toEqual(original);
  });

  it("graduates a rung-1 app only after the fork snapshots and preserves its tree", async () => {
    const sandbox = fakeSandbox();
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const startedPromise = new Promise<void>((resolve) => { started = resolve; });
    const model = scriptedLanguageModel(
      validCreate(),
      async () => {
        started();
        await gate;
        return JSON.stringify({
          rung: 2,
          files: [{ path: "/app/server.js", content: "export const state = new Map();" }],
        });
      },
    );
    const store = memoryStore();
    const runtime = createApps({ store, guard: guardFixture(), tools, sandbox, catalog, model });
    const original = await runtime.create({ prompt: "Dashboard" }, ctx);

    const editing = runtime.edit(original.id, "Build a server-computed view", ctx);
    await startedPromise;
    expect(await runtime.get(original.id, ctx)).toEqual(original);
    release();
    const result = await editing;

    expect(result.app.server).toMatch(/^fake:snap_/);
    expect(result.app.tree).toEqual(original.tree);
    expect(result.version.rung).toBe(3);
    expect(await runtime.get(original.id, ctx)).toEqual(result.app);
  });

  it("returns a contained issue when an edit requires an unavailable sandbox", async () => {
    const store = memoryStore();
    const runtime = createApps({
      store,
      guard: guardFixture(),
      tools,
      catalog,
      model: scriptedLanguageModel(validCreate()),
    });
    const original = await runtime.create({ prompt: "Dashboard" }, ctx);

    const result = await runtime.edit(original.id, "Persist mutations in server state", ctx);

    expect(result.app).toEqual(original);
    expect(result.issues).toContain("sandbox-unavailable: this edit requires server execution");
    expect(await runtime.history(original.id).list()).toEqual([]);
  });
});
