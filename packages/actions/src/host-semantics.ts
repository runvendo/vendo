import type { ToolSemantics } from "@vendoai/core";
import { judgmentsFileSchema, overridesFileSchema, toolsFileSchema } from "./formats.js";

/**
 * The generation-facing merged view of the `.vendo` trio: per-tool field
 * semantics with the AI and authored overlays applied, keyed by tool name.
 * Takes the RAW parsed JSON of the `.vendo` files (any may be absent) and
 * returns undefined when nothing applies. Malformed input throws; the caller
 * decides how loud to be.
 *
 * Overlay order is the layer order by AUTHOR: the scanner's inferred hints, the
 * judge's corrections, then the human's — authored last so it wins, matching
 * the registry's capability merge.
 */
export function mergedHostSemantics(
  files: { tools?: unknown; judgments?: unknown; overrides?: unknown },
): Record<string, ToolSemantics> | undefined {
  const toolsFile = files.tools === undefined ? undefined : toolsFileSchema.parse(files.tools);
  const judgmentsFile = files.judgments === undefined ? undefined : judgmentsFileSchema.parse(files.judgments);
  const overridesFile = files.overrides === undefined ? undefined : overridesFileSchema.parse(files.overrides);

  const semantics: Record<string, ToolSemantics> = {};
  const overlay = (name: string, layer: ToolSemantics | undefined): void => {
    if (layer === undefined) return;
    semantics[name] = { ...semantics[name], ...layer };
  };
  for (const tool of toolsFile?.tools ?? []) overlay(tool.name, tool.semantics);
  // Semantics are generation HINTS, not capability, so this view stays on the
  // file's raw-JSON terms: no binding guard (the registry's `applyJudgment`
  // owns that for anything that can move capability) and `pending` is ignored
  // here because a loosening can only ever name one of the four grades.
  for (const [name, judged] of Object.entries(judgmentsFile?.tools ?? {})) overlay(name, judged.fields.semantics);
  for (const [name, override] of Object.entries(overridesFile?.tools ?? {})) overlay(name, override.semantics);

  return Object.keys(semantics).length === 0 ? undefined : semantics;
}
