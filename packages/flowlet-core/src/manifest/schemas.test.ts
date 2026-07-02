import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv from "ajv";
import { describe, expect, it } from "vitest";
import { generatedSchemas } from "../../scripts/generate-schemas";
import { manifestThemeSchema } from "./theme";
import { toolsManifestSchema } from "./manifest";

const schemasDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "schemas");

const validTheme = {
  version: 1,
  accent: "#0A7CFF",
  background: "#FFFFFF",
  surface: "#F5F7FA",
  text: "#111418",
  mutedText: "#5B6470",
  fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
  radius: 8,
  mode: "light",
};

function compileCommitted(file: string) {
  return new Ajv({ strict: false }).compile(
    JSON.parse(readFileSync(join(schemasDir, file), "utf8")),
  );
}

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
    expect(compileCommitted("theme.schema.json")(validTheme)).toBe(true);
  });

  it("zod and AJV agree: unknown keys are rejected on both sides", () => {
    const themeWithExtra = { ...validTheme, extraToken: "#FFFFFF" };
    expect(compileCommitted("theme.schema.json")(themeWithExtra)).toBe(false);
    expect(manifestThemeSchema.safeParse(themeWithExtra).success).toBe(false);

    const toolsWithExtra = { version: 1, tools: [], extra: 1 };
    expect(compileCommitted("tools.schema.json")(toolsWithExtra)).toBe(false);
    expect(toolsManifestSchema.safeParse(toolsWithExtra).success).toBe(false);
  });

  it("zod and AJV agree: missing events is accepted (zod normalizes to [])", () => {
    // JSON Schema `default` is annotation-only: raw-JSON consumers must treat a
    // missing `events` as empty; zod parse is the normalization layer.
    const noEvents = { version: 1, tools: [] };
    expect(compileCommitted("tools.schema.json")(noEvents)).toBe(true);
    const parsed = toolsManifestSchema.parse(noEvents);
    expect(parsed.events).toEqual([]);
  });
});
