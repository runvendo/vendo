/**
 * Host-configured MCP server ingestion for the Flowlet agent runtime.
 *
 * Design: docs/superpowers/specs/2026-07-04-flowlet-mcp-client-design.md.
 * Mirrors the Composio adapter seam: `McpToolSource` is injectable (the real
 * adapter wraps `@ai-sdk/mcp`'s `createMCPClient`; tests inject a fake), and
 * `ingestMcpTools` FAILS CLOSED — no declared servers means no network I/O.
 *
 * MCP servers are host-level (declared by the host developer, shared by all
 * users), unlike Composio's per-user OAuth. Tools are registered as
 * `<serverName>_<toolName>` so provenance is legible and servers can't collide
 * with each other or with other sources.
 */

import type { ToolSet } from "ai";
import { buildDescriptor, type ToolAnnotations, type ToolDescriptor } from "./descriptor";

/** A single host-declared MCP server (Streamable HTTP transport only). */
export interface McpServerConfig {
  /**
   * Prefix for this server's tool names (`<name>_<tool>`). Must be a valid
   * tool-name fragment: letters, digits, `_`, `-`.
   */
  name: string;
  /** The server's Streamable HTTP endpoint (http/https). */
  url: string;
  /** Extra HTTP headers, e.g. `{ Authorization: "Bearer ..." }`. */
  headers?: Record<string, string>;
  /** Optional narrowing allowlist of UNPREFIXED tool names. */
  tools?: string[];
}

/** What one server's fetch yields: executable tools + their MCP annotations. */
export interface McpFetchResult {
  tools: ToolSet;
  /** Per (unprefixed) tool name, the server-reported annotation hints. */
  annotations: Record<string, ToolAnnotations>;
}

/**
 * The Flowlet abstraction over an MCP connection. The real implementation
 * ({@link createMcpToolSource}) wraps `@ai-sdk/mcp`; tests implement it
 * directly.
 */
export interface McpToolSource {
  fetchTools(config: McpServerConfig): Promise<McpFetchResult>;
}

/**
 * Final tool names must be provider-safe: the SDK forwards them verbatim to
 * the model API, and Anthropic caps tool names at `[A-Za-z0-9_-]{1,64}`. A
 * server-returned name that breaks this after prefixing would 400 the WHOLE
 * turn, so invalid names are skipped fail-closed instead.
 */
const VALID_TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Sanitize an error for logging. SDK transport errors embed the raw HTTP
 * response body, which a malicious server can use to reflect the request's
 * Authorization header — so never log the error object itself, and redact
 * every configured header value from the message.
 */
function describeError(err: unknown, headers?: Record<string, string>): string {
  let message = err instanceof Error ? err.message : String(err);
  for (const value of Object.values(headers ?? {})) {
    if (value.length > 0) message = message.split(value).join("[redacted]");
  }
  return message.slice(0, 300);
}

/**
 * Ingest tools from host-declared MCP servers.
 *
 * FAILS CLOSED: an empty server list returns empty without touching the
 * source. Per-server fault tolerance: a server that errors is warned about,
 * recorded in `failures`, and skipped — it never breaks other servers or the
 * turn. Callers use `failures` to avoid caching a partial result.
 *
 * Name safety: duplicate final names (duplicate server names, or prefix
 * ambiguity like server "a" tool "b_c" vs server "a_b" tool "c") keep the
 * FIRST registration and warn; server-returned tool names that are not
 * provider-safe are skipped.
 */
