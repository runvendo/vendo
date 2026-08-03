import { readOptionalVendoJson } from "#actions/host-files";
import {
  VendoError,
  descriptorHash,
  isVendoAuthored,
  toolDescriptorSchema,
  vendoAuthored,
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
  VENDO_OVERRIDES_FORMAT,
  extractedToolSchema,
  judgmentsFileSchema,
  overridesFileSchema,
  toolsFileSchema,
  type CapabilityBrief,
  type CompoundTool,
  type ExtractedTool,
  type GraphqlBinding,
  type HttpMethod,
  type JudgmentsFile,
  type OpenApiBinding,
  type OverridesFile,
  type RouteBinding,
  type ServerActionBinding,
  type ToolBinding,
  type ToolOverride,
  type TrpcBinding,
} from "../formats.js";
import { applyJudgment } from "../judgments.js";
import { createCompoundExecutor, validateCapabilities, type PrimitiveStepTarget } from "./compound.js";
import { error, isArgsObject } from "./outcome.js";
import { searchToolDescriptors, tokenize, type ToolSearchMatch, type ToolSearchOptions } from "./search.js";
import { defaultFetch } from "@vendoai/core";

export interface ActionsRegistry extends ToolRegistry {
  add(tools: ToolRegistry): void;
  /** Capability briefs carried by `.vendo/overrides.json` (04 §1). Validated and exposed; consumed by later milestones. */
  briefs(): Promise<CapabilityBrief[]>;
  /**
   * Runtime tool search (ENG-252): rank the merged, enabled tool surface against
   * a free-text intent. Disabled tools are excluded (they never enter the loaded
   * descriptor set), so a hit is always a loadable, guard-bound tool.
   */
  search(query: string, options?: ToolSearchOptions): Promise<ToolSearchMatch[]>;
  /** Fetch + register the named lazy toolkits' tools (idempotent, global —
   * descriptors are the same for every principal; per-USER scoping lives in
   * the agent's loadout, spec 2026-07-20). */
  expandToolkits(toolkits: string[]): Promise<void>;
  /** The per-turn initial loadout: host/eager tools first, then the given
   * (connected) toolkits' tools — never an alphabetical slice of the catalog. */
  loadoutSeed(connectedToolkits: string[]): Promise<string[]>;
  /**
   * The tool menu one SURFACE offers, resolved from `.vendo/overrides.json`'s
   * `surfaces` block. `undefined` means unrestricted — the surface offers
   * everything it would have offered before menus existed.
   *
   * An explicit `surfaces.<surface>.tools` wins, in the host's authored order.
   * Absent, `agent` is unrestricted and `mcp` falls back to the default door
   * menu: every merged, enabled tool whose post-override `audience` is
   * `"end-user"` or ungraded — the tools a product's own customer could
   * legitimately call, which is exactly who is on the far end of an MCP client.
   *
   * CURATION, NOT SECURITY. A menu changes what a surface OFFERS; the guard,
   * `disabled`, and audience exclusions decide what may RUN, and none of them
   * consult this. A menu entry naming an unknown or disabled tool is therefore
   * a typo, not a breach: it warns once per boot and is ignored, and the rest
   * of the menu still applies (a bad label must never take a host down).
   */
  surfaceMenu(surface: "agent" | "mcp"): Promise<string[] | undefined>;
  /** The brokered-connector toolkit a loaded tool belongs to (undefined for
   * host tools, compounds, and connectors without per-user connections) —
   * the lookup behind the pre-guard connect check (discovery discipline,
   * spec 2026-07-25). */
  connectorToolkit(tool: string): Promise<{ connector: string; toolkit: string } | undefined>;
}

/** CORE-2 (wave 5): `grant` and `mcpConsent` are first-class optional fields
 * on core's RunContext now — the structural twin this alias used to declare is
 * gone. The alias survives for existing imports; new code can use RunContext
 * directly. */
export type ActionsRunContext = RunContext;

/** One entry of the wiring-generated registration map (04 §1): the imported
 * server-action function itself. `never[]` keeps arbitrary host action
 * signatures assignable; the runtime invokes positionally per the binding's
 * `params` order. */
export type ServerActionHandler = (...args: never[]) => unknown;

