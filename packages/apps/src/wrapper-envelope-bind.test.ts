import type { NormalizedCatalog } from "@vendoai/core";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { modelEngine } from "./engine.js";
import { scriptedLanguageModel, type ScriptedModelCall } from "./testing/index.js";

/**
 * Regression guard for the LIVE Maple failure (2026-07-27, demos.vendo.run):
 * "Show my spending by category" rendered nothing. The model bound the donut's
 * `slices` array prop to the spending tool's ROOT object — the `{ data: [...] }`
 * envelope the route returns — so validation rejected every attempt with
 * `expected an array, the bound field is object`, the closed fix space was
 * empty (a kind mismatch is not a compile binding error), and the whole app was
 * regenerated. Three creates, no app.
 *
 * The fixture is the live shape: the real component contract, the real
 * envelope, the real wire the model wrote.
 */

const catalog: NormalizedCatalog = [{
  name: "MapleSpendingDonut",
  description: "Spending by category.",
  propsSchema: z.object({
    slices: z.array(z.object({ category: z.string(), amount: z.number() })),
    size: z.number().optional(),
  }),
  propsJsonSchema: {
    type: "object",
    properties: {
      slices: {
        type: "array",
        items: {
          type: "object",
          properties: { category: { type: "string" }, amount: { type: "number" } },
          required: ["category", "amount"],
        },
      },
      size: { type: "number" },
    },
    required: ["slices"],
    additionalProperties: false,
  },
}];

const slicesShape = {
  kind: "array" as const,
  items: {
    kind: "object" as const,
    fields: { category: { kind: "string" as const }, amount: { kind: "number" as const } },
  },
};

/** The real route shape: `ok(spendingByCategory())` → `{ data: SpendingSlice[] }`. */
const envelopeShapes = {
  host_getSpendingInsights: { kind: "object" as const, fields: { data: slicesShape } },
};

const tools = [{ name: "host_getSpendingInsights", description: "Spending by category", risk: "read" }];

const deps = (model: unknown, extra: Record<string, unknown> = {}) => ({
  model,
  catalog,
  tools,
  ...extra,
}) as unknown as Parameters<typeof modelEngine.create>[1];

const promptText = (call: ScriptedModelCall): string => call.prompt.map((message) => {
  if (typeof message.content === "string") return message.content;
  return message.content.map((part) => part.text ?? "").join("");
}).join("\n");

const isRepairCall = (call: ScriptedModelCall): boolean =>
  promptText(call).includes("locate the failing nodes");

/** The wire the live model wrote: the donut's slices bound to the tool ROOT. */
const wrapperBoundWire = '<App name="Spending"><MapleSpendingDonut slices={host_getSpendingInsights({})}/></App>';

type Nodes = Array<{ id: string; component: string; props?: Record<string, unknown> }>;

const donutSlices = (document: { tree?: unknown }): unknown =>
  (document.tree as { nodes: Nodes }).nodes.find(({ component }) => component === "MapleSpendingDonut")?.props?.slices;

describe("wrapper-envelope rebind (array prop bound to a { data: [...] } wrapper)", () => {
  it("rebinds to the wrapper's only array and validates — no full-lane regeneration", async () => {
    const calls: ScriptedModelCall[] = [];
    const events: Array<Record<string, unknown>> = [];
    const model = scriptedLanguageModel((call) => {
      calls.push(call);
      return wrapperBoundWire;
    });

    const document = await modelEngine.create(
      { prompt: "Show my spending by category" },
      deps(model, { toolShapes: envelopeShapes, onPipeline: (event: Record<string, unknown>) => events.push(event) }),
    );

    expect(donutSlices(document)).toEqual({ $path: "/hostGetSpendingInsights/data" });
    // ONE wire generation: no strict repair round, no second full lane.
    expect(calls).toHaveLength(1);
    expect(calls.filter(isRepairCall)).toHaveLength(0);
    expect(events).toContainEqual(expect.objectContaining({ stage: "repair", rounds: 0, repaired: true, rebinds: 1 }));
    expect(events.filter((event) => event.stage === "full")).toHaveLength(1);
  });

  it("leaves an AMBIGUOUS wrapper (two array fields) exactly as it is today", async () => {
    const calls: ScriptedModelCall[] = [];
    const model = scriptedLanguageModel((call) => {
      calls.push(call);
      return wrapperBoundWire;
    });

    await expect(modelEngine.create(
      { prompt: "Show my spending by category" },
      deps(model, {
        toolShapes: {
          host_getSpendingInsights: {
            kind: "object" as const,
            fields: { data: slicesShape, pending: slicesShape },
          },
        },
      }),
    )).rejects.toThrow(/could not produce a valid app/);
    // The whole ladder ran and nothing was silently rebound.
    expect(calls.length).toBeGreaterThan(1);
  });

  it("leaves a wrapper with NO array field exactly as it is today", async () => {
    const model = scriptedLanguageModel(() => wrapperBoundWire);

    await expect(modelEngine.create(
      { prompt: "Show my spending by category" },
      deps(model, {
        toolShapes: {
          host_getSpendingInsights: {
            kind: "object" as const,
            fields: { total: { kind: "number" as const }, currency: { kind: "string" as const } },
          },
        },
      }),
    )).rejects.toThrow(/could not produce a valid app/);
  });

  it("still repairs when the envelope bind is only ONE of several faults", async () => {
    // slices lands on the wrapper AND the size prop binds a missing field —
    // the deterministic arm fixes its own class and the strict round the rest.
    const wire = '<App name="Spending"><MapleSpendingDonut slices={host_getSpendingInsights({})} size={host_getSpendingInsights({}).missing}/></App>';
    const model = scriptedLanguageModel((call) => {
      if (isRepairCall(call)) return { tool: "apply_fixes", input: { fix_0: "__no_valid_fix__" } };
      return wire;
    });

    const document = await modelEngine.create(
      { prompt: "Show my spending by category" },
      deps(model, { toolShapes: envelopeShapes }),
    );

    expect(donutSlices(document)).toEqual({ $path: "/hostGetSpendingInsights/data" });
  });
});
