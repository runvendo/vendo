/** Build entry: assemble dist/eject-templates for the published package. */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assembleEjectTemplates } from "./eject-templates-lib.mjs";

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = await assembleEjectTemplates(packageDir);
const surfaces = Object.entries(manifest.surfaces)
  .map(([surface, { files }]) => `${surface} (${files.length} files)`)
  .join(", ");
console.log(`[ui] assembled eject templates v${manifest.version}: ${surfaces}`);
