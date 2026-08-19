import { readOptionalVendoJson } from "#actions/host-files";
import {
  type ActAs,
  descriptorHash,
  type PermissionGrant,
  type Principal,
  type RunContext,
  type ToolCall,
  type ToolDescriptor,
  toolDescriptorSchema,
  type ToolOutcome,
  type ToolRegistry,
  VendoError,
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
  type JudgmentsFile,
  type OverridesFile,
  type ServerActionBinding,
  type ToolBinding,
  type ToolOverride,
} from "../formats.js";
import { applyJudgment, disabledReason } from "../judgments.js";
import { createCompoundExecutor, validateCapabilities, type PrimitiveStepTarget } from "./compound.js";
import { fetchHostTool, hostRequest } from "./http-dispatch.js";
import { error, isArgsObject } from "./outcome.js";
import { searchToolDescriptors, type ToolSearchMatch, type ToolSearchOptions } from "./search.js";

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
  /** The per-turn initial loadout: every loaded tool, never an alphabetical
   * slice of the catalog. */
  loadoutSeed(): Promise<string[]>;
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
 * The descriptor surface, as a field WHITELIST: provenance the registry knows
 * (audience, semantics, the binding itself) deliberately does not travel to
 * whoever reads `descriptors()`.
 */
function descriptorOf(tool: ToolDescriptor & { binding?: ToolBinding }): ToolDescriptor {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    risk: tool.risk,
    ...(tool.outputSchema !== undefined ? { outputSchema: tool.outputSchema } : {}),
    ...(tool.confirmEach !== undefined ? { confirmEach: tool.confirmEach } : {}),
    ...(tool.title !== undefined ? { title: tool.title } : {}),
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
    ...(override.confirmEach !== undefined ? { confirmEach: override.confirmEach } : {}),
    ...(override.description !== undefined ? { description: override.description } : {}),
    ...(override.title !== undefined ? { title: override.title } : {}),
    ...(override.disabled !== undefined ? { disabled: override.disabled } : {}),
    ...(override.audience !== undefined ? { audience: override.audience } : {}),
    // v3: overrides correct semantics field-by-field, never wholesale.
    ...(override.semantics !== undefined ? { semantics: { ...descriptor.semantics, ...override.semantics } } : {}),
  };
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

/** The text channel's grant projection, the twin of `mcpConsentGrant`.
 *
 *  The evidence is the LINK: a code minted inside the product while the person
 *  was signed in as this subject, then sent back from their phone. That is the
 *  same shape of proof an MCP consent record carries — an out-of-band act by the
 *  subject, authorizing this surface to act as them — so it projects to the same
 *  kind of grant. `source: "chat"` because a texted turn IS a chat; the venue
 *  says so too. */
function channelLinkGrant(ctx: ActionsRunContext, call: ToolCall, tool: ExtractedTool): PermissionGrant | undefined {
  if (!ctx.channelLink) return undefined;
  return {
    id: `grt_channel_${ctx.sessionId}`,
    subject: ctx.principal.subject,
    tool: call.tool,
    descriptorHash: descriptorHash(descriptorOf(tool)),
    scope: { kind: "tool" },
    duration: "session",
    contextKey: ctx.sessionId,
    source: "chat",
    grantedAt: new Date().toISOString(),
  };
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

/** The present user's own credentials, forwarded only where the binding and the
 *  configured origin allow it — and never silently when they do not. */
async function presentHeaders(
  config: RegistryConfig,
  tool: ExtractedTool,
  call: ToolCall,
  ctx: RunContext,
  url: URL,
): Promise<{ headers: Record<string, string> } | { error: ToolOutcome }> {
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
      return {
        error: error(
          "blocked",
          `Present credentials for ${call.tool} cannot be forwarded because VENDO_BASE_URL is not set. `
            + "Set VENDO_BASE_URL to this deployment's full public URL (path prefix included) — "
            + "or VENDO_HOST_API_URL when the host API answers on another origin — and restart the server.",
        ),
      };
    }
  }
  return { headers: forwardsPresentHeaders ? forwardedHeaders(ctx) : {} };
}

