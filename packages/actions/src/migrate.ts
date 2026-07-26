import { semanticsFileSchema, type DomainManifest, type SemanticsFile, type ToolSemantics } from "@vendoai/core";
import {
  VENDO_OVERRIDES_FORMAT_V3,
  VENDO_TOOLS_FORMAT_V3,
  overridesFileSchema,
  overridesFileV3Schema,
  toolsFileSchema,
  toolsFileV3Schema,
  vendoFileVersion,
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

/** The generation-facing merged view of the v3 pair: per-tool field semantics
 *  with the authored overlay applied, and the domain manifest with the
 *  authored additions unioned in. */
export interface MergedHostSemantics {
  semantics: Record<string, ToolSemantics>;
  domains?: DomainManifest;
}

const unionDomains = (generated?: DomainManifest, authored?: DomainManifest): DomainManifest | undefined => {
  if (generated === undefined && authored === undefined) return undefined;
  const has = new Set([...(generated?.has ?? []), ...(authored?.has ?? [])]);
  const hasNot = new Set([...(generated?.hasNot ?? []), ...(authored?.hasNot ?? [])]);
  // Authored wins on a direct contradiction: a human/agent classification in
  // overrides.json overrides the opposite auto-derived one, so generation never
  // receives a domain as both HAS and has-NO (which would make it disclaim
  // available data or invent absent data).
  for (const domain of authored?.has ?? []) hasNot.delete(domain);
  for (const domain of authored?.hasNot ?? []) has.delete(domain);
  return { has: [...has], hasNot: [...hasNot] };
};

/**
 * Merged semantics + domains for the umbrella's apps composition (cse lane 1):
 * the replacement for reading `.vendo/semantics.json` directly. Takes the RAW
 * parsed JSON of the `.vendo` files (any subset present) — legacy v1 layouts
 * migrate in-memory first, so `semantics.json` is consulted only until sync
 * rewrites the dir — and returns undefined when nothing applies. Malformed
 * input throws; the caller decides how loud to be.
 */
export function mergedSemanticsAndDomains(
  files: { tools?: unknown; overrides?: unknown; semantics?: unknown },
): MergedHostSemantics | undefined {
  const toolsFile = files.tools === undefined
    ? undefined
    : vendoFileVersion(files.tools) === 1 ? toolsFileSchema.parse(files.tools) : toolsFileV3Schema.parse(files.tools);
  const overridesFile = files.overrides === undefined
    ? undefined
    : vendoFileVersion(files.overrides) === 1 ? overridesFileSchema.parse(files.overrides) : overridesFileV3Schema.parse(files.overrides);
  const toolsV3 = toolsFile !== undefined && toolsFile.format === VENDO_TOOLS_FORMAT_V3 ? toolsFile : undefined;
  const overridesV3 = overridesFile !== undefined && overridesFile.format === VENDO_OVERRIDES_FORMAT_V3 ? overridesFile : undefined;
  // The retired semantics.json counts only while tools.json is still v1 (or
  // absent) — once sync has rewritten the dir, a stale copy is ignored.
  const legacySemantics = toolsV3 === undefined && files.semantics !== undefined
    ? semanticsFileSchema.parse(files.semantics)
    : undefined;

  const semantics: Record<string, ToolSemantics> = {};
  const overlay = (name: string, layer: ToolSemantics | undefined): void => {
    if (layer === undefined) return;
    semantics[name] = { ...semantics[name], ...layer };
  };
  for (const [name, entry] of Object.entries(legacySemantics?.tools ?? {})) overlay(name, entry);
  for (const tool of toolsV3?.tools ?? []) overlay(tool.name, tool.semantics);
  for (const [name, override] of Object.entries(overridesFile?.tools ?? {})) overlay(name, override.semantics);

  const domains = unionDomains(
    toolsV3?.domains ?? legacySemantics?.domains,
    overridesV3?.domains,
  );
  if (Object.keys(semantics).length === 0 && domains === undefined) return undefined;
  return { semantics, ...(domains === undefined ? {} : { domains }) };
}
