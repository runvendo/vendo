import type { NormalizedCatalog } from "@vendoai/core";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { modelEngine } from "./engine.js";
import { NO_VALID_FIX } from "./pipeline.js";
import { scriptedLanguageModel, type ScriptedModelCall } from "./testing/index.js";

/** W4 pipeline (spec §How a generation runs) — structured repair, outline +
 *  region-parallel tier-2, and the end pass, all engine-internal behind the
 *  GenerationEngine seam. Scripted-model fixtures follow engine.test.ts. */

const catalog: NormalizedCatalog = [{
  name: "MetricCard",
  description: "Use for a single important metric.",
  propsSchema: z.object({
    label: z.string(),
    value: z.string(),
    trend: z.number().optional(),
  }),
  propsJsonSchema: {
    type: "object",
    properties: {
      label: { type: "string" },
      value: { type: "string" },
      trend: { type: "number" },
    },
    required: ["label", "value"],
    additionalProperties: false,
  },
}];

const promptText = (call: ScriptedModelCall): string => call.prompt.map((message) => {
  if (typeof message.content === "string") return message.content;
  return message.content.map((part) => part.text ?? "").join("");
}).join("\n");

const isRepairCall = (call: ScriptedModelCall): boolean =>
  promptText(call).includes("locate the failing nodes");

const isOutlineCall = (call: ScriptedModelCall): boolean =>
  promptText(call).includes("plan Vendo app generations");

const isEndPassCall = (call: ScriptedModelCall): boolean =>
  promptText(call).includes("end-pass editor");

const metricShapes = {
  host_metric: {
    kind: "object" as const,
    fields: {
      total: { kind: "string" as const },
      count: { kind: "number" as const },
      rows: {
        kind: "array" as const,
        items: { kind: "object" as const, fields: { id: { kind: "string" as const }, label: { kind: "string" as const } } },
      },
    },
  },
};

const deps = (model: unknown, extra: Record<string, unknown> = {}) => ({
  model,
  catalog,
  ...extra,
}) as unknown as Parameters<typeof modelEngine.create>[1];

type Nodes = Array<{ id: string; component: string; props?: Record<string, unknown> }>;