/** How this call authenticates to the host: the ActAs seam for away and MCP,
 *  the present user's forwarded credentials otherwise. */
async function hostHeaders(
  config: RegistryConfig,
  tool: ExtractedTool,
  call: ToolCall,
  ctx: RunContext,
  url: URL,
): Promise<{ headers: Record<string, string>; actAsMinted: boolean } | { error: ToolOutcome }> {
  if (ctx.presence === "away") {
    if (!config.actAs) return { error: error("not-implemented", "away execution isn't set up for this product") };
    const grant = (ctx as ActionsRunContext).grant;
    if (!grant) return { error: error("validation", "away execution requires a captured grant") };
    const authed = await actAsAuth(config.actAs, ctx.principal, grant, {
      declined: "the host declined away execution for this action",
      failed: "away authentication failed",
    });
    if ("error" in authed) return { error: authed.error };
    return { headers: authed.headers, actAsMinted: true };
  }
  if (ctx.venue === "mcp" || (ctx as ActionsRunContext).mcpConsent !== undefined) {
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
      return {
        error: error(
          "not-implemented",
          "MCP host execution isn't set up for this product — the host must provide actAs (createVendo({ actAs }))",
        ),
      };
    }
    const actionsCtx = ctx as ActionsRunContext;
    // A ctx with neither a real grant nor the door's consent record did not come
    // from the door — fail closed rather than authenticate an unattested call.
    const grant = actionsCtx.grant ?? mcpConsentGrant(actionsCtx, call, tool);
    if (!grant) return { error: error("validation", "MCP host execution requires the door's consent context") };
    const authed = await actAsAuth(config.actAs, ctx.principal, grant, {
      declined: "the host declined MCP execution for this action",
      failed: "MCP authentication failed",
    });
    if ("error" in authed) return { error: authed.error };
    return { headers: authed.headers, actAsMinted: true };
  }
  if ((ctx as ActionsRunContext).channelLink !== undefined) {
    // A TEXTED turn. Its presence is "present" — there really is a person
    // holding a phone, which is what lets the guard ask them to approve a
    // money-moving call — but there is no browser request behind it, so the
    // present path has nothing to forward and would call the host API
    // unauthenticated. The host answers 401 and the agent apologises for a
    // "sign-in problem" it cannot fix. Same situation as an MCP-OAuth user, so
    // the same answer: authenticate through the ActAs seam.
    if (!config.actAs) {
      return {
        error: error(
          "not-implemented",
          "text-channel host execution isn't set up for this product — the host must provide actAs (createVendo({ auth }) fills it)",
        ),
      };
    }
    const actionsCtx = ctx as ActionsRunContext;
    const grant = actionsCtx.grant ?? channelLinkGrant(actionsCtx, call, tool);
    if (!grant) return { error: error("validation", "text-channel host execution requires the link on the ctx") };
    const authed = await actAsAuth(config.actAs, ctx.principal, grant, {
      declined: "the host declined text-channel execution for this action",
      failed: "text-channel authentication failed",
    });
    if ("error" in authed) return { error: authed.error };
    return { headers: authed.headers, actAsMinted: true };
  }
  const present = await presentHeaders(config, tool, call, ctx, url);
  return "error" in present ? present : { headers: present.headers, actAsMinted: false };
}

