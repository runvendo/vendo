/**
 * The host's tool sources: `tool()` (descriptor + execute, the host's own auth
 * model), `api()` (the existing actions registry over `.vendo/tools.json`),
 * `mcp` servers, and `mergeSources` — one registry the guard binds, where a
 * name collision is a boot error, never a silent shadow.
 */
import { createActions, mcpConnector, type Connector, type McpHeadersResolver } from "@vendoai/actions";
import {
  TOOL_NAME_PATTERN,
  VendoError,
  safeErrorMessage,
  type ActAs,
  type Json,
  type JsonSchema,
  type RiskLabel,
  type RunContext,
  type ToolCall,
  type ToolDescriptor,
  type ToolOutcome,
  type ToolRegistry,
} from "@vendoai/core";

export interface ToolConfig {
  name: string;
  description?: string;
  /** The dev's label is FINAL; unlabeled = ungraded = asks at call time. */
  risk?: RiskLabel;
  inputSchema: JsonSchema;
  /** The tool's DECLARED result shape. Surfaces print it, so generated UI can
   *  bind to fields before any call; nothing validates a result against it, so a
   *  stale schema never fails a working tool. */
  outputSchema?: JsonSchema;
  execute(input: Json, ctx: RunContext, call: ToolCall): Promise<Json> | Json;
}

/** One host-authored tool, ready for `agent({ tools: [...] })`. */
export interface HostTool {
  descriptor: ToolDescriptor;
  execute: ToolConfig["execute"];
}

export type ToolSource = HostTool | ToolRegistry;

export function tool(config: ToolConfig): HostTool {
  if (!TOOL_NAME_PATTERN.test(config.name)) {
    throw new VendoError(
      "validation",
      `tool name "${config.name}" must match ${String(TOOL_NAME_PATTERN)}`,
    );
  }
  return {
    descriptor: {
      name: config.name,
      description: config.description ?? "",
      inputSchema: config.inputSchema,
      ...(config.outputSchema === undefined ? {} : { outputSchema: config.outputSchema }),
      risk: config.risk ?? "ungraded",
    },
    execute: config.execute,
  };
}

export interface ApiOptions {
  /** The `.vendo` directory (or host root); defaults to the working directory. */
  dir?: string;
  /** Away-run auth minting; a present user's headers forward on their own. */
  actAs?: ActAs;
  baseUrl?: string;
  untrustedOriginPolicy?: "warn" | "fail";
  fetch?: typeof fetch;
}

/** The existing actions registry: `.vendo/tools.json`, layered overrides,
 *  present-header forwarding with the origin gate, `actAs` for away runs. */
export function api(options: ApiOptions = {}): ToolRegistry {
  return createActions({
    ...(options.dir === undefined ? {} : { dir: options.dir }),
    ...(options.actAs === undefined ? {} : { actAs: options.actAs }),
    ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
    ...(options.untrustedOriginPolicy === undefined
      ? {}
      : { untrustedOriginPolicy: options.untrustedOriginPolicy }),
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });
}

/**
 * `agent({ mcp: [...] })` — external MCP servers as tool sources, through the
 * existing outbound connector. Static headers = one shared identity for every
 * user; a resolver function = per-user identity, resolved at call time.
 */
export interface McpServerConfig {
  url: string;
  headers?: Record<string, string> | McpHeadersResolver;
  /** Tool-name prefix (`mcp_<name>_*`); defaults to "mcp". */
  name?: string;
}

export function mcpSources(configs: readonly McpServerConfig[]): Connector[] {
  return configs.map((config) => mcpConnector(config));
}

const isHostTool = (source: ToolSource): source is HostTool =>
  "descriptor" in source && "execute" in source;

/** A `HostTool`'s registry face: pack law — it returns output or throws, and
 *  never authors the guard's own outcomes. */
const hostToolRegistry = (tools: readonly HostTool[]): ToolRegistry => {
  const byName = new Map(tools.map((t) => [t.descriptor.name, t]));
  return {
    async descriptors() {
      return tools.map((t) => t.descriptor);
    },
    async execute(call, ctx): Promise<ToolOutcome> {
      const entry = byName.get(call.tool);
      if (entry === undefined) {
        return { status: "error", error: { code: "not-found", message: `Unknown tool: ${call.tool}` } };
      }
      try {
        return { status: "ok", output: await entry.execute(call.args, ctx, call) };
      } catch (error) {
        return { status: "error", error: { code: "tool-failed", message: safeErrorMessage(error) } };
      }
    },
  };
};

/**
 * Merge the host's tool sources and MCP servers into ONE registry.
 *
 * Statically-known names (every `tool()`) collide at boot, synchronously.
 * Dynamic sources (`api()`, MCP listings) are only knowable by asking them, so
 * their collisions throw on the first projection instead — still before any
 * call can dispatch through a shadowed name.
 */
export function mergeSources(
  sources: readonly ToolSource[],
  mcp: readonly McpServerConfig[],
): ToolRegistry {
  const hostTools = sources.filter(isHostTool);
  const seen = new Set<string>();
  for (const t of hostTools) {
    if (seen.has(t.descriptor.name)) {
      throw new VendoError(
        "conflict",
        `two tools claim the name "${t.descriptor.name}". Names are global as authored — rename one.`,
      );
    }
    seen.add(t.descriptor.name);
  }

  const registries: ToolRegistry[] = sources.filter((s): s is ToolRegistry => !isHostTool(s));
  if (hostTools.length > 0) registries.unshift(hostToolRegistry(hostTools));
  if (mcp.length > 0) {
    registries.push(createActions({ tools: [], connectors: mcpSources(mcp) }));
  }

  return {
    async descriptors(ctx) {
      const all = (await Promise.all(registries.map((r) => r.descriptors(ctx)))).flat();
      const names = new Set<string>();
      for (const d of all) {
        if (names.has(d.name)) {
          throw new VendoError(
            "conflict",
            `two tool sources claim the name "${d.name}". Names are global as authored — rename one.`,
          );
        }
        names.add(d.name);
      }
      return all;
    },
    async execute(call, ctx): Promise<ToolOutcome> {
      for (const registry of registries) {
        const listed = await registry.descriptors();
        if (listed.some((d) => d.name === call.tool)) return registry.execute(call, ctx);
      }
      return { status: "error", error: { code: "not-found", message: `Unknown tool: ${call.tool}` } };
    },
  };
}