describe("structured repair (one strict call over the closed fix space)", () => {
  it("fixes a binding error from the enum of real field paths in ONE strict round", async () => {
    const wrong = '<App name="Shape"><Query id="metric" tool="host_metric"/><MetricCard label="Revenue" value={metric.missing_field}/></App>';
    const calls: ScriptedModelCall[] = [];
    const model = scriptedLanguageModel((call) => {
      calls.push(call);
      if (isRepairCall(call)) return { tool: "apply_fixes", input: { fix_0: "/metric/total" } };
      return wrong;
    });

    const document = await modelEngine.create(
      { prompt: "Build it" },
      deps(model, {
        tools: [{ name: "host_metric", description: "Revenue metric", risk: "read" }],
        toolShapes: metricShapes,
      }),
    );

    expect(calls).toHaveLength(2); // one wire generation + ONE strict repair call, no regeneration
    expect((document.tree as { nodes: Nodes }).nodes.at(-1)?.props?.value).toEqual({ $path: "/metric/total" });
  });

  it("offers a strict flat schema: real field paths kind-filtered to the prop type plus the no-valid-fix arm", async () => {
    const wrong = '<App name="Shape"><Query id="metric" tool="host_metric"/><MetricCard label="Revenue" value={metric.missing_field}/></App>';
    let repairTool: { name?: string; inputSchema?: unknown; strict?: boolean } | undefined;
    const model = scriptedLanguageModel((call) => {
      if (isRepairCall(call)) {
        repairTool = call.tools?.[0] as typeof repairTool;
        return { tool: "apply_fixes", input: { fix_0: "/metric/total" } };
      }
      return wrong;
    });

    await modelEngine.create(
      { prompt: "Build it" },
      deps(model, {
        tools: [{ name: "host_metric", description: "Revenue metric", risk: "read" }],
        toolShapes: metricShapes,
      }),
    );

    expect(repairTool?.name).toBe("apply_fixes");
    expect(repairTool?.strict).toBe(true);
    const schema = repairTool?.inputSchema as {
      additionalProperties: boolean;
      required: string[];
      properties: { fix_0: { enum: string[] } };
    };
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual(["fix_0"]);
    // MetricCard.value is a string prop: string-kind paths stay, the array
    // and object paths are filtered, the no-valid-fix arm is always present.
    expect(schema.properties.fix_0.enum).toContain("/metric/total");
    expect(schema.properties.fix_0.enum).toContain("/metric/rows/0/label");
    expect(schema.properties.fix_0.enum).not.toContain("/metric/rows");
    expect(schema.properties.fix_0.enum).not.toContain("/metric/count");
    expect(schema.properties.fix_0.enum).toContain(NO_VALID_FIX);
  });

  it("turns a no-valid-fix on a required prop into an honest Text disclaimer", async () => {
    const wrong = '<App name="Shape"><Stack><Text text="Overview"/><MetricCard label="Revenue" value={metric.missing_field}/></Stack><Query id="metric" tool="host_metric"/></App>';
    const model = scriptedLanguageModel((call) => {
      if (isRepairCall(call)) return { tool: "apply_fixes", input: { fix_0: NO_VALID_FIX } };
      return wrong;
    });

    const document = await modelEngine.create(
      { prompt: "Build it" },
      deps(model, {
        tools: [{ name: "host_metric", description: "Revenue metric", risk: "read" }],
        toolShapes: metricShapes,
      }),
    );

    const nodes = (document.tree as { nodes: Nodes }).nodes;
    expect(nodes.map(({ component }) => component)).not.toContain("MetricCard");
    expect(nodes.some(({ component, props }) => component === "Text" && String(props?.text).includes("isn't available"))).toBe(true);
  });

  it("fixes an invented query tool from the enum of registry tools", async () => {
    const wrong = '<App name="Tools"><Query id="rev" tool="get_revenue_history"/><MetricCard label="Revenue" value={rev.total}/></App>';
    let repairEnum: string[] | undefined;
    const model = scriptedLanguageModel((call) => {
      if (isRepairCall(call)) {
        const schema = (call.tools?.[0] as { inputSchema?: { properties?: { fix_0?: { enum?: string[] } } } }).inputSchema;
        repairEnum = schema?.properties?.fix_0?.enum;
        return { tool: "apply_fixes", input: { fix_0: "host_metric" } };
      }
      return wrong;
    });

    const document = await modelEngine.create(
      { prompt: "Build it" },
      deps(model, {
        tools: [
          { name: "host_metric", description: "Revenue metric", risk: "read" },
          { name: "host_delete", description: "Delete", risk: "destructive" },
        ],
        toolShapes: metricShapes,
      }),
    );

    expect(repairEnum).toEqual(["host_metric", NO_VALID_FIX]); // read tools only
    expect((document.tree as { queries?: Array<{ tool: string }> }).queries).toEqual([
      { name: "rev", tool: "host_metric" },
    ]);
  });

  it("removes the query and disclaims dependent host nodes on a no-valid-fix tool", async () => {
    const wrong = '<App name="Tools"><Stack><Text text="Board"/><Query id="rev" tool="get_crypto_prices"/><MetricCard label="BTC" value={rev.total}/></Stack></App>';
    const model = scriptedLanguageModel((call) => {
      if (isRepairCall(call)) return { tool: "apply_fixes", input: { fix_0: NO_VALID_FIX } };
      return wrong;
    });

    const document = await modelEngine.create(
      { prompt: "Crypto prices" },
      deps(model, {
        tools: [{ name: "host_metric", description: "Revenue metric", risk: "read" }],
        toolShapes: metricShapes,
      }),
    );

    const tree = document.tree as { queries?: unknown[]; nodes: Nodes };
    expect(tree.queries ?? []).toEqual([]);
    expect(tree.nodes.map(({ component }) => component)).not.toContain("MetricCard");
    expect(tree.nodes.some(({ component, props }) => component === "Text" && String(props?.text).includes("isn't available"))).toBe(true);
  });

  it("fills a missing mutation payload from the tool input schema skeleton", async () => {
    const wrong = '<App name="Remind"><Query id="inv" tool="host_metric"/><Table rows={inv.rows}/><Button label="Send Reminder" onClick="host_remind"/></App>';
    let payloadSchema: { properties?: Record<string, { enum?: string[] }>; required?: string[] } | undefined;
    const model = scriptedLanguageModel((call) => {
      if (isRepairCall(call)) {
        const schema = (call.tools?.[0] as { inputSchema?: { properties?: Record<string, unknown> } }).inputSchema;
        payloadSchema = schema?.properties?.fix_0 as typeof payloadSchema;
        return { tool: "apply_fixes", input: { fix_0: { invoiceId: "/inv/rows/0/id" } } };
      }
      return wrong;
    });

    const document = await modelEngine.create(
      { prompt: "Overdue invoices with a reminder button" },
      deps(model, {
        tools: [
          { name: "host_metric", description: "Invoices", risk: "read" },
          {
            name: "host_remind",
            description: "Send a reminder",
            risk: "write",
            inputSchema: { type: "object", properties: { invoiceId: { type: "string" } }, required: ["invoiceId"] },
          },
        ],
        toolShapes: metricShapes,
      }),
    );

    expect(payloadSchema?.required).toEqual(["invoiceId"]);
    expect(payloadSchema?.properties?.invoiceId?.enum).toContain("/inv/rows/0/id");
    const button = (document.tree as { nodes: Nodes }).nodes.find(({ component }) => component === "Button");
    expect(button?.props?.onClick).toEqual({
      action: "host_remind",
      payload: { invoiceId: { $path: "/inv/rows/0/id" } },
    });
  });

  it("replaces a dead submit button with an honest disclaimer through the single-arm fix", async () => {
    const wrong = '<App name="Intake"><Stack><Input label="Name"/><Button label="Submit Intake Form"/></Stack></App>';
    const model = scriptedLanguageModel((call) => {
      if (isRepairCall(call)) return { tool: "apply_fixes", input: { fix_0: NO_VALID_FIX } };
      return wrong;
    });

    const document = await modelEngine.create(
      { prompt: "A new-client intake form" },
      deps(model, { tools: [{ name: "host_list", description: "List clients", risk: "read" }] }),
    );

    const components = (document.tree as { nodes: Nodes }).nodes.map(({ component }) => component);
    expect(components).not.toContain("Button");
    expect(components).toContain("Text");
  });

  it("clamps an out-of-enum fix to no-valid-fix (defense when strict is not enforced)", async () => {
    const wrong = '<App name="Shape"><Query id="metric" tool="host_metric"/><MetricCard label="Revenue" value={metric.total} trend={metric.bogus}/></App>';
    const model = scriptedLanguageModel((call) => {
      if (isRepairCall(call)) return { tool: "apply_fixes", input: { fix_0: "/metric/not_in_enum_either" } };
      return wrong;
    });

    const document = await modelEngine.create(
      { prompt: "Build it" },
      deps(model, {
        tools: [{ name: "host_metric", description: "Revenue metric", risk: "read" }],
        toolShapes: metricShapes,
      }),
    );

    // trend is optional: the clamped no-valid-fix drops the prop, the node survives.
    const card = (document.tree as { nodes: Nodes }).nodes.find(({ component }) => component === "MetricCard");
    expect(card?.props?.trend).toBeUndefined();
    expect(card?.props?.value).toEqual({ $path: "/metric/total" });
  });

  it("skips the strict call entirely when no failure has a closed fix space", async () => {
    const invalid = '<App name="Broken"><MetricCard/></App>';
    const valid = '<App name="Fixed"><MetricCard label="Revenue" value="$42k"/></App>';
    const calls: ScriptedModelCall[] = [];
    const model = scriptedLanguageModel((call) => {
      calls.push(call);
      return calls.length === 1 ? invalid : valid;
    });

    const document = await modelEngine.create({ prompt: "Build it" }, deps(model));

    expect(document.name).toBe("Fixed");
    expect(calls).toHaveLength(2);
    expect(calls.some((call) => isRepairCall(call))).toBe(false);
    expect(promptText(calls[1] as ScriptedModelCall)).toContain("REPAIR_THESE_ISSUES");
  });

  it("falls back to the free-form loop after the strict-call transport fails", async () => {
    const wrong = '<App name="Shape"><Query id="metric" tool="host_metric"/><MetricCard label="Revenue" value={metric.missing_field}/></App>';
    const right = '<App name="Shape"><Query id="metric" tool="host_metric"/><MetricCard label="Revenue" value={metric.total}/></App>';
    const calls: ScriptedModelCall[] = [];
    const model = scriptedLanguageModel((call) => {
      calls.push(call);
      // The repair call answers with TEXT instead of the forced tool call —
      // the transport-level failure mode — so repair yields nothing.
      if (isRepairCall(call)) return "cannot comply";
      return calls.filter((candidate) => !isRepairCall(candidate)).length === 1 ? wrong : right;
    });

    const document = await modelEngine.create(
      { prompt: "Build it" },
      deps(model, {
        tools: [{ name: "host_metric", description: "Revenue metric", risk: "read" }],
        toolShapes: metricShapes,
      }),
    );

    expect((document.tree as { nodes: Nodes }).nodes.at(-1)?.props?.value).toEqual({ $path: "/metric/total" });
    // wire + strict round 1 + strict round 2 budget is NOT spent on transport
    // failure loops: one failed strict call, then free-form regeneration.
    expect(calls.filter((call) => isRepairCall(call)).length).toBeLessThanOrEqual(2);
    expect(calls.some((call) => promptText(call).includes("REPAIR_THESE_ISSUES"))).toBe(true);
  });
});

