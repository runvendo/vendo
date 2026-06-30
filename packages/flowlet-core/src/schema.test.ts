import { describe, it, expect } from "vitest";
import { z } from "zod";
import { isJsonSchemaConvertible, toJsonSchema } from "./schema";

describe("schema boundary", () => {
  it("accepts a Zod schema as JSON-Schema-convertible", () => {
    expect(isJsonSchemaConvertible(z.object({ city: z.string() }))).toBe(true);
  });

  it("converts a Zod schema to a JSON Schema object with properties", () => {
    const json = toJsonSchema(z.object({ city: z.string() })) as Record<string, unknown>;
    expect(json.type).toBe("object");
    expect((json.properties as Record<string, unknown>).city).toBeDefined();
  });
});
