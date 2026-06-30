/**
 * Flowlet's tool contract IS the ai SDK's tool type — no parallel abstraction.
 *
 * Define a tool with `tool({ description, inputSchema, execute })`; a collection of
 * tools is a `ToolSet` (`Record<string, Tool>`). The SDK converts Zod input schemas to
 * JSON Schema at the model boundary, so Flowlet keeps no schema glue. MCP tools are
 * ingested as a `ToolSet` via the SDK's MCP client (`createMCPClient` from
 * `@ai-sdk/mcp`, with `client.tools()`), wired in F2 — not a custom adapter here.
 */
export { tool } from "ai";
export type { Tool, ToolSet } from "ai";
