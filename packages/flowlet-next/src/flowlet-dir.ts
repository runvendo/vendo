/**
 * Read the `.flowlet/` directory (`flowlet init`'s output) from disk.
 *
 * Zero-config contract: a missing directory or file falls back to safe
 * defaults (default brand, empty tool manifest) so chat + generated UI work
 * on an app with nothing extracted yet. A PRESENT-but-invalid file fails loud
 * — these are developer-editable files and silently ignoring an edit is worse
 * than an error at boot.
 *
 * Server-only (node:fs).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { toolsManifestSchema, type ToolsManifest } from "@flowlet/core";
import { brandTokensSchema, defaultBrand, type BrandTokens } from "@flowlet/components/theme";

export interface LoadedFlowletDir {
  brand: BrandTokens;
  manifest: ToolsManifest;
}

const EMPTY_MANIFEST: ToolsManifest = { version: 1, tools: [], events: [] };

function readJson(file: string): unknown | undefined {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return undefined; // absent → caller defaults
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `${path.basename(file)} is not valid JSON (${file}): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export function loadFlowletDir(dir: string = path.join(process.cwd(), ".flowlet")): LoadedFlowletDir {
  const themeRaw = readJson(path.join(dir, "theme.json"));
  const toolsRaw = readJson(path.join(dir, "tools.json"));

  let brand = defaultBrand;
  if (themeRaw !== undefined) {
    const parsed = brandTokensSchema.safeParse(themeRaw);
    if (!parsed.success) {
      throw new Error(`theme.json does not match the brand-token schema: ${parsed.error.message}`);
    }
    brand = parsed.data;
  }

  let manifest = EMPTY_MANIFEST;
  if (toolsRaw !== undefined) {
    const parsed = toolsManifestSchema.safeParse(toolsRaw);
    if (!parsed.success) {
      throw new Error(`tools.json does not match the tools-manifest schema: ${parsed.error.message}`);
    }
    manifest = parsed.data;
  }

  return { brand, manifest };
}
