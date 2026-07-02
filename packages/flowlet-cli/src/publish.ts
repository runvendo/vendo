import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { toolsManifestSchema } from "./tools/manifest.js";

/**
 * `flowlet publish` — STUB. The cloud manifest registry is ENG-198 (track A);
 * this validates the manifest and computes the content hash a real publish
 * would be keyed by. Embedded mode reads .flowlet/ from disk and never needs it.
 */
export async function runPublish(opts: { targetDir: string }): Promise<number> {
  const manifestPath = path.join(path.resolve(opts.targetDir), ".flowlet/tools.json");
  let manifest: unknown;
  try {
    manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
    toolsManifestSchema.parse(manifest);
  } catch (err) {
    console.error(
      `cannot publish: ${manifestPath} missing or invalid — ${err instanceof Error ? err.message : String(err)}`,
    );
    return 1;
  }
  const hash = createHash("sha256").update(JSON.stringify(manifest)).digest("hex");
  console.log(
    [
      `manifest valid — sha256:${hash}`,
      "publish is a stub: the cloud registry lands with ENG-198.",
      "When it ships, this command uploads the manifest (tenant + version + hash) and sessions bind to it.",
      "Embedded hosts read .flowlet/ from disk; publish stays a no-op there.",
    ].join("\n"),
  );
  return 0;
}
