import {
  validateTree,
  validateTreeV2,
  type AppDocument,
  type NormalizedCatalog,
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

// The engine consumes the composition-normalized catalog (01 §14): the
// propsJsonSchema below is the DERIVED document, never host-authored.
const catalog: NormalizedCatalog = [{
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

const validCreate = (name = "Revenue dashboard") =>
  `<App name="${name}"><MetricCard label="Revenue" value="$42k"/></App>`;

const invalidCreate = '<App name="Broken"><MetricCard/></App>';

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
    formatVersion: "vendo-genui/v2",
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
        formatVersion: "vendo-genui/v2",
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


  it("reports wrong-typed host props as catalog issues", async () => {
    const wrongProps = '<App name="Broken metric"><MetricCard label="Revenue" value={42}/></App>';
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
        expect.stringMatching(/node "metriccard-1" props.*MetricCard.*value.*Expected string/i),
      ]),
    });
  });

  it("validates schema-less catalog entries permissively and prompts description-only (01 §14)", async () => {
    const schemaless: NormalizedCatalog = [{
      name: "PlainCard",
      description: "The model infers props for this card.",
    }];
    let capturedPrompt = "";
    const model = scriptedLanguageModel((call: ScriptedModelCall) => {
      capturedPrompt = call.prompt.map((message) => {
        if (typeof message.content === "string") return message.content;
        return message.content.map((part) => part.text ?? "").join("");
      }).join("\n");
      // v2 JSX wire (format-gen-v2): arbitrary props on a schema-less host
      // entry must pass the permissive validator.
      return '<App name="Plain app"><PlainCard goes={42}/></App>';
    });
    const runtime = createApps({
      store: memoryStore(),
      guard: guardFixture(),
      tools,
      catalog: schemaless,
      model,
    });

    await expect(runtime.create({ prompt: "Build a plain card" }, ctx)).resolves.toMatchObject({
      tree: {
        nodes: expect.arrayContaining([
          expect.objectContaining({ component: "PlainCard", source: "host" }),
        ]),
      },
    });
    expect(capturedPrompt).toContain('"whenToUse": "The model infers props for this card."');
    expect(capturedPrompt).toContain('"propsJsonSchema": null');
  });

  it("exempts path, state, and action bindings while validating the remaining host props", async () => {
    const boundProps = [
      '<App name="Bound metric"><Query id="headline" tool="host_headline"/>',
      '<MetricCard label={headline.label} value={state.selectedValue} onSelect="selectMetric"/></App>',
    ].join("");
    const bindingTools: ToolRegistry = {
      async descriptors() {
        return [{
          name: "host_headline",
          description: "Headline metric",
          inputSchema: { type: "object" },
          risk: "read",
        }];
      },
      async execute() { return { status: "ok", output: { label: "Revenue" } }; },
    };
    const runtime = createApps({
      store: memoryStore(),
      guard: guardFixture(),
      tools: bindingTools,
      catalog,
      model: scriptedLanguageModel(boundProps),
    });

    await expect(runtime.create({ prompt: "Build a bound metric" }, ctx)).resolves.toMatchObject({
      tree: { nodes: [{ component: "Stack" }, { component: "MetricCard" }] },
    });
  });



  it("applies a wire edit patch, records rung 1, and undo restores the previous document", async () => {
    const store = memoryStore();
    const runtime = createApps({
      store,
      guard: guardFixture(),
      tools,
      catalog,
      model: scriptedLanguageModel(
        validCreate(),
        '<Edit><Set id="metriccard-1" value="$84k"/></Edit>',
      ),
    });
    const original = await runtime.create({ prompt: "Dashboard" }, ctx);

    const result = await runtime.edit(original.id, "Double the displayed revenue", ctx);

    expect(result.app.tree).toMatchObject({ nodes: [{ id: "root" }, { props: { value: "$84k" } }] });
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
        return `<Edit><ForkPin slot="${slot}" into="root"/></Edit>`;
      },
      `<Edit><Island name="${componentName}">${source.replace("$1.2M", "$1.4M")}</Island></Edit>`,
      // Props-only edit to the pinned node: no source change, no base change —
      // the SUBTREE comparison alone must mark the slot touched (Devin, PR #375:
      // the v1-gated pinnedSubtree made this dead for v2 apps).
      `<Edit><Set id="${pinComponentName(slot).toLowerCase()}-1" tone="bold"/></Edit>`,
      '<Edit><SetName name="Maple overview"/></Edit>',
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
        formatVersion: "vendo-genui/v2",
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
        id: `${componentName.toLowerCase()}-1`,
        component: componentName,
        source: "generated",
      })]),
    });

    await runtime.edit(original.id, "Increase the displayed net worth", ctx);
    await runtime.edit(original.id, "Make the card bold", ctx);
    await runtime.edit(original.id, "Rename the app", ctx);

    const rows = await store.records(`vendo:app-pin-intents:${original.id}`).list();
    const trails = rows.records.map((record) => record.data);
    expect(trails).toEqual(expect.arrayContaining([
      expect.objectContaining({ slot, intent: "Remix the net worth card" }),
      expect.objectContaining({ slot, intent: "Increase the displayed net worth" }),
      expect.objectContaining({ slot, intent: "Make the card bold" }),
    ]));
    expect(trails).toHaveLength(3);
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
      model: scriptedLanguageModel(`<Edit><ForkPin slot="${slot}" into="root"/></Edit>`),
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
        formatVersion: "vendo-genui/v2",
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
    const forkOps = `<Edit><ForkPin slot="${slot}" into="root"/></Edit>`;
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
        formatVersion: "vendo-genui/v2",
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

  it("contains twice-broken wire patches and leaves the original document untouched", async () => {
    const store = memoryStore();
    const brokenOps = '<Edit><Set id="missing" value={1}/></Edit>';
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
    const unknownParent = '<Edit><Insert into="ghost-1"><PeriodFilter/></Insert></Edit>';
    const unknownOp = '<Edit><AddComponent name="PeriodFilter"/></Edit>';
    const repaired = `<Edit>
      <Island name="PeriodFilter">export default function PeriodFilter() { return <select><option>All time</option></select>; }</Island>
      <Insert into="root" at={1}><PeriodFilter/></Insert>
    </Edit>`;
    const runtime = createApps({
      store,
      guard: guardFixture(),
      tools,
      catalog: [],
      model: scriptedLanguageModel(
        unknownParent,
        unknownOp,
        (call) => {
          const prompt = promptText(call).replaceAll('\\"', '"');
          expect(prompt).toContain('wire unknown-target');
          expect(prompt).toContain('ghost-1');
          expect(prompt).toContain('wire invalid-patch-op: <AddComponent> is not an edit op');
          return repaired;
        },
      ),
    });

    const result = await runtime.edit(original.id, "Add a filter dropdown", ctx);

    expect(result.failure).toBeUndefined();
    expect(result.issues).toBeUndefined();
    expect(result.app.tree?.nodes.find(({ id }) => id === "root")?.children).toEqual(["existing", "periodfilter-1"]);
    expect(result.app.components).toMatchObject({
      ExistingPanel: original.components?.ExistingPanel,
      PeriodFilter: expect.stringContaining("<select>"),
    });
  });

  it("rejects an edit that leaves the rooted view empty and returns a retryable failure", async () => {
    const store = memoryStore();
    const original = generatedTreeApp();
    await putApp(store, original);
    const removeOnlyContent = '<Edit><Remove id="existing"/></Edit>';
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
        `<Edit><Island name="PeriodFilter">${source}</Island><Insert into="root" position={0}><PeriodFilter/></Insert></Edit>`,
        (call) => {
          expect(promptText(call).replaceAll('\\"', '"')).toContain('<Insert> does not take "position"');
          return `<Edit><Island name="PeriodFilter">${source}</Island><Insert into="root" at={0}><PeriodFilter/></Insert></Edit>`;
        },
      ),
    });

    const result = await runtime.edit(original.id, "Put a filter before the dashboard", ctx);

    expect(result.failure).toBeUndefined();
    expect(result.app.tree?.nodes.find(({ id }) => id === "root")?.children).toEqual(["periodfilter-1", "existing"]);
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
        '<Edit><Move id="existing" into="root" at={4}/></Edit>',
        (call) => {
          expect(promptText(call).replaceAll('\\"', '"')).toContain("leaves a gap");
          return '<Edit><Move id="existing" into="root" at={0}/></Edit>';
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
      model: scriptedLanguageModel('<Edit><Set id="existing" tone="green"/></Edit>'),
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
    const moveCycle = '<Edit><Move id="section" into="leaf"/></Edit>';
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
        formatVersion: "vendo-genui/v2",
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
        formatVersion: "vendo-genui/v2",
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
      model: scriptedLanguageModel('<Edit><SetName name="Renamed"/></Edit>'),
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
        '<Edit><Set id="metriccard-1" label="API status"/></Edit>',
      ),
    });
    const original = await runtime.create({ prompt: "Dashboard" }, ctx);

    const result = await runtime.edit(original.id, "Make the API status card blue", ctx);

    expect(result.issues).toBeUndefined();
    expect(result.version.rung).toBe(1);
    expect(result.app.tree).toMatchObject({ nodes: [{ id: "root" }, { props: { label: "API status" } }] });
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
        formatVersion: "vendo-genui/v2",
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
        return '<Edit><SetName name="Model edit"/></Edit>';
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

