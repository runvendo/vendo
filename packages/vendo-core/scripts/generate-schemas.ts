import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { zodToJsonSchema } from "zod-to-json-schema";
import { manifestThemeSchema } from "../src/manifest/theme";
import { toolsManifestSchema, vendoManifestSchema } from "../src/manifest/manifest";

// CONSTRAINT: zodToJsonSchema cannot serialize .refine()/.transform() logic, so
// the drift test would silently miss them. Manifest schemas must stay
// refinement-free (regex/enum/literal only); if a refinement ever becomes
// necessary, add an explicit AJV-side test asserting the same rejection.
const opts = { target: "jsonSchema7" as const, $refStrategy: "none" as const };

/** file name -> JSON Schema document. Imported by the sync test; run as a script to write. */
export const generatedSchemas: Record<string, Record<string, unknown>> = {
  "theme.schema.json": zodToJsonSchema(manifestThemeSchema, opts) as Record<string, unknown>,
  "tools.schema.json": zodToJsonSchema(toolsManifestSchema, opts) as Record<string, unknown>,
  "manifest.schema.json": zodToJsonSchema(vendoManifestSchema, opts) as Record<string, unknown>,
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const outDir = join(dirname(fileURLToPath(import.meta.url)), "..", "schemas");
  mkdirSync(outDir, { recursive: true });
  for (const [file, schema] of Object.entries(generatedSchemas)) {
    writeFileSync(join(outDir, file), JSON.stringify(schema, null, 2) + "\n");
    console.log(`wrote schemas/${file}`);
  }
}
