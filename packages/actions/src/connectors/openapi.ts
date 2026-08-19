import type { PermissionGrant, Principal, RunContext, ToolCall, ToolDescriptor, ToolOutcome } from "@vendoai/core";
import type { OpenApiBinding } from "../formats.js";
import { extractOpenApiDocument, openApiDocument } from "../openapi-document.js";
import { fetchHostTool, hostRequest } from "../runtime/http-dispatch.js";
import { error, isArgsObject } from "../runtime/outcome.js";
import type { Connector } from "./connector.js";
import { normalizeToolName } from "./names.js";

/** 04-actions §3 — what a per-principal connector headers resolver sees: the
 * acting principal plus the presence/grant context of the execution. Descriptor
 * listing resolves WITHOUT a principal (a system context). */
export interface ConnectorAuthContext {
  principal?: Principal;
  presence?: RunContext["presence"];
  grant?: PermissionGrant;
}

/** Async per-principal credential resolution for a connector. Shared static
 * headers remain the simple default. */
export type ConnectorHeadersResolver = (
  auth: ConnectorAuthContext,
) => Promise<Record<string, string>> | Record<string, string>;

/**
 * Any REST API with an OpenAPI document becomes agent tools: the document goes
 * through the SAME extractor `vendo sync` runs over a spec file, and the tools
 * execute through the SAME HTTP dispatch a host tool executes through — so a
 * spec handed here and a spec in the repo behave identically.
 *
 * `spec` is the document itself (JSON/YAML text, or already parsed), never a
 * path or a URL: reading and fetching are the caller's business, which keeps
 * this usable on every runtime.
 */
export function openApiConnector(config: {
  spec: string | Record<string, unknown>;
  /** Wins over the spec's own `servers[0]`. */
  baseUrl?: string;
  headers?: Record<string, string> | ConnectorHeadersResolver;
  name?: string;
}): Connector {
  const connectorName = config.name ?? "openapi";
  const descriptors: ToolDescriptor[] = [];
  const bindings = new Map<string, OpenApiBinding>();

  for (const tool of extractOpenApiDocument(openApiDocument(config.spec))) {
    // Extraction names the product's OWN tools `host_*`; under a connector the
    // namespace is the connector's, so that prefix goes.
    const name = normalizeToolName(`openapi_${connectorName}`, tool.name.replace(/^host_/, ""));
    if (bindings.has(name)) throw new Error(`OpenAPI tool-name collision: ${name}`);
    bindings.set(name, { ...tool.binding, ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}) });
    descriptors.push({
      name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      ...(tool.outputSchema === undefined ? {} : { outputSchema: tool.outputSchema }),
      risk: tool.risk,
    });
  }

  async function resolveHeaders(ctx: RunContext): Promise<Record<string, string>> {
    if (typeof config.headers !== "function") return { ...config.headers };
    const auth: ConnectorAuthContext = {
      principal: ctx.principal,
      presence: ctx.presence,
      ...(ctx.grant === undefined ? {} : { grant: ctx.grant }),
    };
    return { ...(await config.headers(auth)) };
  }

  return {
    name: connectorName,

    async descriptors(): Promise<ToolDescriptor[]> {
      return descriptors;
    },

    async execute(call: ToolCall, ctx: RunContext): Promise<ToolOutcome> {
      const binding = bindings.get(call.tool);
      if (!binding) return error("not-found", `Unknown OpenAPI tool: ${call.tool}`);
      if (!isArgsObject(call.args)) return error("validation", `Arguments for ${call.tool} must be an object`);
      const built = hostRequest(binding, call.args, call.tool, config.baseUrl);
      if ("error" in built) return built.error;
      return fetchHostTool(binding, call.tool, built.request, await resolveHeaders(ctx));
    },
  };
}
