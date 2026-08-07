import { describe, expect, it } from "vitest";
import { z } from "zod";
import { config, copy, data, propsSchema, type KitComponentSpec } from "../../src/kit/schema.js";

describe("prop classing", () => {
  it("tags props config | copy | data", () => {
    expect(config(z.number(), "how it behaves").cls).toBe("config");
    expect(copy(z.string(), "label text").cls).toBe("copy");
    expect(data(z.array(z.unknown()), "rows from a tool").cls).toBe("data");
  });

  it("carries doc + required flag", () => {
    const spec = data(z.array(z.unknown()), "rows", { required: true });
    expect(spec.doc).toBe("rows");
    expect(spec.required).toBe(true);
  });
});

describe("propsSchema", () => {
  const spec: KitComponentSpec = {
    name: "Demo",
    summary: "A demo component.",
    props: {
      rows: data(z.array(z.record(z.unknown())), "table rows", { required: true }),
      limit: config(z.number().int().positive(), "max rows"),
      title: copy(z.string(), "heading"),
    },
    examples: ["<Demo rows={x.list().data} limit={10} title=\"Hi\"/>"],
  };

  it("builds a zod object that validates good props", () => {
    const schema = propsSchema(spec);
    const parsed = schema.parse({ rows: [{ a: 1 }], limit: 10, title: "Hi" });
    expect(parsed.limit).toBe(10);
  });

  it("requires required props and rejects the wrong type", () => {
    const schema = propsSchema(spec);
    expect(schema.safeParse({ limit: 10 }).success).toBe(false); // missing rows
    expect(schema.safeParse({ rows: [], limit: -1 }).success).toBe(false); // bad limit
    expect(schema.safeParse({ rows: [] }).success).toBe(true); // optionals omitted
  });
});