describe("v2 wire create", () => {
  const wireCreate = (name = "Revenue dashboard") =>
    `<App name="${name}"><MetricCard label="Revenue" value="$42k"/></App>`;

  it("creates a validated v2 document from the wire dialect", async () => {
    const store = memoryStore();
    const runtime = createApps({
      store,
      guard: guardFixture(),
      tools,
      catalog,
      model: scriptedLanguageModel(wireCreate()),
    });

    const app = await runtime.create({ prompt: "Build a revenue dashboard" }, ctx);

    expect(app.name).toBe("Revenue dashboard");
    expect(app.server).toBeUndefined();
    expect(app.components).toBeUndefined();
    expect(app.tree).toMatchObject({
      formatVersion: "vendo-genui/v2",
      root: "root",
      nodes: [
        { id: "root", component: "Stack", source: "prewired" },
        { id: "metriccard-1", component: "MetricCard", source: "host", props: { label: "Revenue", value: "$42k" } },
      ],
    });
    expect(validateTreeV2(app.tree).ok).toBe(true);
  });

  it("sends the wire dialect with the catalog and no v1 JSON contract", async () => {
    let capturedPrompt = "";
    const model = scriptedLanguageModel((call) => {
      capturedPrompt = promptText(call);
      return wireCreate();
    });
    const runtime = createApps({
      store: memoryStore(),
      guard: guardFixture(),
      tools,
      catalog,
      model,
    });

    await runtime.create({ prompt: "Build a revenue dashboard" }, ctx);

    expect(capturedPrompt).toContain("WIRE DIALECT (vendo-genui/v2)");
    expect(capturedPrompt).toContain('"whenToUse": "Use for a single important metric');
    expect(capturedPrompt).not.toContain('formatVersion is "vendo-genui/v2"');
    expect(capturedPrompt).not.toContain("CREATE DIALECT: emit exactly");
  });

  it("carries islands to document-level components, never on the tree", async () => {
    const wire = [
      '<App name="Noted"><RevenueNote/>',
      '<Island name="RevenueNote">export default function RevenueNote() { return <p>note</p>; }</Island></App>',
    ].join("");
    const runtime = createApps({
      store: memoryStore(),
      guard: guardFixture(),
      tools,
      catalog,
      model: scriptedLanguageModel(wire),
    });

    const app = await runtime.create({ prompt: "Build a note" }, ctx);

    expect(app.components).toStrictEqual({
      RevenueNote: "export default function RevenueNote() { return <p>note</p>; }",
    });
    expect(app.tree).not.toHaveProperty("components");
    expect(app.tree).toMatchObject({
      formatVersion: "vendo-genui/v2",
      nodes: [{ id: "root" }, { id: "revenuenote-1", component: "RevenueNote", source: "generated" }],
    });
  });

  it("streams valid-while-partial v2 payloads and finishes with resolved query data", async () => {
    const streamed = [
      '<App name="Streaming dashboard"><Query id="metric" tool="host_metric"/>',
      '<Stack gap={8}><Text text="Revenue"/>',
      '<MetricCard label="Revenue" value={metric}/></Stack></App>',
    ];
    const queryTools: ToolRegistry = {
      async descriptors() {
        return [{
          name: "host_metric",
          description: "Revenue metric",
          inputSchema: { type: "object" },
          risk: "read",
        }];
      },
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
      catalog,
      model: scriptedLanguageModel(streamed),
    });
    const views: Array<{ appId: string; payload: Record<string, unknown> }> = [];

    const app = await runtime.create({
      prompt: "Build a streaming dashboard",
      onView: (part) => views.push(part as unknown as typeof views[number]),
    }, ctx);
    const opened = await runtime.open(app.id, ctx);

    expect(views.length).toBeGreaterThanOrEqual(2);
    expect(views.every((view) => view.appId === app.id)).toBe(true);
    expect(views.every((view) => view.payload.formatVersion === "vendo-genui/v2")).toBe(true);
    expect(views[0]?.payload).toMatchObject({ streaming: true, nodes: [{ id: "root" }] });
    expect(views.some((view) => (view.payload.data as { metric?: string } | undefined)?.metric === "$42k")).toBe(true);
    expect(views.at(-1)?.payload).not.toHaveProperty("streaming");
    expect(opened).toMatchObject({ kind: "tree" });
    if (opened.kind !== "tree") throw new Error("Expected a tree surface");
    expect((opened.payload as { data?: { metric?: string } }).data?.metric).toBe("$42k");
    expect(views.at(-1)?.payload).toEqual(opened.payload);
  });

  it("repairs one invalid wire with issue feedback and rejects two invalid attempts", async () => {
    const invalidWire = '<App name="Broken"><MetricCard/></App>';
    const prompts: string[] = [];
    const model = scriptedLanguageModel((call) => {
      prompts.push(promptText(call));
      return prompts.length === 1 ? invalidWire : wireCreate("Repaired");
    });
    const runtime = createApps({
      store: memoryStore(),
      guard: guardFixture(),
      tools,
      catalog,
      model,
    });

    const app = await runtime.create({ prompt: "Build a metric" }, ctx);

    expect(app.name).toBe("Repaired");
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("REPAIR_THESE_ISSUES");
    expect(prompts[1]).toContain("MetricCard");

    const rejectingStore = memoryStore();
    const rejecting = createApps({
      store: rejectingStore,
      guard: guardFixture(),
      tools,
      catalog,
      model: scriptedLanguageModel(invalidWire, invalidWire),
    });
    await expect(rejecting.create({ prompt: "Build a metric" }, ctx)).rejects.toMatchObject({
      code: "validation",
    });
    expect(await rejecting.list(ctx)).toEqual([]);
  });
});

