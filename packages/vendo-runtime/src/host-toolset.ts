/**
 * `hostToolset` — turn host tool definitions (the company's own API surface,
 * from `@vendoai/core`'s OpenAPI adapter) into ai SDK tools for the engine's
 * caller seam (`RunInput.tools`).
 *
 * The tools deliberately have NO `execute`: per topology B the call runs in
 * the user's browser on their existing session, and the loop only receives
 * the result. Each tool carries its annotations top-level (picked up by
 * `buildDescriptor`) and the client-executor marker that routes it through
 * `wrapClientTool` in `buildToolset`.
 */

import { jsonSchema, tool, type Tool, type ToolSet } from "ai";
import { renderFormatHints, type HostToolDefinition } from "@vendoai/core";

/** Field name marking a tool as client-executed. */
export const CLIENT_EXECUTOR_MARKER = "vendoExecutor" as const;

/** Build the caller-seam ToolSet for a set of host tool definitions. */
export function hostToolset(defs: HostToolDefinition[]): ToolSet {
  const tools: ToolSet = {};
  for (const def of defs) {
    // Declared result-field formats travel WITH the tool: the model reads the
    // rendering rules ("integer cents: divide by 100", "never timezone-shift")
    // in the same place it reads what the tool does.
    const hints = def.formats ? renderFormatHints(def.formats) : "";
    const base: Tool = tool({
      description: hints ? `${def.description}\n${hints}` : def.description,
      inputSchema: jsonSchema(def.inputSchema),
    });
    tools[def.name] = {
      ...base,
      annotations: def.annotations,
      // Field-format hints ride top-level so `buildDescriptor` can carry them
      // onto the descriptor (and thence the approval card/receipt), the same
      // way it picks up the annotations and the client-executor marker.
      ...(def.formats ? { formats: def.formats } : {}),
      [CLIENT_EXECUTOR_MARKER]: "client",
    } as unknown as Tool;
  }
  return tools;
}
