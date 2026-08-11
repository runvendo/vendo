import { promises as fs } from "node:fs";
import type { JsonSchema } from "@vendoai/core";
import { VENDO_TOOLS_FORMAT, schemaIsBlind, toolsFileSchema, type ExtractedTool, type SchemaSource } from "../formats.js";
import { bindingIdentity, writeIfChanged } from "./common.js";

export type ToolSchemaSlot = "inputSchema" | "outputSchema";

export interface ToolSchemaPatch {
  tool: string;
  /** `bindingIdentity` at judgment time — a rebound tool never takes a stale schema. */
  binding: string;
  slot: ToolSchemaSlot;
  schema: JsonSchema;
}

export interface ToolSchemaPatchResult {
  written: Array<{ tool: string; slot: ToolSchemaSlot }>;
  skipped: Array<{ tool: string; slot: ToolSchemaSlot; reason: "rebound" | "occupied" | "unknown-tool" }>;
}

const sourceKey = (slot: ToolSchemaSlot): "inputSchemaSource" | "outputSchemaSource" =>
  slot === "inputSchema" ? "inputSchemaSource" : "outputSchemaSource";

/**
 * The ONE targeted writer for `.vendo/tools.json` outside `vendoSync`.
 *
 * Fills EMPTY slots only. `occupied` is the wall, and it lives HERE rather than
 * in a prompt: a slot whose source is `declared` or `types` is the host's own
 * contract, and no model gets to talk its way past that. The file is re-read
 * (never patched from a stale in-memory copy), matched on name AND binding
 * identity, re-validated with `toolsFileSchema`, and written only when the
 * bytes actually change.
 */
export async function patchToolSchemas(
  toolsPath: string,
  patches: readonly ToolSchemaPatch[],
): Promise<ToolSchemaPatchResult> {
  const result: ToolSchemaPatchResult = { written: [], skipped: [] };
  if (patches.length === 0) return result;

  let file: { tools: ExtractedTool[] };
  try {
    file = toolsFileSchema.parse(JSON.parse(await fs.readFile(toolsPath, "utf8")) as unknown);
  } catch {
    // No parseable catalog: the structural sync already failed loudly, and a
    // judgment must never be the thing that creates one.
    for (const patch of patches) result.skipped.push({ tool: patch.tool, slot: patch.slot, reason: "unknown-tool" });
    return result;
  }

  const byName = new Map(file.tools.map((tool) => [tool.name, tool]));
  for (const patch of patches) {
    const tool = byName.get(patch.tool);
    if (tool === undefined) {
      result.skipped.push({ tool: patch.tool, slot: patch.slot, reason: "unknown-tool" });
      continue;
    }
    if (bindingIdentity(tool.binding) !== patch.binding) {
      result.skipped.push({ tool: patch.tool, slot: patch.slot, reason: "rebound" });
      continue;
    }
    if (!schemaIsBlind(tool[sourceKey(patch.slot)])) {
      result.skipped.push({ tool: patch.tool, slot: patch.slot, reason: "occupied" });
      continue;
    }
    Object.assign(tool, { [patch.slot]: patch.schema, [sourceKey(patch.slot)]: "inferred" satisfies SchemaSource });
    result.written.push({ tool: patch.tool, slot: patch.slot });
  }

  if (result.written.length === 0) return result;
  const validated = toolsFileSchema.parse({ format: VENDO_TOOLS_FORMAT, tools: file.tools });
  await writeIfChanged(toolsPath, `${JSON.stringify(validated, null, 2)}\n`);
  return result;
}
