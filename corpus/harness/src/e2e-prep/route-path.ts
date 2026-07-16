import { readdir } from "node:fs/promises";
import path from "node:path";

/** The catch-all segment `vendo init` currently scaffolds (renamed from
 * `[...path]` in 1e577988). Used when the route does not exist yet and the
 * harness has to create it. */
export const initVendoRouteSegment = "[...vendo]";

const catchAllSegment = /^\[\.\.\..+\]$/;

/**
 * Resolve the Vendo handler route file inside an init-run corpus repo by
 * reading the segment `vendo init` actually created under `api/vendo/`,
 * instead of hardcoding the segment name. This keeps the e2e prep seam from
 * drifting when init renames its scaffold (as it did in 1e577988,
 * `[...path]` -> `[...vendo]`). Falls back to the current init segment when
 * no route exists yet, so callers that create the file get the init shape.
 */
export async function vendoRouteFilePath(appRoot: string, appDirRel: string): Promise<string> {
  const vendoApiDir = path.join(appRoot, appDirRel, "api", "vendo");
  const entries = await readdir(vendoApiDir, { withFileTypes: true }).catch(() => []);
  const segments = entries
    .filter((entry) => entry.isDirectory() && catchAllSegment.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  return path.join(vendoApiDir, segments[0] ?? initVendoRouteSegment, "route.ts");
}
