/**
 * A tool's DECLARED output schema is what the screen type check reads.
 *
 * `screenTypings` has always preferred `toolOutputSchemas` over the sampled
 * `toolShapes` — and nothing ever populated it, so every screen was type-checked
 * against one observation instead of the host's own contract. Sampling erases
 * what a declaration keeps: an enum field samples as a bare `string`, so a host
 * component whose prop takes that enum could never be satisfied from any tool,
 * and "show me my spending by category" was refused at the checks floor on a
 * screen that was correct (demo-bank's `MapleSpendingDonut.slices` against
 * `host_getSpendingInsights`, live 2026-08).
 *
 * Both halves of the seam are real here: the declaration travels the SHIPPED
 * write path (a `ToolRegistry` descriptor → `generationToolContext` → the floor's
 * dependencies) and is read back through the SHIPPED read path (the checks
 * floor's own gauntlet → `componentScreenTypings` → `tsc`). Neither side is
 * stubbed, so they cannot agree by construction.
 */
import {
  type JsonSchema,
  type RunContext,
  type ToolDescriptor,
  type ToolRegistry,
} from "@vendoai/core";
import {
  type NormalizedCatalog,
  type StandardSchema,
} from "../../src/contract/index.js";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createApps } from "../../src/server/index.js";
import { guardFixture } from "../../src/server/testing/guard-fixture.js";
import { memoryStore } from "../../src/server/testing/memory-store.js";
import { scriptedLanguageModel } from "../../src/server/testing/scripted-model.js";

const TOOL = "host_getSpendingInsights";
const CATEGORIES = ["dining", "groceries", "other"] as const;

/** The host's own contract: category is an ENUM, and the slices live one hop in
 *  under `data`. */
const outputSchema: JsonSchema = {
  type: "object",
  properties: {
    data: {
      type: "array",
      items: {
        type: "object",
        properties: {
          category: { type: "string", enum: [...CATEGORIES] },
          amount: { type: "integer" },
        },
        required: ["category", "amount"],
      },
    },
  },
  required: ["data"],
};

/** The donut in miniature: `slices` takes rows whose category is the SAME enum,
 *  which a sampled `string` can never satisfy. */
const donutJsonSchema: JsonSchema = {
  type: "object",
  properties: {
    slices: {
      type: "array",
      items: {
        type: "object",
        properties: {
          category: { type: "string", enum: [...CATEGORIES] },
          amount: { type: "number" },
        },
        required: ["category", "amount"],
      },
    },
  },
  required: ["slices"],
  additionalProperties: false,
};

const catalog: NormalizedCatalog = [{
  name: "MapleSpendingDonut",
  description: "Spending by category",
  propsSchema: z.object({
    slices: z.array(z.object({ category: z.enum(CATEGORIES), amount: z.number() })),
  }) as unknown as StandardSchema,
  propsJsonSchema: donutJsonSchema,
}];

const descriptor = (declared: boolean): ToolDescriptor => ({
  name: TOOL,
  description: "Spending by category, this month",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  risk: "read",
  ...(declared ? { outputSchema } : {}),
});

/** A registry that really answers, so the runtime really samples: the sample
 *  carries `category: "dining"`, which derives to the bare `string` that erases
 *  the enum. `sampled: false` is the tool that cannot be sampled at all, where
 *  only a declaration can say anything. */
const registry = (options: { declared: boolean; sampled: boolean }): ToolRegistry => ({
  async descriptors() { return [descriptor(options.declared)]; },
  async execute() {
    return options.sampled
      ? { status: "ok" as const, output: { data: [{ category: "dining", amount: 34_218 }] } }
      : { status: "error" as const, error: { code: "unavailable" as const, message: "the account is not connected" } };
  },
});

const ctx: RunContext = {
  principal: { kind: "user", subject: "user_ada" },
  venue: "app",
  presence: "present",
  sessionId: "session_ada",
};

const runtime = (options: { declared: boolean; sampled: boolean }) => createApps({
  store: memoryStore(),
  guard: guardFixture(),
  tools: registry(options),
  catalog,
  model: scriptedLanguageModel(() => "no"),
});

const DONUT = `import { MapleSpendingDonut, useQuery } from "@vendo/screen";

export default function Spending() {
  const spending = useQuery("${TOOL}");
  return <MapleSpendingDonut slices={spending.data} />;
}
`;
const WRONG_FIELD = `import { Text, useQuery } from "@vendo/screen";

export default function Spending() {
  const spending = useQuery("${TOOL}");
  return <Text text={spending.total} />;
}
`;

const APP = "app_declared" as const;

/** The screen through the checks floor — the paint gate every author faces. */
const paint = async (options: { declared: boolean; sampled: boolean }, source: string) =>
  await runtime(options).floor(ctx).component({ appId: APP, source });

describe("the declaration is the contract the screen is checked against", () => {
  it("refuses a field the declaration does not carry, with no sample in play", async () => {
    const result = await paint({ declared: true, sampled: false }, WRONG_FIELD);

    expect(result.ok).toBe(false);
    // The declaration is the only thing that could know this — and it teaches
    // the field that IS there.
    const blocking = result.ok ? "" : result.blocking.join("\n");
    expect(blocking).toContain("total");
    expect(blocking).toContain("data");
  }, 60_000);

  it("satisfies an enum-typed prop — the donut case", async () => {
    const result = await paint({ declared: true, sampled: true }, DONUT);

    expect(result.ok ? [] : result.blocking).toEqual([]);
    expect(result.ok).toBe(true);
  }, 60_000);
});
