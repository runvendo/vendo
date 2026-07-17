import {
  validateTree,
  type AppDocument,
  type ComponentCatalog,
  type RunContext,
  type ToolRegistry,
} from "@vendoai/core";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createApps } from "./index.js";
import { pinComponentName } from "./pins.js";
import type { SandboxAdapter } from "./sandbox.js";
import {
  fakeSandbox,
  guardFixture,
  memoryStore,
  seedAppRow,
  scriptedLanguageModel,
  type ScriptedModelCall,
} from "./testing/index.js";
import { instructionRequiresServer, modelEngine } from "./engine.js";

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
  description: "Use for a single important metric with a short label and display value.",
  propsSchema: z.object({
    label: z.string(),
    value: z.string(),
    trend: z.number().optional(),
    onSelect: z.string().optional(),
  }),
  propsJsonSchema: {
    type: "object",
    properties: {
      label: { type: "string" },
      value: { type: "string" },
      trend: { type: "number" },
      onSelect: { type: "string" },
    },
    required: ["label", "value"],
    additionalProperties: false,
  },
  examples: ['{"label":"Revenue","value":"$42k","trend":12}'],
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

const promptText = (call: ScriptedModelCall): string => call.prompt.map((message) => {
  if (typeof message.content === "string") return message.content;
  return message.content.map((part) => part.text ?? "").join("");
}).join("\n");

const generatedTreeApp = (): AppDocument => ({
  format: "vendo/app@1",
  id: "app_generated_edit",
  name: "Generated dashboard",
  ui: "tree",
  tree: {
    formatVersion: "vendo-genui/v1",
    root: "root",
    nodes: [
      { id: "root", component: "Stack", source: "prewired", children: ["existing"] },
      { id: "existing", component: "ExistingPanel", source: "generated" },
    ],
  },
  components: {
    ExistingPanel: "export default function ExistingPanel() { return <section>Existing</section>; }",
  },
});

