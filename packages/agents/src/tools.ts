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
import { asSchema, type FlexibleSchema, type InferSchema } from "ai";

/** What `execute` is handed. A zod (or any standard-schema) `inputSchema` types
 *  it; a raw JSON Schema cannot, because JSON Schema is data — there is nothing
 *  in it for TypeScript to read — so that branch stays `Json`, as it always was. */
export type ToolInput<TSchema> = [InferSchema<TSchema>] extends [never] ? Json : InferSchema<TSchema>;

export interface ToolConfig<TSchema = JsonSchema> {
  name: string;
  /** What this tool does and when to reach for it. REQUIRED: it is the only
   *  thing the model reads when deciding whether to call it. */
  description: string;
  /** The dev's label is FINAL; unlabeled = ungraded = asks at call time. */
  risk?: RiskLabel;
  /** A zod schema — which also types `execute`'s `input` — or a raw JSON
   *  Schema for a host that has one already. */
  inputSchema: TSchema;
  /** The tool's DECLARED result shape. Surfaces print it, so generated UI can
   *  bind to fields before any call; nothing validates a result against it, so a
   *  stale schema never fails a working tool. */
  outputSchema?: JsonSchema;
  execute(input: ToolInput<TSchema>, ctx: RunContext, call: ToolCall): Promise<Json> | Json;
}

/** One host-authored tool, ready for `agent({ tools: [...] })`. */
export interface HostTool {
  descriptor: ToolDescriptor;
  execute(input: Json, ctx: RunContext, call: ToolCall): Promise<Json> | Json;
}

export type ToolSource = HostTool | ToolRegistry;

/**
 * A descriptor carries JSON Schema and nothing else — it crosses the wire to a
 * model, a box and a browser, none of which can run a validator — so a zod
 * schema is converted ONCE, here, rather than at every reader.
 *
 * The two branches are told apart by what the AI SDK itself keys on: zod (v3.25+
 * and v4 alike) and every standard schema carry `~standard`, an `asSchema`
 * result carries `jsonSchema`, and a lazy schema is a function. A raw JSON
 * Schema is a plain object with none of those, and is passed through untouched.
 */
const isJsonSchema = (schema: JsonSchema | FlexibleSchema): schema is JsonSchema =>
  typeof schema === "object" && !("~standard" in schema) && !("jsonSchema" in schema);

const toJsonSchema = (schema: JsonSchema | FlexibleSchema): JsonSchema =>
  isJsonSchema(schema)
    ? schema
    // `asSchema`'s `jsonSchema` is only a promise for a DEFERRED schema; zod's
    // is built synchronously, which is why a descriptor can be minted here.
    : asSchema(schema).jsonSchema as JsonSchema;

export function tool<TSchema extends JsonSchema | FlexibleSchema>(config: ToolConfig<TSchema>): HostTool {
  if (!TOOL_NAME_PATTERN.test(config.name)) {
    throw new VendoError(
      "validation",
      `tool name "${config.name}" must match ${String(TOOL_NAME_PATTERN)}`,
    );
  }
  if ((config.description ?? "").trim() === "") {
    throw new VendoError(
      "validation",
      `tool "${config.name}" needs a description. It is the only thing the model reads when it `
      + "decides whether to call this tool, so without one the tool is effectively invisible — "
      + "write a sentence saying what it does and when to use it.",
    );
  }
  return {
    descriptor: {
      name: config.name,
      description: config.description,
      inputSchema: toJsonSchema(config.inputSchema),
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
  /** The host origin route/tRPC tools dial; defaults to `VENDO_BASE_URL`. */
  baseUrl?: string;
  untrustedOriginPolicy?: "warn" | "fail";
  fetch?: typeof fetch;
}

/** The existing actions registry: `.vendo/tools.json`, layered overrides,
 *  present-header forwarding with the origin gate, `actAs` for away runs. */
export function api(options: ApiOptions = {}): ToolRegistry {
  const baseUrl = options.baseUrl ?? process.env["VENDO_BASE_URL"];
  return createActions({
    dir: options.dir ?? ".",
    ...(options.actAs === undefined ? {} : { actAs: options.actAs }),
    ...(baseUrl === undefined ? {} : { baseUrl }),
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