describe("tier0-wired create (two lanes)", () => {
  const deps = (model: Parameters<typeof createApps>[0]["model"], extra: Record<string, unknown> = {}) => ({
    model: model as NonNullable<Parameters<typeof createApps>[0]["model"]>,
    catalog,
    ...extra,
  }) as unknown as Parameters<typeof modelEngine.create>[1];

  const tier0Wire = '<App name="Instant board"><MetricCard label="Revenue" value="--"/></App>';
  const tier2Wire = '<App name="Full board"><MetricCard label="Revenue" value="$42k" trend={12}/></App>';

  it("paints a validated tier-0 app through onPartial, then returns the full-lane document", async () => {
    const prompts: string[] = [];
    const systems: string[] = [];
    const model = scriptedLanguageModel((call) => {
      const text = promptText(call);
      prompts.push(text);
      systems.push(text);
      return prompts.length === 1 ? tier0Wire : tier2Wire;
    });
    const partials: Array<{ name?: string }> = [];

    const document = await modelEngine.create(
      { prompt: "Build a revenue board" },
      deps(model, { onPartial: (partial: { name?: string }) => partials.push(partial) }),
    );

    expect(document.name).toBe("Full board");
    expect(prompts).toHaveLength(2);
    expect(systems[0]).toContain("PAINT PASS");
    expect(systems[1]).not.toContain("PAINT PASS");
    expect(systems[1]).toContain("TIER0_LAYOUT");
    expect(systems[1]).toContain("metriccard-1:MetricCard");
    expect(partials.some((partial) => partial.name === "Instant board")).toBe(true);
    expect(partials.some((partial) => partial.name === "Full board")).toBe(true);
  });

  it("falls back to the resident tier-0 document when the full lane cannot validate", async () => {
    let calls = 0;
    const model = scriptedLanguageModel(() => {
      calls += 1;
      return calls === 1 ? tier0Wire : '<App name="Broken"><MetricCard/></App>';
    });

    const document = await modelEngine.create(
      { prompt: "Build a revenue board" },
      deps(model, { onPartial: () => undefined }),
    );

    expect(document.name).toBe("Instant board");
    expect(calls).toBe(3); // tier-0 + full lane attempt + one repair attempt
  });

  it("skips the paint lane without a streaming consumer and when disabled", async () => {
    let calls = 0;
    const model = scriptedLanguageModel(() => {
      calls += 1;
      return tier2Wire;
    });

    await modelEngine.create({ prompt: "No stream" }, deps(model));
    expect(calls).toBe(1);

    await modelEngine.create(
      { prompt: "Stream but disabled" },
      deps(model, { onPartial: () => undefined, paint: { disabled: true } }),
    );
    expect(calls).toBe(2);
  });

  it("runs the paint lane on the dedicated no-think paint model when configured", async () => {
    const paintPrompts: string[] = [];
    const mainPrompts: string[] = [];
    const paintModel = scriptedLanguageModel((call) => {
      paintPrompts.push(promptText(call));
      return tier0Wire;
    });
    const model = scriptedLanguageModel((call) => {
      mainPrompts.push(promptText(call));
      return tier2Wire;
    });

    const document = await modelEngine.create(
      { prompt: "Build a revenue board" },
      deps(model, { onPartial: () => undefined, paint: { model: paintModel } }),
    );

    expect(document.name).toBe("Full board");
    expect(paintPrompts).toHaveLength(1);
    expect(paintPrompts[0]).toContain("PAINT PASS");
    expect(mainPrompts).toHaveLength(1);
  });
});

