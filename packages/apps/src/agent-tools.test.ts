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
    expect(descriptors.map((descriptor) => descriptor.risk)).toEqual(["write", "write", "read"]);
    expect(descriptors.find(({ name }) => name === "vendo_apps_edit")?.description).toMatch(/retry.*same app/i);
  });

  it("surfaces a structured retryable edit failure instead of implying the app changed", async () => {
    const broken = JSON.stringify({
      ops: [{ op: "set-prop", nodeId: "missing", prop: "value", value: 1 }],
    });
    const runtime = createApps({
      store: memoryStore(),
      guard: guardFixture(),
      tools: hostTools,
      catalog: [],
      model: scriptedLanguageModel(generated, broken),
    });
    const created = await runtime.create({ prompt: "Build a dashboard" }, ctx);

    const outcome = await runtime.agentTools().execute({
      id: "call_edit_failure",
      tool: "vendo_apps_edit",
      args: { appId: created.id, instruction: "Change a missing card" },
    }, ctx);

    expect(outcome).toMatchObject({
      status: "ok",
      output: {
        app: created,
        failure: {
          code: "edit-rejected",
          retryable: true,
          message: expect.stringMatching(/same app/i),
        },
        issues: expect.arrayContaining([expect.stringContaining("missing")]),
      },
    });
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
