import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv from "ajv";
import { describe, expect, it } from "vitest";
import { generatedSchemas } from "../../scripts/generate-schemas";

const schemasDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "schemas");

describe("committed JSON Schema artifacts", () => {
  for (const [file, schema] of Object.entries(generatedSchemas)) {
    it(`${file} is in sync with the zod source (run pnpm generate:schemas)`, () => {
      const committed = JSON.parse(readFileSync(join(schemasDir, file), "utf8"));
      expect(committed).toEqual(schema);
    });

    it(`${file} compiles under ajv`, () => {
      const ajv = new Ajv({ strict: false });
      expect(() => ajv.compile(schema)).not.toThrow();
    });
  }

  it("theme.schema.json accepts the flowlet-components default brand shape", () => {
    const ajv = new Ajv({ strict: false });
    const validate = ajv.compile(
      JSON.parse(readFileSync(join(schemasDir, "theme.schema.json"), "utf8")),
    );
    expect(
      validate({
        version: 1,
        accent: "#0A7CFF",
        background: "#FFFFFF",
        surface: "#F5F7FA",
        text: "#111418",
        mutedText: "#5B6470",
        fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
        radius: 8,
        mode: "light",
      }),
    ).toBe(true);
  });
});
