/**
 * Contract-compliance gate: everything the extractor emits must validate
 * against BOTH the frozen zod schemas (@vendoai/core) and the committed
 * generated JSON Schemas (packages/vendo-core/schemas/*.schema.json).
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Ajv from "ajv";
import { convertOpenApi } from "./openapi.js";
import { toolsManifestSchema, manifestThemeSchema } from "./manifest.js";
import { mapVarsToBrand } from "../theme/map-to-brand.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const schemasDir = path.join(here, "../../../vendo-core/schemas");
const fixture = path.join(here, "../../test/fixtures/openapi/maple.json");

function ajvValidator(file: string) {
  return new Ajv({ strict: false }).compile(JSON.parse(readFileSync(path.join(schemasDir, file), "utf8")));
}

describe("extractor output vs frozen contracts", () => {
  it("openapi-extracted tools.json validates under zod AND the committed JSON Schema", async () => {
    const tools = await convertOpenApi(fixture);
    const manifest = { version: 1, tools, events: [] };
    expect(toolsManifestSchema.safeParse(manifest).success).toBe(true);
    const validate = ajvValidator("tools.schema.json");
    expect(validate(manifest)).toBe(true);
  });

  it("extracted theme validates under zod AND the committed JSON Schema", () => {
    const { brand } = mapVarsToBrand([
      { name: "--color-bg", value: "#FBFBFA", file: "a.css", darkScope: false },
      { name: "--color-surface", value: "#FFFFFF", file: "a.css", darkScope: false },
      { name: "--color-ink", value: "#111111", file: "a.css", darkScope: false },
    ]);
    expect(manifestThemeSchema.safeParse(brand).success).toBe(true);
    expect(ajvValidator("theme.schema.json")(brand)).toBe(true);
  });
});
