import {
  TOOL_NAME_PATTERN,
  toolDescriptorSchema,
  type RunContext,
  type ToolRegistry,
} from "@vendoai/core";
import { describe, expect, it } from "vitest";
import { createApps } from "./index.js";
import {
  bindTools,
  guardFixture,
  memoryStore,
  seedAppRow,
  scriptedLanguageModel,
} from "./testing/index.js";

const ctx: RunContext = {
  principal: { kind: "user", subject: "user_tools" },
  venue: "chat",
  presence: "present",
  sessionId: "session_tools",
};

const hostTools: ToolRegistry = {
  async descriptors() { return []; },
  async execute() { return { status: "error", error: { code: "not-found", message: "missing" } }; },
};

const generated = JSON.stringify({
  name: "Tool-built dashboard",
  tree: {
    formatVersion: "vendo-genui/v1",
    root: "root",
    nodes: [{ id: "root", component: "Text", source: "prewired", props: { text: "Ready" } }],
  },
});

describe("apps agent tools", () => {
  it("exposes exactly provider-safe draft-2020-12 descriptors with closed object inputs", async () => {
    const runtime = createApps({
      store: memoryStore(),
      guard: guardFixture(),
      tools: hostTools,
      catalog: [],
      model: scriptedLanguageModel(generated),
    });

    const descriptors = await runtime.agentTools().descriptors();

    expect(descriptors.map((descriptor) => descriptor.name)).toEqual([
      "vendo_apps_create",
      "vendo_apps_edit",
      "vendo_apps_open",
    ]);
    for (const descriptor of descriptors) {
      expect(TOOL_NAME_PATTERN.test(descriptor.name)).toBe(true);
      expect(toolDescriptorSchema.safeParse(descriptor).success).toBe(true);
      expect(descriptor.inputSchema).toMatchObject({
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        additionalProperties: false,
      });
      expect(() => JSON.stringify(descriptor.inputSchema)).not.toThrow();
    }
    // Creating a document is a rung-1-only, jailed UI operation: it cannot
    // reach host tools, a server machine, or the network.
    expect(descriptors.map((descriptor) => descriptor.risk)).toEqual(["read", "write", "read"]);
  });

  it("classifies only provable tree edits as read-class", async () => {
    const store = memoryStore();
    const runtime = createApps({
      store,
      guard: guardFixture(),
      tools: hostTools,
      catalog: [],
      model: scriptedLanguageModel(generated),
    });
    const created = await runtime.create({ prompt: "Build a dashboard" }, ctx);
    await seedAppRow(store, {
      ...created,
      id: "app_http",
      ui: "http",
      server: "fake:snap_http",
    }, ctx.principal.subject);

    await expect(runtime.agentToolRisk({
      id: "call_tree_edit",
      tool: "vendo_apps_edit",
      args: { appId: created.id, instruction: "Make the heading blue" },
    }, ctx)).resolves.toBe("read");
    await expect(runtime.agentToolRisk({
      id: "call_server_edit",
      tool: "vendo_apps_edit",
      args: { appId: created.id, instruction: "Persist this to the database" },
    }, ctx)).resolves.toBe("write");

    await expect(runtime.agentToolRisk({
      id: "call_missing_edit",
      tool: "vendo_apps_edit",
      args: { appId: "app_missing", instruction: "Make the heading blue" },
    }, ctx)).resolves.toBe("write");
    await expect(runtime.agentToolRisk({
      id: "call_http_edit",
      tool: "vendo_apps_edit",
      args: { appId: "app_http", instruction: "Make the heading blue" },
    }, ctx)).resolves.toBe("write");
    await expect(runtime.agentToolRisk({
      id: "call_bad_edit",
      tool: "vendo_apps_edit",
      args: { appId: created.id },
    }, ctx)).resolves.toBe("write");
    await expect(runtime.agentToolRisk({
      id: "call_host",
      tool: "host_accounts_update",
      args: {},
    }, ctx)).resolves.toBeUndefined();
  });

  it("keeps malformed and foreign edit calls write-class", async () => {
    const store = memoryStore();
    const runtime = createApps({
      store,
      guard: guardFixture(),
      tools: hostTools,
      catalog: [],
      model: scriptedLanguageModel(generated),
    });
    const created = await runtime.create({ prompt: "Build a dashboard" }, ctx);
    await seedAppRow(store, {
      ...created,
      id: "app_foreign",
    }, "user_other");

    for (const [id, args] of [
      ["call_null_edit", null],
      ["call_array_edit", []],
      ["call_primitive_edit", "invalid"],
    ] as const) {
      await expect(runtime.agentToolRisk({
        id,
        tool: "vendo_apps_edit",
        args,
      }, ctx)).resolves.toBe("write");
    }
    await expect(runtime.agentToolRisk({
      id: "call_foreign_edit",
      tool: "vendo_apps_edit",
      args: { appId: "app_foreign", instruction: "Make the heading blue" },
    }, ctx)).resolves.toBe("write");
  });

  it("creates and opens an app through the guard-bound fixture", async () => {
    const store = memoryStore();
    const guard = guardFixture();
    const runtime = createApps({
      store,
      guard,
      tools: hostTools,
      catalog: [],
      model: scriptedLanguageModel(generated),
    });
    const bound = bindTools(guard, runtime.agentTools());

    const created = await bound.execute({
      id: "call_create",
      tool: "vendo_apps_create",
      args: { prompt: "Build a dashboard" },
    }, ctx);
    expect(created).toMatchObject({
      status: "ok",
      output: { id: expect.stringMatching(/^app_/), name: "Tool-built dashboard" },
    });
    if (created.status !== "ok" || typeof created.output !== "object" || created.output === null) {
      throw new Error("Expected a created app");
    }
    const appId = (created.output as { id: string }).id;
    expect(await runtime.get(appId, ctx)).not.toBeNull();

    await expect(bound.execute({
      id: "call_open",
      tool: "vendo_apps_open",
      args: { appId },
    }, ctx)).resolves.toMatchObject({ status: "ok", output: { kind: "tree" } });
    expect(guard.audit.filter((event) => event.kind === "tool-call")).toHaveLength(2);
  });

  it("keeps the raw registry unbound while the umbrella wrapper blocks and audits", async () => {
    const store = memoryStore();
    const guard = guardFixture({ rules: { vendo_apps_create: "block" } });
    const runtime = createApps({
      store,
      guard,
      tools: hostTools,
      catalog: [],
      model: scriptedLanguageModel(generated),
    });
    const call = {
      id: "call_unbound_create",
      tool: "vendo_apps_create",
      args: { prompt: "Build directly" },
    };

    await expect(runtime.agentTools().execute(call, ctx)).resolves.toMatchObject({ status: "ok" });
    expect(await runtime.list(ctx)).toHaveLength(1);
    expect(guard.audit.filter((event) => event.kind === "tool-call")).toEqual([]);

    await expect(bindTools(guard, runtime.agentTools()).execute({ ...call, id: "call_bound_create" }, ctx))
      .resolves.toEqual({ status: "blocked", reason: "Programmed block for vendo_apps_create" });
    expect(await runtime.list(ctx)).toHaveLength(1);
    expect(guard.audit.filter((event) => event.kind === "tool-call")).toHaveLength(1);
  });

  it("contains runtime and input errors while preserving VendoError codes", async () => {
    const runtime = createApps({
      store: memoryStore(),
      guard: guardFixture(),
      tools: hostTools,
      catalog: [],
      model: scriptedLanguageModel(generated),
    });
    const registry = runtime.agentTools();

    await expect(registry.execute({
      id: "call_missing",
      tool: "vendo_apps_open",
      args: { appId: "app_missing" },
    }, ctx)).resolves.toEqual({
      status: "error",
      error: { code: "not-found", message: "app not found: app_missing" },
    });
    await expect(registry.execute({
      id: "call_bad_input",
      tool: "vendo_apps_create",
      args: { prompt: "ok", extra: true },
    }, ctx)).resolves.toMatchObject({
      status: "error",
      error: { code: "validation" },
    });
  });
});