describe("outline + region-parallel tier-2 (flagged)", () => {
  const parallelTools = [
    { name: "host_metric", description: "Revenue metric", risk: "read" },
    { name: "host_invoices", description: "Invoice list", risk: "read" },
  ];
  const parallelShapes = {
    ...metricShapes,
    host_invoices: {
      kind: "object" as const,
      fields: {
        rows: { kind: "array" as const, items: { kind: "object" as const, fields: { id: { kind: "string" as const } } } },
      },
    },
  };
  const outline = {
    tool: "plan_outline",
    input: {
      appName: "Finance board",
      sharedFacts: "Amounts are cents.",
      sections: [
        { id: "s1", brief: "Revenue summary", tools: ["host_metric"], coupledWithPrevious: false },
        { id: "s2", brief: "Invoice table", tools: ["host_invoices"], coupledWithPrevious: false },
      ],
    },
  };

  it("plans sections, streams them in parallel, and assembles one validated document", async () => {
    const sectionPrompts: string[] = [];
    const model = scriptedLanguageModel((call) => {
      const text = promptText(call);
      if (isOutlineCall(call)) return outline;
      if (text.includes("OUTLINE_SECTION s1")) {
        sectionPrompts.push(text);
        return '<App name="Finance board"><Query id="s1_metric" tool="host_metric"/><MetricCard label="Revenue" value={s1_metric.total}/></App>';
      }
      if (text.includes("OUTLINE_SECTION s2")) {
        sectionPrompts.push(text);
        return '<App name="Finance board"><Query id="s2_inv" tool="host_invoices"/><Table rows={s2_inv.rows}/></App>';
      }
      throw new Error(`unexpected single-stream call: ${text.slice(0, 120)}`);
    });

    const document = await modelEngine.create(
      { prompt: "A finance board" },
      deps(model, {
        tools: parallelTools,
        toolShapes: parallelShapes,
        pipeline: { regionParallel: true },
      }),
    );

    expect(document.name).toBe("Finance board");
    expect(sectionPrompts).toHaveLength(2);
    expect(sectionPrompts.every((prompt) => prompt.includes("Amounts are cents."))).toBe(true);
    const tree = document.tree as { queries?: Array<{ name: string }>; nodes: Nodes };
    expect(tree.queries?.map(({ name }) => name).sort()).toEqual(["s1_metric", "s2_inv"]);
    const components = tree.nodes.map(({ component }) => component);
    expect(components).toContain("MetricCard");
    expect(components).toContain("Table");
  });

  it("falls back to the single stream when the outline call fails", async () => {
    const valid = '<App name="Single"><MetricCard label="Revenue" value="$42k"/></App>';
    const lanes: string[] = [];
    const model = scriptedLanguageModel((call) => {
      if (isOutlineCall(call)) { lanes.push("outline"); return "no outline for you"; }
      lanes.push("full");
      return valid;
    });

    const document = await modelEngine.create(
      { prompt: "Build it" },
      deps(model, { tools: parallelTools, toolShapes: parallelShapes, pipeline: { regionParallel: true } }),
    );

    expect(document.name).toBe("Single");
    expect(lanes).toEqual(["outline", "full"]);
  });

  it("falls back to the single stream when coupling collapses the outline to one unit", async () => {
    const coupled = {
      tool: "plan_outline",
      input: {
        appName: "Coupled",
        sharedFacts: "",
        sections: [
          { id: "s1", brief: "Picker", tools: ["host_metric"], coupledWithPrevious: false },
          { id: "s2", brief: "Filtered view", tools: ["host_invoices"], coupledWithPrevious: true },
        ],
      },
    };
    const valid = '<App name="Single"><MetricCard label="Revenue" value="$42k"/></App>';
    const lanes: string[] = [];
    const model = scriptedLanguageModel((call) => {
      if (isOutlineCall(call)) { lanes.push("outline"); return coupled; }
      lanes.push(promptText(call).includes("OUTLINE_SECTION") ? "section" : "full");
      return valid;
    });

    const document = await modelEngine.create(
      { prompt: "A picker filtering a view" },
      deps(model, { tools: parallelTools, toolShapes: parallelShapes, pipeline: { regionParallel: true } }),
    );

    expect(document.name).toBe("Single");
    expect(lanes).toEqual(["outline", "full"]);
  });

  it("falls back to the single stream when ANY planned section fails to land (never ships a partial app)", async () => {
    const threeSections = {
      tool: "plan_outline",
      input: {
        appName: "Board",
        sharedFacts: "",
        sections: [
          { id: "s1", brief: "Metrics", tools: ["host_metric"], coupledWithPrevious: false },
          { id: "s2", brief: "Invoices", tools: ["host_invoices"], coupledWithPrevious: false },
          { id: "s3", brief: "Alerts", tools: [], coupledWithPrevious: false },
        ],
      },
    };
    const valid = '<App name="Single"><MetricCard label="Revenue" value="$42k"/></App>';
    const lanes: string[] = [];
    const model = scriptedLanguageModel((call) => {
      const text = promptText(call);
      if (isOutlineCall(call)) { lanes.push("outline"); return threeSections; }
      if (text.includes("OUTLINE_SECTION s1")) { lanes.push("s1"); return '<App name="Board"><MetricCard label="Revenue" value="$42k"/></App>'; }
      if (text.includes("OUTLINE_SECTION s2")) { lanes.push("s2"); return '<App name="Board"><Text text="Invoices"/></App>'; }
      if (text.includes("OUTLINE_SECTION s3")) { lanes.push("s3"); return "no wire markup at all"; }
      lanes.push("full");
      return valid;
    });

    const document = await modelEngine.create(
      { prompt: "Metrics, invoices, and alerts" },
      deps(model, { tools: parallelTools, toolShapes: parallelShapes, pipeline: { regionParallel: true } }),
    );

    // Two of three sections landed — assembling would silently drop the
    // alerts region, so the engine must regenerate via the single stream.
    expect(document.name).toBe("Single");
    expect(lanes.at(-1)).toBe("full");
  });

  it("stays off without the flag", async () => {
    const valid = '<App name="Plain"><MetricCard label="Revenue" value="$42k"/></App>';
    const lanes: string[] = [];
    const model = scriptedLanguageModel((call) => {
      lanes.push(isOutlineCall(call) ? "outline" : "full");
      return valid;
    });

    await modelEngine.create({ prompt: "Build it" }, deps(model, { tools: parallelTools }));

    expect(lanes).toEqual(["full"]);
  });
});

