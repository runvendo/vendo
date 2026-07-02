/**
 * `hostToolset` — turn host tool definitions (the company's own API surface,
 * from `@flowlet/core`'s OpenAPI adapter) into ai SDK tools for the engine's
 * caller seam (`RunInput.tools`).
 *
 * The tools deliberately have NO `execute`: per topology B the call runs in
 * the user's browser on their existing session, and the loop only receives
 * the result. Each tool carries its annotations top-level (picked up by
 * `buildDescriptor`) and the client-executor marker that routes it through
 * `wrapClientTool` in `buildToolset`.
 */

import { jsonSchema, tool, type Tool, type ToolSet } from "ai";
import type { HostToolDefinition } from "@flowlet/core";

/** Field name marking a tool as client-executed. */
export const CLIENT_EXECUTOR_MARKER = "flowletExecutor" as const;

/** Build the caller-seam ToolSet for a set of host tool definitions. */
export function hostToolset(defs: HostToolDefinition[]): ToolSet {
  const tools: ToolSet = {};
  for (const def of defs) {
    const base: Tool = tool({
      description: def.description,
      inputSchema: jsonSchema(def.inputSchema),
    });
    tools[def.name] = {
      ...base,
      annotations: def.annotations,
      [CLIENT_EXECUTOR_MARKER]: "client",
    } as unknown as Tool;
  }
  return tools;
}
