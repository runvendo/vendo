import { readFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import {
  VendoError,
  toolDescriptorSchema,
  type ActAs,
  type PermissionGrant,
  type RunContext,
  type ToolCall,
  type ToolDescriptor,
  type ToolOutcome,
  type ToolRegistry,
} from "@vendoai/core";
import type { Connector } from "../connectors/connector.js";
import {
  extractedToolSchema,
  overridesFileSchema,
  toolsFileSchema,
  type ExtractedTool,
  type OpenApiBinding,
  type OverridesFile,
  type RouteBinding,
  type ToolOverride,
} from "../formats.js";

export interface ActionsRegistry extends ToolRegistry {
  add(tools: ToolRegistry): void;
}

/** Away calls carry the exact grant captured by the guard binding. */
export type ActionsRunContext = RunContext & { grant?: PermissionGrant };

interface RegistryConfig {
  dir?: string;
  tools?: ExtractedTool[];
  connectors?: Connector[];
  actAs?: ActAs;
  baseUrl?: string;
  fetch?: typeof fetch;
}

type Dispatch =
  | { kind: "host"; descriptor: ToolDescriptor; tool: ExtractedTool }
  | { kind: "connector"; descriptor: ToolDescriptor; connector: Connector }
  | { kind: "registry"; descriptor: ToolDescriptor; registry: ToolRegistry };

interface LoadedRegistry {
  descriptors: ToolDescriptor[];
  dispatch: Map<string, Dispatch>;
}

const STRIPPED_HEADERS = new Set([
  "host",
  "connection",
  "content-length",
  "transfer-encoding",
  "keep-alive",
  "upgrade",
]);

function error(code: string, message: string): ToolOutcome {
  return { status: "error", error: { code, message } };
}

function descriptorOf(tool: ExtractedTool): ToolDescriptor {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    risk: tool.risk,
    ...(tool.critical !== undefined ? { critical: tool.critical } : {}),
  };
}

function mergeOverride<T extends ToolDescriptor>(descriptor: T, override?: ToolOverride): T & { disabled?: boolean } {
  if (!override) return descriptor;
  return {
    ...descriptor,
    ...(override.risk !== undefined ? { risk: override.risk } : {}),
    ...(override.critical !== undefined ? { critical: override.critical } : {}),
    ...(override.description !== undefined ? { description: override.description } : {}),
    ...(override.disabled !== undefined ? { disabled: override.disabled } : {}),
  };
}

async function readOptionalJson<T>(path: string, parse: (value: unknown) => T): Promise<T | undefined> {
  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new VendoError("validation", `Could not read ${path}`, {
      cause: cause instanceof Error ? cause.message : String(cause),
    });
  }

  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch (cause) {
    throw new VendoError("validation", `Malformed JSON in ${path}`, {
      cause: cause instanceof Error ? cause.message : String(cause),
    });
  }

  try {
    return parse(value);
  } catch (cause) {
    throw new VendoError("validation", `Invalid Vendo actions file ${path}`, {
      cause: cause instanceof Error ? cause.message : String(cause),
    });
  }
}

function isArgsObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function appendQuery(url: URL, key: string, value: unknown): void {
  const values = Array.isArray(value) ? value : [value];
  for (const item of values) {
    const encoded = item !== null && typeof item === "object" ? JSON.stringify(item) : String(item);
    url.searchParams.append(key, encoded);
  }
}

function withPathArgs(path: string, args: Record<string, unknown>): { path: string; remaining: Record<string, unknown> } {
  const consumed = new Set<string>();
  const resolved = path.replace(/\{([^{}]+)\}/g, (_match, param: string) => {
    if (!Object.prototype.hasOwnProperty.call(args, param) || args[param] === undefined) {
      throw new VendoError("validation", `Missing required path parameter: ${param}`);
    }
    consumed.add(param);
    const value = args[param];
    return Array.isArray(value)
      ? value.map((segment) => encodeURIComponent(String(segment))).join("/")
      : encodeURIComponent(String(value));
  });
  return {
    path: resolved,
    remaining: Object.fromEntries(Object.entries(args).filter(([key]) => !consumed.has(key))),
  };
}

function joinedUrl(baseUrl: string, path: string): URL {
  return new URL(`${baseUrl.replace(/\/$/, "")}${path}`);
}

function resolveUrl(binding: RouteBinding | OpenApiBinding, configuredBaseUrl?: string): URL {
  let baseUrl: string | undefined;
  if (binding.kind === "openapi" && binding.baseUrl) {
    try {
      const candidate = new URL(binding.baseUrl);
      if (candidate.protocol === "http:" || candidate.protocol === "https:") baseUrl = binding.baseUrl;
    } catch {
      // Relative OpenAPI server URLs intentionally fall back to the host origin.
    }
  }
  baseUrl ??= configuredBaseUrl;
  if (!baseUrl) {
    throw new VendoError(
      "validation",
      `Cannot execute ${binding.kind} binding ${binding.path}; set createActions({ baseUrl }) for server-side route execution`,
    );
  }
  try {
    return joinedUrl(baseUrl, binding.path);
  } catch {
    throw new VendoError("validation", `Invalid baseUrl for ${binding.path}; set createActions({ baseUrl }) to a valid origin`);
  }
}