interface RegistryConfig {
  dir?: string;
  tools?: ExtractedTool[];
  connectors?: Connector[];
  actAs?: ActAs;
  /**
   * 04 §1: the server-action registration map the generated wiring file passes
   * into `createVendo({ serverActions })`, keyed `"<module>#<exportName>"`.
   * Dispatch is direct and in-process — no Next action-id bindings. A
   * server-action tool whose key is absent fails closed (clear error, no work).
   */
  serverActions?: Record<string, ServerActionHandler>;
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
  /**
   * 09-vendo §2 (install-dx wave 1.1): what to do when a present-mode call has
   * browser auth to forward but the target fails the trusted-origin rule for
   * "untrusted-host-origin" specifically — NEVER for "cross-origin-binding",
   * which always stays warn-only (same-origin trust must never extend to a
   * cross-origin binding). "warn" is today's behavior: fire
   * `onPresentCredentialsNotForwarded` and run the call unauthenticated.
   * "fail" runs the hook (the audit warning still records) and then fails the
   * call closed instead of reaching the host with no credentials — the
   * umbrella sets this in production so a missing VENDO_BASE_URL surfaces
   * loudly. Defaults to "warn".
   */
  untrustedOriginPolicy?: "warn" | "fail";
  fetch?: typeof fetch;
  /** Inject the authored overrides doc directly instead of reading
   *  `.vendo/overrides.json` from `dir`. Two callers share this seam: the
   *  unified try surface (Task 15a) passes an in-memory doc for non-file
   *  hosts, and the hosted-config seam (cse lane 3) lets the umbrella pass
   *  cloud-published overrides when there is no local file. Takes precedence
   *  over the file read whole-file (mirrors `tools`/`capabilities`), and the
   *  corrections apply to host and connector tools the same way the dir
   *  read's do (mergeOverride at load). The provider form is resolved ONCE
   *  through the memoized loadHost (boot-once, no hot-swap) and MAY be async
   *  so the umbrella can await a first-request cloud fetch; resolving to
   *  undefined falls back to the `dir` file read. `tools.json` always comes
   *  from `dir`. The resolved doc is validated at load with the authored-file
   *  posture: a malformed doc throws `validation` loudly. */
  overrides?: OverridesFile | (() => OverridesFile | undefined | Promise<OverridesFile | undefined>);
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
  /** Post-override audience per registered tool name — provenance the
   *  descriptor surface deliberately drops, kept here because the door's
   *  default menu is defined in terms of it. Absent name = ungraded. */
  audience: Map<string, ExtractedTool["audience"]>;
  /** Every name any source claimed — including disabled/quarantined entries
   * that never reach dispatch. Incremental expansion checks it so a
   * mid-run toolkit append can never shadow a reserved name. */
  reserved: Set<string>;
}

const STRIPPED_HEADERS = new Set([
  "host",
  "connection",
  "content-length",
  "transfer-encoding",
  "keep-alive",
  "upgrade",
]);

/**
 * Design §12's second mechanical vote, METHOD axis — the tool's execution shape
 * distilled into the one fact the vote needs (`ToolDescriptor.bindingRisk`).
 *
 * DERIVED here rather than copied off the tool, because the descriptor surface is
 * fed by data a host controls (`.vendo/tools.json`, `overrides.json`, a connector
 * catalog) and `overrides.json` may LOWER a declared `risk`. The vote is the
 * backstop for exactly that, so it must read something no author can set.
 *
 * Every value returned escalates or says nothing: `undefined` for a read shape is
 * how the vote behaved before this existed, and there is no value meaning "read".
 * A compound returns nothing on purpose — its declared risk is already the
 * riskiest step's (§4), and each step re-enters the guard on its own.
 */
function bindingRiskOf(binding: ToolBinding | undefined): ToolDescriptor["bindingRisk"] {
  switch (binding?.kind) {
    case "route":
    case "openapi":
      if (binding.method === "DELETE") return "destructive";
      return binding.method === "GET" ? undefined : "write";
    case "trpc":
    case "graphql":
      return binding.type === "mutation" ? "write" : undefined;
    // A server action is a POST-shaped mutation surface and static parsing cannot
    // prove otherwise — the same stance `serverActionRisk` takes at build time.
    case "server-action":
      return "write";
    default:
      return undefined;
  }
}

/**
 * The descriptor surface, as a field WHITELIST: provenance the registry knows
 * (audience, semantics, the binding itself) deliberately does not travel to
 * whoever reads `descriptors()`.
 *
 * `bindingRisk` is the one field added FROM the binding rather than passed
 * through, and it is added because the whitelist was silently disabling half of
 * THE LAW: `mechanicalRisk` reads the tool's method, the whitelist dropped
 * `binding.method`, and so a DELETE-bound tool labelled `write` was projected
 * into unattended runs. It is derived, never copied, so nothing a host can author
 * widens what reaches the vote (see {@link bindingRiskOf}).
 */
function descriptorOf(tool: ToolDescriptor & { binding?: ToolBinding }): ToolDescriptor {
  const bindingRisk = bindingRiskOf(tool.binding);
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    risk: tool.risk,
    ...(tool.critical !== undefined ? { critical: tool.critical } : {}),
    ...(tool.title !== undefined ? { title: tool.title } : {}),
    ...(bindingRisk !== undefined ? { bindingRisk } : {}),
  };
}

