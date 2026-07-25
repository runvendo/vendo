import type { SemanticsFile } from "@vendoai/core";
import {
  VENDO_OVERRIDES_FORMAT_V3,
  VENDO_TOOLS_FORMAT_V3,
  type CapabilitiesFile,
  type ExtractedToolV3,
  type OverridesFile,
  type OverridesFileV3,
  type ToolsFile,
  type ToolsFileV3,
} from "./formats.js";

/**
 * Format v3 migration (cse lane 1): the parsed legacy `.vendo/` four — any
 * subset present — folds once into the two-file, split-by-author pair.
 * Pure and in-memory: the registry migrates transparently at load and warns;
 * only `vendo sync` rewrites the files on disk (lane 1b).
 */
export interface LegacyVendoFiles {
  tools?: ToolsFile;
  overrides?: OverridesFile;
  capabilities?: CapabilitiesFile;
  semantics?: SemanticsFile;
}

export function migrateLegacyVendoDir(legacy: LegacyVendoFiles): { tools: ToolsFileV3; overrides: OverridesFileV3 } {
  // Machine layer: legacy tools + the semantics.json per-tool maps (stale
  // entries for removed tools drop) + the semantics.json domain manifest.
  const semanticsByTool = legacy.semantics?.tools ?? {};
  const tools: ExtractedToolV3[] = (legacy.tools?.tools ?? []).map((tool) => {
    const semantics = semanticsByTool[tool.name];
    return { ...tool, ...(semantics === undefined ? {} : { semantics }) };
  });
  const domains = legacy.semantics?.domains;

  // Authored layer: legacy overrides + the capabilities.json compounds and
  // briefs (nothing else — empty arrays are omitted so the file stays clean).
  const compounds = legacy.capabilities?.tools ?? [];
  const briefs = legacy.capabilities?.briefs ?? [];

  return {
    tools: {
      format: VENDO_TOOLS_FORMAT_V3,
      tools,
      ...(domains === undefined ? {} : { domains }),
    },
    overrides: {
      format: VENDO_OVERRIDES_FORMAT_V3,
      tools: legacy.overrides?.tools ?? {},
      ...(compounds.length === 0 ? {} : { compounds }),
      ...(briefs.length === 0 ? {} : { briefs }),
      ...(legacy.overrides?.remix === undefined ? {} : { remix: legacy.overrides.remix }),
    },
  };
}
