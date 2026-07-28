import type { DomainManifest, ToolSemantics } from "@vendoai/core";
import { overridesFileSchema, toolsFileSchema } from "./formats.js";

/** The generation-facing merged view of the `.vendo` pair: per-tool field
 *  semantics with the authored overlay applied, and the domain manifest with
 *  the authored additions unioned in. */
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
 * Merged semantics + domains for the umbrella's apps composition: takes the RAW
 * parsed JSON of the `.vendo` files (either may be absent) and returns
 * undefined when nothing applies. Malformed input throws; the caller decides
 * how loud to be.
 */
export function mergedSemanticsAndDomains(
  files: { tools?: unknown; overrides?: unknown },
): MergedHostSemantics | undefined {
  const toolsFile = files.tools === undefined ? undefined : toolsFileSchema.parse(files.tools);
  const overridesFile = files.overrides === undefined ? undefined : overridesFileSchema.parse(files.overrides);

  const semantics: Record<string, ToolSemantics> = {};
  const overlay = (name: string, layer: ToolSemantics | undefined): void => {
    if (layer === undefined) return;
    semantics[name] = { ...semantics[name], ...layer };
  };
  for (const tool of toolsFile?.tools ?? []) overlay(tool.name, tool.semantics);
  for (const [name, override] of Object.entries(overridesFile?.tools ?? {})) overlay(name, override.semantics);

  const domains = unionDomains(toolsFile?.domains, overridesFile?.domains);
  if (Object.keys(semantics).length === 0 && domains === undefined) return undefined;
  return { semantics, ...(domains === undefined ? {} : { domains }) };
}
