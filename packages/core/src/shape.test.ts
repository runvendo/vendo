import { describe, expect, it } from "vitest";
import {
  deriveShapeCard,
  describeShape,
  shapeAtPointer,
  shapeCardSchema,
  type ShapeType,
} from "./shape.js";
import type { Json } from "./ids.js";

/** deriveShape/mergeShapes are internal; deriveShapeCard is their only
 *  production path, so derivation (single sample) and merging (multiple
 *  samples) are exercised through it. */
const derived = (...samples: Json[]): ShapeType => deriveShapeCard("t", samples).output;

/** v2 spec §3 — shape cards keep structure only; values are never stored. */
describe("shape derivation (single-sample deriveShapeCard)", () => {
  it("derives scalar kinds", () => {
    expect(derived("hi")).toEqual({ kind: "string" });
    expect(derived(3.5)).toEqual({ kind: "number" });
    expect(derived(true)).toEqual({ kind: "boolean" });
    expect(derived(null)).toEqual({ kind: "null" });
  });

  it("derives objects field-by-field, preserving field order", () => {
    expect(derived({ month: "Jan", revenue: 1200 })).toEqual({
      kind: "object",
      fields: { month: { kind: "string" }, revenue: { kind: "number" } },
    });
  });

  it("derives nested structures", () => {
    expect(derived({ rows: [{ id: 1 }] })).toEqual({
      kind: "object",
      fields: {
        rows: { kind: "array", items: { kind: "object", fields: { id: { kind: "number" } } } },
      },
    });
  });

  it("merges array element shapes across elements (missing fields become optional)", () => {
    expect(derived([{ a: 1, b: "x" }, { a: 2 }])).toEqual({
      kind: "array",
      items: {
        kind: "object",
        fields: { a: { kind: "number" }, b: { kind: "string" } },
        optional: ["b"],
      },
    });
  });

  it("derives an empty array's items as json (unknown)", () => {
    expect(derived([])).toEqual({ kind: "array", items: { kind: "json" } });
  });

  it("degrades non-Json values (undefined, functions) to json instead of throwing", () => {
    expect(derived(undefined)).toEqual({ kind: "json" });
    expect(derived(() => 1)).toEqual({ kind: "json" });
  });

  it("caps derivation depth: pathologically deep samples degrade to json, never overflow", () => {
    let deep: unknown = 1;
    for (let i = 0; i < 10_000; i += 1) deep = { next: deep };
    const shape = derived(deep);
    expect(shape.kind).toBe("object");
    expect(JSON.stringify(shape)).toContain('"json"');
  });
});

describe("shape merging (multi-sample deriveShapeCard)", () => {
  it("merges identical scalar kinds to themselves", () => {
    expect(derived("a", "b")).toEqual({ kind: "string" });
  });

  it("degrades mismatched kinds to json", () => {
    expect(derived("a", 1)).toEqual({ kind: "json" });
    expect(derived({}, [])).toEqual({ kind: "json" });
  });

  it("json absorbs everything", () => {
    expect(derived(undefined, "a")).toEqual({ kind: "json" });
    expect(derived("a", undefined)).toEqual({ kind: "json" });
  });

  it("merges objects field-wise, marking one-sided fields optional across samples", () => {
    expect(derived({ a: 1, b: "x" }, { a: 2 }, { a: 3, c: true })).toEqual({
      kind: "object",
      fields: { a: { kind: "number" }, b: { kind: "string" }, c: { kind: "boolean" } },
      optional: ["b", "c"],
    });
  });

  it("merges arrays item-wise", () => {
    expect(derived([1], [2])).toEqual({ kind: "array", items: { kind: "number" } });
  });
});