function forwardedHeaders(ctx: RunContext): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(ctx.requestHeaders ?? {})) {
    if (!STRIPPED_HEADERS.has(name.toLowerCase())) headers[name] = value;
  }
  return headers;
}

function absoluteHttpUrl(value: string | undefined): URL | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url : undefined;
  } catch {
    return undefined;
  }
}

function mayForwardPresentHeaders(
  binding: RouteBinding | OpenApiBinding,
  requestUrl: URL,
  configuredBaseUrl?: string,
): boolean {
  const bindingBaseUrl = binding.kind === "openapi" ? absoluteHttpUrl(binding.baseUrl) : undefined;
  if (!bindingBaseUrl) return true; // The URL was built from the configured host base URL.
  const configured = absoluteHttpUrl(configuredBaseUrl);
  return configured !== undefined && configured.origin === requestUrl.origin;
}

function validationError(source: string, cause: unknown): VendoError {
  return new VendoError("validation", `Invalid tool descriptor from ${source}`, {
    cause: cause instanceof Error ? cause.message : String(cause),
  });
}

function parseExtractedTool(value: unknown, source: string): ExtractedTool {
  try {
    return extractedToolSchema.parse(value);
  } catch (cause) {
    throw validationError(source, cause);
  }
}

function parseToolDescriptor(value: unknown, source: string): ToolDescriptor {
  try {
    return toolDescriptorSchema.parse(value);
  } catch (cause) {
    throw validationError(source, cause);
  }
}

function setHeader(headers: Record<string, string>, name: string, value: string): void {
  for (const existing of Object.keys(headers)) {
    if (existing.toLowerCase() === name.toLowerCase()) delete headers[existing];
  }
  headers[name] = value;
}

async function executeHost(config: RegistryConfig, tool: ExtractedTool, call: ToolCall, ctx: RunContext): Promise<ToolOutcome> {
  if (!isArgsObject(call.args)) return error("validation", `Arguments for ${call.tool} must be an object`);

  let url: URL;
  let body: string | undefined;
  try {
    const substituted = withPathArgs(tool.binding.path, call.args);
    url = resolveUrl({ ...tool.binding, path: substituted.path }, config.baseUrl);
    if (tool.binding.kind === "route") {
      if (tool.binding.argsIn === "query") {
        for (const [key, value] of Object.entries(substituted.remaining)) appendQuery(url, key, value);
      } else {
        body = JSON.stringify(substituted.remaining);
      }
    } else {
      const remaining = { ...substituted.remaining };
      if (Object.prototype.hasOwnProperty.call(remaining, "body")) {
        body = JSON.stringify(remaining.body);
        delete remaining.body;
      }
      for (const [key, value] of Object.entries(remaining)) appendQuery(url, key, value);
    }
  } catch (cause) {
    return error("validation", cause instanceof Error ? cause.message : `Invalid arguments for ${call.tool}`);
  }

  let headers: Record<string, string>;
  if (ctx.presence === "away") {
    if (!config.actAs) return error("not-implemented", "away execution isn't set up for this product");
    const grant = (ctx as ActionsRunContext).grant;
    if (!grant) return error("validation", "away execution requires a captured grant");
    try {
      const auth = await config.actAs(ctx.principal, grant);
      if (!auth) return error("not-implemented", "the host declined away execution for this action");
      headers = { ...auth.headers };
    } catch (cause) {
      return error("act-as-error", cause instanceof Error ? cause.message : "away authentication failed");
    }
  } else {
    headers = mayForwardPresentHeaders(tool.binding, url, config.baseUrl) ? forwardedHeaders(ctx) : {};
  }
  setHeader(headers, "accept", "application/json");
  if (body !== undefined) setHeader(headers, "content-type", "application/json");

  try {
    const request = config.fetch ?? globalThis.fetch;
    const response = await request(url, {
      method: tool.binding.method,
      headers,
      ...(body !== undefined ? { body } : {}),
    });
    const text = await response.text();
    if (!response.ok) {
      return error(
        "http-error",
        `${tool.binding.method} ${url.pathname} → ${response.status}: ${text.slice(0, 200)}`,
      );
    }
    if (text) {
      try {
        return { status: "ok", output: JSON.parse(text) };
      } catch {
        // Successful non-JSON responses retain their HTTP status and text.
      }
    }
    return { status: "ok", output: { status: response.status, text } };
  } catch (cause) {
    return error("network-error", cause instanceof Error ? cause.message : `Network request failed for ${call.tool}`);
  }
}