describe("wire extraction tolerance", () => {
  it("compiles a wire wrapped in a markdown fence or prose preamble", async () => {
    const fenced = "Here is the app:\n```xml\n" + validCreate("Fenced board") + "\n```\nDone!";
    const runtime = createApps({
      store: memoryStore(),
      guard: guardFixture(),
      tools,
      catalog,
      model: scriptedLanguageModel(fenced),
    });

    const app = await runtime.create({ prompt: "Build a fenced board" }, ctx);

    expect(app.name).toBe("Fenced board");
    expect(app.tree).toMatchObject({ formatVersion: "vendo-genui/v2" });
  });
});

describe("tier-2 hot-swap never regresses the resident paint", () => {
  it("suppresses full-lane partials smaller than the resident tier-0 tree", async () => {
    const tier0 = '<App name="Instant"><MetricCard label="Revenue" value="--"/><Text text="Loading detail"/></App>';
    const tier2Chunks = [
      '<App name="Full">',
      '<MetricCard label="Revenue" value="$42k"/>',
      '<Text text="Detail"/><Text text="More"/></App>',
    ];
    let calls = 0;
    const model = scriptedLanguageModel(() => {
      calls += 1;
      return calls === 1 ? tier0 : tier2Chunks;
    });
    const partials: number[] = [];

    const document = await modelEngine.create(
      { prompt: "Build it" },
      {
        model,
        catalog,
        onPartial: (partial: { tree: { nodes: unknown[] } }) => { partials.push(partial.tree.nodes.length); },
      } as unknown as Parameters<typeof modelEngine.create>[1],
    );

    expect(document.name).toBe("Full");
    // Tier-0 painted 3 nodes (root + card + text). Once resident, no later
    // partial may show fewer nodes than the resident paint.
    const residentSize = 3;
    const afterResident = partials.slice(partials.indexOf(residentSize) + 1);
    expect(afterResident.every((count) => count >= residentSize)).toBe(true);
  });
});

