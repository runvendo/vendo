import { describe, expect, it } from "vitest";
import { manifestThemeSchema, manifestComponentSchema } from "@vendoai/core";
import { zodToJsonSchema } from "zod-to-json-schema";
import { defaultBrand, brandTokensSchema } from "./theme/brand";
import { descriptors } from "./descriptors";

describe("existing artifacts conform to the frozen manifest contracts", () => {
  it("defaultBrand is a valid manifest theme", () => {
    expect(() => manifestThemeSchema.parse(defaultBrand)).not.toThrow();
  });

  it("brandTokensSchema and manifestThemeSchema agree on shape", () => {
    // Same generated JSON Schema = structurally identical contracts.
    expect(zodToJsonSchema(brandTokensSchema, { $refStrategy: "none" })).toEqual(
      zodToJsonSchema(manifestThemeSchema, { $refStrategy: "none" }),
    );
  });

  it("every prewired descriptor serializes to a valid ManifestComponent", () => {
    for (const d of descriptors) {
      const entry = {
        name: d.name,
        description: d.description,
        propsSchema: zodToJsonSchema(d.propsSchema, { $refStrategy: "none" }) as Record<
          string,
          unknown
        >,
      };
      expect(() => manifestComponentSchema.parse(entry), d.name).not.toThrow();
    }
  });
});
