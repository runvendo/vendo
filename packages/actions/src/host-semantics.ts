import type { ToolSemantics } from "@vendoai/core";
import { overridesFileSchema, toolsFileSchema } from "./formats.js";

/**
 * The generation-facing merged view of the `.vendo` pair: per-tool field
 * semantics with the authored overlay applied, keyed by tool name. Takes the
 * RAW parsed JSON of the `.vendo` files (either may be absent) and returns
 * undefined when nothing applies. Malformed input throws; the caller decides
 * how loud to be.
 */
export function mergedHostSemantics(
  files: { tools?: unknown; overrides?: unknown },
): Record<string, ToolSemantics> | undefined {
  const toolsFile = files.tools === undefined ? undefined : toolsFileSchema.parse(files.tools);
  const overridesFile = files.overrides === undefined ? undefined : overridesFileSchema.parse(files.overrides);

  const semantics: Record<string, ToolSemantics> = {};
  const overlay = (name: string, layer: ToolSemantics | undefined): void => {
    if (layer === undefined) return;
    semantics[name] = { ...semantics[name], ...layer };
  };
  for (const tool of toolsFile?.tools ?? []) overlay(tool.name, tool.semantics);
  for (const [name, override] of Object.entries(overridesFile?.tools ?? {})) overlay(name, override.semantics);

  return Object.keys(semantics).length === 0 ? undefined : semantics;
}