describe("generation engine through createApps", () => {
  it("fails closed when a tree-classified edit unexpectedly yields server code", async () => {
    const store = memoryStore();
    const original: AppDocument = {
      format: "vendo/app@1",
      id: "app_unexpected_code",
      name: "Safe tree",
      ui: "tree",
      tree: {
        formatVersion: "vendo-genui/v1",
        root: "root",
        nodes: [{ id: "root", component: "Text", props: { text: "Safe" } }],
      },
    };
    await putApp(store, original);
    vi.spyOn(modelEngine, "edit").mockResolvedValueOnce({
      kind: "code",
      rung: 2,
      files: [{ path: "/app/server.js", content: "export const changed = true;" }],
    });
    const sandbox = fakeSandbox();
    const createMachine = vi.spyOn(sandbox, "create");
    const resumeMachine = vi.spyOn(sandbox, "resume");
    const runtime = createApps({
      store,
      guard: guardFixture(),
      tools,
      sandbox,
      catalog,
      model: scriptedLanguageModel("unused"),
    });

    const result = await runtime.edit(original.id, "Make the heading blue", ctx);

    expect(result.issues).toEqual([
      "approval-required: a tree-classified edit unexpectedly produced server code",
    ]);
    expect(result.app).toEqual(original);
    expect(await runtime.get(original.id, ctx)).toEqual(original);
    expect(await runtime.history(original.id).list()).toEqual([]);
    expect(sandbox.machines.size).toBe(0);
    expect(createMachine).not.toHaveBeenCalled();
    expect(resumeMachine).not.toHaveBeenCalled();
  });

  it("includes catalog schemas, when-to-use guidance, and usage examples in the model prompt", async () => {
    let capturedPrompt = "";
    const model = scriptedLanguageModel((call) => {
      capturedPrompt = call.prompt.map((message) => {
        if (typeof message.content === "string") return message.content;
        return message.content.map((part) => part.text ?? "").join("");
      }).join("\n");
      return validCreate();
    });
    const runtime = createApps({
      store: memoryStore(),
      guard: guardFixture(),
      tools,
      catalog,
      model,
    });

    await runtime.create({ prompt: "Build a revenue dashboard" }, ctx);

    expect(capturedPrompt).toContain('"whenToUse": "Use for a single important metric');
    expect(capturedPrompt).toContain('"propsJsonSchema": {');
    expect(capturedPrompt).toContain('"required": [');
    expect(capturedPrompt).toContain('"examples": [');
    expect(capturedPrompt).toContain('{\\"label\\":\\"Revenue\\",\\"value\\":\\"$42k\\",\\"trend\\":12}');
    expect(capturedPrompt).toContain('you MUST use a source:"host" node with its exact name and props schema');
  });

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

  it("reports wrong-typed host props as catalog issues", async () => {
    const wrongProps = JSON.stringify({
      name: "Broken metric",
      tree: {
        formatVersion: "vendo-genui/v1",
        root: "metric",
        nodes: [{
          id: "metric",
          component: "MetricCard",
          source: "host",
          props: { label: "Revenue", value: 42 },
        }],
      },
    });
    const runtime = createApps({
      store: memoryStore(),
      guard: guardFixture(),
      tools,
      catalog,
      model: scriptedLanguageModel(wrongProps, wrongProps),
    });

    await expect(runtime.create({ prompt: "Build a broken metric" }, ctx)).rejects.toMatchObject({
      code: "validation",
      detail: expect.arrayContaining([
        expect.stringMatching(/node "metric" props.*MetricCard.*value.*Expected string/i),
      ]),
    });
  });

  it("exempts path, state, and action bindings while validating the remaining host props", async () => {
    const boundProps = JSON.stringify({
      name: "Bound metric",
      tree: {
        formatVersion: "vendo-genui/v1",
        root: "metric",
        nodes: [{
          id: "metric",
          component: "MetricCard",
          source: "host",
          props: {
            label: { $path: "/headline/label" },
            value: { $state: "selectedValue" },
            onSelect: { action: "selectMetric", payload: { id: "revenue" } },
          },
        }],
      },
    });
    const runtime = createApps({
      store: memoryStore(),
      guard: guardFixture(),
      tools,
      catalog,
      model: scriptedLanguageModel(boundProps),
    });

    await expect(runtime.create({ prompt: "Build a bound metric" }, ctx)).resolves.toMatchObject({
      tree: { nodes: [{ component: "MetricCard" }] },
    });
  });

  it("streams node-boundary view snapshots, resolves queries during create, and finishes with the open result", async () => {
    const streamed = [
      '{"name":"Streaming dashboard","tree":{"formatVersion":"vendo-genui/v1","root":"root","nodes":[{"id":"root","component":"Stack","source":"prewired","children":["metric"]},',
      '{"id":"metric","component":"Text","source":"prewired","props":{"text":{"$path":"/metric"}}}],"queries":[{"path":"/metric","tool":"host_metric"}]}}',
    ];
    const queryTools: ToolRegistry = {
      async descriptors() { return []; },
      async execute(call) {
        return call.tool === "host_metric"
          ? { status: "ok", output: "$42k" }
          : { status: "error", error: { code: "not-found", message: "missing" } };
      },
    };
    const runtime = createApps({
      store: memoryStore(),
      guard: guardFixture(),
      tools: queryTools,
      catalog: [],
      model: scriptedLanguageModel(streamed),
    });
    const views: Array<{ appId: string; payload: Record<string, unknown> }> = [];

    const app = await runtime.create({
      prompt: "Build a streaming dashboard",
      onView: (part) => views.push(part as unknown as typeof views[number]),
    }, ctx);
    const opened = await runtime.open(app.id, ctx);

    expect(views.length).toBeGreaterThanOrEqual(3);
    expect(views.every((view) => view.appId === app.id)).toBe(true);
    expect(views[0]?.payload).toMatchObject({ streaming: true, nodes: [{ id: "root" }] });
    expect(views.some((view) => (view.payload.data as { metric?: string } | undefined)?.metric === "$42k")).toBe(true);
    expect(views.at(-1)?.payload).not.toHaveProperty("streaming");
    expect(opened).toMatchObject({ kind: "tree" });
    if (opened.kind !== "tree") throw new Error("Expected a tree surface");
    expect(views.at(-1)?.payload).toEqual(opened.payload);
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

  it("forks a captured host slot and records a per-pin replayable intent trail", async () => {
    const store = memoryStore();
    const source = `export default function MapleNetWorthCard() {
  return <section><h2>Net worth</h2><strong>$1.2M</strong></section>;
}`;
    const slot = "net-worth-card";
    const componentName = pinComponentName(slot);
    const model = scriptedLanguageModel(
      (call) => {
        const prompt = call.prompt.map((message) => typeof message.content === "string"
          ? message.content
          : message.content.map((part) => part.text ?? "").join("")).join("\n");
        expect(prompt).toContain("REMIXABLE HOST SLOTS");
        expect(prompt).toContain(slot);
        expect(prompt).toContain("MapleNetWorthCard");
        expect(prompt).toContain("$1.2M");
        expect(prompt).toContain(componentName);
        return JSON.stringify({
          ops: [{ op: "fork-pin", slot, nodeId: "maple-net-worth", parentId: "root" }],
        });
      },
      JSON.stringify({
        ops: [{
          op: "add-component",
          name: componentName,
          source: source.replace("$1.2M", "$1.4M"),
        }],
      }),
      JSON.stringify({ ops: [{ op: "set-name", name: "Maple overview" }] }),
    );
    const runtime = createApps({
      store,
      guard: guardFixture(),
      tools,
      catalog,
      model,
      pinBaselines: [{
        slot,
        source,
        hash: "sha256:maple-base",
        exportable: false,
        capturedAt: "2026-07-14T12:00:00.000Z",
      }],
    });
    const original: AppDocument = {
      format: "vendo/app@1",
      id: "app_maple_pin",
      name: "Maple overview",
      ui: "tree",
      tree: {
        formatVersion: "vendo-genui/v1",
        root: "root",
        nodes: [{ id: "root", component: "Stack", source: "prewired" }],
      },
    };
    await putApp(store, original);

    const forked = await runtime.edit(original.id, "Remix the net worth card", ctx);
    expect(forked.issues).toBeUndefined();
    expect(forked.app.pins).toEqual([{ slot, base: "sha256:maple-base" }]);
    expect(forked.app.components?.[componentName]).toBe(source);
    expect(forked.app.tree).toMatchObject({
      nodes: expect.arrayContaining([expect.objectContaining({
        id: "maple-net-worth",
        component: componentName,
        source: "generated",
      })]),
    });

    await runtime.edit(original.id, "Increase the displayed net worth", ctx);
    await runtime.edit(original.id, "Rename the app", ctx);

    const rows = await store.records(`vendo:app-pin-intents:${original.id}`).list();
    const trails = rows.records.map((record) => record.data);
    expect(trails).toEqual(expect.arrayContaining([
      expect.objectContaining({ slot, intent: "Remix the net worth card" }),
      expect.objectContaining({ slot, intent: "Increase the displayed net worth" }),
    ]));
    expect(trails).toHaveLength(2);
  });

  it("forks a named-export host slot with a synthesized default export (ENG-348)", async () => {
    const store = memoryStore();
    const source = `export function MapleNetWorthCard() {
  return <section><h2>Net worth</h2><strong>$1.2M</strong></section>;
}`;
    const slot = "net-worth-card";
    const componentName = pinComponentName(slot);
    const runtime = createApps({
      store,
      guard: guardFixture(),
      tools,
      catalog,
      model: scriptedLanguageModel(JSON.stringify({
        ops: [{ op: "fork-pin", slot, nodeId: "maple-net-worth", parentId: "root" }],
      })),
      pinBaselines: [{
        slot,
        source,
        hash: "sha256:maple-base",
        exportable: false,
        capturedAt: "2026-07-14T12:00:00.000Z",
      }],
    });
    const original: AppDocument = {
      format: "vendo/app@1",
      id: "app_maple_named_pin",
      name: "Maple overview",
      ui: "tree",
      tree: {
        formatVersion: "vendo-genui/v1",
        root: "root",
        nodes: [{ id: "root", component: "Stack", source: "prewired" }],
      },
    };
    await putApp(store, original);

    const forked = await runtime.edit(original.id, "Remix the net worth card", ctx);
    expect(forked.issues).toBeUndefined();
    expect(forked.app.pins).toEqual([{ slot, base: "sha256:maple-base" }]);
    // The jail entry renders only a default export; the fork ships the captured
    // source plus the synthesized alias so the remix never crashes at render.
    expect(forked.app.components?.[componentName])
      .toBe(`${source}\nexport { MapleNetWorthCard as default };\n`);
  });

  it("refuses to fork a baseline with no detectable component export, loudly", async () => {
    const store = memoryStore();
    const slot = "net-worth-card";
    const forkOps = JSON.stringify({
      ops: [{ op: "fork-pin", slot, nodeId: "maple-net-worth", parentId: "root" }],
    });
    const runtime = createApps({
      store,
      guard: guardFixture(),
      tools,
      catalog,
      model: scriptedLanguageModel(forkOps, forkOps),
      pinBaselines: [{
        slot,
        source: "const NetWorthCard = () => null;",
        hash: "sha256:maple-base",
        exportable: false,
        capturedAt: "2026-07-14T12:00:00.000Z",
      }],
    });
    const original: AppDocument = {
      format: "vendo/app@1",
      id: "app_maple_unexported_pin",
      name: "Maple overview",
      ui: "tree",
      tree: {
        formatVersion: "vendo-genui/v1",
        root: "root",
        nodes: [{ id: "root", component: "Stack", source: "prewired" }],
      },
    };
    await putApp(store, original);

    const result = await runtime.edit(original.id, "Remix the net worth card", ctx);
    expect(result.app).toEqual(original);
    expect(result.issues).toEqual(expect.arrayContaining([
      expect.stringContaining("no default export"),
    ]));
    // The unrenderable fork was refused at fork time, never persisted.
    expect(await runtime.get(original.id, ctx)).toEqual(original);
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

  it("retries a failed tree-edit plan with cumulative, indexed repair feedback", async () => {
    const store = memoryStore();
    const original = generatedTreeApp();
    await putApp(store, original);
    const duplicateRoot = JSON.stringify({
      ops: [{
        op: "add-node",
        node: { id: "root", component: "Stack", source: "prewired" },
      }],
    });
    const malformedComponent = JSON.stringify({
      ops: [{ op: "add-component", component: { name: "PeriodFilter", source: "export default null" } }],
    });
    const repaired = JSON.stringify({
      ops: [
        {
          op: "add-component",
          name: "PeriodFilter",
          source: "export default function PeriodFilter() { return <select><option>All time</option></select>; }",
        },
        {
          op: "add-node",
          node: { id: "filter", component: "PeriodFilter", source: "generated" },
          parentId: "root",
          index: 1,
        },
      ],
    });
    const runtime = createApps({
      store,
      guard: guardFixture(),
      tools,
      catalog: [],
      model: scriptedLanguageModel(
        duplicateRoot,
        malformedComponent,
        (call) => {
          const prompt = promptText(call).replaceAll('\\"', '"');
          expect(prompt).toContain('tree op[0] add-node failed: node "root" already exists');
          expect(prompt).toContain("tree op[0] add-component failed: requires name and source strings");
          expect(prompt).toContain('"index"');
          expect(prompt).toContain('"nodeId"');
          return repaired;
        },
      ),
    });

    const result = await runtime.edit(original.id, "Add a filter dropdown", ctx);

    expect(result.failure).toBeUndefined();
    expect(result.issues).toBeUndefined();
    expect(result.app.tree?.nodes.find(({ id }) => id === "root")?.children).toEqual(["existing", "filter"]);
    expect(result.app.components).toMatchObject({
      ExistingPanel: original.components?.ExistingPanel,
      PeriodFilter: expect.stringContaining("<select>"),
    });
  });

  it("rejects an edit that leaves the rooted view empty and returns a retryable failure", async () => {
    const store = memoryStore();
    const original = generatedTreeApp();
    await putApp(store, original);
    const removeOnlyContent = JSON.stringify({
      ops: [{ op: "remove-node", nodeId: "existing" }],
    });
    const runtime = createApps({
      store,
      guard: guardFixture(),
      tools,
      catalog: [],
      model: scriptedLanguageModel(removeOnlyContent),
    });

    const result = await runtime.edit(original.id, "Remove the only visible panel", ctx);

    expect(result.failure).toMatchObject({ code: "edit-rejected", retryable: true });
    expect(result.issues).toEqual(expect.arrayContaining([expect.stringContaining("empty")]));
    expect(result.app).toEqual(original);
    expect(await runtime.get(original.id, ctx)).toEqual(original);
  });

  it("rejects unsupported position aliases instead of silently misplacing an added node", async () => {
    const store = memoryStore();
    const original = generatedTreeApp();
    await putApp(store, original);
    const source = "export default function PeriodFilter() { return <select><option>All</option></select>; }";
    const runtime = createApps({
      store,
      guard: guardFixture(),
      tools,
      catalog: [],
      model: scriptedLanguageModel(
        JSON.stringify({
          ops: [
            { op: "add-component", name: "PeriodFilter", source },
            {
              op: "add-node",
              node: { id: "filter", component: "PeriodFilter", source: "generated" },
              parentId: "root",
              position: 0,
            },
          ],
        }),
        (call) => {
          expect(promptText(call).replaceAll('\\"', '"')).toContain('tree op[1] add-node failed: unsupported field "position"');
          return JSON.stringify({
            ops: [
              { op: "add-component", name: "PeriodFilter", source },
              {
                op: "add-node",
                node: { id: "filter", component: "PeriodFilter", source: "generated" },
                parentId: "root",
                index: 0,
              },
            ],
          });
        },
      ),
    });

    const result = await runtime.edit(original.id, "Put a filter before the dashboard", ctx);

    expect(result.failure).toBeUndefined();
    expect(result.app.tree?.nodes.find(({ id }) => id === "root")?.children).toEqual(["filter", "existing"]);
  });

  it("repairs parent placement fields nested inside add-node instead of persisting an orphan", async () => {
    const store = memoryStore();
    const original = generatedTreeApp();
    await putApp(store, original);
    const source = "export default function PeriodFilter() { return <select><option>All</option></select>; }";
    const runtime = createApps({
      store,
      guard: guardFixture(),
      tools,
      catalog: [],
      model: scriptedLanguageModel(
        JSON.stringify({
          ops: [
            { op: "add-component", name: "PeriodFilter", source },
            {
              op: "add-node",
              node: {
                id: "filter",
                component: "PeriodFilter",
                source: "generated",
                parentId: "root",
                position: 0,
              },
            },
          ],
        }),
        (call) => {
          const prompt = promptText(call).replaceAll('\\"', '"');
          expect(prompt).toContain('tree op[1] add-node failed: node has unsupported fields "parentId", "position"');
          expect(prompt).toContain("place parentId and index on the add-node operation");
          return JSON.stringify({
            ops: [
              { op: "add-component", name: "PeriodFilter", source },
              {
                op: "add-node",
                node: { id: "filter", component: "PeriodFilter", source: "generated" },
                parentId: "root",
                index: 0,
              },
            ],
          });
        },
      ),
    });

    const result = await runtime.edit(original.id, "Put a filter before the dashboard", ctx);

    expect(result.failure).toBeUndefined();
    expect(result.app.tree?.nodes.find(({ id }) => id === "root")?.children).toEqual(["filter", "existing"]);
    expect(result.app.tree?.nodes.filter(({ id }) => id === "filter")).toHaveLength(1);
  });

  it("rejects a move index that leaves a gap instead of silently appending the node", async () => {
    const store = memoryStore();
    const original = generatedTreeApp();
    await putApp(store, original);
    const runtime = createApps({
      store,
      guard: guardFixture(),
      tools,
      catalog: [],
      model: scriptedLanguageModel(
        JSON.stringify({
          ops: [{ op: "move-node", nodeId: "existing", parentId: "root", index: 4 }],
        }),
        (call) => {
          expect(promptText(call).replaceAll('\\"', '"')).toContain(
            'tree op[0] move-node failed: index 4 leaves a gap in parent "root" children (length 0)',
          );
          return JSON.stringify({
            ops: [{ op: "move-node", nodeId: "existing", parentId: "root", index: 0 }],
          });
        },
      ),
    });

    const result = await runtime.edit(original.id, "Keep the panel first", ctx);

    expect(result.failure).toBeUndefined();
    expect(result.app.tree?.nodes.find(({ id }) => id === "root")?.children).toEqual(["existing"]);
  });

  it("preserves existing generated component sources across unrelated tree ops", async () => {
    const store = memoryStore();
    const original = generatedTreeApp();
    await putApp(store, original);
    const runtime = createApps({
      store,
      guard: guardFixture(),
      tools,
      catalog: [],
      model: scriptedLanguageModel(JSON.stringify({
        ops: [{ op: "set-prop", nodeId: "existing", prop: "tone", value: "green" }],
      })),
    });

    const result = await runtime.edit(original.id, "Make the numbers green", ctx);

    expect(result.app.components).toEqual(original.components);
    await expect(runtime.open(original.id, ctx)).resolves.toMatchObject({
      kind: "tree",
      payload: { components: original.components },
      components: original.components,
    });
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

  it("routes every rung-4 phrase to the code dialect, so a custom-client ask graduates", async () => {
    // "custom client" is a FULL_WEB_APP phrase with no SERVER_INSTRUCTION word in
    // it; before the routing fix it took the tree dialect and could never graduate.
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

    const result = await runtime.edit(original.id, "Make this a custom client over the data", ctx);

    expect(result.issues).toBeUndefined();
    expect(result.version.rung).toBe(4);
    expect(result.app.ui).toBe("http");
    expect(result.app.tree).toEqual(original.tree);
  });

  it("routes a UI ask that mentions the API to the tree dialect (ENG-349)", async () => {
    // "API" and "function" are SERVER_INSTRUCTION words, but here they label
    // visible elements; before the routing fix this edit took the code dialect
    // and failed slowly (here: sandbox-unavailable, since no sandbox is wired).
    const store = memoryStore();
    const runtime = createApps({
      store,
      guard: guardFixture(),
      tools,
      catalog,
      model: scriptedLanguageModel(
        validCreate(),
        JSON.stringify({ ops: [{ op: "set-prop", nodeId: "metric", prop: "label", value: "API status" }] }),
      ),
    });
    const original = await runtime.create({ prompt: "Dashboard" }, ctx);

    const result = await runtime.edit(original.id, "Make the API status card blue", ctx);

    expect(result.issues).toBeUndefined();
    expect(result.version.rung).toBe(1);
    expect(result.app.tree).toMatchObject({ nodes: [{ props: { label: "API status" } }] });
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

describe("instructionRequiresServer (ENG-349)", () => {
  const app = (ui?: "tree" | "http"): AppDocument => ({
    format: "vendo/app@1",
    id: "app_router",
    name: "Router fixture",
    ...(ui === undefined ? {} : { ui }),
  });

  it.each([
    "Make the API status card blue",
    "Rename the function list header",
    "Move the HTTP status badge next to the title",
    "Update the External vendors table caption",
    "Make the secret santa list festive",
  ])("routes the UI ask %j to the tree dialect", (instruction) => {
    expect(instructionRequiresServer(app(), instruction)).toBe(false);
  });

  it.each([
    "Add a server function that calls the api and stores results",
    "Call the external api and cache the results",
    "Add a function that fetches live prices",
    "Use my secret key to authenticate the request",
    "Persist mutations in server state",
    "Make the api card blue and call the api for fresh data",
    "Make this a custom client over the data",
    "Turn this into a full web app",
  ])("routes the server ask %j to the code dialect", (instruction) => {
    expect(instructionRequiresServer(app(), instruction)).toBe(true);
  });

  it("always routes an http app to the code dialect", () => {
    expect(instructionRequiresServer(app("http"), "Make the heading blue")).toBe(true);
  });
});
