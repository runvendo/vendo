import { describe, expect, it } from "vitest";
import { describeShape, shapeAtPointer, shapeFromJsonSchema, type ShapeType } from "./shape.js";
import type { JsonSchema } from "./ids.js";

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

  it("renders a declared enum as its values, not as the bare kind", () => {
    expect(describeShape({ kind: "string", enum: ["paid", "void"] })).toBe('"paid" | "void"');
    expect(describeShape({
      kind: "object",
      fields: { status: { kind: "string", enum: ["open"] }, total: { kind: "number" } },
    })).toBe('{ status: "open", total: number }');
  });
});

describe("shapeFromJsonSchema", () => {
  it("converts scalars, arrays and objects, marking non-required fields optional", () => {
    expect(shapeFromJsonSchema({ type: "string" })).toEqual({ kind: "string" });
    expect(shapeFromJsonSchema({ type: "integer" })).toEqual({ kind: "number" });
    expect(shapeFromJsonSchema({
      type: "object",
      properties: {
        rows: { type: "array", items: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
        note: { type: "string" },
      },
      required: ["rows"],
    })).toEqual({
      kind: "object",
      fields: {
        rows: { kind: "array", items: { kind: "object", fields: { id: { kind: "string" } } } },
        note: { kind: "string" },
      },
      optional: ["note"],
    });
  });

  it("keeps enum and const values on the scalar branch", () => {
    expect(shapeFromJsonSchema({ type: "string", enum: ["paid", "void"] }))
      .toEqual({ kind: "string", enum: ["paid", "void"] });
    expect(shapeFromJsonSchema({ const: 7 })).toEqual({ kind: "number", enum: [7] });
  });

  it("intersects allOf branches, keeping their enums and required fields", () => {
    expect(shapeFromJsonSchema({
      allOf: [
        {
          type: "object",
          properties: { id: { type: "string" }, status: { type: "string", enum: ["posted", "pending"] }, notes: { type: "string" } },
          required: ["id", "status"],
        },
        { type: "object", properties: { actor: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } } },
      ],
    })).toEqual({
      kind: "object",
      fields: {
        id: { kind: "string" },
        status: { kind: "string", enum: ["posted", "pending"] },
        notes: { kind: "string" },
        actor: { kind: "object", fields: { name: { kind: "string" } } },
      },
      optional: ["notes", "actor"],
    });
  });

  it("intersects sibling properties with the allOf branches", () => {
    expect(shapeFromJsonSchema({
      type: "object",
      properties: { total: { type: "number" } },
      required: ["total"],
      allOf: [{ type: "object", properties: { id: { type: "string" } }, required: ["id"] }],
    })).toEqual({ kind: "object", fields: { id: { kind: "string" }, total: { kind: "number" } } });
  });

  it("degrades an allOf with a non-object member whole", () => {
    expect(shapeFromJsonSchema({ allOf: [{ type: "object", properties: { id: { type: "string" } } }, { type: "string" }] }))
      .toEqual({ kind: "json" });
    // An unmodelled member is not a constraint either: better unconstrained
    // than confidently narrow.
    expect(shapeFromJsonSchema({
      allOf: [{ type: "object", properties: { id: { type: "string" } } }, { anyOf: [{ type: "string" }, { type: "number" }] }],
    })).toEqual({ kind: "json" });
  });

  it("treats a constraint-only allOf branch as a constraint, not an erasure", () => {
    // The standard OpenAPI idiom: one branch describes, the next only tightens.
    expect(shapeFromJsonSchema({
      allOf: [
        { type: "object", properties: { id: { type: "string" }, note: { type: "string" } } },
        { required: ["id"] },
      ],
    })).toEqual({
      kind: "object",
      fields: { id: { kind: "string" }, note: { kind: "string" } },
      optional: ["note"],
    });
    expect(shapeFromJsonSchema({
      allOf: [{ type: "object", properties: { id: { type: "string" } }, required: ["id"] }, { additionalProperties: false }],
    })).toEqual({ kind: "object", fields: { id: { kind: "string" } } });
  });

  it("degrades an allOf of constraints alone rather than closing an empty object", () => {
    expect(shapeFromJsonSchema({ allOf: [{ required: ["id"] }] })).toEqual({ kind: "json" });
  });

  it("degrades unmodelled constructs to json instead of throwing", () => {
    expect(shapeFromJsonSchema({})).toEqual({ kind: "json" });
    expect(shapeFromJsonSchema({ anyOf: [{ type: "string" }, { type: "number" }] })).toEqual({ kind: "json" });
    expect(shapeFromJsonSchema({ type: "array" })).toEqual({ kind: "array", items: { kind: "json" } });
  });

  it("caps conversion depth instead of overflowing", () => {
    let schema: JsonSchema = { type: "string" };
    for (let index = 0; index < 10_000; index += 1) schema = { type: "object", properties: { next: schema } };
    expect(JSON.stringify(shapeFromJsonSchema(schema))).toContain('"json"');
  });
});
