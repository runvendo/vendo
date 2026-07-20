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
import { instructionRequiresServedApp, instructionRequiresServer, modelEngine } from "./engine.js";
import { fakeBoxSandbox } from "./testing/fake-box.js";

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
  it("fails closed when a server-needing edit has no sandbox adapter to graduate onto", async () => {
    // execution-v2 Wave 3 — server capability rides a machine; with no adapter
    // configured, graduation refuses loudly (non-retryable) and changes nothing.
    const store = memoryStore();
    const original: AppDocument = {
      format: "vendo/app@1",
      id: "app_no_adapter",
      name: "Safe tree",
      ui: "tree",
      tree: {
        formatVersion: "vendo-genui/v2",
        root: "root",
        nodes: [{ id: "root", component: "Text", props: { text: "Safe" } }],
      },
    };
    await putApp(store, original);
    const runtime = createApps({
      store,
      guard: guardFixture(),
      tools,
      catalog,
      model: scriptedLanguageModel("unused"),
    });

    const result = await runtime.edit(original.id, "Add a daily email digest of unpaid invoices", ctx);

    expect(result.failure).toMatchObject({ code: "edit-rejected", retryable: false });
    expect(result.issues?.[0]).toContain("no sandbox adapter is configured");
    expect(result.app).toEqual(original);
    expect(await runtime.get(original.id, ctx)).toEqual(original);
    expect(await runtime.history(original.id).list()).toEqual([]);
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
      // The action names a REAL registry tool — an invented one is a law-2
      // unknown-tool error since W3 (covered in engine-laws.test.ts).
      '<MetricCard label={headline.label} value={state.selectedValue} onSelect="host_headline"/></App>',
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

  it("records a pin intent for an edit that only touches a node below the pinned instance", async () => {
    // pinnedSubtree must traverse DESCENDANTS of the pinned instance: a props
    // change on a child node — with the pin base, the island source, and the
    // pinned node itself all unchanged — still touches the slot, so the edit
    // must land in the per-slot replay trail (otherwise a rebase silently
    // drops it from the replay).
    const store = memoryStore();
    const slot = "net-worth-card";
    const componentName = pinComponentName(slot);
    const source = `export default function MapleNetWorthCard() {
  return <section><h2>Net worth</h2><strong>$1.2M</strong></section>;
}`;
    const pinnedId = `${componentName.toLowerCase()}-1`;
    const original: AppDocument = {
      format: "vendo/app@1",
      id: "app_maple_pin_child",
      name: "Maple overview",
      ui: "tree",
      pins: [{ slot, base: "sha256:maple-base" }],
      components: { [componentName]: source },
      tree: {
        formatVersion: "vendo-genui/v2",
        root: "root",
        // The pinned instance is NOT first in nodes, and the edited node sits
        // below it — only a real subtree walk marks the slot touched.
        nodes: [
          { id: "root", component: "Stack", source: "prewired", children: [pinnedId] },
          { id: pinnedId, component: componentName, source: "generated", children: ["note-1"] },
          { id: "note-1", component: "Text", source: "prewired", props: { text: "old note" } },
        ],
      },
    };
    await putApp(store, original);
    const runtime = createApps({
      store,
      guard: guardFixture(),
      tools,
      catalog,
      model: scriptedLanguageModel('<Edit><Set id="note-1" text="new note"/></Edit>'),
      pinBaselines: [{
        slot,
        source,
        hash: "sha256:maple-base",
        exportable: false,
        capturedAt: "2026-07-14T12:00:00.000Z",
      }],
    });

    const result = await runtime.edit(original.id, "Update the note", ctx);

    expect(result.issues).toBeUndefined();
    const rows = await store.records(`vendo:app-pin-intents:${original.id}`).list();
    expect(rows.records.map((record) => record.data)).toEqual([
      expect.objectContaining({ slot, intent: "Update the note" }),
    ]);
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

  it("keeps a pure-UI edit on the cheap tree path even when a sandbox is available (no escalation)", async () => {
    // execution-v2 Wave 3 — the graduation judgment must NOT escalate a
    // visible-element edit: the box is never woken and no machine is provisioned.
    const store = memoryStore();
    const sandbox = fakeBoxSandbox();
    const createMachine = vi.spyOn(sandbox, "create");
    const runtime = createApps({
      store,
      guard: guardFixture(),
      tools,
      catalog,
      model: scriptedLanguageModel(validCreate(), '<Edit><SetName name="Renamed dashboard"/></Edit>'),
      machine: { sandbox },
    });
    const original = await runtime.create({ prompt: "Dashboard" }, ctx);

    const result = await runtime.edit(original.id, "Rename the dashboard heading", ctx);

    expect(result.failure).toBeUndefined();
    expect(result.graduated).toBeUndefined();
    expect(result.app.name).toBe("Renamed dashboard");
    expect(result.app.machine).toBeUndefined();
    expect(createMachine).not.toHaveBeenCalled();
    expect(sandbox.machines).toHaveLength(0);
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
    // Wave 3 (Devin PR #410): ambiguous scheduling/data words that LABEL a
    // visible element must stay on the tree path.
    "Make the digest card blue",
    "Rename the watch list header",
    "Recolor the daily summary card",
    "Move the monitor panel to the top",
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
    // Wave 3 graduation signals: schedules + those same words used as ACTIONS.
    "Watch my unpaid invoices and email me a daily digest at 8am",
    "Add a nightly digest of overdue accounts",
    "Run this on a schedule and store the results",
    "Monitor prices in the background and alert me",
  ])("routes the server ask %j to the code dialect", (instruction) => {
    expect(instructionRequiresServer(app(), instruction)).toBe(true);
  });

  it("always routes an http app to the code dialect", () => {
    expect(instructionRequiresServer(app("http"), "Make the heading blue")).toBe(true);
  });
});

describe("instructionRequiresServedApp (Wave 4 layer 3)", () => {
  const app = (ui?: "tree" | "http"): AppDocument => ({
    format: "vendo/app@1",
    id: "app_served",
    name: "Served fixture",
    ...(ui === undefined ? {} : { ui }),
  });

  it.each([
    "Make me a full kanban board for my invoices with drag-and-drop between columns",
    "Turn this into a full web app",
    "Rebuild this as a served web app",
    "I want a custom frontend with a whiteboard canvas",
    "Add drag and drop reordering to the board",
  ])("judges %j a served-app (layer 3) ask", (instruction) => {
    expect(instructionRequiresServedApp(app(), instruction)).toBe(true);
    // A served-app ask is a fortiori a server ask (it rides graduation).
    expect(instructionRequiresServer(app(), instruction)).toBe(true);
  });

  it.each([
    "Make the status board heading blue",
    "Watch my unpaid invoices and email me a daily digest at 8am",
    "Add a nightly digest of overdue accounts",
    "Make the API status card blue",
    // Cubic PR #419: served-app words that LABEL a visible element are tree
    // asks (same ENG-349 rule as the ambiguous server terms).
    "Make the kanban board heading blue",
    "Move the whiteboard panel to the top",
  ])("keeps %j below layer 3", (instruction) => {
    expect(instructionRequiresServedApp(app(), instruction)).toBe(false);
  });

  it("counts an ambiguous served word used as the THING TO BUILD", () => {
    expect(instructionRequiresServedApp(app(), "Build a kanban for my invoices")).toBe(true);
    expect(instructionRequiresServedApp(app(), "I want a collaborative whiteboard")).toBe(true);
  });

  it("an already-served app is always a layer-3 subject", () => {
    expect(instructionRequiresServedApp(app("http"), "Make the heading blue")).toBe(true);
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

  it("prewarms full + paint models best-effort and swallows failures", async () => {
    let calls = 0;
    const store = memoryStore();
    const runtime = createApps({
      store,
      guard: guardFixture(),
      tools,
      catalog,
      model: scriptedLanguageModel(() => { calls += 1; return "ok"; }),
      paint: { model: scriptedLanguageModel(() => { calls += 1; return "ok"; }) },
    });
    await runtime.prewarm();
    expect(calls).toBe(2); // one warm-up hit per configured model

    // A throwing model must not surface — prewarm is best-effort.
    const throwing = { specificationVersion: "v2", provider: "x", modelId: "x", supportedUrls: {}, doGenerate() { throw new Error("boom"); }, doStream() { throw new Error("boom"); } } as unknown as Parameters<typeof createApps>[0]["model"];
    const runtime2 = createApps({ store: memoryStore(), guard: guardFixture(), tools, catalog, model: throwing });
    await expect(runtime2.prewarm()).resolves.toBeUndefined();
  });

  it("emits per-lane timing (first-partial + complete with usage) through onTiming", async () => {
    const model = scriptedLanguageModel((call) =>
      promptText(call).includes("PAINT PASS") ? tier0Wire : tier2Wire);
    const events: Array<{ lane: string; phase: string; atMs: number; thinking: boolean; usage?: { outputTokens?: number } }> = [];

    await modelEngine.create(
      { prompt: "Build a revenue board" },
      deps(model, { onPartial: () => undefined, onTiming: (e: typeof events[number]) => events.push(e) }),
    );

    const paintFirst = events.find((e) => e.lane === "paint" && e.phase === "first-partial");
    const paintComplete = events.find((e) => e.lane === "paint" && e.phase === "complete");
    const fullComplete = events.find((e) => e.lane === "full" && e.phase === "complete");
    expect(paintFirst).toBeDefined();
    expect(paintComplete?.usage?.outputTokens).toBe(1);
    expect(fullComplete).toBeDefined();
    expect(events.every((e) => e.thinking === false)).toBe(true);
    expect(events.every((e) => e.atMs >= 0)).toBe(true);
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
    expect(calls).toBe(4); // tier-0 + full lane attempt + two repair attempts
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

  it("rejects an island importing a module the jail cannot load and repairs to ambient Kit charts", async () => {
    const broken = '<App name="Chart"><RevChart/><Island name="RevChart">import { scaleLinear } from "d3-scale";\nexport default function RevChart() { return <p>{String(scaleLinear)}</p>; }</Island></App>';
    const fixed = '<App name="Chart"><RevChart/><Island name="RevChart">export default function RevChart() { return <svg width="100" height="40"><rect width="10" height="20"/></svg>; }</Island></App>';
    const prompts: string[] = [];
    const model = scriptedLanguageModel((call) => {
      prompts.push(promptText(call));
      return prompts.length === 1 ? broken : fixed;
    });
    const document = await modelEngine.create({ prompt: "Build a chart" }, guardDeps(model));
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("d3-scale");
    expect(prompts[1]).toContain("ambient");
    expect(document.components?.RevChart).toContain("<svg");
    expect(document.components?.RevChart).not.toContain("d3-scale");
  });

  it("silently strips habit imports of react and kit-ish specifiers (W4b — ambient scope)", async () => {
    const wire = [
      '<App name="Ok"><Note/><Island name="Note">',
      'import React, { useState } from "react";',
      'import { Stat } from "@vendo/kit";',
      "export default function Note() { const [n] = useState(0); return <Stat label=\"n\" value={String(n)}/>; }",
      "</Island></App>",
    ].join("\n");
    const prompts: string[] = [];
    const model = scriptedLanguageModel((call) => {
      prompts.push(promptText(call));
      return wire;
    });
    const document = await modelEngine.create({ prompt: "Build it" }, guardDeps(model));
    // No repair round: the strip is silent (a pretraining habit, not an error).
    expect(prompts).toHaveLength(1);
    expect(document.components?.Note).not.toContain("import");
    expect(document.components?.Note).toContain("export default function Note()");
  });

  it("describes the ambient island scope and tools API in the create prompt", async () => {
    let captured = "";
    const model = scriptedLanguageModel((call) => {
      captured = promptText(call);
      return validCreate();
    });
    await modelEngine.create({ prompt: "Build it" }, guardDeps(model));
    expect(captured).not.toContain("LAST RESORT");
    expect(captured).toContain("already in scope");
    expect(captured).toContain("await tools.");
    expect(captured).toContain("pending-approval");
    expect(captured).toContain("DataTable");
    expect(captured).toContain("fmt.money");
  });

  it("stamps the per-island tool manifest from literal tools chains (W4b §2)", async () => {
    const wire = [
      '<App name="Lookup"><ClientLookup/><Island name="ClientLookup">',
      "export default function ClientLookup() {",
      "  const [hits, setHits] = useState([]);",
      '  const run = async (q) => setHits((await tools.clients.search({ q })).data);',
      "  const metric = async () => tools.host_metric({});",
      "  return <Input label=\"Find\" onChange={run}/>;",
      "}",
      "</Island></App>",
    ].join("\n");
    const document = await modelEngine.create({ prompt: "Build it" }, guardDeps(scriptedLanguageModel(wire), {
      tools: [
        { name: "clients_search", description: "Search clients", risk: "read" },
        { name: "host_metric", description: "Metric", risk: "read" },
      ],
      pipeline: { structuredRepair: false },
    }));
    expect(document.componentTools).toStrictEqual({ ClientLookup: ["clients_search", "host_metric"] });
  });

  it("stamps an empty manifest for a tool-free island (least privilege)", async () => {
    const wire = '<App name="Plain"><Note/><Island name="Note">export default function Note() { return <p>hi</p>; }</Island></App>';
    const document = await modelEngine.create({ prompt: "Build it" }, guardDeps(scriptedLanguageModel(wire), {
      tools: [{ name: "host_metric", description: "Metric", risk: "read" }],
      pipeline: { structuredRepair: false },
    }));
    expect(document.componentTools).toStrictEqual({ Note: [] });
  });

  it("repairs an island calling a tool absent from the registry", async () => {
    const broken = '<App name="Bad"><Note/><Island name="Note">export default function Note() { useEffect(() => { tools.made.up({}); }, []); return <p>x</p>; }</Island></App>';
    const fixed = '<App name="Bad"><Note/><Island name="Note">export default function Note() { useEffect(() => { tools.host_metric({}); }, []); return <p>x</p>; }</Island></App>';
    const prompts: string[] = [];
    const model = scriptedLanguageModel((call) => {
      prompts.push(promptText(call));
      return prompts.length === 1 ? broken : fixed;
    });
    const document = await modelEngine.create({ prompt: "Build it" }, guardDeps(model, {
      tools: [{ name: "host_metric", description: "Metric", risk: "read" }],
      pipeline: { structuredRepair: false },
    }));
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("unknown tool");
    expect(prompts[1]).toContain("host_metric");
    expect(document.componentTools).toStrictEqual({ Note: ["host_metric"] });
  });

  it("rejects computed tools access and repairs (adversarial: tools[expr])", async () => {
    const broken = '<App name="Bad"><Note/><Island name="Note">export default function Note() { const name = "host_metric"; useEffect(() => { tools[name]({}); }, []); return <p>x</p>; }</Island></App>';
    const fixed = '<App name="Bad"><Note/><Island name="Note">export default function Note() { useEffect(() => { tools.host_metric({}); }, []); return <p>x</p>; }</Island></App>';
    const prompts: string[] = [];
    const model = scriptedLanguageModel((call) => {
      prompts.push(promptText(call));
      return prompts.length === 1 ? broken : fixed;
    });
    await modelEngine.create({ prompt: "Build it" }, guardDeps(model, {
      tools: [{ name: "host_metric", description: "Metric", risk: "read" }],
      pipeline: { structuredRepair: false },
    }));
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("computed");
  });

  it("rejects host catalog / prewired components inside island JSX and repairs to the ambient Kit", async () => {
    // Live P4 finding: the island rendered <MapleSpendingDonut/> (a host
    // catalog component) — host components live in the HOST page and can
    // never cross into the jail, so the island died on a ReferenceError.
    const broken = '<App name="Mix"><Note/><Island name="Note">export default function Note() { return <MetricCard label="x" value="1"/>; }</Island></App>';
    const fixed = '<App name="Mix"><Note/><Island name="Note">export default function Note() { return <Stat label="x" value="1"/>; }</Island></App>';
    const prompts: string[] = [];
    const model = scriptedLanguageModel((call) => {
      prompts.push(promptText(call));
      return prompts.length === 1 ? broken : fixed;
    });
    const document = await modelEngine.create({ prompt: "Build it" }, guardDeps(model));
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("MetricCard");
    expect(prompts[1]).toContain("ambient Kit");
    expect(document.components?.Note).toContain("<Stat");
  });

  it("rejects a raw network call inside an island and repairs to ambient tools", async () => {
    // Live P3 finding: the model wrote fetch("/api/payments") from pretraining
    // habit; the jail CSP blocked it silently (connect-src 'none') and the
    // island just died. Catch it at compile and route to repair instead.
    const broken = '<App name="Bad"><Note/><Island name="Note">export default function Note() { useEffect(() => { fetch("/api/payments"); }, []); return <p>x</p>; }</Island></App>';
    const fixed = '<App name="Bad"><Note/><Island name="Note">export default function Note() { useEffect(() => { tools.host_metric({}); }, []); return <p>x</p>; }</Island></App>';
    const prompts: string[] = [];
    const model = scriptedLanguageModel((call) => {
      prompts.push(promptText(call));
      return prompts.length === 1 ? broken : fixed;
    });
    await modelEngine.create({ prompt: "Build it" }, guardDeps(model, {
      tools: [{ name: "host_metric", description: "Metric", risk: "read" }],
      pipeline: { structuredRepair: false },
    }));
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("no network");
    expect(prompts[1]).toContain("tools");
  });

  it("rejects aliasing the tools object and repairs (adversarial)", async () => {
    const broken = '<App name="Bad"><Note/><Island name="Note">export default function Note() { const t = tools; useEffect(() => { t.host_metric({}); }, []); return <p>x</p>; }</Island></App>';
    const fixed = '<App name="Bad"><Note/><Island name="Note">export default function Note() { useEffect(() => { tools.host_metric({}); }, []); return <p>x</p>; }</Island></App>';
    const prompts: string[] = [];
    const model = scriptedLanguageModel((call) => {
      prompts.push(promptText(call));
      return prompts.length === 1 ? broken : fixed;
    });
    await modelEngine.create({ prompt: "Build it" }, guardDeps(model, {
      tools: [{ name: "host_metric", description: "Metric", risk: "read" }],
      pipeline: { structuredRepair: false },
    }));
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("literal member access");
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
      // pipeline off: this test pins the FREE-FORM fallback loop (the
      // structured path is covered in engine-pipeline.test.ts).
      guardDeps(model, {
        tools: [{ name: "host_metric", description: "Revenue metric", risk: "read" }],
        pipeline: { structuredRepair: false },
      }),
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
        // pipeline off: pins the free-form fallback (structured path is
        // covered in engine-pipeline.test.ts).
        pipeline: { structuredRepair: false },
      }),
    );
    expect(calls).toBe(2);
    expect((document.tree as { nodes: Array<{ props?: Record<string, unknown> }> }).nodes.at(-1)?.props?.value)
      .toEqual({ $path: "/metric/total" });
  });

  it("sketches each tool's INPUT beside its name (W4b — islands and actions must match the real arg shape)", async () => {
    let captured = "";
    const model = scriptedLanguageModel((call) => {
      captured = promptText(call);
      return validCreate();
    });
    await modelEngine.create(
      { prompt: "Build it" },
      guardDeps(model, {
        tools: [
          {
            name: "host_createOrder",
            description: "Place an order",
            risk: "write",
            inputSchema: {
              type: "object",
              properties: {
                body: {
                  type: "object",
                  properties: { merchant: { type: "string" }, amountCents: { type: "number" } },
                },
              },
            },
          },
          {
            name: "host_transfer",
            description: "Send money",
            risk: "destructive",
            inputSchema: {
              type: "object",
              properties: { amount: { type: "integer" }, recipient_name: { type: "string" } },
              required: ["amount", "recipient_name"],
            },
          },
        ],
      }),
    );
    // The nested `body` wrapper is visible — flat args against this tool were
    // the live P3 failure (the host route read an empty JSON body and ran
    // with defaults).
    expect(captured).toContain("host_createOrder [write] (input: {body: {merchant, amountCents}})");
    expect(captured).toContain("host_transfer [destructive] (input: {amount, recipient_name})");
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
    // W4b — the island fear rules are retired; the Kit-or-island posture stands.
    expect(captured).not.toContain("LAST RESORT");
    expect(captured).toContain("covers the need");
    expect(captured).toContain("Never hardcode");
    // vendo-v2-cells — the display-cell contract rides with the shapes:
    // object cells project via template; date/cents display rides a Kit
    // semantic component / format token or a legacy format step (W3).
    expect(captured).toContain("RESHAPE PIPES");
    expect(captured).toContain("template(");
    expect(captured).toContain("is NOT optional");
    // W3 — the COMPONENTS section is generated from the Kit specs.
    expect(captured).toContain("COMPONENTS (generated from the component schemas");
    expect(captured).toContain("<Money");
    expect(captured).toContain("DataTable");
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

describe("branded prewired components validate on create", () => {
  it("accepts Card/Stat/Badge/Table/Button as prewired (compiler and validator agree)", async () => {
    const wire = [
      '<App name="Branded"><Stack>',
      '<Stat label="Overdue" value="3"/><Badge label="Late"/>',
      '<Card title="Invoices"><Table rows={[]}/></Card>',
      '<Button label="Remind" onClick="host_remind"/>',
      "</Stack></App>",
    ].join("");
    const document = await modelEngine.create(
      { prompt: "Build it" },
      { model: scriptedLanguageModel(wire), catalog } as unknown as Parameters<typeof modelEngine.create>[1],
    );
    const sources = (document.tree as { nodes: Array<{ component: string; source?: string }> }).nodes
      .map((node) => [node.component, node.source]);
    expect(sources).toContainEqual(["Stat", "prewired"]);
    expect(sources).toContainEqual(["Card", "prewired"]);
  });
});

describe("binding kind vs host prop schema", () => {
  it("repairs a binding whose field shape mismatches the prop's declared type", async () => {
    const wrong = '<App name="Chart"><Query id="cashflow" tool="host_cashflow"/><MetricCard label="Revenue" value={cashflow.rows}/></App>';
    const right = '<App name="Chart"><Query id="cashflow" tool="host_cashflow"/><MetricCard label="Revenue" value={cashflow.total}/></App>';
    const prompts: string[] = [];
    const model = scriptedLanguageModel((call) => {
      prompts.push(promptText(call));
      return prompts.length === 1 ? wrong : right;
    });
    const document = await modelEngine.create(
      { prompt: "Build it" },
      {
        model,
        catalog,
        tools: [{ name: "host_cashflow", description: "Cashflow", risk: "read" }],
        toolShapes: {
          host_cashflow: {
            kind: "object",
            fields: {
              total: { kind: "string" },
              rows: { kind: "array", items: { kind: "object", fields: { label: { kind: "string" } } } },
            },
          },
        },
      } as unknown as Parameters<typeof modelEngine.create>[1],
    );
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("expected a string, the bound field is array");
    expect((document.tree as { nodes: Array<{ props?: Record<string, unknown> }> }).nodes.at(-1)?.props?.value)
      .toEqual({ $path: "/cashflow/total" });
  });
});

describe("string interpolation guard", () => {
  it("repairs a binding embedded inside a string attribute", async () => {
    const wrong = '<App name="Interp"><Query id="metric" tool="host_metric"/><MetricCard label="Total: {metric.total}" value={metric.total}/></App>';
    const right = '<App name="Interp"><Query id="metric" tool="host_metric"/><MetricCard label="Total" value={metric.total}/></App>';
    const prompts: string[] = [];
    const model = scriptedLanguageModel((call) => {
      prompts.push(promptText(call));
      return prompts.length === 1 ? wrong : right;
    });
    const document = await modelEngine.create(
      { prompt: "Build it" },
      {
        model,
        catalog,
        tools: [{ name: "host_metric", description: "Metric", risk: "read" }],
      } as unknown as Parameters<typeof modelEngine.create>[1],
    );
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("string interpolation is unsupported");
    expect((document.tree as { nodes: Array<{ props?: Record<string, unknown> }> }).nodes.at(-1)?.props?.label)
      .toBe("Total");
  });
});

describe("edit path filters pre-existing catalog/action issues (fast-follow)", () => {
  const legacyApp = (): AppDocument => ({
    format: "vendo/app@1",
    id: "app_legacy",
    name: "Invoices",
    ui: "tree",
    tree: {
      formatVersion: "vendo-genui/v2",
      root: "root",
      // `table` omits source (legacy/direct tree) and carries the now-rejected
      // `data` prop; the renderer still resolves it to the prewired Table.
      nodes: [
        { id: "root", component: "Stack", source: "prewired", children: ["heading", "table"] },
        { id: "heading", component: "Text", props: { text: "Invoices" } },
        { id: "table", component: "Table", props: { data: [] } },
      ],
    },
  } as unknown as AppDocument);

  it("does not block an edit to an untouched node carrying a now-rejected prewired prop", async () => {
    const patch = '<Edit><Set id="heading" text="Overdue invoices"/></Edit>';
    const result = await modelEngine.edit(
      { app: legacyApp(), instruction: "Rename the heading" },
      { model: scriptedLanguageModel(patch), catalog } as unknown as Parameters<typeof modelEngine.edit>[1],
    );
    expect(result.kind).toBe("document");
  });

  it("surfaces a prewired prop issue the edit newly introduces", async () => {
    const patch = '<Edit><Set id="heading" data="bogus"/></Edit>';
    const result = await modelEngine.edit(
      { app: legacyApp(), instruction: "Break the heading" },
      { model: scriptedLanguageModel(patch, patch), catalog } as unknown as Parameters<typeof modelEngine.edit>[1],
    );
    expect(result.kind).toBe("failure");
    if (result.kind === "failure") {
      expect(result.issues.some((issue) => issue.includes('unknown prop "data"') && issue.includes("heading"))).toBe(true);
    }
  });
});

describe("edit path islands (W4b — strip + manifest restamp)", () => {
  const baseApp = (): AppDocument => ({
    format: "vendo/app@1",
    id: "app_islands",
    name: "Metrics",
    ui: "tree",
    tree: {
      formatVersion: "vendo-genui/v2",
      root: "root",
      nodes: [
        { id: "root", component: "Stack", source: "prewired", children: ["heading"] },
        { id: "heading", component: "Text", props: { text: "Metrics" } },
      ],
    },
  } as unknown as AppDocument);

  it("strips habit imports and stamps the manifest for an island added by an edit", async () => {
    const patch = [
      '<Edit><Insert into="root"><Pulse/></Insert><Island name="Pulse">',
      'import { useState } from "react";',
      "export default function Pulse() {",
      "  const [v, setV] = useState(null);",
      "  useEffect(() => { (async () => setV(await tools.host_metric({})))(); }, []);",
      '  return <p>{v === null ? "..." : String(v)}</p>;',
      "}",
      "</Island></Edit>",
    ].join("\n");
    const result = await modelEngine.edit(
      { app: baseApp(), instruction: "Add a live metric pulse" },
      {
        model: scriptedLanguageModel(patch),
        catalog,
        tools: [{ name: "host_metric", description: "Metric", risk: "read" }],
      } as unknown as Parameters<typeof modelEngine.edit>[1],
    );
    expect(result.kind).toBe("document");
    if (result.kind === "document") {
      expect(result.document.components?.Pulse).not.toContain("import");
      expect(result.document.componentTools).toStrictEqual({ Pulse: ["host_metric"] });
    }
  });

  it("repairs an edit island calling an unknown tool", async () => {
    const broken = '<Edit><Insert into="root"><Pulse/></Insert><Island name="Pulse">export default function Pulse() { useEffect(() => { tools.made_up({}); }, []); return <p>x</p>; }</Island></Edit>';
    const fixed = '<Edit><Insert into="root"><Pulse/></Insert><Island name="Pulse">export default function Pulse() { useEffect(() => { tools.host_metric({}); }, []); return <p>x</p>; }</Island></Edit>';
    const prompts: string[] = [];
    const model = scriptedLanguageModel((call) => {
      prompts.push(promptText(call));
      return prompts.length === 1 ? broken : fixed;
    });
    const result = await modelEngine.edit(
      { app: baseApp(), instruction: "Add a pulse" },
      {
        model,
        catalog,
        tools: [{ name: "host_metric", description: "Metric", risk: "read" }],
      } as unknown as Parameters<typeof modelEngine.edit>[1],
    );
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("unknown tool");
    expect(result.kind).toBe("document");
    if (result.kind === "document") {
      expect(result.document.componentTools).toStrictEqual({ Pulse: ["host_metric"] });
    }
  });
});

describe("action-wiring honesty guard", () => {
  // pipeline off: these tests pin the FREE-FORM fallback loop (the
  // structured-repair path is covered in engine-pipeline.test.ts).
  const actionDeps = (model: unknown, tools: Array<{ name: string; description: string; risk: string }>) => ({
    model,
    catalog,
    tools,
    pipeline: { structuredRepair: false },
  }) as unknown as Parameters<typeof modelEngine.create>[1];

  it("repairs a mutating action that carries no payload", async () => {
    const wrong = '<App name="Remind"><Button label="Send Reminder" onClick="host_remind"/></App>';
    const right = '<App name="Remind"><Button label="Send Reminder" onClick={{action:"host_remind",payload:{clientId:"c1"}}}/></App>';
    const prompts: string[] = [];
    const model = scriptedLanguageModel((call) => {
      prompts.push(promptText(call));
      return prompts.length === 1 ? wrong : right;
    });
    const document = await modelEngine.create(
      { prompt: "Overdue invoices with a reminder button" },
      actionDeps(model, [{ name: "host_remind", description: "Send a reminder", risk: "write" }]),
    );
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("no payload");
    expect((document.tree as { nodes: Array<{ props?: Record<string, unknown> }> }).nodes.at(-1)?.props?.onClick)
      .toEqual({ action: "host_remind", payload: { clientId: "c1" } });
  });

  it("repairs a submit button wired to a read-only tool", async () => {
    const wrong = '<App name="Form"><Button label="Submit" onClick="host_list"/></App>';
    const right = '<App name="Form"><Button label="Submit" onClick={{action:"host_create",payload:{name:"x"}}}/></App>';
    const prompts: string[] = [];
    const model = scriptedLanguageModel((call) => {
      prompts.push(promptText(call));
      return prompts.length === 1 ? wrong : right;
    });
    await modelEngine.create(
      { prompt: "A form" },
      actionDeps(model, [
        { name: "host_list", description: "List clients", risk: "read" },
        { name: "host_create", description: "Create a client", risk: "write" },
      ]),
    );
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("read-only tool");
  });

  it("repairs a dead submit button into an honest disclaimer when the host has no tool", async () => {
    const wrong = '<App name="Intake"><Stack><Input label="Name"/><Button label="Submit Intake Form"/></Stack></App>';
    const right = '<App name="Intake"><Stack><Input label="Name"/><Text text="This host has no client-creation tool, so intake can\'t be submitted here."/></Stack></App>';
    const prompts: string[] = [];
    const model = scriptedLanguageModel((call) => {
      prompts.push(promptText(call));
      return prompts.length === 1 ? wrong : right;
    });
    const document = await modelEngine.create(
      { prompt: "A new-client intake form" },
      actionDeps(model, [{ name: "host_list", description: "List clients", risk: "read" }]),
    );
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("fake affordance");
    const components = (document.tree as { nodes: Array<{ component: string }> }).nodes.map((node) => node.component);
    expect(components).not.toContain("Button");
    expect(components).toContain("Text");
  });

  it("accepts a mutating action with a payload and a non-submit read button on the first pass", async () => {
    const wire = '<App name="Ok"><Stack><Button label="Delete" onClick={{action:"host_delete",payload:{id:"x"}}}/><Button label="Cancel"/><Button label="View details" onClick="host_list"/></Stack></App>';
    const prompts: string[] = [];
    const model = scriptedLanguageModel((call) => {
      prompts.push(promptText(call));
      return wire;
    });
    await modelEngine.create(
      { prompt: "Build it" },
      actionDeps(model, [
        { name: "host_delete", description: "Delete a row", risk: "destructive" },
        { name: "host_list", description: "List rows", risk: "read" },
      ]),
    );
    expect(prompts).toHaveLength(1);
  });
});
