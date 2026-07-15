import { readFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import {
  VendoError,
  descriptorHash,
  toolDescriptorSchema,
  type ActAs,
  type PermissionGrant,
  type Principal,
  type RunContext,
  type ToolCall,
  type ToolDescriptor,
  type ToolOutcome,
  type ToolRegistry,
} from "@vendoai/core";
import type { Connector } from "../connectors/connector.js";
import {
  capabilitiesFileSchema,
  extractedToolSchema,
  overridesFileSchema,
  toolsFileSchema,
  type CapabilitiesFile,
  type CapabilityBrief,
  type CompoundTool,
  type ExtractedTool,
  type HttpMethod,
  type OpenApiBinding,
  type OverridesFile,
  type RouteBinding,
  type ToolBinding,
  type ToolOverride,
  type TrpcBinding,
} from "../formats.js";
import { createCompoundExecutor, validateCapabilities, type PrimitiveStepTarget } from "./compound.js";
import { error, isArgsObject } from "./outcome.js";

export interface ActionsRegistry extends ToolRegistry {
  add(tools: ToolRegistry): void;
  /** Capability briefs carried by `.vendo/capabilities.json` (04 §1). Validated and exposed; consumed by later milestones. */
  briefs(): Promise<CapabilityBrief[]>;
}

/** Away calls carry the exact grant captured by the guard binding; venue="mcp"
 * calls carry the door's OAuth-consent projection (10-mcp §3) as `mcpConsent`,
 * attached by the door. `mcpConsent` is the STRUCTURAL twin of @vendoai/mcp's
 * `McpRunContext` — actions depends on core only (so the type can't be
 * imported); the door guarantees the shape, exactly as guard guarantees
 * `grant`. */
export type ActionsRunContext = RunContext & {
  grant?: PermissionGrant;
  mcpConsent?: { clientId: string; scopes: string[] };
};

interface RegistryConfig {
  dir?: string;
  tools?: ExtractedTool[];
  connectors?: Connector[];
  actAs?: ActAs;
  baseUrl?: string;
  /**
   * Whether `baseUrl` is an operator-set, trusted origin. Present-request
   * credentials (cookie/authorization) are forwarded to a route binding's host
   * ONLY when the base is trusted. An origin auto-derived from an inbound
   * request (e.g. the umbrella's zero-config same-origin default) is NOT
   * trusted: a spoofed Host on any early request would otherwise poison the
   * base and exfiltrate a later user's forwarded credentials. Defaults to true
   * so an explicitly-passed baseUrl keeps forwarding.
   */
  baseUrlTrusted?: boolean;
  /** Umbrella-owned structured warning hook. It fires only when a present host
   * call has browser auth to forward but the target fails the trusted-origin
   * rule. Callers should de-duplicate at the composition boundary. */
  onPresentCredentialsNotForwarded?: (event: {
    ctx: RunContext;
    tool: ToolDescriptor;
    reason: "untrusted-host-origin" | "cross-origin-binding";
  }) => void | Promise<void>;
  fetch?: typeof fetch;
  /** Inject `.vendo/capabilities.json` directly (tests, non-file hosts); takes precedence over `dir` (04 §1/§6). */
  capabilities?: CapabilitiesFile;
  /**
   * 04 §6: the guard-bound execution seam every compound step routes through.
   * The umbrella assigns it AFTER `guard.bind(actions)` — read at execution
   * time, exactly like `baseUrl`. Absent → compounds return `not-implemented`
   * and perform no work; there is no second execution path.
   */
  invokeTool?: ToolRegistry["execute"];
}

type Dispatch =
  | { kind: "host"; descriptor: ToolDescriptor; tool: ExtractedTool }
  | { kind: "connector"; descriptor: ToolDescriptor; connector: Connector }
  | { kind: "registry"; descriptor: ToolDescriptor; registry: ToolRegistry }
  | { kind: "compound"; descriptor: ToolDescriptor; tool: CompoundTool };

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

function descriptorOf(tool: ToolDescriptor): ToolDescriptor {
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

function hasInboundAuthHeaders(ctx: RunContext): boolean {
  return Object.keys(ctx.requestHeaders ?? {}).some((name) => {
    const normalized = name.toLowerCase();
    return normalized === "authorization" || normalized === "cookie";
  });
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
  binding: ToolBinding,
  requestUrl: URL,
  configuredBaseUrl: string | undefined,
  baseUrlTrusted: boolean,
): boolean {
  const bindingBaseUrl = binding.kind === "openapi" ? absoluteHttpUrl(binding.baseUrl) : undefined;
  // A route binding resolves against the configured base; forward the caller's
  // credentials only when that base is a trusted (operator-set) origin — never
  // to an origin auto-learned from an inbound request.
  if (!bindingBaseUrl) return baseUrlTrusted;
  const configured = absoluteHttpUrl(configuredBaseUrl);
  return baseUrlTrusted && configured !== undefined && configured.origin === requestUrl.origin;
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

/** The actAs seam's disposition, riding the outcome as a passthrough field the
 * guard binding lifts into audit `detail.actAs` and strips (block-actions
 * design cross-cutting audit enrichment — the same mechanism as
 * `connectorAccount`). "declined" IS the away re-verification outcome: the
 * host refusing to mint fails the run closed; there is no second seam. */
export type ActAsDisposition = "minted" | "declined" | "mismatch" | "error";

function withActAs(outcome: ToolOutcome, actAs: ActAsDisposition): ToolOutcome {
  return { ...outcome, actAs } as unknown as ToolOutcome;
}

/** The shared ActAs invocation for away + venue="mcp" host execution (04 §4).
 * The two paths source the grant differently but the seam call is identical:
 * `null` → the host declined; a throw → act-as-error. Returns the AuthMaterial
 * headers or the ToolOutcome to surface (tagged with its actAs disposition). */
async function actAsAuth(
  actAs: ActAs,
  principal: Principal,
  grant: PermissionGrant,
  messages: { declined: string; failed: string },
): Promise<{ headers: Record<string, string> } | { error: ToolOutcome }> {
  if (grant.subject !== principal.subject) {
    return {
      error: withActAs(error(
        "act-as-subject-mismatch",
        "the captured grant does not belong to the current principal",
      ), "mismatch"),
    };
  }
  try {
    const auth = await actAs(principal, grant);
    if (!auth) return { error: withActAs(error("not-implemented", messages.declined), "declined") };
    return { headers: { ...auth.headers } };
  } catch (cause) {
    return { error: withActAs(error("act-as-error", cause instanceof Error ? cause.message : messages.failed), "error") };
  }
}

/** The consent projection (10-mcp §3): a PermissionGrant-shaped value minted
 * per-call ONLY when the ctx carries the door's OAuth-consent record and the
 * guard did not attach a real grant. It honestly labels the authority — the
 * user's standing OAuth consent — as the argument handed to `actAs`. Never
 * stored, never consulted by guard; it exists only for the seam call. */
function mcpConsentGrant(ctx: ActionsRunContext, call: ToolCall, tool: ExtractedTool): PermissionGrant | undefined {
  if (!ctx.mcpConsent) return undefined;
  return {
    id: `grt_mcp_${ctx.sessionId}`,
    subject: ctx.principal.subject,
    tool: call.tool,
    descriptorHash: descriptorHash(descriptorOf(tool)),
    scope: { kind: "tool" },
    duration: "session",
    contextKey: ctx.sessionId,
    source: "mcp",
    grantedAt: new Date().toISOString(),
  };
}

/** The tRPC HTTP envelope (04 §1): queries GET `{mount}/{procedure}?input=...`,
 * mutations POST the input as the JSON body. Hosts whose tRPC root applies the
 * superjson transformer expect the `{ json: ... }` wrapping. */
function trpcRequest(binding: TrpcBinding, args: Record<string, unknown>, configuredBaseUrl?: string): {
  url: URL;
  method: HttpMethod;
  body?: string;
} {
  if (!configuredBaseUrl) {
    throw new VendoError(
      "validation",
      `Cannot execute trpc binding ${binding.procedure}; set createActions({ baseUrl }) for server-side trpc execution`,
    );
  }
  let url: URL;
  try {
    url = joinedUrl(configuredBaseUrl, `${binding.mount.replace(/\/$/, "")}/${binding.procedure}`);
  } catch {
    throw new VendoError("validation", `Invalid baseUrl for trpc procedure ${binding.procedure}; set createActions({ baseUrl }) to a valid origin`);
  }
  const payload = Object.keys(args).length > 0
    ? (binding.transformer === "superjson" ? { json: args } : args)
    : undefined;
  if (binding.type === "query") {
    if (payload !== undefined) url.searchParams.set("input", JSON.stringify(payload));
    return { url, method: "GET" };
  }
  return { url, method: "POST", ...(payload !== undefined ? { body: JSON.stringify(payload) } : {}) };
}

/** Unwrap the tRPC success envelope: `{ result: { data } }`, with superjson's
 * `{ json }` wrapping inside `data` when the host applies the transformer. */
function trpcOutput(binding: TrpcBinding, parsed: unknown): unknown {
  const result = parsed !== null && typeof parsed === "object" && "result" in parsed
    ? (parsed as { result: unknown }).result
    : undefined;
  const data = result !== null && typeof result === "object" && result !== undefined && "data" in result
    ? (result as { data: unknown }).data
    : parsed;
  if (binding.transformer === "superjson" && data !== null && typeof data === "object" && "json" in (data as Record<string, unknown>)) {
    return (data as { json: unknown }).json;
  }
  return data;
}

async function executeHost(config: RegistryConfig, tool: ExtractedTool, call: ToolCall, ctx: RunContext): Promise<ToolOutcome> {
  if (!isArgsObject(call.args)) return error("validation", `Arguments for ${call.tool} must be an object`);

  let url: URL;
  let method: HttpMethod;
  let body: string | undefined;
  try {
    if (tool.binding.kind === "trpc") {
      const request = trpcRequest(tool.binding, call.args, config.baseUrl);
      url = request.url;
      method = request.method;
      body = request.body;
    } else {
      method = tool.binding.method;
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
    }
  } catch (cause) {
    return error("validation", cause instanceof Error ? cause.message : `Invalid arguments for ${call.tool}`);
  }

  let headers: Record<string, string>;
  let actAsMinted = false;
  if (ctx.presence === "away") {
    if (!config.actAs) return error("not-implemented", "away execution isn't set up for this product");
    const grant = (ctx as ActionsRunContext).grant;
    if (!grant) return error("validation", "away execution requires a captured grant");
    const authed = await actAsAuth(config.actAs, ctx.principal, grant, {
      declined: "the host declined away execution for this action",
      failed: "away authentication failed",
    });
    if ("error" in authed) return authed.error;
    headers = authed.headers;
    actAsMinted = true;
  } else if (ctx.venue === "mcp" || (ctx as ActionsRunContext).mcpConsent !== undefined) {
    // 04 §4 / 10-mcp §2.1 / §3: an MCP-OAuth user has no host browser session,
    // so the present path has nothing to forward — and we forward NOTHING even
    // if a forged/mis-plumbed ctx carries requestHeaders (fail-closed). Host
    // auth comes from the ActAs seam, exactly as away: the guard-attached grant
    // when the run was grant-decided, else the door's OAuth-consent projection.
    //
    // The routing KEY is the door's consent evidence (`mcpConsent`), not just
    // venue==="mcp": apps re-contextualizes a `vendo_apps_call` in-app tool ref
    // to `{ ...ctx, venue: "app", appId }` (06-apps call.ts), so a door-driven
    // app interaction reaches here as venue="app" — but `mcpConsent` survives
    // that spread, so we still authenticate via ActAs rather than falling to the
    // (unauthenticated for MCP users) present-forward branch. A venue="app" ctx
    // WITHOUT mcpConsent (ordinary in-product app use) never enters here.
    if (!config.actAs) {
      return error(
        "not-implemented",
        "MCP host execution isn't set up for this product — the host must provide actAs (createVendo({ actAs }))",
      );
    }
    const actionsCtx = ctx as ActionsRunContext;
    // A ctx with neither a real grant nor the door's consent record did not come
    // from the door — fail closed rather than authenticate an unattested call.
    const grant = actionsCtx.grant ?? mcpConsentGrant(actionsCtx, call, tool);
    if (!grant) return error("validation", "MCP host execution requires the door's consent context");
    const authed = await actAsAuth(config.actAs, ctx.principal, grant, {
      declined: "the host declined MCP execution for this action",
      failed: "MCP authentication failed",
    });
    if ("error" in authed) return authed.error;
    headers = authed.headers;
    actAsMinted = true;
  } else {
    const forwardsPresentHeaders = mayForwardPresentHeaders(
      tool.binding,
      url,
      config.baseUrl,
      config.baseUrlTrusted ?? true,
    );
    if (!forwardsPresentHeaders && hasInboundAuthHeaders(ctx) && config.onPresentCredentialsNotForwarded !== undefined) {
      const reason = config.baseUrlTrusted === false
        ? "untrusted-host-origin" as const
        : "cross-origin-binding" as const;
      try {
        await config.onPresentCredentialsNotForwarded({ ctx, tool: descriptorOf(tool), reason });
      } catch {
        // A warning sink must never turn a host API call into a product failure.
      }
    }
    headers = forwardsPresentHeaders ? forwardedHeaders(ctx) : {};
  }
  setHeader(headers, "accept", "application/json");
  if (body !== undefined) setHeader(headers, "content-type", "application/json");

  const outcome = await (async (): Promise<ToolOutcome> => {
    try {
      const request = config.fetch ?? globalThis.fetch;
      const response = await request(url, {
        method,
        headers,
        ...(body !== undefined ? { body } : {}),
      });
      const text = await response.text();
      if (!response.ok) {
        return error(
          "http-error",
          `${method} ${url.pathname} → ${response.status}: ${text.slice(0, 200)}`,
        );
      }
      if (text) {
        try {
          const parsed: unknown = JSON.parse(text);
          return {
            status: "ok",
            output: tool.binding.kind === "trpc" ? trpcOutput(tool.binding, parsed) : parsed,
          };
        } catch {
          // Successful non-JSON responses retain their HTTP status and text.
        }
      }
      return { status: "ok", output: { status: response.status, text } };
    } catch (cause) {
      return error("network-error", cause instanceof Error ? cause.message : `Network request failed for ${call.tool}`);
    }
  })();
  // Audit enrichment: every actAs-authenticated host call reports the seam's
  // disposition, even when the host request itself then fails.
  return actAsMinted ? withActAs(outcome, "minted") : outcome;
}

interface LoadedHost {
  tools: ExtractedTool[];
  overrides: OverridesFile;
  capabilities?: CapabilitiesFile;
}

export function createActions(config: RegistryConfig): ActionsRegistry {
  const connectors = config.connectors ?? [];
  const added: ToolRegistry[] = [];
  let hostPromise: Promise<LoadedHost> | undefined;
  const connectorPromises = new Map<Connector, Promise<ToolDescriptor[]>>();
  const registryPromises = new Map<ToolRegistry, Promise<ToolDescriptor[]>>();
  let loadedPromise: Promise<LoadedRegistry> | undefined;

  function parseCapabilities(value: unknown, source: string): CapabilitiesFile {
    try {
      return capabilitiesFileSchema.parse(value);
    } catch (cause) {
      throw new VendoError("validation", `Invalid Vendo actions file ${source}`, {
        cause: cause instanceof Error ? cause.message : String(cause),
      });
    }
  }

  function loadHost(): Promise<LoadedHost> {
    if (!hostPromise) hostPromise = (async () => {
      const emptyOverrides: OverridesFile = { format: "vendo/overrides@1", tools: {} };
      const configuredTools = config.tools?.map((tool, index) => parseExtractedTool(tool, `config.tools[${index}]`));
      const configuredCapabilities = config.capabilities === undefined
        ? undefined
        : parseCapabilities(config.capabilities, "config.capabilities");
      if (!config.dir) {
        return {
          tools: configuredTools ?? [],
          overrides: emptyOverrides,
          ...(configuredCapabilities === undefined ? {} : { capabilities: configuredCapabilities }),
        };
      }
      // `dir` may be the host root (we look inside its .vendo/) or the .vendo directory itself.
      const vendoDir = basename(resolve(config.dir)) === ".vendo" ? config.dir : join(config.dir, ".vendo");
      const [toolsFile, overrides, capabilitiesFile] = await Promise.all([
        readOptionalJson(join(vendoDir, "tools.json"), (value) => toolsFileSchema.parse(value)),
        readOptionalJson(join(vendoDir, "overrides.json"), (value) => overridesFileSchema.parse(value)),
        readOptionalJson(join(vendoDir, "capabilities.json"), (value) => capabilitiesFileSchema.parse(value)),
      ]);
      const capabilities = configuredCapabilities ?? capabilitiesFile;
      return {
        tools: configuredTools ?? toolsFile?.tools ?? [],
        overrides: overrides ?? emptyOverrides,
        ...(capabilities === undefined ? {} : { capabilities }),
      };
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
      // The primitive table compound steps validate against: post-override host +
      // connector tools ONLY — never compounds, never `add()`-registry tools.
      const primitives = new Map<string, PrimitiveStepTarget>();

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
        primitives.set(merged.name, { risk: merged.risk, disabled });
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
          primitives.set(descriptor.name, { risk: merged.risk, disabled: merged.disabled === true });
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

      // 04 §6: compounds are additional tools merged at load like overrides.
      // Name collisions (any direction) throw `conflict` via register(); a
      // semantic-validation failure QUARANTINES the entry — name reserved,
      // absent from descriptors and dispatch, boot never degrades.
      const compounds = (host.capabilities?.tools ?? []).map(
        (tool) => mergeOverride({ ...tool }, host.overrides.tools[tool.name]),
      );
      const issuesByTool = new Map<string, string[]>();
      for (const issue of validateCapabilities({ tools: compounds }, primitives)) {
        issuesByTool.set(issue.tool, [...(issuesByTool.get(issue.tool) ?? []), issue.message]);
      }
      for (const compound of compounds) {
        const compoundIssues = issuesByTool.get(compound.name) ?? [];
        if (compound.disabled === true || compoundIssues.length > 0) {
          // Disabled and quarantined compounds both reserve the name (collision
          // detection) without dispatching; only quarantine warns.
          register(compound.name, "capabilities", undefined);
          if (compound.disabled !== true) {
            console.warn(
              `[vendo] quarantined compound tool ${compound.name} from .vendo/capabilities.json: ${compoundIssues.join("; ")}`,
            );
          }
          continue;
        }
        register(compound.name, "capabilities", { kind: "compound", descriptor: descriptorOf(compound), tool: compound });
      }

      // Strip disabled reservations from runtime dispatch after all collision checks.
      for (const [name, entry] of dispatch) if (!entry) dispatch.delete(name);
      return { descriptors, dispatch };
    })();
    return loadedPromise;
  }

  const compoundExecutor = createCompoundExecutor({
    config,
    async isPrimitive(name: string): Promise<boolean> {
      const entry = (await load()).dispatch.get(name);
      return entry !== undefined && (entry.kind === "host" || entry.kind === "connector");
    },
  });

  return {
    add(tools: ToolRegistry): void {
      added.push(tools);
      loadedPromise = undefined;
    },

    async descriptors(): Promise<ToolDescriptor[]> {
      return (await load()).descriptors;
    },

    async briefs(): Promise<CapabilityBrief[]> {
      return (await loadHost()).capabilities?.briefs ?? [];
    },

    async execute(call: ToolCall, ctx: RunContext): Promise<ToolOutcome> {
      const entry = (await load()).dispatch.get(call.tool);
      if (!entry) return error("not-found", `Unknown tool: ${call.tool}`);
      if (entry.kind === "host") return executeHost(config, entry.tool, call, ctx);
      if (entry.kind === "compound") return compoundExecutor.execute(entry.tool, call, ctx);
      if (entry.kind === "registry") return entry.registry.execute(call, ctx);
      try {
        return await entry.connector.execute(call, ctx);
      } catch (cause) {
        return error("connector-error", cause instanceof Error ? cause.message : `Connector ${entry.connector.name} failed`);
      }
    },
  };
}
