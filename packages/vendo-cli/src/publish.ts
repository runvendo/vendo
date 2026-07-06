import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { manifestThemeSchema, toolsManifestSchema } from "./tools/manifest.js";
import { createUi, type Ui } from "./ui.js";

/**
 * `vendo publish` — a VALIDATION STUB. The cloud manifest registry is ENG-198
 * (track A); until it ships this command only validates the JSON artifacts
 * against the frozen schemas and computes the content hash a real publish
 * would key tools.json by. Component descriptors are TS source — the host
 * compiler / bundle build check them, and a real publish serializes them
 * (zod → JSON Schema) at assembly time. Embedded mode reads .vendo/ from disk
 * and never needs publish.
 */
export async function runPublish(opts: { targetDir: string; ui?: Ui }): Promise<number> {
  const ui = opts.ui ?? createUi();
  const vendoDir = path.join(path.resolve(opts.targetDir), ".vendo");
  const toolsPath = path.join(vendoDir, "tools.json");

  ui.header("vendo publish");

  let tools: unknown;
  try {
    tools = JSON.parse(await fs.readFile(toolsPath, "utf8"));
    toolsManifestSchema.parse(tools);
  } catch (err) {
    ui.error(
      "cannot publish: .vendo/tools.json is missing or invalid",
      `run \`vendo init\` to scaffold it, or fix the schema error: ${err instanceof Error ? err.message : String(err)}`,
    );
    return 1;
  }
  const hash = createHash("sha256").update(JSON.stringify(tools)).digest("hex");
  ui.step("ok", "tools.json valid", `sha256:${hash}`);

  const themePath = path.join(vendoDir, "theme.json");
  try {
    manifestThemeSchema.parse(JSON.parse(await fs.readFile(themePath, "utf8")));
    ui.step("ok", "theme.json valid");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      ui.step("ok", "theme.json", "not present");
    } else {
      ui.error(
        "cannot publish: .vendo/theme.json is invalid",
        `edit .vendo/theme.json to fix the schema error: ${err instanceof Error ? err.message : String(err)}`,
      );
      return 1;
    }
  }

  ui.note(
    "components/ not validated here — they are TS source; the compiler and bundle build check them, and publish assembly serializes them.",
  );
  ui.note(
    "publish is a validation stub: it checks your .vendo/ artifacts against the frozen schemas. " +
      "The cloud registry lands with ENG-198 — when it ships this command uploads the assembled manifest " +
      "(tenant + version + hash) and sessions bind to it. Embedded hosts read .vendo/ from disk, so publish stays a no-op there.",
  );
  return 0;
}
