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
 * dependencies) and is read back through the SHIPPED read path (the `validate`
 * door → `screenTypesCheck` → `tsc`). Neither side is stubbed, so they cannot
 * agree by construction.
 */
import {
  type JsonSchema,
  type NormalizedCatalog,
  type RunContext,
  type StandardSchema,
  type ToolDescriptor,
  type ToolRegistry,
} from "@vendoai/core";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createApps } from "../index.js";
import { guardFixture, memoryStore, scriptedLanguageModel } from "../testing/index.js";

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

const DONUT = `<App name="Spending"><Query id="spending" tool="${TOOL}"/><MapleSpendingDonut slices={spending.data}/></App>`;
const WRONG_FIELD = `<App name="Spending"><Query id="spending" tool="${TOOL}"/><Text text={spending.total}/></App>`;

const blocked = (findings: readonly { severity: string; message: string }[]): string =>
  findings.filter(({ severity }) => severity === "block").map(({ message }) => message).join("\n");

describe("the declaration is the contract the screen is checked against", () => {
  it("refuses a field the declaration does not carry, with no sample in play", async () => {
    const result = await runtime({ declared: true, sampled: false }).validate({ document: WRONG_FIELD }, ctx);

    expect(result.ok).toBe(false);
    // The declaration is the only thing that could know this — and it teaches
    // the field that IS there.
    expect(blocked(result.findings)).toContain('reads field "total"');
    expect(blocked(result.findings)).toContain("data");
  }, 60_000);

  it("satisfies an enum-typed prop — the donut case", async () => {
    const result = await runtime({ declared: true, sampled: true }).validate({ document: DONUT }, ctx);

    expect(blocked(result.findings)).toBe("");
    expect(result.ok).toBe(true);
  }, 60_000);

  it("without it, the sample erases the enum and the same screen is refused", async () => {
    // The pre-existing bug, kept as the contrast: this is the ONLY difference
    // between the two runs, so the declaration is demonstrably what unblocks it.
    const result = await runtime({ declared: false, sampled: true }).validate({ document: DONUT }, ctx);

    expect(result.ok).toBe(false);
    expect(blocked(result.findings)).toContain("slices");
  }, 60_000);
});