describe("v2 create integration guards (verify-v2 findings)", () => {
  const guardDeps = (model: unknown, extra: Record<string, unknown> = {}) => ({
    model,
    catalog,
    ...extra,
  }) as unknown as Parameters<typeof modelEngine.create>[1];

  it("strips a template-literal island wrapper and persists plain TSX", async () => {
    const wire = [
      '<App name="Wrapped"><Note/>',
      "<Island name=\"Note\">\n{`\nexport default function Note() { return <p>hi</p>; }\n`}\n</Island></App>",
    ].join("");
    const document = await modelEngine.create(
      { prompt: "Build it" },
      guardDeps(scriptedLanguageModel(wire)),
    );
    expect(document.components?.Note).toBe("export default function Note() { return <p>hi</p>; }");
  });

  it("repairs an island without a default export instead of persisting it", async () => {
    const broken = '<App name="NoExport"><Note/><Island name="Note">const nope = 1;</Island></App>';
    const fixed = '<App name="NoExport"><Note/><Island name="Note">export default function Note() { return <p>ok</p>; }</Island></App>';
    const prompts: string[] = [];
    const model = scriptedLanguageModel((call) => {
      prompts.push(promptText(call));
      return prompts.length === 1 ? broken : fixed;
    });
    const document = await modelEngine.create({ prompt: "Build it" }, guardDeps(model));
    expect(document.components?.Note).toContain("export default");
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("REPAIR_THESE_ISSUES");
    expect(prompts[1]).toContain("Note");
  });

  it("repairs a syntactically-broken island instead of persisting it", async () => {
    const broken = '<App name="Syntax"><Note/><Island name="Note">export default function Note() { return <p>oops</p>; </Island></App>';
    const fixed = '<App name="Syntax"><Note/><Island name="Note">export default function Note() { return <p>ok</p>; }</Island></App>';
    let calls = 0;
    const model = scriptedLanguageModel(() => {
      calls += 1;
      return calls === 1 ? broken : fixed;
    });
    const document = await modelEngine.create({ prompt: "Build it" }, guardDeps(model));
    expect(document.components?.Note).toContain("return <p>ok</p>");
    expect(calls).toBe(2);
  });

  it("rejects a query naming a tool absent from the host registry and repairs", async () => {
    const invented = '<App name="Tools"><Query id="rev" tool="get_revenue_history"/><MetricCard label="Revenue" value={rev}/></App>';
    const valid = '<App name="Tools"><Query id="rev" tool="host_metric"/><MetricCard label="Revenue" value={rev}/></App>';
    const prompts: string[] = [];
    const model = scriptedLanguageModel((call) => {
      prompts.push(promptText(call));
      return prompts.length === 1 ? invented : valid;
    });
    const document = await modelEngine.create(
      { prompt: "Build it" },
      guardDeps(model, { tools: [{ name: "host_metric", description: "Revenue metric", risk: "read" }] }),
    );
    expect((document.tree as { queries?: Array<{ tool: string }> }).queries).toEqual([
      { name: "rev", tool: "host_metric" },
    ]);
    expect(prompts[1]).toContain("unknown tool");
    expect(prompts[1]).toContain("get_revenue_history");
  });

  it("routes shape-check binding errors to repair", async () => {
    const wrong = '<App name="Shape"><Query id="metric" tool="host_metric"/><MetricCard label="Revenue" value={metric.missing_field}/></App>';
    const right = '<App name="Shape"><Query id="metric" tool="host_metric"/><MetricCard label="Revenue" value={metric.total}/></App>';
    let calls = 0;
    const model = scriptedLanguageModel(() => {
      calls += 1;
      return calls === 1 ? wrong : right;
    });
    const document = await modelEngine.create(
      { prompt: "Build it" },
      guardDeps(model, {
        tools: [{ name: "host_metric", description: "Revenue metric", risk: "read" }],
        toolShapes: { host_metric: { kind: "object", fields: { total: { kind: "string" } } } },
      }),
    );
    expect(calls).toBe(2);
    expect((document.tree as { nodes: Array<{ props?: Record<string, unknown> }> }).nodes.at(-1)?.props?.value)
      .toEqual({ $path: "/metric/total" });
  });

  it("lists host tools and response shapes in the create prompt and steers composition-first", async () => {
    let captured = "";
    const model = scriptedLanguageModel((call) => {
      captured = promptText(call);
      return validCreate();
    });
    await modelEngine.create(
      { prompt: "Build it" },
      guardDeps(model, {
        tools: [{ name: "host_metric", description: "Revenue metric", risk: "read" }],
        toolShapes: { host_metric: { kind: "object", fields: { total: { kind: "string" } } } },
      }),
    );
    expect(captured).toContain("HOST TOOLS");
    expect(captured).toContain("host_metric");
    expect(captured).toContain("Revenue metric");
    expect(captured).toContain("TOOL RESPONSE SHAPES");
    expect(captured).toContain("total");
    expect(captured).toContain("LAST RESORT");
    expect(captured).toContain("Never hardcode");
  });
});

