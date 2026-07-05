import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { manifestThemeSchema, toolsManifestSchema } from "./tools/manifest.js";

/**
 * `vendo publish` — STUB. The cloud manifest registry is ENG-198 (track A);
 * this validates the JSON artifacts against the frozen schemas and computes the
 * content hash a real publish would key tools.json by. Component descriptors
 * are TS source — they are validated by the host compiler/bundle build, and a
 * real publish serializes them (zod → JSON Schema) at assembly time.
 * Embedded mode reads .vendo/ from disk and never needs publish.
 */
export async function runPublish(opts: { targetDir: string }): Promise<number> {
  const vendoDir = path.join(path.resolve(opts.targetDir), ".vendo");
  const toolsPath = path.join(vendoDir, "tools.json");
  let tools: unknown;
  try {
    tools = JSON.parse(await fs.readFile(toolsPath, "utf8"));
    toolsManifestSchema.parse(tools);
  } catch (err) {
    console.error(
      `cannot publish: ${toolsPath} missing or invalid — ${err instanceof Error ? err.message : String(err)}`,
    );
    return 1;
  }

  const themePath = path.join(vendoDir, "theme.json");
  let themeLine = "theme.json: not present";
  try {
    const theme = JSON.parse(await fs.readFile(themePath, "utf8"));
    manifestThemeSchema.parse(theme);
    themeLine = "theme.json: valid";
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.error(`cannot publish: ${themePath} invalid — ${err instanceof Error ? err.message : String(err)}`);
      return 1;
    }
  }

  const hash = createHash("sha256").update(JSON.stringify(tools)).digest("hex");
  console.log(
    [
      `tools.json: valid — sha256:${hash}`,
      themeLine,
      "components/: not validated here (TS source; the compiler and bundle build check it, publish assembly will serialize it)",
      "publish is a stub: the cloud registry lands with ENG-198.",
      "When it ships, this command uploads the assembled manifest (tenant + version + hash) and sessions bind to it.",
      "Embedded hosts read .vendo/ from disk; publish stays a no-op there.",
    ].join("\n"),
  );
  return 0;
}
