import type { BoundarySchema } from "./schema";
import { toJsonSchema } from "./schema";

/** Reuse MCP's standard annotation vocabulary as the broad permission signal. */
export interface ToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

/** Per-call context. `principal` is opaque in F1; F2 defines its shape. */
export interface ToolContext {
  principal?: unknown;
}

export interface FlowletTool<I = unknown, O = unknown> {
  name: string;
  description: string;
  inputSchema: BoundarySchema<I>;
  outputSchema?: BoundarySchema<O>;
  annotations?: ToolAnnotations;
  /** Open slot for any custom gating metadata; policy lives in F2. */
  permission?: unknown;
  execute(input: I, ctx: ToolContext): Promise<O>;
}

/** Identity helper that fixes inference for tool authors. */
export function defineTool<I, O>(tool: FlowletTool<I, O>): FlowletTool<I, O> {
  return tool;
}

/** Shape of an MCP tool definition (the subset Flowlet maps to/from). */
export interface McpToolDef {
  name: string;
  description?: string;
  inputSchema: unknown; // JSON Schema
  annotations?: ToolAnnotations;
}

/** Flowlet tool -> MCP tool definition (JSON Schema at the boundary). */
export function toMcpTool(tool: FlowletTool): McpToolDef {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: toJsonSchema(tool.inputSchema),
    annotations: tool.annotations,
  };
}

/** MCP tool definition + an executor -> Flowlet tool. */
export function fromMcpTool(
  def: McpToolDef,
  execute: (input: unknown, ctx: ToolContext) => Promise<unknown>,
): FlowletTool {
  return {
    name: def.name,
    description: def.description ?? "",
    // The MCP def already carries JSON Schema; wrap it as the JSON-Schema boundary arm.
    inputSchema: { jsonSchema: def.inputSchema },
    annotations: def.annotations,
    execute,
  };
}
