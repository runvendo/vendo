import { describe, expect, it } from "vitest";
import { generateSampleProps } from "../../src/sync/sample-props.js";

describe("generated preview props", () => {
  it("is deterministic — the same schema and name always produce the same bytes", () => {
    const schema = {
      type: "object",
      properties: {
        title: { type: "string" },
        amountCents: { type: "number" },
        active: { type: "boolean" },
        slices: { type: "array", items: { type: "object", properties: { label: { type: "string" }, amount: { type: "number" } }, required: ["label", "amount"] } },
      },
      required: ["title", "amountCents", "active", "slices"],
    } as const;

    const first = generateSampleProps("Donut", schema);
    // `.vendo/components/` is committed: anything unstable rewrites the corpus
    // on every sync, which is the churn class this lane already fixed twice.
    for (let run = 0; run < 5; run += 1) {
      expect(generateSampleProps("Donut", schema)).toEqual(first);
    }
  });

  it("seeds off the component name, so two components do not share filler", () => {
    const schema = { type: "object", properties: { label: { type: "string" }, count: { type: "number" } }, required: ["label", "count"] } as const;
    expect(generateSampleProps("Alpha", schema)).not.toEqual(generateSampleProps("Beta", schema));
  });

  it("respects declared types, optionality, and constraints", () => {
    const props = generateSampleProps("Card", {
      type: "object",
      properties: {
        name: { type: "string", minLength: 12 },
        ratio: { type: "number", minimum: 10, maximum: 20 },
        tier: { enum: ["gold", "silver"] },
        pinned: { const: true },
        when: { type: "string", format: "date-time" },
        rows: { type: "array", items: { type: "integer" }, minItems: 4 },
        maybe: { type: "string" },
      },
      required: ["name", "ratio", "tier", "pinned", "when", "rows"],
    })!;

    expect(typeof props.name).toBe("string");
    expect((props.name as string).length).toBeGreaterThanOrEqual(12);
    expect(props.ratio as number).toBeGreaterThanOrEqual(10);
    expect(props.ratio as number).toBeLessThanOrEqual(20);
    expect(["gold", "silver"]).toContain(props.tier);
    expect(props.pinned).toBe(true);
    expect(Number.isNaN(Date.parse(props.when as string))).toBe(false);
    expect(props.rows as number[]).toHaveLength(4);
    expect((props.rows as number[]).every((value) => Number.isInteger(value))).toBe(true);
    // Optional properties are still filled: a preview with more data reads
    // closer to the real thing, and every value is schema-valid either way.
    expect(props.maybe).toBeDefined();
  });

  it("drops an optional property it cannot synthesize, but fails on a required one", () => {
    const opaque = {} as Record<string, never>;
    expect(generateSampleProps("Partial", {
      type: "object",
      properties: { good: { type: "string" }, bad: opaque },
      required: ["good"],
    })).toEqual({ good: expect.any(String) });

    expect(generateSampleProps("Blocked", {
      type: "object",
      properties: { bad: opaque },
      required: ["bad"],
    })).toBeNull();
  });

  it("refuses an array whose element type is unknown rather than seeding an empty one", () => {
    // `[]` is typed-correct but makes `if (!rows?.length) return null` render
    // nothing — the exact blank the seed exists to prevent.
    expect(generateSampleProps("Rows", {
      type: "object",
      properties: { rows: { type: "array" } },
      required: ["rows"],
    })).toBeNull();
  });

  it("refuses an empty object where the schema expected data", () => {
    // Same blank-render trap as an unknown array element type: `{}` is
    // typed-correct but the component draws nothing, so the honest rung-3 label
    // beats a seed that guarantees a blank tile.
    // z.record(...) — no declared properties, an open value schema.
    expect(generateSampleProps("Record", {
      type: "object",
      properties: { rows: { type: "object", additionalProperties: { type: "string" } } },
      required: ["rows"],
    })).toBeNull();
    // An all-optional object whose every property is unsynthesizable.
    expect(generateSampleProps("AllOptionalBad", {
      type: "object",
      properties: { a: { type: "array" }, b: { type: "array" } },
    })).toBeNull();
  });

  it("still seeds a component that genuinely declares no props", () => {
    // Distinct from the case above: nothing was expected, so `{}` is correct
    // and the component will draw.
    expect(generateSampleProps("NoProps", {
      type: "object",
      properties: {},
      additionalProperties: false,
    })).toEqual({});
  });

  it("keeps an obviously-paired current/ceiling coherent", () => {
    // A progress bar seeded `value: 554008, max: 228` is typed-correct and
    // visibly broken — worse in a preview than no seed at all.
    const props = generateSampleProps("DocProgress", {
      type: "object",
      properties: { value: { type: "number" }, max: { type: "number" } },
      required: ["value", "max"],
    })!;
    expect(props.value as number).toBeLessThanOrEqual(props.max as number);
    expect(props.value as number).toBeGreaterThan(0);
  });

  it("returns null for the permissive placeholder and for a recursive schema", () => {
    expect(generateSampleProps("Unknown", {})).toBeNull();
    expect(generateSampleProps("Unknown", undefined)).toBeNull();

    const recursive: Record<string, unknown> = { type: "object", required: ["child"] };
    recursive.properties = { child: recursive };
    expect(generateSampleProps("Tree", recursive)).toBeNull();
  });

  it("picks the non-null arm of a nullable union so the preview has real data", () => {
    const props = generateSampleProps("Nullable", {
      type: "object",
      properties: { value: { anyOf: [{ type: "number" }, { type: "null" }] } },
      required: ["value"],
    })!;
    expect(typeof props.value).toBe("number");
  });

  it("produces JSON-safe values that survive the wire", () => {
    const props = generateSampleProps("Wire", {
      type: "object",
      properties: { a: { type: "string" }, b: { type: "array", items: { type: "number" } } },
      required: ["a", "b"],
    })!;
    expect(JSON.parse(JSON.stringify(props))).toEqual(props);
  });
});