describe("end pass (flagged, polish-only, structurally cannot break)", () => {
  const valid = '<App name="Draft board"><MetricCard label="Revenue" value="$42k"/></App>';

  it("applies a compile-validated 0-2 op polish patch", async () => {
    const model = scriptedLanguageModel((call) =>
      isEndPassCall(call) ? '<Edit><SetName name="Revenue at a glance"/></Edit>' : valid);

    const document = await modelEngine.create(
      { prompt: "Build it" },
      deps(model, { pipeline: { endPass: true } }),
    );

    expect(document.name).toBe("Revenue at a glance");
  });

  it("drops an invalid patch silently and ships the original document", async () => {
    const model = scriptedLanguageModel((call) =>
      isEndPassCall(call) ? "sorry, here is prose instead of a patch" : valid);

    const document = await modelEngine.create(
      { prompt: "Build it" },
      deps(model, { pipeline: { endPass: true } }),
    );

    expect(document.name).toBe("Draft board");
  });

  it("applies a relabel and its contract leads with label truth (v4)", async () => {
    let endPassPrompt = "";
    const model = scriptedLanguageModel((call) => {
      if (isEndPassCall(call)) {
        endPassPrompt = promptText(call);
        return '<Edit><SetName name="Revenue at a glance"/><Set id="metriccard-1" label="Monthly revenue"/></Edit>';
      }
      return valid;
    });

    const document = await modelEngine.create(
      { prompt: "Build it" },
      deps(model, { pipeline: { endPass: true } }),
    );

    expect(document.name).toBe("Revenue at a glance");
    const card = (document.tree as { nodes: Nodes }).nodes.find(({ component }) => component === "MetricCard");
    expect(card?.props?.["label"]).toBe("Monthly revenue");
    expect(endPassPrompt).toContain("tell the truth about their bindings");
    expect(endPassPrompt).toContain("AT MOST 4 ops");
  });

  it("drops a patch whose Set rewrites a data prop — relabel only, never rewrite values (review P1)", async () => {
    const model = scriptedLanguageModel((call) =>
      isEndPassCall(call)
        ? '<Edit><Set id="metriccard-1" label="Monthly revenue"/><Set id="metriccard-1" value="$43k"/></Edit>'
        : valid);

    const document = await modelEngine.create(
      { prompt: "Build it" },
      deps(model, { pipeline: { endPass: true } }),
    );

    // The whole patch drops (including the legitimate relabel riding with it).
    expect(document.name).toBe("Draft board");
    const card = (document.tree as { nodes: Nodes }).nodes.find(({ component }) => component === "MetricCard");
    expect(card?.props?.["value"]).toBe("$42k");
    expect(card?.props?.["label"]).toBe("Revenue");
  });

  it("drops a patch that adds nodes — proofread, never restructure", async () => {
    const model = scriptedLanguageModel((call) =>
      isEndPassCall(call)
        ? '<Edit><Insert into="root"><Text text="bonus section"/></Insert></Edit>'
        : valid);

    const document = await modelEngine.create(
      { prompt: "Build it" },
      deps(model, { pipeline: { endPass: true } }),
    );

    expect(document.name).toBe("Draft board");
    expect((document.tree as { nodes: Nodes }).nodes.some(({ props }) => props?.["text"] === "bonus section")).toBe(false);
  });

  it("drops a patch that exceeds the 4-op budget", async () => {
    const model = scriptedLanguageModel((call) =>
      isEndPassCall(call)
        ? '<Edit><SetName name="A"/><SetName name="B"/><SetName name="C"/><SetName name="D"/><SetName name="E"/></Edit>'
        : valid);

    const document = await modelEngine.create(
      { prompt: "Build it" },
      deps(model, { pipeline: { endPass: true } }),
    );

    expect(document.name).toBe("Draft board");
  });

  it("drops a patch that breaks validation (a Remove emptying the app)", async () => {
    const model = scriptedLanguageModel((call, index) => {
      if (isEndPassCall(call)) {
        const wire = promptText(call);
        const match = /id="(metriccard-[0-9]+)"/.exec(wire);
        return `<Edit><Remove id="${match?.[1] ?? "missing"}"/></Edit>`;
      }
      void index;
      return valid;
    });

    const document = await modelEngine.create(
      { prompt: "Build it" },
      deps(model, { pipeline: { endPass: true } }),
    );

    expect(document.name).toBe("Draft board");
    expect((document.tree as { nodes: Nodes }).nodes.some(({ component }) => component === "MetricCard")).toBe(true);
  });

  it("is skipped entirely without the flag", async () => {
    let calls = 0;
    const model = scriptedLanguageModel(() => {
      calls += 1;
      return valid;
    });

    await modelEngine.create({ prompt: "Build it" }, deps(model));

    expect(calls).toBe(1);
  });
});