async function executeHost(config: RegistryConfig, tool: ExtractedTool, call: ToolCall, ctx: RunContext): Promise<ToolOutcome> {
  if (!isArgsObject(call.args)) return error("validation", `Arguments for ${call.tool} must be an object`);
  if (tool.binding.kind === "server-action") return executeServerAction(config, tool.binding, call, ctx);

  const built = hostRequest(tool.binding, call.args, call.tool, config.baseUrl);
  if ("error" in built) return built.error;

  const authed = await hostHeaders(config, tool, call, ctx, built.request.url);
  if ("error" in authed) return authed.error;
  const { headers, actAsMinted } = authed;

  const outcome = await fetchHostTool(tool.binding, call.tool, built.request, headers, config.fetch);
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
  // PARTIAL loss is the same failure at a quieter volume — a catalog that keeps
  // 2 of 5 reads healthy everywhere else, so the tools it lost are named here
  // with the layer that took them (field case: an `operator` grade took 3).
  /** One warning per surface per boot, however often the menu is resolved. */
  const surfaceMenuWarned = new Set<string>();
  let hostToolsWarned = false;
  const warnHostToolSurface = (host: LoadedHost): LoadedHost => {
    if (hostToolsWarned) return host;
    hostToolsWarned = true;
    const off = host.tools.flatMap((tool) => {
      const reason = disabledReason(tool, host.judgments?.tools[tool.name], host.overrides.tools[tool.name]);
      return reason === undefined ? [] : [`${tool.name} (${reason})`];
    });
    if (off.length === host.tools.length) {
      console.warn(
        "[vendo] zero live host tools — every extracted tool is absent, disabled, or excluded, so the agent cannot "
        + "act on this product's API. Review .vendo/tools.json, the judgments in .vendo/judgments.json, and the "
        + "audience exclusions in .vendo/overrides.json, or re-run `vendo init` extraction. (Connector-only "
        + "deployments can ignore this.)",
      );
    } else if (off.length > 0) {
      console.warn(
        `[vendo] ${off.length} of ${host.tools.length} extracted host tools are off, so the agent will never offer `
        + `them: ${off.join(", ")}. To turn one back on, set its "disabled": false in .vendo/overrides.json.`,
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
    return hostPromise.then(warnHostToolSurface);
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
      return { descriptors, dispatch, audience };
    })();
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
      return (await loadHost()).briefs;
    },

    async connectorToolkit(tool: string): Promise<{ connector: string; toolkit: string } | undefined> {
      const entry = (await load()).dispatch.get(tool);
      if (!entry || entry.kind !== "connector") return undefined;
      const toolkit = entry.connector.toolkitOf?.(tool);
      return toolkit === undefined ? undefined : { connector: entry.connector.name, toolkit };
    },

    async loadoutSeed(): Promise<string[]> {
      return (await load()).descriptors.map((descriptor) => descriptor.name);
    },

    async surfaceMenu(surface: "agent" | "mcp"): Promise<string[] | undefined> {
      const [{ dispatch, audience }, host] = await Promise.all([load(), loadHost()]);
      const authored = host.overrides.surfaces?.[surface];
      if (authored !== undefined) {
        // A menu is a FILTER, not a validated reference list. The authored set
        // is returned whole and matched against the live surface at use time,
        // because the surface grows: an `add()`-registered registry's tools do
        // not exist at boot, and dropping their names here would make them
        // permanently unreachable the moment they DO arrive. Unmatched names
        // simply never match anything, which is what a filter should do.
        const unmatched = authored.tools.filter((name) => !dispatch.has(name));
        if (unmatched.length > 0 && !surfaceMenuWarned.has(surface)) {
          surfaceMenuWarned.add(surface);
          console.warn(
            unmatched.length === authored.tools.length
              ? `[vendo] surfaces.${surface}.tools in .vendo/overrides.json matches no registered tool at all `
                + `(${unmatched.join(", ")}). If these are not tools a later \`add()\` registers, this surface `
                + "will offer nothing — check for typos or re-run `vendo sync`."
              : `[vendo] surfaces.${surface}.tools in .vendo/overrides.json names tools that are not registered right `
                + `now: ${unmatched.join(", ")}. They stay on the menu (a later \`add()\` can still supply them); `
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
      // Post-override and enabled-only, so a disabled tool can never come back
      // as loadable.
      return searchToolDescriptors((await load()).descriptors, query, options);
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