export async function ingestMcpTools(args: {
  servers: McpServerConfig[];
  source: McpToolSource;
}): Promise<{ toolset: ToolSet; descriptors: ToolDescriptor[]; failures: string[] }> {
  const { servers, source } = args;

  const toolset: ToolSet = {};
  const descriptors: ToolDescriptor[] = [];
  const failures: string[] = [];

  const seenServers = new Set<string>();
  for (const server of servers) {
    // Duplicate server names would alias each other in the client cache and
    // collide on every prefixed tool name. Deterministic misconfig — warn and
    // skip, but do NOT count as a failure (failures trigger cache retry, and
    // a deterministic one would re-ingest forever).
    if (seenServers.has(server.name)) {
      console.warn(`[flowlet] duplicate MCP server name "${server.name}" skipped.`);
      continue;
    }
    seenServers.add(server.name);

    let fetched: McpFetchResult;
    try {
      fetched = await source.fetchTools(server);
    } catch (err) {
      console.warn(
        `[flowlet] MCP server "${server.name}" skipped: ${describeError(err, server.headers)}`,
      );
      failures.push(server.name);
      continue;
    }

    const allow = server.tools && server.tools.length > 0 ? new Set(server.tools) : null;
    for (const [name, tool] of Object.entries(fetched.tools)) {
      if (allow && !allow.has(name)) continue;
      const prefixed = `${server.name}_${name}`;
      if (!VALID_TOOL_NAME.test(prefixed)) {
        console.warn(
          `[flowlet] MCP server "${server.name}" tool "${name}" skipped: ` +
            "final tool name is not provider-safe.",
        );
        continue;
      }
      if (prefixed in toolset) {
        console.warn(
          `[flowlet] MCP tool name collision on "${prefixed}" ` +
            `(server "${server.name}") — keeping the first registration.`,
        );
        continue;
      }
      toolset[prefixed] = tool;
      descriptors.push(
        buildDescriptor(prefixed, tool, "mcp", fetched.annotations[name] ?? {}),
      );
    }
  }

  return { toolset, descriptors, failures };
}

/**
 * The shape of the raw `tools/list` result we need from the SDK's runtime
 * `listTools()` method. In `@ai-sdk/mcp@1.0.6` this method exists on the
 * MCPClient class but is missing from the public interface (it became public
 * in 2.x, which we can't take yet — it targets @ai-sdk/provider@4). The
 * structural cast below is contract-tested in mcp.contract.test.ts.
 */
interface RawListToolsResult {
  tools: Array<{ name: string; annotations?: ToolAnnotations & { title?: string } }>;
}

/**
 * Build the REAL MCP tool source on `@ai-sdk/mcp@1.0.6` (Streamable HTTP
 * transport, static headers — the approved v1 scope).
 *
 * Client lifecycle: one client per server name, created lazily on first fetch
 * and kept open for reuse. A fetch failure closes + evicts that server's
 * client so the next fetch rebuilds the connection, then rethrows so
 * `ingestMcpTools` can skip the server.
 *
 * The public `tools()` gives executable ai-SDK tools but DISCARDS MCP
 * `annotations`; the runtime `listTools()` recovers them. If a future SDK
 * removes `listTools`, we degrade to empty annotations (tools still ingest;
 * the annotation policy then fail-safes every call to "approve").
 */
export function createMcpToolSource(): McpToolSource {
  type Client = {
    tools(): Promise<ToolSet>;
    close(): Promise<void>;
  };
  const clients = new Map<string, Promise<Client>>();

  async function getClient(config: McpServerConfig): Promise<Client> {
    let client = clients.get(config.name);
    if (!client) {
      client = import("@ai-sdk/mcp").then(({ createMCPClient }) =>
        createMCPClient({
          transport: {
            type: "http",
            url: config.url,
            ...(config.headers ? { headers: config.headers } : {}),
          },
        }),
      ) as Promise<Client>;
      clients.set(config.name, client);
    }
    return client;
  }

  return {
    async fetchTools(config) {
      try {
        const client = await getClient(config);
        const tools = await client.tools();

        // Recover the annotations the public API drops (see docstring).
        let annotations: Record<string, ToolAnnotations> = {};
        const maybeListTools = (
          client as unknown as { listTools?: () => Promise<RawListToolsResult> }
        ).listTools;
        if (typeof maybeListTools === "function") {
          const listed = await maybeListTools.call(client);
          annotations = Object.fromEntries(
            listed.tools.map((t) => {
              const { title: _title, ...hints } = t.annotations ?? {};
              return [t.name, hints];
            }),
          );
        } else {
          console.warn(
            `[flowlet] MCP server "${config.name}": SDK listTools() unavailable — ` +
              "annotations unknown, all its tools will require approval.",
          );
        }

        return { tools, annotations };
      } catch (err) {
        // Drop the (possibly dead) client so the next fetch reconnects.
        const stale = clients.get(config.name);
        clients.delete(config.name);
        if (stale) void stale.then((c) => c.close()).catch(() => {});
        throw err;
      }
    },
  };
}