function mergeOverride<T extends ToolDescriptor & Pick<ExtractedTool, "audience" | "semantics">>(
  descriptor: T,
  override?: ToolOverride,
): T & { disabled?: boolean } & Pick<ExtractedTool, "audience" | "semantics"> {
  if (!override) return descriptor;
  return {
    ...descriptor,
    ...(override.risk !== undefined ? { risk: override.risk } : {}),
    ...(override.critical !== undefined ? { critical: override.critical } : {}),
    ...(override.description !== undefined ? { description: override.description } : {}),
    ...(override.title !== undefined ? { title: override.title } : {}),
    ...(override.disabled !== undefined ? { disabled: override.disabled } : {}),
    ...(override.audience !== undefined ? { audience: override.audience } : {}),
    // v3: overrides correct semantics field-by-field, never wholesale.
    ...(override.semantics !== undefined ? { semantics: { ...descriptor.semantics, ...override.semantics } } : {}),
  };
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

/**
 * How a failed host call names what it called: origin **and** path. A wire
 * origin pointing at the wrong host 404s every tool while every path is
 * correct, and a message carrying only the path reads exactly like a malformed
 * path — so the origin is never omitted.
 *
 * Assembled from the URL's safe parts rather than scrubbed after the fact:
 * `host` cannot contain userinfo, and dropping `search` drops query-string
 * tokens. A baseUrl may carry either (`https://svc:pw@host`,
 * `https://ghp_x@host`, `?access_token=…`) and this string reaches host logs
 * and the model.
 */
function requestTarget(url: URL): string {
  return `${url.protocol}//${url.host}${url.pathname}`;
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
  let parsed: ToolDescriptor;
  try {
    parsed = toolDescriptorSchema.parse(value);
  } catch (cause) {
    throw validationError(source, cause);
  }
  // Parsing must not LAUNDER provenance. Zod rebuilds the object from its string
  // keys, which drops the `vendoAuthored` symbol brand — and a Vendo verb that
  // arrives here unbranded falls back to §12's mechanical vote, which mis-votes
  // on the names we chose ourselves (core `resolvedRisk`). Carried over from the
  // SOURCE object, so it stays unforgeable: a descriptor that arrived as data —
  // a connector catalog, tools.json, the wire — cannot carry a symbol at all.
  return isVendoAuthored(value as ToolDescriptor) ? vendoAuthored(parsed) : parsed;
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
type ActAsDisposition = "minted" | "declined" | "mismatch" | "error";

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
 * superjson transformer expect the `{ json: ... }` wrapping — which is exactly
 * `superjson.serialize(value)` for every value that can traverse the agent
 * tool-call wire (plain JSON; no Date/Map/Set instances exist there, so no
 * `meta` is ever needed). Known limitation: a host validator that demands a
 * rich type (e.g. `z.date()`) rejects the ISO string visibly as a tRPC 400 —
 * request-path date coercion via schema-informed `meta` is a follow-up. */
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
 * `{ json }` wrapping inside `data` when the host applies the transformer.
 * `meta` is intentionally ignored: rich types come back as their JSON
 * projections (ISO strings etc.), the format the agent layer consumes. */
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

/** The GraphQL HTTP transport (04 §1): every operation — query or mutation —
 * is a POST of `{ query: document, variables: args }` to the host endpoint.
 * The binding's document declares each tool argument as a same-named variable,
 * so the agent's args ride through unmodified. Auth semantics (present-forward,
 * away/actAs, venue=mcp) are identical to route bindings. */
function graphqlRequest(binding: GraphqlBinding, args: Record<string, unknown>, configuredBaseUrl?: string): {
  url: URL;
  method: HttpMethod;
  body: string;
} {
  if (!binding.document) {
    throw new VendoError(
      "validation",
      `Cannot execute graphql binding ${binding.operation}; extraction emitted no executable document for it (fail-closed); review the tool's note before enabling`,
    );
  }
  if (!configuredBaseUrl) {
    throw new VendoError(
      "validation",
      `Cannot execute graphql binding ${binding.operation}; set createActions({ baseUrl }) for server-side graphql execution`,
    );
  }
  let url: URL;
  try {
    url = joinedUrl(configuredBaseUrl, binding.endpoint.length > 1 ? binding.endpoint.replace(/\/+$/, "") : binding.endpoint);
  } catch {
    throw new VendoError("validation", `Invalid baseUrl for graphql operation ${binding.operation}; set createActions({ baseUrl }) to a valid origin`);
  }
  return { url, method: "POST", body: JSON.stringify({ query: binding.document, variables: args }) };
}

/** Unwrap the GraphQL response envelope. GraphQL reports failures as a 200
 * with an `errors` array — that is still a failed call and surfaces as an
 * http-error outcome so the agent sees the server's message. On success the
 * single root field's value (the document has exactly one) is the output. */
function graphqlOutput(binding: GraphqlBinding, parsed: unknown): ToolOutcome {
  const envelope = parsed !== null && typeof parsed === "object"
    ? parsed as { data?: unknown; errors?: unknown }
    : undefined;
  const errors = envelope?.errors;
  if (Array.isArray(errors) && errors.length > 0) {
    const message = errors
      .map((item) => item !== null && typeof item === "object" && typeof (item as { message?: unknown }).message === "string"
        ? (item as { message: string }).message
        : "GraphQL error")
      .join("; ");
    return error("http-error", `graphql ${binding.operation} → errors: ${message.slice(0, 200)}`);
  }
  const data = envelope && "data" in envelope ? envelope.data : parsed;
  if (data !== null && typeof data === "object" && !Array.isArray(data)) {
    const record = data as Record<string, unknown>;
    if (Object.keys(record).length === 1 && binding.operation in record) {
      return { status: "ok", output: record[binding.operation] };
    }
  }
  return { status: "ok", output: data };
}

/** The JSON projection of an in-process return value: Dates become ISO
 * strings, `undefined` members drop, a bare `undefined` becomes `null` — the
 * same shape the value would have crossed an HTTP boundary with. */
function jsonProjection(value: unknown): { ok: true; output: ToolOutcome & { status: "ok" } } | { ok: false; message: string } {
  try {
    const text = JSON.stringify(value);
    return { ok: true, output: { status: "ok", output: text === undefined ? null : JSON.parse(text) } };
  } catch (cause) {
    return { ok: false, message: cause instanceof Error ? cause.message : "output is not JSON-serializable" };
  }
}

/** Direct in-process dispatch through the wiring-generated registration map
 * (04 §1). Rides the present user's ambient request context only: there is no
 * HTTP seam to attach ActAs AuthMaterial to, so away and MCP execution fail
 * closed instead of running with the wrong authority. A missing or non-function
 * registration fails closed — clear error, no work performed. */
async function executeServerAction(
  config: RegistryConfig,
  binding: ServerActionBinding,
  call: ToolCall,
  ctx: RunContext,
): Promise<ToolOutcome> {
  const key = `${binding.module}#${binding.exportName}`;
  if (ctx.presence === "away" || ctx.venue === "mcp" || (ctx as ActionsRunContext).mcpConsent !== undefined) {
    return error(
      "not-implemented",
      `server action ${key} executes in-process with the present user's session; away/MCP execution is not supported for server-action bindings`,
    );
  }
  const handler = config.serverActions?.[key];
  if (typeof handler !== "function") {
    return error(
      "not-implemented",
      `server action ${key} is not in the createVendo({ serverActions }) registration map; re-run vendo init to regenerate the wiring`,
    );
  }
  const args = call.args as Record<string, unknown>;
  const positional = binding.params.map((param) => args[param]);
  let output: unknown;
  try {
    output = await (handler as (...values: unknown[]) => unknown)(...positional);
  } catch (cause) {
    return error("server-action-error", cause instanceof Error ? cause.message : `Server action ${key} failed`);
  }
  const projected = jsonProjection(output);
  return projected.ok ? projected.output : error("server-action-error", `Server action ${key} returned a non-JSON value: ${projected.message}`);
}

async function executeHost(config: RegistryConfig, tool: ExtractedTool, call: ToolCall, ctx: RunContext): Promise<ToolOutcome> {
  if (!isArgsObject(call.args)) return error("validation", `Arguments for ${call.tool} must be an object`);
  if (tool.binding.kind === "server-action") return executeServerAction(config, tool.binding, call, ctx);

  let url: URL;
  let method: HttpMethod;
  let body: string | undefined;
  try {
    if (tool.binding.kind === "trpc") {
      const request = trpcRequest(tool.binding, call.args, config.baseUrl);
      url = request.url;
      method = request.method;
      body = request.body;
    } else if (tool.binding.kind === "graphql") {
      const request = graphqlRequest(tool.binding, call.args, config.baseUrl);
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
    if (!forwardsPresentHeaders && hasInboundAuthHeaders(ctx)) {
      const reason = config.baseUrlTrusted === false
        ? "untrusted-host-origin" as const
        : "cross-origin-binding" as const;
      if (config.onPresentCredentialsNotForwarded !== undefined) {
        try {
          await config.onPresentCredentialsNotForwarded({ ctx, tool: descriptorOf(tool), reason });
        } catch {
          // A warning sink must never turn a host API call into a product failure.
        }
      }
      // "untrusted-host-origin" only (09-vendo §2 install-dx wave 1.1):
      // "cross-origin-binding" always stays warn-only, in every policy.
      if (reason === "untrusted-host-origin" && config.untrustedOriginPolicy === "fail") {
        return error(
          "blocked",
          `Present credentials for ${call.tool} cannot be forwarded because VENDO_BASE_URL is not set. `
            + "Set VENDO_BASE_URL to this deployment's public origin and restart the server.",
        );
      }
    }
    headers = forwardsPresentHeaders ? forwardedHeaders(ctx) : {};
  }
  setHeader(headers, "accept", "application/json");
  if (body !== undefined) setHeader(headers, "content-type", "application/json");

  const outcome = await (async (): Promise<ToolOutcome> => {
    try {
      const request = config.fetch ?? defaultFetch;
      const response = await request(url, {
        method,
        headers,
        ...(body !== undefined ? { body } : {}),
      });
      const text = await response.text();
      if (!response.ok) {
        return error(
          "http-error",
          `${method} ${requestTarget(url)} → ${response.status}: ${text.slice(0, 200)}`,
        );
      }
      if (text) {
        try {
          const parsed: unknown = JSON.parse(text);
          if (tool.binding.kind === "graphql") return graphqlOutput(tool.binding, parsed);
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

/** The loaded host view of `.vendo/`: the machine layer, the AI one, and the
 *  authored one. */
interface LoadedHost {
  tools: ExtractedTool[];
  judgments: JudgmentsFile | undefined;
  overrides: OverridesFile;
  compounds: CompoundTool[];
  briefs: CapabilityBrief[];
}

/** One host tool's EFFECTIVE state: the extracted skeleton hardened by its
 *  standing judgment, then corrected by the human's override. Judgments are a
 *  HOST-tool layer only — connector, registry, and compound tools never carry
 *  one, so they keep going through `mergeOverride` alone.
 *
 *  Every reader of host enablement goes through here. Deriving `disabled` by
 *  hand anywhere else reads a pre-judgment surface and lies. */
function effectiveHostTool(host: LoadedHost, extracted: ExtractedTool): ExtractedTool {
  return mergeOverride(
    applyJudgment({ ...extracted }, host.judgments?.tools[extracted.name]),
    host.overrides.tools[extracted.name],
  );
}

export function createActions(config: RegistryConfig): ActionsRegistry {
  const connectors = config.connectors ?? [];
  const added: ToolRegistry[] = [];
  let hostPromise: Promise<LoadedHost> | undefined;
  const descriptorPromises = new Map<Connector | ToolRegistry, Promise<ToolDescriptor[]>>();
  let loadedPromise: Promise<LoadedRegistry> | undefined;

  function parseOverrides(value: unknown, source: string): OverridesFile {
    try {
      return overridesFileSchema.parse(value);
    } catch (cause) {
      throw new VendoError("validation", `Invalid Vendo actions file ${source}`, {
        cause: cause instanceof Error ? cause.message : String(cause),
      });
    }
  }

  // The product's core promise, warned at the seam that knows: an agent with
  // zero live host tools serves users it cannot help (field case: an
  // extraction stripped to tools: [] shipped a silently useless agent).
  /** One warning per surface per boot, however often the menu is resolved. */
  const surfaceMenuWarned = new Set<string>();
  let zeroLiveWarned = false;
  const warnZeroLiveTools = (host: LoadedHost): LoadedHost => {
    if (zeroLiveWarned) return host;
    const live = host.tools.filter((tool) => effectiveHostTool(host, tool).disabled !== true);
    if (live.length === 0) {
      zeroLiveWarned = true;
      console.warn(
        "[vendo] zero live host tools — every extracted tool is absent, disabled, or excluded, so the agent cannot "
        + "act on this product's API. Review .vendo/tools.json, the judgments in .vendo/judgments.json, and the "
        + "audience exclusions in .vendo/overrides.json, or re-run `vendo init` extraction. (Connector-only "
        + "deployments can ignore this.)",
      );
    }
    return host;
  };

  function loadHost(): Promise<LoadedHost> {
    if (!hostPromise) hostPromise = (async () => {
      const emptyOverrides: OverridesFile = { format: VENDO_OVERRIDES_FORMAT, tools: {} };
      const configuredTools = config.tools?.map((tool, index) => parseExtractedTool(tool, `config.tools[${index}]`));
      // cse lane 3 — an injected overrides doc (hosted config or the try
      // surface's in-memory profile) resolved ONCE through this memoized
      // loadHost. The provider form may be async so the umbrella can await a
      // first-request cloud fetch (reliable for the security-relevant
      // enablement path); it resolves to undefined when the surface is not
      // cloud-owned, letting the dir read below handle the file. The resolved
      // doc parses loudly (Task 15a posture: a malformed injected doc must
      // never be silently ignored).
      const resolvedOverrides = typeof config.overrides === "function"
        ? await (config.overrides as () => OverridesFile | undefined | Promise<OverridesFile | undefined>)()
        : config.overrides;
      const injectedOverrides = resolvedOverrides === undefined
        ? undefined
        : parseOverrides(resolvedOverrides, "config.overrides");
      if (!config.dir) {
        return {
          tools: configuredTools ?? [],
          // No dir, no judgments: judgments.json has no injection channel
          // (nothing writes the file yet — the judge channel is its own lane),
          // so a dir-less host simply has no AI layer.
          judgments: undefined,
          // An injected overrides doc still applies without a .vendo dir
          // (non-file / cloud-only hosts).
          overrides: injectedOverrides ?? emptyOverrides,
          compounds: injectedOverrides?.compounds ?? [],
          briefs: injectedOverrides?.briefs ?? [],
        };
      }
      // An injected overrides doc (cse lane 3 hosted config, or the unified
      // try surface's in-memory profile.overrides) wins over the
      // overrides.json read — AND config.tools (profile.tools) skips the
      // tools.json read the same way. This isn't just precedence: on a
      // filesystem-less venue (a Worker on workerd) the disk leg must never
      // run at all when the in-memory piece already fully substitutes for it
      // — see readOptionalVendoJson's non-ENOENT handling for the residual
      // reads that DO still run.
      const [toolsFile, judgmentsFileRead, overridesFileRead] = await Promise.all([
        configuredTools !== undefined
          ? Promise.resolve(undefined)
          : readOptionalVendoJson(config.dir, "tools.json", (value) => toolsFileSchema.parse(value)),
        // Absent → undefined, exactly like the pair. MALFORMED → throws, the
        // same fail-closed posture as overrides.json and for the same reason:
        // this file can carry disables and audience exclusions, so silently
        // ignoring a broken one would silently LOOSEN the surface.
        readOptionalVendoJson(config.dir, "judgments.json", (value) => judgmentsFileSchema.parse(value)),
        injectedOverrides !== undefined
          ? Promise.resolve(undefined)
          : readOptionalVendoJson(config.dir, "overrides.json", (value) => overridesFileSchema.parse(value)),
      ]);
      const overrides = injectedOverrides ?? overridesFileRead ?? emptyOverrides;
      return {
        tools: configuredTools ?? toolsFile?.tools ?? [],
        judgments: judgmentsFileRead,
        overrides,
        compounds: overrides.compounds ?? [],
        briefs: overrides.briefs ?? [],
      };
    })();
    return hostPromise.then(warnZeroLiveTools);
  }

  /** Memoized per source. A REJECTION is never memoized: a transient schema
   * fetch failure (broker blip, DNS) would otherwise pin the rejected promise
   * for the process lifetime, so discovery could never recover without a
   * restart. Evicting on rejection makes the next read retry. */
  function cachedDescriptors(source: Connector | ToolRegistry): Promise<ToolDescriptor[]> {
    let promise = descriptorPromises.get(source);
    if (!promise) {
      promise = source.descriptors();
      descriptorPromises.set(source, promise);
      promise.catch(() => {
        if (descriptorPromises.get(source) === promise) descriptorPromises.delete(source);
      });
    }
    return promise;
  }

  function load(): Promise<LoadedRegistry> {
    if (loadedPromise === undefined) {
      const building = buildRegistry();
      loadedPromise = building;
      // Same rule as cachedDescriptors: a failed build must not be the answer
      // forever — drop it so the next read rebuilds.
      building.catch(() => {
        if (loadedPromise === building) loadedPromise = undefined;
      });
    }
    return loadedPromise;
  }

  function buildRegistry(): Promise<LoadedRegistry> {
    return (async () => {
      const host = await loadHost();
      const connectorLists = await Promise.all(connectors.map((connector) => cachedDescriptors(connector)));
      const registryLists = await Promise.all(added.map((registry) => cachedDescriptors(registry)));
      const reserved = new Map<string, Dispatch | undefined>();
      const descriptors: ToolDescriptor[] = [];
      const audience = new Map<string, ExtractedTool["audience"]>();
      // The primitive table compound steps validate against: post-override host +
      // connector tools ONLY — never compounds, never `add()`-registry tools.
      const primitives = new Map<string, PrimitiveStepTarget>();

      function register(name: string, source: string, entry?: Dispatch): void {
        if (reserved.has(name)) throw new VendoError("conflict", `Duplicate tool name ${name} from ${source}`);
        // Disabled tools still reserve their name so ambiguous overrides cannot hide collisions.
        reserved.set(name, entry);
        if (entry) descriptors.push(entry.descriptor);
      }

      for (const extracted of host.tools) {
        const merged = effectiveHostTool(host, extracted);
        const descriptor = descriptorOf(merged);
        if (merged.audience !== undefined) audience.set(merged.name, merged.audience);
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
          // audience/semantics are override provenance, not descriptor surface.
          const { disabled: _disabled, audience: _audience, semantics: _semantics, ...descriptor } = merged;
          if (merged.audience !== undefined) audience.set(descriptor.name, merged.audience);
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
      const compounds = host.compounds.map(
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
              `[vendo] quarantined compound tool ${compound.name} from .vendo/overrides.json: ${compoundIssues.join("; ")}`,
            );
          }
          continue;
        }
        if (compound.audience !== undefined) audience.set(compound.name, compound.audience);
        register(compound.name, "capabilities", { kind: "compound", descriptor: descriptorOf(compound), tool: compound });
      }

      // v3 orphan detection (cse lane 1): an authored reference — override
      // entry, compound step, brief tools ref — naming a tool no source
      // registered is almost always a typo or a removed tool. LOUD warn,
      // never a throw: a stale reference must not take the agent down.
      const orphans: string[] = [];
      for (const name of Object.keys(host.overrides.tools)) {
        if (!reserved.has(name)) orphans.push(`tools["${name}"]`);
      }
      for (const compound of compounds) {
        for (const step of compound.binding.steps) {
          if (!reserved.has(step.tool)) orphans.push(`compound ${compound.name} step ${step.id} → ${step.tool}`);
        }
      }
      for (const brief of host.briefs) {
        for (const name of brief.tools ?? []) {
          if (!reserved.has(name)) orphans.push(`brief "${brief.name}" → ${name}`);
        }
      }
      if (orphans.length > 0) {
        console.warn(
          `[vendo] orphaned tool references in .vendo/overrides.json — these name no extracted, connector, or compound tool: ${orphans.join(", ")}. Check for typos or re-run \`vendo sync\`.`,
        );
      }

      // Runtime dispatch keeps only enabled entries once all collision checks ran.
      const dispatch = new Map<string, Dispatch>();
      for (const [name, entry] of reserved) if (entry) dispatch.set(name, entry);
      return { descriptors, dispatch, audience, reserved: new Set(reserved.keys()) };
    })();
  }

  /** Discovery discipline (spec 2026-07-25): merge ONLY the newly expanded connectors'
   * tools into an already-loaded registry — same override + disabled
   * semantics as buildRegistry, without redoing the host/compound merge. A
   * name that is already reserved is kept as-is (previously expanded tools
   * re-listed by the connector) rather than thrown as a boot-style conflict:
   * expansion runs on live traffic, and a collision here would poison the
   * load memo for the rest of the process. */
  async function appendExpanded(
    current: Promise<LoadedRegistry>,
    changed: Connector[],
  ): Promise<LoadedRegistry> {
    const [loaded, host] = await Promise.all([current, loadHost()]);
    const descriptors = [...loaded.descriptors];
    const dispatch = new Map(loaded.dispatch);
    const reserved = new Set(loaded.reserved);
    // Audience is carried forward the same way buildRegistry records it, so a
    // mid-run expanded tool grades identically for the door's default menu.
    const audience = new Map(loaded.audience);
    for (const connector of changed) {
      const list = await cachedDescriptors(connector);
      for (let index = 0; index < list.length; index += 1) {
        const rawDescriptor = parseToolDescriptor(list[index]!, `connector ${connector.name}[${index}]`);
        if (reserved.has(rawDescriptor.name)) continue;
        const merged = mergeOverride(rawDescriptor, host.overrides.tools[rawDescriptor.name]);
        const { disabled: _disabled, audience: _audience, semantics: _semantics, ...descriptor } = merged;
        reserved.add(descriptor.name);
        if (merged.audience !== undefined) audience.set(descriptor.name, merged.audience);
        if (merged.disabled === true) continue;
        descriptors.push(descriptor);
        dispatch.set(descriptor.name, { kind: "connector", descriptor, connector });
      }
    }
    return { descriptors, dispatch, audience, reserved };
  }

  /** Default cap on toolkits one search may expand — bounds fan-out when a
   * broad intent matches many index blurbs. Hosts tune it per query via
   * ToolSearchOptions.maxExpansions. */
  const MAX_SEARCH_EXPANSIONS = 3;
  let indexPromise: Promise<Array<{ toolkit: string; label?: string; description?: string }>> | undefined;
  /** Discovery discipline (spec 2026-07-25): identical queries answer from a process-lifetime memo — repeat
   * discovery costs zero index reads, zero expansions, zero schema fetches.
   * add() invalidates it (the searchable surface changed). */
  const searchMemo = new Map<string, Promise<ToolSearchMatch[]>>();

  function discoveryEntries() {
    if (indexPromise === undefined) {
      const building = (async () => {
        const lists = await Promise.all(connectors.map((connector) => connector.discoveryIndex?.() ?? Promise.resolve([])));
        return lists.flat();
      })();
      indexPromise = building;
      // A rejected index is not the answer forever (see cachedDescriptors).
      building.catch(() => {
        if (indexPromise === building) indexPromise = undefined;
      });
    }
    return indexPromise;
  }

  /** Expand named toolkits on every lazy connector; on any growth, bust that
   * connector's descriptor memo and APPEND the new tools to an already-loaded
   * registry — never a full load-memo bust, so the host/compound merge
   * and every other source's schemas stay done. A failed append degrades to
   * the full rebuild rather than a poisoned load memo. */
  async function expand(toolkits: string[]): Promise<boolean> {
    if (toolkits.length === 0) return false;
    const changed: Connector[] = [];
    for (const connector of connectors) {
      if (connector.expandToolkits === undefined) continue;
      if (await connector.expandToolkits(toolkits)) {
        descriptorPromises.delete(connector);
        changed.push(connector);
      }
    }
    if (changed.length === 0) return false;
    const current = loadedPromise;
    if (current !== undefined) {
      loadedPromise = appendExpanded(current, changed).catch(() => buildRegistry());
    }
    return true;
  }

  async function runSearch(query: string, options?: ToolSearchOptions): Promise<ToolSearchMatch[]> {
    // Rank the discovery index FIRST (toolkit-level pseudo-descriptors for
    // lazily-loaded connectors) and expand the top matches, so an unloaded
    // toolkit's tools are findable by intent ("send email" → gmail).
    const index = await discoveryEntries();
    const maxExpansions = Math.max(Math.trunc(options?.maxExpansions ?? MAX_SEARCH_EXPANSIONS), 0);
    const expandedNames = new Set<string>();
    if (index.length > 0 && maxExpansions > 0) {
      // Whole-word overlap scoring: the tool scorer's substring matching
      // lets stopwords ("an" ⊂ "channels") expand unrelated toolkits, so the
      // index ranks on exact word tokens only, ignoring 1–2 char tokens.
      const queryTokens = tokenize(query).filter((token) => token.length >= 3);
      const scored = index
        .map((entry) => {
          const words = new Set(tokenize(`${entry.label ?? ""} ${entry.description ?? ""}`));
          let score = 0;
          for (const token of queryTokens) {
            if (token === entry.toolkit.toLowerCase()) score += 8;
            else if (words.has(token)) score += 2;
          }
          return { toolkit: entry.toolkit, score };
        })
        .filter((hit) => hit.score > 0)
        .sort((a, b) => (b.score - a.score) || (a.toolkit < b.toolkit ? -1 : 1))
        .slice(0, maxExpansions);
      await expand(scored.map((hit) => hit.toolkit));
      for (const hit of scored) expandedNames.add(hit.toolkit);
    }
    // load().descriptors is the post-override, enabled-only surface — disabled
    // tools never reach it, so they can never be returned as loadable.
    const matches = searchToolDescriptors((await load()).descriptors, query, options);
    if (expandedNames.size === 0) return matches;
    return matches.map((match) => {
      const toolkit = [...expandedNames].find((name) => match.name.startsWith(`${name}_`));
      // A plain fact, not an invitation (discovery-discipline criterion 12):
      // the old suffix told the model calling unconnected tools was the way
      // to prompt a connect, which turned catalogs into call sprees.
      return toolkit === undefined ? match : {
        ...match,
        description: `${match.description} (part of the ${toolkit} toolkit — requires a connected ${toolkit} account)`,
      };
    });
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
      searchMemo.clear();
    },

    async descriptors(): Promise<ToolDescriptor[]> {
      return (await load()).descriptors;
    },

    async briefs(): Promise<CapabilityBrief[]> {
      return (await loadHost()).briefs;
    },

    async expandToolkits(toolkits: string[]): Promise<void> {
      await expand(toolkits);
    },

    async connectorToolkit(tool: string): Promise<{ connector: string; toolkit: string } | undefined> {
      const entry = (await load()).dispatch.get(tool);
      if (!entry || entry.kind !== "connector") return undefined;
      const toolkit = entry.connector.toolkitOf?.(tool);
      return toolkit === undefined ? undefined : { connector: entry.connector.name, toolkit };
    },

    async loadoutSeed(connectedToolkits: string[]): Promise<string[]> {
      await expand(connectedToolkits);
      const { descriptors: all, dispatch } = await load();
      const eager: string[] = [];
      const connected: string[] = [];
      for (const descriptor of all) {
        const entry = dispatch.get(descriptor.name);
        if (!entry) continue;
        const isLazyConnectorTool = entry.kind === "connector" && entry.connector.expandToolkits !== undefined;
        if (!isLazyConnectorTool) {
          eager.push(descriptor.name);
          continue;
        }
        if (connectedToolkits.some((toolkit) => descriptor.name.startsWith(`${toolkit}_`))) connected.push(descriptor.name);
      }
      return [...eager, ...connected];
    },

    async surfaceMenu(surface: "agent" | "mcp"): Promise<string[] | undefined> {
      const [{ dispatch, audience }, host] = await Promise.all([load(), loadHost()]);
      const authored = host.overrides.surfaces?.[surface];
      if (authored !== undefined) {
        // A menu is a FILTER, not a validated reference list. The authored set
        // is returned whole and matched against the live surface at use time,
        // because the surface grows: a lazy connector's tools do not exist at
        // boot, and dropping their names here would make them permanently
        // unreachable the moment they DO arrive. Unmatched names simply never
        // match anything, which is what a filter should do.
        const unmatched = authored.tools.filter((name) => !dispatch.has(name));
        if (unmatched.length > 0 && !surfaceMenuWarned.has(surface)) {
          surfaceMenuWarned.add(surface);
          console.warn(
            unmatched.length === authored.tools.length
              ? `[vendo] surfaces.${surface}.tools in .vendo/overrides.json matches no registered tool at all `
                + `(${unmatched.join(", ")}). If these are not lazy connector tools awaiting expansion, this surface `
                + "will offer nothing — check for typos or re-run `vendo sync`."
              : `[vendo] surfaces.${surface}.tools in .vendo/overrides.json names tools that are not registered right `
                + `now: ${unmatched.join(", ")}. They stay on the menu (a lazy connector tool matches once expanded); `
                + "if that is not what they are, check for a typo, a disabled tool, or re-run `vendo sync`.",
          );
        }
        return [...authored.tools];
      }
      if (surface === "agent") return undefined;
      // The default door menu: an MCP client speaks for a person, so offer the
      // tools that person's own auth admits. Ungraded reads as end-user.
      return [...dispatch.keys()].filter((name) => {
        const grade = audience.get(name);
        return grade === undefined || grade === "end-user";
      });
    },

    async search(query: string, options?: ToolSearchOptions): Promise<ToolSearchMatch[]> {
      const memoKey = [
        query.trim().toLowerCase().replace(/\s+/g, " "),
        options?.limit ?? "",
        options?.maxExpansions ?? "",
      ].join("\u0000");
      const memoized = searchMemo.get(memoKey);
      if (memoized !== undefined) return memoized;
      if (searchMemo.size > 500) searchMemo.clear();
      const promise = runSearch(query, options);
      searchMemo.set(memoKey, promise);
      // A failed search must not pin its failure for the process lifetime.
      promise.catch(() => searchMemo.delete(memoKey));
      return promise;
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
