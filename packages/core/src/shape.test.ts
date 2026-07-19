import { describe, expect, it } from "vitest";
import {
  deriveShape,
  deriveShapeCard,
  describeShape,
  mergeShapes,
  shapeAtPointer,
  shapeCardSchema,
  type ShapeType,
} from "./shape.js";

/** v2 spec §3 — shape cards keep structure only; values are never stored. */
describe("deriveShape", () => {
  it("derives scalar kinds", () => {
    expect(deriveShape("hi")).toEqual({ kind: "string" });
    expect(deriveShape(3.5)).toEqual({ kind: "number" });
    expect(deriveShape(true)).toEqual({ kind: "boolean" });
    expect(deriveShape(null)).toEqual({ kind: "null" });
  });

  it("derives objects field-by-field, preserving field order", () => {
    expect(deriveShape({ month: "Jan", revenue: 1200 })).toEqual({
      kind: "object",
      fields: { month: { kind: "string" }, revenue: { kind: "number" } },
    });
  });

  it("derives nested structures", () => {
    expect(deriveShape({ rows: [{ id: 1 }] })).toEqual({
      kind: "object",
      fields: {
        rows: { kind: "array", items: { kind: "object", fields: { id: { kind: "number" } } } },
      },
    });
  });

  it("merges array element shapes across elements (missing fields become optional)", () => {
    expect(deriveShape([{ a: 1, b: "x" }, { a: 2 }])).toEqual({
      kind: "array",
      items: {
        kind: "object",
        fields: { a: { kind: "number" }, b: { kind: "string" } },
        optional: ["b"],
      },
    });
  });

  it("derives an empty array's items as json (unknown)", () => {
    expect(deriveShape([])).toEqual({ kind: "array", items: { kind: "json" } });
  });

  it("degrades non-Json values (undefined, functions) to json instead of throwing", () => {
    expect(deriveShape(undefined)).toEqual({ kind: "json" });
    expect(deriveShape(() => 1)).toEqual({ kind: "json" });
  });

  it("caps derivation depth: pathologically deep samples degrade to json, never overflow", () => {
    let deep: unknown = 1;
    for (let i = 0; i < 10_000; i += 1) deep = { next: deep };
    const shape = deriveShape(deep);
    expect(shape.kind).toBe("object");
    expect(JSON.stringify(shape)).toContain('"json"');
  });
});

describe("mergeShapes", () => {
  it("merges identical scalar kinds to themselves", () => {
    expect(mergeShapes({ kind: "string" }, { kind: "string" })).toEqual({ kind: "string" });
  });

  it("degrades mismatched kinds to json", () => {
    expect(mergeShapes({ kind: "string" }, { kind: "number" })).toEqual({ kind: "json" });
    expect(mergeShapes({ kind: "object", fields: {} }, { kind: "array", items: { kind: "json" } }))
      .toEqual({ kind: "json" });
  });

  it("json absorbs everything", () => {
    expect(mergeShapes({ kind: "json" }, { kind: "string" })).toEqual({ kind: "json" });
    expect(mergeShapes({ kind: "string" }, { kind: "json" })).toEqual({ kind: "json" });
  });

  it("merges objects field-wise, marking one-sided fields optional and unioning optional lists", () => {
    const merged = mergeShapes(
      { kind: "object", fields: { a: { kind: "number" }, b: { kind: "string" } }, optional: ["b"] },
      { kind: "object", fields: { a: { kind: "number" }, c: { kind: "boolean" } } },
    );
    expect(merged).toEqual({
      kind: "object",
      fields: { a: { kind: "number" }, b: { kind: "string" }, c: { kind: "boolean" } },
      optional: ["b", "c"],
    });
  });

  it("merges arrays item-wise", () => {
    expect(mergeShapes(
      { kind: "array", items: { kind: "number" } },
      { kind: "array", items: { kind: "number" } },
    )).toEqual({ kind: "array", items: { kind: "number" } });
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