describe("runtime tool-shape wiring", () => {
  it("samples read tools once and feeds names + response shapes into generation", async () => {
    const executed: string[] = [];
    const shapeTools: ToolRegistry = {
      async descriptors() {
        return [
          {
            name: "host_metric",
            description: "Revenue metric",
            inputSchema: { type: "object", properties: {}, additionalProperties: false },
            risk: "read",
          },
          {
            name: "host_delete",
            description: "Delete something",
            inputSchema: { type: "object", properties: {}, additionalProperties: false },
            risk: "destructive",
          },
        ];
      },
      async execute(call) {
        executed.push(call.tool);
        return { status: "ok", output: { total: 42, currency: "USD" } };
      },
    };
    const prompts: string[] = [];
    const model = scriptedLanguageModel((call) => {
      prompts.push(promptText(call));
      return '<App name="Shaped"><Query id="metric" tool="host_metric"/><MetricCard label="Revenue" value={metric.currency}/></App>';
    });
    const runtime = createApps({
      store: memoryStore(),
      guard: guardFixture(),
      tools: shapeTools,
      catalog,
      model,
    });

    await runtime.create({ prompt: "Show revenue" }, ctx);
    await runtime.create({ prompt: "Show revenue again" }, ctx);

    // Only the read tool is sampled, and only once across creates.
    expect(executed).toEqual(["host_metric"]);
    expect(prompts[0]).toContain("HOST TOOLS");
    expect(prompts[0]).toContain("host_delete");
    expect(prompts[0]).toContain("TOOL RESPONSE SHAPES");
    expect(prompts[0]).toContain("currency");
  });
});