describe("shapeAtPointer", () => {
  const shape: ShapeType = {
    kind: "object",
    fields: {
      rows: { kind: "array", items: { kind: "object", fields: { month: { kind: "string" } } } },
      total: { kind: "number" },
    },
  };

  it('"" returns the whole shape', () => {
    expect(shapeAtPointer(shape, "")).toEqual(shape);
  });

  it("walks object fields", () => {
    expect(shapeAtPointer(shape, "/total")).toEqual({ kind: "number" });
  });

  it("array index segments step into items", () => {
    expect(shapeAtPointer(shape, "/rows/0/month")).toEqual({ kind: "string" });
  });

  it("misses return undefined (absent field, non-index into array, past a scalar)", () => {
    expect(shapeAtPointer(shape, "/missing")).toBeUndefined();
    expect(shapeAtPointer(shape, "/rows/month")).toBeUndefined();
    expect(shapeAtPointer(shape, "/total/deeper")).toBeUndefined();
  });

  it("json stays json at any depth", () => {
    expect(shapeAtPointer({ kind: "json" }, "/a/b/c")).toEqual({ kind: "json" });
  });

  it("decodes RFC 6901 escapes and rejects malformed ones", () => {
    const escaped: ShapeType = { kind: "object", fields: { "a/b": { kind: "string" } } };
    expect(shapeAtPointer(escaped, "/a~1b")).toEqual({ kind: "string" });
    expect(shapeAtPointer(escaped, "/a~2b")).toBeUndefined();
    expect(shapeAtPointer(shape, "total")).toBeUndefined();
  });
});

describe("describeShape", () => {
  it("renders the compact notation the engine embeds in model context", () => {
    expect(describeShape({ kind: "string" })).toBe("string");
    expect(describeShape({ kind: "json" })).toBe("Json");
    expect(describeShape({
      kind: "array",
      items: { kind: "object", fields: { month: { kind: "string" }, revenue: { kind: "number" } } },
    })).toBe("{ month: string, revenue: number }[]");
  });

  it("marks optional fields and renders empty objects", () => {
    expect(describeShape({
      kind: "object",
      fields: { a: { kind: "number" }, b: { kind: "string" } },
      optional: ["b"],
    })).toBe("{ a: number, b?: string }");
    expect(describeShape({ kind: "object", fields: {} })).toBe("{}");
  });

  it("elides beyond the depth bound instead of recursing forever", () => {
    let shape: ShapeType = { kind: "string" };
    for (let i = 0; i < 50; i += 1) shape = { kind: "object", fields: { next: shape } };
    const text = describeShape(shape);
    expect(text).toContain("…");
    expect(text.length).toBeLessThan(2_000);
  });
});

describe("shape cards", () => {
  it("deriveShapeCard merges multiple recorded samples", () => {
    const card = deriveShapeCard("metrics.revenue", [
      { rows: [{ month: "Jan", revenue: 1 }] },
      { rows: [{ month: "Feb", revenue: 2, note: "promo" }] },
    ]);
    expect(card.tool).toBe("metrics.revenue");
    expect(card.source).toBe("sample");
    expect(card.output).toEqual({
      kind: "object",
      fields: {
        rows: {
          kind: "array",
          items: {
            kind: "object",
            fields: {
              month: { kind: "string" },
              revenue: { kind: "number" },
              note: { kind: "string" },
            },
            optional: ["note"],
          },
        },
      },
    });
  });

  it("deriveShapeCard with no samples yields an unknown (json) output", () => {
    expect(deriveShapeCard("metrics.revenue", []).output).toEqual({ kind: "json" });
  });

  it("shapeCardSchema accepts a derived card and rejects malformed ones", () => {
    const card = deriveShapeCard("payments.list", [{ items: [] }], "2026-07-18T00:00:00Z");
    expect(card.sampledAt).toBe("2026-07-18T00:00:00Z");
    expect(shapeCardSchema.safeParse(card).success).toBe(true);
    expect(shapeCardSchema.safeParse({ tool: "t" }).success).toBe(false);
    expect(shapeCardSchema.safeParse({
      tool: "t",
      output: { kind: "wat" },
      source: "sample",
    }).success).toBe(false);
  });
});