export function createActions(config: RegistryConfig): ActionsRegistry {
  const connectors = config.connectors ?? [];
  const added: ToolRegistry[] = [];
  let hostPromise: Promise<{ tools: ExtractedTool[]; overrides: OverridesFile }> | undefined;
  const connectorPromises = new Map<Connector, Promise<ToolDescriptor[]>>();
  const registryPromises = new Map<ToolRegistry, Promise<ToolDescriptor[]>>();
  let loadedPromise: Promise<LoadedRegistry> | undefined;

  function loadHost(): Promise<{ tools: ExtractedTool[]; overrides: OverridesFile }> {
    if (!hostPromise) hostPromise = (async () => {
      const emptyOverrides: OverridesFile = { format: "vendo/overrides@1", tools: {} };
      const configuredTools = config.tools?.map((tool, index) => parseExtractedTool(tool, `config.tools[${index}]`));
      if (!config.dir) return { tools: configuredTools ?? [], overrides: emptyOverrides };
      // `dir` may be the host root (we look inside its .vendo/) or the .vendo directory itself.
      const vendoDir = basename(resolve(config.dir)) === ".vendo" ? config.dir : join(config.dir, ".vendo");
      const [toolsFile, overrides] = await Promise.all([
        readOptionalJson(join(vendoDir, "tools.json"), (value) => toolsFileSchema.parse(value)),
        readOptionalJson(join(vendoDir, "overrides.json"), (value) => overridesFileSchema.parse(value)),
      ]);
      return { tools: configuredTools ?? toolsFile?.tools ?? [], overrides: overrides ?? emptyOverrides };
    })();
    return hostPromise;
  }

  function connectorDescriptors(connector: Connector): Promise<ToolDescriptor[]> {
    let promise = connectorPromises.get(connector);
    if (!promise) {
      promise = connector.descriptors();
      connectorPromises.set(connector, promise);
    }
    return promise!;
  }

  function addedDescriptors(registry: ToolRegistry): Promise<ToolDescriptor[]> {
    let promise = registryPromises.get(registry);
    if (!promise) {
      promise = registry.descriptors();
      registryPromises.set(registry, promise);
    }
    return promise!;
  }

  function load(): Promise<LoadedRegistry> {
    loadedPromise ??= (async () => {
      const host = await loadHost();
      const connectorLists = await Promise.all(connectors.map((connector) => connectorDescriptors(connector)));
      const registryLists = await Promise.all(added.map((registry) => addedDescriptors(registry)));
      const dispatch = new Map<string, Dispatch>();
      const descriptors: ToolDescriptor[] = [];

      function register(name: string, source: string, entry?: Dispatch): void {
        if (dispatch.has(name)) throw new VendoError("conflict", `Duplicate tool name ${name} from ${source}`);
        if (entry) {
          dispatch.set(name, entry);
          descriptors.push(entry.descriptor);
        } else {
          // Disabled tools still reserve their name so ambiguous overrides cannot hide collisions.
          dispatch.set(name, undefined as unknown as Dispatch);
        }
      }

      for (const extracted of host.tools) {
        const merged = mergeOverride({ ...extracted }, host.overrides.tools[extracted.name]);
        const descriptor = descriptorOf(merged);
        const disabled = merged.disabled === true;
        register(merged.name, "host tools", disabled ? undefined : { kind: "host", descriptor, tool: merged });
      }
      for (let index = 0; index < connectors.length; index += 1) {
        const connector = connectors[index]!;
        for (let descriptorIndex = 0; descriptorIndex < connectorLists[index]!.length; descriptorIndex += 1) {
          const rawDescriptor = parseToolDescriptor(
            connectorLists[index]![descriptorIndex],
            `connector ${connector.name}[${descriptorIndex}]`,
          );
          const merged = mergeOverride(rawDescriptor, host.overrides.tools[rawDescriptor.name]);
          const { disabled: _disabled, ...descriptor } = merged;
          register(
            descriptor.name,
            `connector ${connector.name}`,
            merged.disabled === true ? undefined : { kind: "connector", descriptor, connector },
          );
        }
      }
      for (let index = 0; index < added.length; index += 1) {
        const registry = added[index]!;
        for (let descriptorIndex = 0; descriptorIndex < registryLists[index]!.length; descriptorIndex += 1) {
          const descriptor = parseToolDescriptor(
            registryLists[index]![descriptorIndex],
            `added registry[${index}][${descriptorIndex}]`,
          );
          register(descriptor.name, "added registry", { kind: "registry", descriptor, registry });
        }
      }

      // Strip disabled reservations from runtime dispatch after all collision checks.
      for (const [name, entry] of dispatch) if (!entry) dispatch.delete(name);
      return { descriptors, dispatch };
    })();
    return loadedPromise;
  }

  return {
    add(tools: ToolRegistry): void {
      added.push(tools);
      loadedPromise = undefined;
    },

    async descriptors(): Promise<ToolDescriptor[]> {
      return (await load()).descriptors;
    },

    async execute(call: ToolCall, ctx: RunContext): Promise<ToolOutcome> {
      const entry = (await load()).dispatch.get(call.tool);
      if (!entry) return error("not-found", `Unknown tool: ${call.tool}`);
      if (entry.kind === "host") return executeHost(config, entry.tool, call, ctx);
      if (entry.kind === "registry") return entry.registry.execute(call, ctx);
      try {
        return await entry.connector.execute(call, ctx);
      } catch (cause) {
        return error("connector-error", cause instanceof Error ? cause.message : `Connector ${entry.connector.name} failed`);
      }
    },
  };
}
