/**
 * `agent({ mcp: [...] })` — external MCP servers as tool sources, through the
 * existing outbound connector. Static headers = one shared identity for every
 * user; a resolver function = per-user identity, resolved at call time.
 */
import { mcpConnector, type Connector, type McpHeadersResolver } from "@vendoai/actions";

export interface McpServerConfig {
  url: string;
  headers?: Record<string, string> | McpHeadersResolver;
  /** Tool-name prefix (`mcp_<name>_*`); defaults to "mcp". */
  name?: string;
}

export function mcpSources(configs: readonly McpServerConfig[]): Connector[] {
  return configs.map((config) => mcpConnector(config));
}
