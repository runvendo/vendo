import {
  createActions,
  createConnectGate,
  mergedSemanticsAndDomains,
  overridesFileSchema,
  VENDO_TOOLS_FORMAT,
  type ActionsRegistry,
  type ActionsRunContext,
  type CatalogFile,
  type Connector,
  type ExtractedTool,
  type OverridesFile,
  type ServerActionHandler,
} from "@vendoai/actions";
import { createAgent, VENDO_TOOL_PACK_PREFIX, type VendoAgent } from "@vendoai/agent";
import { memoizedSurfaceMenu } from "./surface-menu.js";
import {
  buildEnv,
  createApps,
  createAppTokens,
  pinBaselineSchema,
  type AppsConfig,
  type AppsRuntime,
  type PinBaseline,
  type SandboxAdapter,
} from "@vendoai/apps";
import { e2bInstalled, e2bSandbox } from "@vendoai/apps/e2b";
import {
  createAutomations,
  type AutomationsEngine,
} from "@vendoai/automations";
import {
  VendoError,
  descriptorHash,
  vendoThemeSchema,
  type ActAs,
  type AppDocument,
  type ComponentCatalog,
  type ComponentRegistry,
  type Json,
  type KnowledgeAdapter,
  type PermissionGrant,
  type Principal,
  type RunContext,
  type RunId,
  type SecretsProvider,
  type StoreAdapter,
  type ToolDescriptor,
  type ToolOutcome,
  type ToolRegistry,
  type VendoTheme,
} from "@vendoai/core";
import { createGuard, type Judge, type PolicyConfig, type PolicyFile, type VendoGuard } from "@vendoai/guard";
import {
  bindKnowledgeStore,
  cloudKnowledge,
  createKnowledgeTools,
  entailmentVerifier,
  type KnowledgeToolsOptions,
} from "@vendoai/knowledge";
import { createMcpDoor, type AppsPort, type HostOAuthAdapter, type McpDoor } from "@vendoai/mcp";
import {
  adoptEphemeralSubject,
  createStore,
  envSecrets,
  registerEphemeralSubject,
  sweepEphemeralSubjects,
  type SubjectMergeReport,
  type VendoStore,
} from "@vendoai/store";
// 02-store §5: the erase API ships on the umbrella's runtime surface so hosts
// reach it without installing @vendoai/store directly.
export { eraseStore, type EraseReport, type EraseTable } from "@vendoai/store";
// XCUT-3: the production-deploy path — createStore({ url }) plus the secrets
// runtime — is reachable from the umbrella itself (docs/persistence-and-deploy
// imports these from "@vendoai/vendo/server"); hosts never need to install
// @vendoai/store directly.
export { createStore, envSecrets, secretStore, storeSecrets } from "@vendoai/store";
// 09-vendo §2.1 — host-identity presets: one `auth` key fills the principal,
// actAs, and oauth seams from one config. The conformance kit + shared types
// ship here (safe — no peer deps reachable through them); the five zero-arg
// preset FUNCTIONS ship on their own subpath instead
// (@vendoai/vendo/auth/auth0, /auth/auth-js, /auth/clerk, /auth/jwt,
// /auth/supabase) so importing this server entry never forces a host to
// have every preset's optional peer dep installed (corpus-triage Task 9 —
// see auth-presets/index.ts for why).
export {
  hostAuthPresetConformance,
  type HostAuthPreset,
  type HostAuthPresetConformanceOptions,
  type HostAuthPresetOptions,
  type HostAuthPresetUser,
  type HostAuthPresetUserResolver,
  type SupabaseHostAuthPresetOptions,
} from "./auth-presets/index.js";
import type { HostAuthPreset } from "./auth-presets/index.js";
import { createByoApprovals } from "./byo-approvals.js";
import { initTelemetry, type Telemetry } from "@vendoai/telemetry";
import type { LanguageModel } from "ai";
import {
  capabilitySurfaceSnapshot,
  createCapabilityMissCapture,
  type CapabilitySurfaceSnapshot,
} from "./capability-misses.js";
import { catalogThemeSummary, mergeRuntimeCatalog, normalizeCatalogConfig, runtimeCatalogFromFile, runtimeCatalogFromJson } from "./catalog.js";
import { knowledgeIndexResolver } from "./knowledge-prompt.js";
import { bindVendoModelSlots, vendoModel } from "#dev-creds/model";
// Models spec 2026-07-22 — `vendoModel(name?)` is the vendo model family
// entry: the lazily-resolving env ladder createVendo composes when the host
// passes none, exported for host code too (judge wiring, host features). No
// argument means `vendo` semantics (per-rung defaults); a name passes through
// VERBATIM to the resolved rung. `devModel` stays as the deprecated alias.
export { devModel, vendoModel, type DevModelOptions, type VendoModelOptions, type VendoModelSlot } from "#dev-creds/model";
import { resolveModels } from "./models-config.js";
export { type ModelsConfig } from "./models-config.js";
import type { ModelsConfig } from "./models-config.js";
import {
  byoConnections,
  cloudConnections,
  hasConnections,
  unconfiguredConnections,
  type ConnectionsService,
} from "./connections.js";
// The shipped connections adapters ride the server surface so a host can pass
// one explicitly via createVendo({ connections }) — see selectConnections.
export {
  byoConnections,
  cloudConnections,
  unconfiguredConnections,
  type CloudConnectionsOptions,
  type ConnectionsService,
} from "./connections.js";
import { cloudSandbox } from "./sandbox.js";
// The Cloud sandbox adapter rides the server surface like the connections
// adapters: a host can pass it explicitly via createVendo({ sandbox }) with
// its own options instead of relying on the VENDO_API_KEY default.
export { cloudSandbox, type CloudSandboxOptions } from "./sandbox.js";
import { cloudApps } from "./cloud-apps.js";
import { chainSecrets, cloudSecrets } from "./cloud-secrets.js";
// The Cloud secrets provider and its chaining helper ride the server surface
// like the other Cloud adapters: a host can compose them explicitly via
// createVendo({ secrets: chainSecrets(envSecrets(), cloudSecrets({...})) })
// instead of relying on the VENDO_API_KEY default (selectSecrets below).
export { chainSecrets, cloudSecrets, type CloudSecretsOptions } from "./cloud-secrets.js";
import { cloudTools } from "./cloud-tools.js";
// The Cloud tools adapter (the execution half of the zero-key Composio seam)
// rides the server surface the same way: pass it explicitly via
// createVendo({ connectors: [cloudTools({...})] }) to scope with `apps`.
export { cloudTools, type CloudToolsOptions } from "./cloud-tools.js";
import { cloudConfig, type CloudConfig, type CloudConfigResult } from "./cloud-config.js";
// The Cloud hosted-config adapter (the read half of the config-resolution seam)
// rides the server surface too: the composition seam (selectConfigSurface)
// consults it for a `.vendo` surface the host neither set nor keeps on disk.
export { cloudConfig, type CloudConfig, type CloudConfigDoc, type CloudConfigResult, type CloudConfigOptions } from "./cloud-config.js";
import { selectConfigSurface, type ConfigSurfaceName } from "./config-surface.js";
export {
  selectConfigSurface,
  isConfigSurface,
  CONFIG_SURFACES,
  type ConfigSurfaceName,
  type ConfigSurfaceOwner,
} from "./config-surface.js";
import { HostedSessionDoorsMissingError, hostedStore, type HostedStore } from "./hosted-store.js";
// The hosted-store adapter rides the server surface like the other Cloud
// adapters: a host can pass it explicitly via createVendo({ store }) with its
// own options instead of relying on the VENDO_API_KEY default.
export { hostedStore, type HostedStore, type HostedStoreOptions } from "./hosted-store.js";
import { createRuntimeCapture } from "./runtime-capture.js";
import {
  BASE_PATH,
  VERSION,
  dispatchRoutes,
  environment,
  errorResponse,
  internalError,
  routeSegments,
  type RouteEntry,
  type SandboxVenue,
  type WireContext,
  type WireDeps,
} from "./wire/shared.js";
import { appRoutes } from "./wire/apps.js";
import { boxRoutes, fnProxyRoutes } from "./wire/box.js";
import { approvalRoutes, grantRoutes } from "./wire/approvals.js";
import { automationRoutes, runRoutes } from "./wire/automations.js";
import { connectionRoutes } from "./wire/connections.js";
import {
  createContextResolver,
  withAnonCookie,
  type AnonSession,
} from "./wire/context.js";
import {
  DOCTOR_ACT_AS_APP_ID,
  DOCTOR_ACT_AS_PRINCIPAL,
  doctorActAsTool,
  doctorPresentTool,
  doctorRoutes,
} from "./wire/doctor.js";
import {
  activityRoutes,
  devRoutes,
  orgsRoutes,
  statusRoutes,
  systemRoutes,
} from "./wire/misc.js";
import { threadRoutes } from "./wire/threads.js";

/** 10-mcp §5 — the door's canonical mount under the wire's own prefix. */
const MCP_MOUNT = `${BASE_PATH}/mcp`;
export interface Vendo {
  handler: (req: Request) => Promise<Response>;
  emit(event: string, payload: Json, principal: Principal): Promise<RunId[]>;
  agent: VendoAgent;
  guard: VendoGuard;
  /** Existing-agents — the guard-bound registry with BYO approval parking:
      the registry the `vendo_*` tool pack executes through. Same binding
      chat, apps, and automations ride (no unguarded route); the one addition
      is that a `pending-approval` outcome parks the exact call so the wire
      resumes it on approve, discards it on deny, and expires it on the
      parked-call TTL sweep. */
  guardedTools: ToolRegistry;
  apps: AppsRuntime;
  automations: AutomationsEngine;
  actions: ActionsRegistry;
  connections: ConnectionsService;
  store: VendoStore;
}

// Task 15a — the profile piece types, named from THIS entry so they sit
// beside createVendo/CreateVendoConfig: the hosted try venue (a Worker in the
// console repo) composes typed `profile` pieces against the umbrella alone,
// without adding a direct @vendoai/actions or @vendoai/core dependency.
export type { CatalogFile, ExtractedTool, OverridesFile } from "@vendoai/actions";
export type { VendoTheme } from "@vendoai/core";
export type { PolicyFile } from "@vendoai/guard";

export interface CreateVendoConfig {
  /** @deprecated Superseded by `models.agent` (models spec 2026-07-22);
      still functional for one release. The agent's LLM — the inference
      adapter seam (03-agent §1): any ai-SDK LanguageModel. An explicitly
      passed model always wins (BYO-LLM); when absent the seam resolves a
      real key from the environment — provider keys via vendoModel's ladder,
      then VENDO_API_KEY → Vendo Cloud managed inference — and fails honestly
      with instructions when none exists (precedence: resolveModels). */
  model?: LanguageModel;
  /** @deprecated The `model` half is superseded by `models.paint`;
      `disabled` remains the single-lane switch. v2 spec §4 — tier-0 paint
      lane knob for app generation. */
  paint?: AppsConfig["paint"];
  /** Models spec 2026-07-22 (DX surface 3) — the models block, keyed by slot,
      valued by a model-name string (resolved through vendoModel's credential
      ladder: VERBATIM passthrough, per-rung defaults, env pins) or an
      explicit ai-SDK LanguageModel object (wins as-is). `agent` supersedes
      the top-level `model`; `paint` supersedes `paint.model`; `judge` only
      feeds a judge the host wired from a string — vendoAutoJudge(
      vendoModel("vendo-judge")) — there is NO judge-on-by-default. */
  models?: ModelsConfig;
  /** 09-vendo §2.1 — ONE host-identity preset filling the principal, actAs, and
      oauth seams from one config key. Mutually exclusive with all three:
      mixing throws VendoError("validation") at compose time. */
  auth?: HostAuthPreset;
  /** Per-seam escape hatch: host session → principal; null → the per-client
      ephemeral anonymous principal. With neither `auth` nor `principal`, every
      session is anonymous (the null path is the default resolver — 09 §2). */
  principal?: (req: Request) => Promise<Principal | null>;
  /** Host components available to generated apps: the name-keyed registry
      object (01 §14 — the same object serves <VendoRoot>; the server ignores
      each entry's `component` reference) or the array form. Entry names must
      mirror the client-side components map 1:1. */
  catalog?: ComponentCatalog | ComponentRegistry;
  /** cse lane 3 — programmatic override for the theme surface. An explicit
      theme wins over `.vendo/theme.json` (config-surface precedence). A
      structural, boot-once surface: it is resolved once at compose (feeds app
      generation and the system-prompt summary), so unlike design-rules/brief
      it is not re-read live. */
  theme?: VendoTheme;
  /** cse lane 3 — programmatic override for the product brief surface (03-agent
      §3; the same prose `.vendo/brief.md` carries). A non-blank string wins
      over the file; blank falls through. */
  brief?: string;
  store?: VendoStore;
  sandbox?: SandboxAdapter;
  /** Knowledge K1 — the product knowledge base seam (core's KnowledgeAdapter).
      Configured, it composes the `vendo_knowledge_search` agent tool; unset,
      the tool does not exist (precedence: selectKnowledge). */
  knowledge?: KnowledgeAdapter;
  connectors?: Connector[];
  /** Toolkit scoping for the AUTO-COMPOSED Cloud connector (discovery
      discipline, 2026-07-25 spec): with VENDO_API_KEY and no explicit
      `connectors`, the composed cloudTools/cloudConnections pair is scoped to
      exactly these toolkits — the discovery index, the executable tools, and
      the connect catalog all bound to the set (instead of lazily advertising
      the console's whole catalog). Ignored when `connectors` or `connections`
      is passed explicitly — scope those adapters directly (e.g.
      `composioConnector({ apps })`). */
  connectorApps?: string[];
  /** 04-actions §3 — an explicit connections adapter; always wins over the
      defaults (precedence: selectConnections). */
  connections?: ConnectionsService;
  actAs?: ActAs;
  /** 04-actions §1 (ENG-248): the server-action registration map emitted by the
      generated wiring file, keyed `"<module>#<exportName>"`. Server-action tools
      dispatch in-process through it; a missing key fails closed at execution. */
  serverActions?: Record<string, ServerActionHandler>;
  policy?: PolicyConfig;
  judge?: Judge;
  secrets?: SecretsProvider;
  telemetry?: boolean;
  /** Development-only source capture. NODE_ENV=development enables this with
      cwd/.vendo defaults; an explicit object supplies a host root for adapters
      whose process cwd differs. `false` disables the environment default. */
  development?: boolean | { root?: string; out?: string };
  /** Unified try surface — the project root the `.vendo/` profile is read
      under: the actions files (tools.json/overrides.json via the actions
      block's `dir`), theme.json, brief.md, catalog.json, the
      per-generation design-rules.md read, the remixable pin baselines, and the
      development-capture defaults all resolve against it. Unset keeps today's
      behavior (the process cwd), so `npx vendo try` can mount a real
      composition over a profile living in a temp directory without chdir. */
  profileDir?: string;
  /** Unified try surface — the fetch host route/OpenAPI tool bindings execute
      through, threaded verbatim into the actions registry. An explicitly
      passed function always wins (adapter rule); unset keeps the platform
      fetch. `npx vendo try` injects a synthetic-fixture fetch here so host
      tool calls succeed with no host API running. */
  fetch?: typeof fetch;
  /** Unified try surface (Task 15a) — the `.vendo/` profile pieces as
      IN-MEMORY compose-time inputs, for venues with no filesystem (the hosted
      try venue composes per anonymous session from an AI-generated tool
      catalog + theme + brief held in memory; the `profileDir` seam can't
      reach it). Precedence PER PIECE, each independent of the others:
      `profile.<piece>` (in-memory, wins) → the `profileDir` file → the cwd
      default. A caller may pass only `tools` + `theme` and still read
      `brief.md` from disk. Each piece's type is exactly what the
      corresponding file read parses today (the zod-inferred file shapes —
      never a new shape): `tools`/`overrides` ride the actions
      registry's existing in-memory inputs and are validated THERE (its
      config-parse posture: a malformed piece throws `validation` loudly —
      note the registry loads lazily, so that throw surfaces on the FIRST
      ACTIONS USE (`actions.descriptors()`/`execute()`, or the first turn
      that loads tools), not at `createVendo` itself — wrap that call);
      `theme`/`brief`/`catalog` are trusted typed config, the same
      posture as the existing `catalog` key (zod parsing exists for untyped
      file bytes, not typed config). `policy` is the parsed `policy.json`
      document (the guard's `PolicyFile` shape — what the file read parses
      into today), for the venue that holds its demo policy in memory where
      the local `vendo try` writes the file; the longer-standing explicit
      `policy` knob wins over it (the `apps.designRules` discipline), and
      when the piece applies it feeds the guard inline, replacing the
      file/cloud legs entirely. `designRules` is a convenience alias for
      `apps.designRules` — one seam, so a host composing everything from one
      profile object doesn't have to split it; when both are set the
      longer-standing `apps.designRules` knob wins, and either fixes the rules
      for the instance lifetime exactly as `apps.designRules` documents.
      Unset `profile` (or any unset piece) keeps today's behavior unchanged. */
  profile?: {
    tools?: ExtractedTool[];
    overrides?: OverridesFile;
    theme?: VendoTheme;
    brief?: string;
    catalog?: CatalogFile;
    policy?: PolicyFile;
    designRules?: string;
  };
  /** 10-mcp §1 — the one flag: open the MCP door so outside agents (Claude,
      ChatGPT, Cursor) reach the host's tools through the SAME guard-bound path.
      Opening it is a host decision (10-mcp §2), so it is off by default.
      The additive object form opens the door with options: `baseUrl` is the
      canonical PUBLIC base URL the door's discovery metadata, issuer, resource
      identifiers, and RFC 8707 audience binding derive from — set it (or
      `VENDO_BASE_URL`, the default) behind a reverse proxy, where the request
      URL carries the proxy-internal origin. Forwarded headers are never
      trusted. `remoteAs` (10-mcp §3.1) trusts an external authorization server
      — e.g. the hosted broker at `{tenant}.mcp.vendo.run` — instead of serving
      the door's local OAuth surface, and `federation` (10-mcp §3.2) answers
      that server's signed login handshake at `{mount}/federate`. */
  mcp?: boolean | {
    baseUrl?: string;
    remoteAs?: { issuer: string; jwksUri?: string; audience: string };
    federation?: { secret: string };
  };
  /** 10-mcp §3 plus its additive prebuilt flow — the host's session + identity seam. Threaded top-level like
      `actAs`/`principal` (the door is agnostic; the umbrella owns the shape).
      REQUIRED when `mcp` is true: the door cannot mint principals without it. */
  oauth?: HostOAuthAdapter;
  /** 03-agent — chat context controls. All optional. `toolOutputCap` defaults to
      DEFAULT_TOOL_OUTPUT_CAP so one huge host-tool response can't blow the context;
      pass 0 to disable. `historyWindow` bounds messages re-sent per turn (default: full). */
  agent?: {
    /** Host voice and standing guidance, appended to the agent's system
        prompt every turn (03 §3 `instructions`) — tone, formatting, what to
        emphasize. Policy belongs in guard directions, not here. */
    instructions?: string;
    toolOutputCap?: number;
    maxOutputTokens?: number;
    historyWindow?: number;
    /** ENG-252 — cap on the uncurated initial tool loadout; the rest stay
        discoverable via `vendo_tools_search`. Defaults to the agent block's
        DEFAULT_MAX_INITIAL_TOOLS. */
    maxInitialTools?: number;
    /** ENG-252 — explicit curated initial loadout by tool name. When set,
        exactly these host tools (that exist and are enabled) start active —
        the cap is not applied; the rest stay discoverable via
        `vendo_tools_search`. Vendo's own `vendo_*` tools are always active. */
    loadout?: string[];
    /** Discovery discipline (spec 2026-07-25) — how many lazy connector toolkits ONE
        `vendo_tools_search` query may expand from the discovery index.
        Default 3. Lower it to keep a broad intent from fanning out schema
        loads; 0 disables index-driven expansion entirely (already-loaded
        tools stay searchable). */
    maxSearchExpansions?: number;
    /** AGENT-7: agent-loop step cap per turn (default 20). Exhaustion streams a
        renderable `data-vendo-step-limit` part instead of ending silently. */
    maxSteps?: number;
  };
  /** 02-store §4 (kill-list B3) — ephemeral (anonymous) session lifecycle.
      Anonymous visitors get a TTL-based session on disk: every request touches
      it; an idle session is swept — its rows erased from the store and its
      in-memory threads cascaded away. All optional.
      - `ttlMs` idle timeout before a session is swept (default 30 min). `0`
        disables TTL eviction.
      - `sweepIntervalMs` how often the amortized on-request sweep and the
        unref'd background timer run (default 60 s).
      - `now` internal clock seam (tests only). */
  sessions?: {
    ttlMs?: number;
    sweepIntervalMs?: number;
    now?: () => number;
  };
  /** Existing-agents — approval lifecycle knobs.
      - `parkedCallTtlMs` idle timeout for a guarded call parked from a BYO
        agent loop (a `vendo/approval-ref@1` envelope with no Vendo thread to
        resume through). Past it, the sweep denies the approval through the
        existing abandonment semantics and `<VendoApprovalEmbed>` reads
        "expired". Default 60 min; `0` disables expiry. Vendo-thread approvals
        are untouched — their abandonment stays turn-driven (AGENT-6). */
  approvals?: {
    parkedCallTtlMs?: number;
  };
  /** execution-v2 Waves 4+9 — apps-block options. `experimentalMachines` is
      the per-project layer-2 opt-in: NEW box graduation (the escalation
      ladder's last rung) and machine provisioning refuse with a typed
      VendoError naming this flag until the host enables it; steps/agentic
      automations (the ladder's first two rungs) never need it, and apps that
      already carry a machine keep every runtime path. `experimentalServedApps`
      is the layer-3 opt-in on top: a machine may serve the app surface itself
      (the host embeds its URL in a sandboxed iframe) — it REQUIRES
      `experimentalMachines` (layer 3 is served by a layer-2 machine). OFF by
      default — layer-3 generation, the 2→3 surface flip, and open() on a
      served app all refuse with a typed VendoError naming the flag. */
  apps?: {
    experimentalServedApps?: boolean;
    experimentalMachines?: boolean;
    /** Generation-pipeline flags (exemplarContract, structuredRepair,
        regionParallel, endPass) — opt-in while the A/B is measured; threaded
        verbatim to the apps engine. */
    pipeline?: AppsConfig["pipeline"];
    /** Host design rules for app generation (spec 2026-07-20): the same prose
        `.vendo/design-rules.md` carries, for hosts that prefer programmatic
        config. A non-blank string wins over the file and is fixed for the
        instance lifetime; unset/blank falls through to a PER-GENERATION read
        of the file, so editing it applies to the next create/edit without a
        restart. */
    designRules?: string;
  };
}

/** ENG-237 recommended defaults (documented in the PR body; Yousef-gated as
    09-vendo contract text). */
const DEFAULT_SESSION_TTL_MS = 30 * 60_000;
const DEFAULT_SESSION_SWEEP_INTERVAL_MS = 60_000;
/** Existing-agents — a BYO loop has no turn-driven abandonment sweep, so an
    orphaned approval card in a foreign chat expires on time instead: generous
    enough to walk away and come back, bounded enough that stale writes can't
    be approved days later. */
const DEFAULT_PARKED_CALL_TTL_MS = 60 * 60_000;

interface ResolvedSessions {
  ttlMs: number;
  sweepIntervalMs: number;
  now?: () => number;
}

function validateSessionsConfig(sessions: CreateVendoConfig["sessions"]): ResolvedSessions {
  const ttlMs = sessions?.ttlMs ?? DEFAULT_SESSION_TTL_MS;
  const sweepIntervalMs = sessions?.sweepIntervalMs ?? DEFAULT_SESSION_SWEEP_INTERVAL_MS;
  // ttlMs 0 (or negative) is the documented off switch. Any other value must
  // be a non-negative integer; the sweep interval must be a positive integer.
  if (!Number.isInteger(ttlMs) || ttlMs < 0) {
    throw new VendoError("validation", "sessions.ttlMs must be a non-negative integer (0 disables TTL eviction)");
  }
  if (!Number.isInteger(sweepIntervalMs) || sweepIntervalMs < 1) {
    throw new VendoError("validation", "sessions.sweepIntervalMs must be a positive integer");
  }
  return { ttlMs, sweepIntervalMs, ...(sessions?.now === undefined ? {} : { now: sessions.now }) };
}

function validateParkedCallTtl(approvals: CreateVendoConfig["approvals"]): number {
  const parkedCallTtlMs = approvals?.parkedCallTtlMs ?? DEFAULT_PARKED_CALL_TTL_MS;
  if (!Number.isInteger(parkedCallTtlMs) || parkedCallTtlMs < 0) {
    throw new VendoError(
      "validation",
      "approvals.parkedCallTtlMs must be a non-negative integer (0 disables parked-call expiry)",
    );
  }
  return parkedCallTtlMs;
}

/** Operator-tuned env knobs must be positive integer milliseconds. A typo
    like "8m" fails loudly here (validateSessionsConfig's posture) instead of
    flowing as NaN into the machine config, where NaN defeats runBoxEdit's
    `??` defaults — every box edit would time out instantly and hot-poll the
    box control port. */
function positiveIntegerEnv(name: string): number | undefined {
  const raw = environment(name);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new VendoError("validation", `${name} must be a positive integer of milliseconds, got ${JSON.stringify(raw)}`);
  }
  return value;
}

/** Default char cap on a single tool result before it reaches the model (03-agent §2).
    Generous enough for normal host responses, small enough that a runaway payload is
    truncated to a preview instead of blowing the context window. Override via config.agent. */
const DEFAULT_TOOL_OUTPUT_CAP = 32_000;

/** The shared Cloud-default leg of the ADAPTER RULE: VENDO_API_KEY fills a
    seam the host left unset, VENDO_CLOUD_URL overrides the console base URL. */
function cloudKeyOptions(): { apiKey: string; baseUrl?: string } | undefined {
  const apiKey = environment("VENDO_API_KEY");
  if (apiKey === undefined) return undefined;
  const baseUrl = environment("VENDO_CLOUD_URL");
  return { apiKey, ...(baseUrl === undefined ? {} : { baseUrl }) };
}

/** Sandbox leg of the ADAPTER RULE (see the block comment at
    selectConnections below): explicit adapter → BYO sandbox env (e2b) →
    VENDO_API_KEY defaults the Cloud managed pool → the dark venue.
    The Cloud slot fills ONLY when the host passed no sandbox and no BYO
    sandbox env is present, so setting a Vendo key never shadows an existing
    provider account. (The v1 Modal adapter is retired with the execution-v2
    seam; Modal can return behind the same seam later.) */
function selectSandbox(configured: SandboxAdapter | undefined): {
  adapter: SandboxAdapter | undefined;
  venue: SandboxVenue;
} {
  if (configured !== undefined) return { adapter: configured, venue: "custom" };

  // An env key only lights a venue when its optional SDK is actually
  // installed; otherwise /status would report a venue whose first
  // create() dies on a missing module.
  const e2bApiKey = environment("E2B_API_KEY");
  if (e2bApiKey !== undefined && e2bInstalled()) {
    // Wave 4 — operator knob for the provider machine lifetime. The default
    // 5-minute TTL kills a box mid-way through a long in-box agent build
    // (the box agent loop runs for minutes). Explicit VENDO_E2B_TIMEOUT_MS
    // wins; otherwise a raised box-edit budget implies a matching machine
    // lifetime (budget + 5-minute slack), so the two knobs cannot silently
    // disagree.
    const configured = Number(environment("VENDO_E2B_TIMEOUT_MS"));
    const editBudget = Number(environment("VENDO_BOX_EDIT_TIMEOUT_MS"));
    const timeoutMs = Number.isFinite(configured) && configured > 0
      ? configured
      : Number.isFinite(editBudget) && editBudget > 0
        ? editBudget + 5 * 60_000
        : undefined;
    return {
      adapter: e2bSandbox({
        apiKey: e2bApiKey,
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
      }),
      venue: "e2b",
    };
  }

  const cloud = cloudKeyOptions();
  if (cloud !== undefined) {
    return { adapter: cloudSandbox(cloud), venue: "cloud" };
  }

  return { adapter: undefined, venue: false };
}

/** ADAPTER RULE, connectors seam: which Connector[] feeds the actions
    registry. An explicitly passed array always wins — including an empty one
    ("no connectors" is a choice). Only a wholly unset slot lets
    VENDO_API_KEY default the Cloud tools connector (Composio tools brokered
    through the console; the connections seam below independently resolves to
    the cloud broker for the SAME posture, so connect and use stay paired). */
function selectConnectors(configured: Connector[] | undefined, connectorApps?: string[]): Connector[] {
  if (configured !== undefined) return configured;
  const apiKey = environment("VENDO_API_KEY");
  if (apiKey !== undefined) {
    const baseUrl = environment("VENDO_CLOUD_URL");
    return [cloudTools({
      apiKey,
      ...(baseUrl === undefined ? {} : { baseUrl }),
      ...(connectorApps === undefined ? {} : { apps: connectorApps }),
    })];
  }
  return [];
}

/** ADAPTER RULE, knowledge seam (ENG-368): which KnowledgeAdapter (if any)
    backs the `vendo_knowledge_search` tool. Precedence, top to bottom:
      1. an explicitly passed adapter always wins — including the no-key BYO
         paths (`httpKnowledge({ url })`, `lexicalKnowledge()`), which is how a
         Cloud subscriber keeps its own engine by construction. A zero-config
         `lexicalKnowledge()` is handed the composed store here
         (bindKnowledgeStore), so the host never plumbs one;
      2. VENDO_API_KEY makes the Cloud engine the default for the seam the host
         left unfilled (VENDO_CLOUD_URL overrides the console base URL) —
         the same rung every other Cloud-backed seam above already has;
      3. nothing configured at all: no adapter, no tool. That silence is
         intended — the agent must not advertise a knowledge base the host
         does not have — and it is the ONLY silent outcome. A key that is
         wrong or a console that is down surfaces on first use (the client
         raises `cloud-required`; the tool answers "unavailable" and warns the
         operator with the cause), per the Cloud rule that key problems appear
         on the first real service call, never at a validate endpoint.
    The adapters themselves never read the environment. */
function selectKnowledge(
  configured: KnowledgeAdapter | undefined,
  store: StoreAdapter,
): KnowledgeAdapter | undefined {
  if (configured !== undefined) return bindKnowledgeStore(configured, store);
  const cloud = cloudKeyOptions();
  if (cloud === undefined) return undefined;
  return cloudKnowledge(cloud);
}

/** The verifier is OFF by default (conductor ruling, checker round 1).
    `VENDO_KNOWLEDGE_VERIFY=on` turns it on for the Cloud engine.

    It ships off because the live measurement says it does not clear the bar it
    exists for: on the 94-question corpus it still answered 9-19 of 34
    unanswerable questions per pass (docs/eval/KNOWLEDGE.md), while adding a
    model call per search and seconds of latency to a call the user waits
    through. Shipping that on by default would be a product decision nobody
    made. Hosts who want the trade — fewer confident wrong answers, at that
    cost — opt in with one variable.

    A value that is neither on nor off is a TYPO, and a typo that silently
    means "off" is how a host thinks it has a trust feature it does not. Loud,
    like every other env knob here (positiveIntegerEnv). */
function knowledgeVerifyEnabled(): boolean {
  const raw = environment("VENDO_KNOWLEDGE_VERIFY")?.trim().toLowerCase();
  if (raw === undefined || raw === "") return false;
  if (["on", "true", "1"].includes(raw)) return true;
  if (["off", "false", "0"].includes(raw)) return false;
  throw new VendoError(
    "validation",
    `VENDO_KNOWLEDGE_VERIFY must be on or off, got ${JSON.stringify(raw)}`,
  );
}

/** The tool options for the composed engine: the verifier, and nothing else.

    It is NOT score-gated. K14 ran it only inside a calibrated band, and the
    live run showed what that costs — four unanswerable questions per pass
    scored outside the band, were never checked, and were answered by the
    threshold. A check gated on the number it exists to replace inherits that
    number's blind spots (spec §The verifier pass: "not threshold-gated ... it
    runs on every search that would return hits").

    The verifier model is the family's cheap pick on its own
    `knowledgeVerifier` slot — pinnable with VENDO_MODEL_KNOWLEDGE_VERIFIER or
    `models.knowledgeVerifier`, beside `judge` rather than borrowing it. A rung
    that resolves to nothing simply yields no verdict: the tool answers as it
    would have without a verifier and marks the result unverified, which is why
    this can never make knowledge unavailable.

    NOTE the one thing this function must never do: change a threshold. */
function knowledgeToolOptions(
  hostConfigured: boolean,
  models: ModelsConfig | undefined,
): KnowledgeToolsOptions {
  if (hostConfigured || !knowledgeVerifyEnabled()) return {};
  const model = vendoModel(undefined, { slot: "knowledgeVerifier" });
  bindVendoModelSlots(model, models);
  return { verifier: entailmentVerifier({ model }) };
}

/** ADAPTER RULE (docs/superpowers/specs/2026-07-17-vendo-cloud-definition-design.md):
    an infrastructure-backed block defines one adapter interface; which
    implementation composes is decided HERE, at the seam where createVendo
    wires blocks together — never by a hidden key-conditional inside the block.
    Precedence, top to bottom:
      1. an explicitly passed adapter always wins;
      2. BYO — a connector's own connections capability (connections must live
         where the connector executes);
      3. VENDO_API_KEY makes the Cloud adapter the default for the seam the
         host left unfilled (VENDO_CLOUD_URL overrides the console base URL);
      4. the unconfigured fallback, which fails closed with setup guidance.
    The adapters themselves never read the environment. */
/** Wraps a connections adapter so a successful `disconnect` drops the
    subject's cached connected-toolkit list. Invalidation is a COMPOSITION
    concern — the cache lives here, not in any adapter — so every posture gets
    it without an adapter knowing the cache exists. `initiate` needs no hook:
    a cached MISS already refetches before the gate blocks anything. */
function withDisconnectInvalidation(
  service: ConnectionsService,
  invalidate: (subject: string) => void,
): ConnectionsService {
  return {
    ...service,
    posture: service.posture,
    list: (principal) => service.list(principal),
    initiate: (principal, options) => service.initiate(principal, options),
    status: (principal, connector, connectionId) => service.status(principal, connector, connectionId),
    async disconnect(principal, connector, connectionId) {
      await service.disconnect(principal, connector, connectionId);
      invalidate(principal.subject);
    },
    catalog: () => service.catalog(),
  };
}

function selectConnections(
  configured: ConnectionsService | undefined,
  connectors: Connector[],
  connectorApps?: string[],
): ConnectionsService {
  if (configured !== undefined) return configured;
  if (connectors.some(hasConnections)) return byoConnections(connectors);
  const cloud = cloudKeyOptions();
  if (cloud === undefined) return unconfiguredConnections();
  // The same host scoping the composed cloudTools carries — the connect
  // dock's catalog must never advertise a toolkit the agent cannot invoke.
  return cloudConnections({
    ...cloud,
    ...(connectorApps === undefined ? {} : { apps: connectorApps }),
  });
}

/* ADAPTER RULE, inference seam: the agent and apps blocks consume one ai-SDK
   LanguageModel; which implementation composes is decided at resolveModels
   (models-config.ts). Precedence per slot: an explicitly passed model object
   always wins (BYO-LLM) → env pin (VENDO_MODEL / VENDO_MODEL_<SLOT>) →
   `models` string → the per-rung default. Every string rides vendoModel()'s
   env ladder, whose rungs live INSIDE it (resolveDevCredential): a provider
   key (ANTHROPIC / OPENAI / GOOGLE) via the host-installed @ai-sdk provider,
   then VENDO_API_KEY via @ai-sdk/anthropic pointed at the Cloud model gateway
   (`<console>/api/v1` — Anthropic-compatible /messages), then the honest
   keyless failure with exact instructions on first use. vendoModel is the one
   seam-sanctioned lazy env resolver; every other adapter still never reads
   the environment. */

/** The ephemeral-session operations bound to the composed store (02-store §4):
    registration == touch, adoption on sign-in, and the TTL sweep. Selected
    WITH the store (selectStore below) because the local engine reaches its
    session registry over SQL while the hosted store reaches it over the
    store wire — downstream consumers (wire/context, the sweep) stay
    oblivious to which one they got. */
interface SessionOps {
  register(subject: string, now: number): Promise<void>;
  adopt(from: string, to: string): Promise<SubjectMergeReport | null>;
  /** Erases every session idle ≥ idleMs; resolves the evicted subjects. */
  sweep(idleMs: number, now: number): Promise<string[]>;
}

function localSessionOps(store: VendoStore): SessionOps {
  return {
    register: (subject, now) => registerEphemeralSubject(store, subject, now),
    adopt: (from, to) => adoptEphemeralSubject(store, from, to),
    sweep: (idleMs, now) => sweepEphemeralSubjects(store, { idleMs, now }),
  };
}

function hostedSessionOps(store: HostedStore, touchDebounceMs: number): SessionOps {
  // Last successful WIRE touch per subject. Presence means the subject is
  // registered on the console; entries retire with the session (adopt/sweep),
  // so the map tracks at most the live anonymous sessions of this process.
  const wireTouched = new Map<string, number>();
  // vendo-web@7cd0a02 (2026-07-19) removed the console's session doors per a
  // newer spec (anonymous visitor = end_user row; adoption = PUT
  // /users/{externalId}); against that console every door op meets a bare
  // 404. The doors then go quiet for the process — one warn, no per-request
  // failures, no per-interval sweep retries — because anonymous traffic must
  // keep serving and there is nothing to retry INTO. The full contract catch-
  // up (merge + TTL lifecycle on the new surface) is the vendo-web follow-up
  // tracked in docs/verification/existing-agents/polish/hosted-sessions-404.md.
  let doorsMissing = false;
  const disableDoors = (): void => {
    if (doorsMissing) return;
    doorsMissing = true;
    console.warn(
      "[vendo] Vendo Cloud console does not serve the hosted session doors (/api/v1/store/sessions/* was removed in vendo-web@7cd0a02): "
      + "anonymous-session registration, the anonymous→signed-in merge, and the hosted TTL sweep are disabled for this process. "
      + "Hosted anonymous sessions will not be swept until the console grows a replacement surface.",
    );
  };
  return {
    async register(subject, now) {
      if (doorsMissing) return;
      // In-process debounce: skip the wire touch when this subject's LAST
      // successful touch is younger than sweepIntervalMs/2. TTLs are hours
      // while the debounce window is seconds, and the claim leg re-checks
      // idleness server-side, so a touched_at that is up to one debounce
      // window stale can never get a live session swept — steady-state
      // anonymous traffic costs zero extra round-trips.
      const last = wireTouched.get(subject);
      if (last !== undefined && now - last < touchDebounceMs) return;
      try {
        await store.sessions.register(subject, now);
        wireTouched.set(subject, now);
      } catch (error) {
        // The registry itself is gone: failing closed would 500 every
        // anonymous request while protecting a sweep that cannot run.
        if (error instanceof HostedSessionDoorsMissingError) {
          disableDoors();
          return;
        }
        // INVARIANT: registered ⇒ sweepable. The FIRST registration must fail
        // closed — if it doesn't land, rows written under this subject would
        // be unreachable by the TTL sweep forever. A subsequent touch only
        // refreshes idleness, so a console blip there fails OPEN with a warn:
        // the next request retries (the failed touch is not recorded), and an
        // hours-long TTL absorbs the staleness.
        if (last === undefined) throw error;
        console.warn(`[vendo] hosted session touch failed; will retry next request: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
    async adopt(from, to) {
      // No doors, no merge report: the caller still retires the anon cookie
      // (the linkage is unrecoverable either way) and skips the merge audit.
      if (doorsMissing) return null;
      try {
        const report = await store.sessions.adopt(from, to);
        wireTouched.delete(from);
        return report;
      } catch (error) {
        if (!(error instanceof HostedSessionDoorsMissingError)) throw error;
        disableDoors();
        wireTouched.delete(from);
        return null;
      }
    },
    // The HOST-driven sweep (hosted-store one-pager): list stale candidates,
    // claim each (the wire claim repeats the idleness predicate — a re-touch
    // defeats it, same serialization as sweepEphemeralSubjects), and finish
    // every claimed subject through the erase cascade.
    async sweep(idleMs, now) {
      if (doorsMissing) return [];
      const evicted: string[] = [];
      try {
        for (const subject of await store.sessions.stale(idleMs, now)) {
          if (!(await store.sessions.claim(subject, idleMs, now))) continue;
          await store.erase.bySubject(subject);
          wireTouched.delete(subject);
          evicted.push(subject);
        }
      } catch (error) {
        if (!(error instanceof HostedSessionDoorsMissingError)) throw error;
        disableDoors();
      }
      return evicted;
    },
  };
}

/** A host may also pass hostedStore({...}) explicitly via createVendo({ store });
    the session doors it carries are then used as-is instead of the local SQL
    engine's (any other custom store keeps the local ops — and with them
    today's loud dbFor failure rather than a silent no-op). */
function isHostedStore(store: VendoStore): store is HostedStore {
  const candidate = store as Partial<HostedStore>;
  return typeof candidate.sessions?.register === "function"
    && typeof candidate.erase?.bySubject === "function";
}

/** ADAPTER RULE, store seam (cloned from selectConnections): persistence is
    one VendoStore; which implementation composes is decided HERE. Precedence,
    top to bottom:
      1. an explicitly passed store always wins (BYO — the host's own Postgres
         or PGlite via createStore, the hard BYO rule);
      2. VENDO_API_KEY makes the Cloud hosted store the default for the seam
         the host left unfilled (VENDO_CLOUD_URL overrides the console base) —
         Vendo data lives with Vendo, tenant = the key's org, resolved
         server-side on every call;
      3. the local createStore default (02-store §4 re-derived: encryption is
         a production-owned concern — with VENDO_STORE_ENCRYPTION_KEY set,
         stored secrets encrypt at rest; without it, dev mode stores locally
         unencrypted (the data dir is gitignored) while production secret
         writes fail closed with instructions).
    The adapters themselves never read the environment. */
function selectStore(configured: VendoStore | undefined, touchDebounceMs: number): {
  store: VendoStore;
  sessions: SessionOps;
} {
  if (configured !== undefined) {
    return {
      store: configured,
      sessions: isHostedStore(configured)
        ? hostedSessionOps(configured, touchDebounceMs)
        : localSessionOps(configured),
    };
  }
  const cloud = cloudKeyOptions();
  if (cloud !== undefined) {
    const hosted = hostedStore(cloud);
    return { store: hosted, sessions: hostedSessionOps(hosted, touchDebounceMs) };
  }
  const encryptionKey = environment("VENDO_STORE_ENCRYPTION_KEY");
  const local = createStore(encryptionKey === undefined
    ? { allowUnencryptedSecrets: environment("NODE_ENV") !== "production" }
    : { encryption: { key: encryptionKey } });
  return { store: local, sessions: localSessionOps(local) };
}

/** ADAPTER RULE, secrets seam (cloned from selectConnections): generated-app
    env building and the apps block's redaction consume one SecretsProvider;
    which implementation composes is decided HERE. Precedence, top to bottom:
      1. an explicitly passed provider always wins (BYO — the host's own vault
         indirection via createVendo({ secrets }));
      2. the process environment stays first even with a key — a defined,
         non-empty env value wins (the hard BYO rule: setting a Vendo key
         never shadows a secret the operator already ships in the env) — and
         VENDO_API_KEY chains the Cloud secrets provider behind it for the
         names the environment leaves unset (VENDO_CLOUD_URL overrides the
         console base URL);
      3. keyless, the envSecrets default alone (unchanged behavior).
    The providers themselves never read VENDO_API_KEY; a Cloud lookup failure
    propagates from the chain (chainSecrets) — redaction already tolerates
    provider failures at its own layer. */
function selectSecrets(configured: SecretsProvider | undefined): SecretsProvider {
  if (configured !== undefined) return configured;
  const cloud = cloudKeyOptions();
  if (cloud === undefined) return envSecrets();
  return chainSecrets(envSecrets(), cloudSecrets(cloud));
}

function isJsonRequest(request: Request): boolean {
  return request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase()
    === "application/json";
}

/** 09 §4 — the .vendo/ files feeding the generation seat, read fail-soft (the
    composition works without them; on non-Node runtimes they just stay unset).
    Reads `node:fs` through the runtime built-in accessor so this module carries
    NO static Node import and still loads/bundles for edge/Worker targets. */
function dotVendoFile(name: string, root?: string): string | undefined {
  try {
    const proc = (globalThis as { process?: { getBuiltinModule?: (id: string) => unknown } }).process;
    const fs = proc?.getBuiltinModule?.("node:fs") as typeof import("node:fs") | undefined;
    if (fs === undefined) return undefined;
    return fs.readFileSync(`${root === undefined ? "." : root}/.vendo/${name}`, "utf8");
  } catch {
    return undefined;
  }
}

/** The compose-time project root for .vendo reads that happen LATER (the
    per-generation design-rules read): pinning it keeps a host that chdirs
    mid-run reading the same project every other .vendo input came from. */
function dotVendoRoot(): string | undefined {
  try {
    return (globalThis as { process?: { cwd?: () => string } }).process?.cwd?.();
  } catch {
    return undefined;
  }
}

/** Parse a theme surface body (from `.vendo/theme.json` or, when it later gains
    a cloud leg, the published doc). Malformed → undefined, same fail-soft
    stance as the rest of the .vendo readers. */
function parseVendoTheme(raw: string | undefined): VendoTheme | undefined {
  if (raw === undefined) return undefined;
  try {
    const parsed = vendoThemeSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** 06-apps §8 — load sync-captured host source into the composition. Invalid
    files are warned and skipped so one bad slot cannot crash the host; an
    absent directory is the normal zero-remixable-components case. */
function dotVendoPinBaselines(root?: string): PinBaseline[] {
  const proc = (globalThis as { process?: { getBuiltinModule?: (id: string) => unknown } }).process;
  const fs = proc?.getBuiltinModule?.("node:fs") as typeof import("node:fs") | undefined;
  if (fs === undefined) return [];
  const directory = `${root === undefined ? "." : root}/.vendo/remixable`;
  let names: string[];
  try {
    names = fs.readdirSync(directory).filter((name) => name.endsWith(".json")).sort();
  } catch (error) {
    if ((error as { code?: unknown }).code === "ENOENT") return [];
    console.warn(`[vendo] could not read ${directory}; pin baselines were skipped`);
    return [];
  }

  const baselines: PinBaseline[] = [];
  const slots = new Set<string>();
  for (const name of names) {
    const file = `${directory}/${name}`;
    try {
      const parsed = pinBaselineSchema.parse(JSON.parse(fs.readFileSync(file, "utf8")));
      if (slots.has(parsed.slot)) {
        console.warn(`[vendo] duplicate pin baseline slot ${parsed.slot} in ${file}; file was skipped`);
        continue;
      }
      slots.add(parsed.slot);
      baselines.push(parsed);
    } catch {
      console.warn(`[vendo] invalid pin baseline ${file}; file was skipped`);
    }
  }
  return baselines;
}

function relativePath(url: URL): string | null {
  if (url.pathname === BASE_PATH) return "/";
  if (!url.pathname.startsWith(`${BASE_PATH}/`)) return null;
  return url.pathname.slice(BASE_PATH.length);
}

/** 10-mcp §4-5 — the paths the door owns: its own mount (plus subpaths), and the
    FOUR exact origin-root discovery documents it serves — the RFC 9728/8414
    path-inserted metadata for its fixed mount, and the SEP-2127 server card. We
    match those four EXACTLY rather than claiming the whole `/.well-known/oauth-*`
    prefixes: a boundary-free prefix would shadow a host serving its own OAuth/
    OIDC metadata at the same origin (and would even swallow
    `/.well-known/oauth-protected-resourceX`). These are NOT wire routes — the
    door mints its own principals (§3), and the OAuth /token and /register
    endpoints are form-encoded POSTs — so they bypass the wire's principal/CSRF
    machinery. */
const DOOR_WELL_KNOWN_PATHS: ReadonlySet<string> = new Set([
  `/.well-known/oauth-protected-resource${MCP_MOUNT}`,
  `/.well-known/oauth-authorization-server${MCP_MOUNT}`,
  "/.well-known/mcp/server-card.json",
  "/.well-known/mcp-server-card",
]);

function isDoorPath(pathname: string): boolean {
  if (pathname === MCP_MOUNT || pathname.startsWith(`${MCP_MOUNT}/`)) return true;
  return DOOR_WELL_KNOWN_PATHS.has(pathname);
}

function jsonMutationRequired(request: Request, path: string): boolean {
  if (!["POST", "PUT", "PATCH", "DELETE"].includes(request.method)) return false;
  // /box/ is the app-token bearer surface (execution-v2 Lane C): no cookies,
  // no ambient credentials, curl-able from any language inside the box — so
  // the CSRF json gate doesn't apply; JSON-bodied box routes validate their
  // own content-type like the webhook surface does.
  if (path === "/apps/import" || path === "/tick" || path.startsWith("/webhooks/") || path.startsWith("/box/")) return false;
  return true;
}

function telemetryClient(enabled: boolean | undefined): Telemetry | undefined {
  if (enabled !== true) return undefined;
  try {
    return initTelemetry({ version: VERSION, runtime: true });
  } catch {
    return undefined;
  }
}

/** The wire route TABLE (kill-list B4): every route as (method, pattern,
    handler), assembled from the per-area modules under src/wire/. Entries are
    matched IN ORDER, preserving the old if-chain's precedence exactly:
    1. the dev-only injection seams (fall through in production),
    2. the doctor production gate + doctor probe routes,
    3. the machine surfaces — webhooks, tick, sync impact — all raw-path
       matches ahead of any segment decoding,
    4. the user surfaces: threads → approvals → connections → grants →
       the orgs cloud-required seam → apps → automations → runs →
       activity/status.
    A handler returning undefined falls through to later entries (grouped
    handlers keep the old chain's method/operation fall-out), and no match at
    all answers not-found. */
const wireRoutes: readonly RouteEntry[] = [
  ...devRoutes,
  ...doctorRoutes,
  ...systemRoutes,
  // execution-v2 Lane C: the box callback surface is a machine surface like
  // webhooks/tick — raw prefix match, bearer-authenticated, ahead of the user
  // surfaces; the fn proxy sits just before the grouped /apps arm so
  // /apps/:id/fn/:name resolves here, not through the grouped fall-through.
  ...boxRoutes,
  ...threadRoutes,
  ...approvalRoutes,
  ...connectionRoutes,
  ...grantRoutes,
  ...orgsRoutes,
  ...fnProxyRoutes,
  ...appRoutes,
  ...automationRoutes,
  ...runRoutes,
  ...activityRoutes,
  ...statusRoutes,
];

function createWireHandler(deps: WireDeps): (request: Request) => Promise<Response> {
  // Amortized on-request sweep bookkeeping — lives in the shared handler closure
  // (persists across requests), NOT per-invocation. The serverless-safe leg:
  // Next.js gives no timer guarantee, so every request may trigger the sweep.
  // Awaited BEFORE the request is handled (evict-on-expiry): a request arriving
  // past the TTL gets a fresh, empty session rather than racing its own sweep.
  // A sweep failure is caught and logged, never surfaced to the innocent
  // request that triggered it (same posture as the background timer leg) — a
  // failed sweep just means idle sessions live until the next interval.
  let lastSweepAt = deps.sessions.now();
  const maybeSweep = async (): Promise<void> => {
    if (!deps.sweepEnabled) return;
    const now = deps.sessions.now();
    if (now - lastSweepAt < deps.sessions.sweepIntervalMs) return;
    lastSweepAt = now;
    try {
      await deps.sweep();
    } catch (error) {
      console.warn(`[vendo] session sweep failed; will retry next interval: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  // LOAD-BEARING per-request ordering relative to routing (kill-list B4 kept
  // it byte-identical to the old chain):
  //   1. maybeSweep — awaited BEFORE anything (evict-on-expiry, above);
  //   2. the MCP door's paths — before relativePath's not-found AND the CSRF
  //      json-mutation gate (see the comment at the check);
  //   3. relativePath → not-found for non-wire paths;
  //   4. onRequestOrigin — a validated wire route teaches the same-origin
  //      baseUrl default;
  //   5. the CSRF json-mutation gate — before ANY route handler runs;
  //   6. await ready — schema before the first store touch;
  //   7. the route table (wireRoutes above; tick auth and the orgs seam are
  //      ordinary entries at their old chain positions; the anon-session
  //      touch happens inside each handler's context() call);
  //   8. no match → not-found;
  //   9. withAnonCookie at the single exit — the minted Set-Cookie rides
  //      every response shape (JSON, error, SSE/stream).
  return async (request) => {
    await maybeSweep();
    // Per-request anonymous-session state + the one shared context-resolution
    // pass (see wire/shared.ts). Both MUST be minted per-invocation — the
    // handler closure is shared across requests.
    const anon: AnonSession = {};
    const context = createContextResolver(deps, anon);

    const respond = async (): Promise<Response> => {
    try {
      const url = new URL(request.url);
      // 10-mcp: hand the door its own paths BEFORE any wire machinery. It runs
      // ahead of relativePath's not-found rejection (the origin-root discovery
      // documents fall outside BASE_PATH) and ahead of the CSRF json-mutation
      // gate (OAuth /token and /register are form-encoded POSTs, not JSON). The
      // door authenticates every request through oauth.principal (§3), so the
      // wire's principal resolver never runs for it — and, deliberately, these
      // requests do NOT teach the same-origin baseUrl default: only a request
      // addressing a real Vendo WIRE route may (04 §4), and the door's paths are
      // the door's, not wire routes.
      if (deps.door !== undefined && isDoorPath(url.pathname)) {
        await deps.ready();
        return await deps.door.handler(request);
      }
      const path = relativePath(url);
      if (path === null) throw new VendoError("not-found", "unknown Vendo route");
      // Learn the same-origin default only from a request that addresses a real
      // Vendo route (defense in depth beyond the untrusted-forwarding rule).
      deps.onRequestOrigin?.(url.origin);
      if (jsonMutationRequired(request, path) && !isJsonRequest(request)) {
        throw new VendoError("validation", "content-type must be application/json");
      }
      await deps.ready();

      // The per-request view the route table dispatches on (kill-list B4).
      // Segments decode lazily so raw-matched pre-routes (proxy, webhooks,
      // doctor) never decode — preserving the old chain's decode timing.
      let segmentsCache: string[] | undefined;
      const wire: WireContext = {
        request,
        url,
        path,
        get segments() {
          return (segmentsCache ??= routeSegments(path));
        },
        params: {},
        context: (venue) => context(request, venue),
        deps,
      };

      const routed = await dispatchRoutes(wireRoutes, wire);
      if (routed !== undefined) return routed;

      throw new VendoError("not-found", "unknown Vendo route");
    } catch (error) {
      if (error instanceof VendoError) return errorResponse(error);
      // The wire response stays generic (no internals leak to clients), but
      // the host operator gets the real failure on their own server log.
      console.error("[vendo] unhandled wire error:", error);
      return internalError();
    }
    };
    // Attach the anon Set-Cookie (if a session was minted this request) at the
    // single exit — covering JSON, error, and SSE/stream responses alike.
    return withAnonCookie(await respond(), anon.setCookie);
  };
}

/** 09-vendo §2 — compose every live block around the guard choke point. */
export function createVendo(config: CreateVendoConfig): Vendo {
  // 09-vendo §2.1 — one preset or the per-seam trio, never mixed. Checked
  // before anything is constructed so a miswired config leaks no resources.
  if (config.auth !== undefined) {
    const mixed = (["principal", "actAs", "oauth"] as const)
      .filter((key) => config[key] !== undefined);
    if (mixed.length > 0) {
      throw new VendoError(
        "validation",
        `createVendo({ auth }) already fills the principal, actAs, and oauth seams from one preset (09-vendo §2.1); remove ${mixed.map((key) => `\`${key}\``).join(", ")} or drop \`auth\` — one preset or the per-seam trio, never mixed.`,
      );
    }
  }
  // The three seams the identity story fills: from the preset, from the
  // per-seam trio, or — with neither `auth` nor `principal` — the anonymous
  // default resolver (every session ephemeral, 00 conventions "identity
  // optional" / 02-store §4). Absent preset halves leave their seams unset.
  const resolvePrincipal = config.auth?.principal ?? config.principal ?? (async () => null);
  const actAsSeam = config.auth === undefined ? config.actAs : config.auth.actAs;
  const oauthSeam = config.auth === undefined ? config.oauth : config.auth.oauth;
  // 02-store §4 (kill-list B3) — ephemeral session policy. Validated like the
  // agent's context config; defaults are the recommended knobs. The store takes
  // the clock per call (register/sweep), so one time source needs no seam.
  // Validated FIRST because the hosted session ops derive their touch-debounce
  // window from the sweep interval.
  const sessionsConfig = validateSessionsConfig(config.sessions);
  const sessionNow = sessionsConfig.now ?? Date.now;
  // Persistence, selected by the adapter rule at this composition seam
  // (selectStore above): explicit store → VENDO_API_KEY hosted store → the
  // local createStore default (02-store §4 re-derived: encryption is
  // production-owned — VENDO_STORE_ENCRYPTION_KEY encrypts at rest; without
  // it dev stores locally unencrypted while production secret writes fail
  // closed). The session doors travel with the store: SQL registry locally,
  // the store wire when hosted.
  // Touch-debounce window, clamped by BOTH knobs. INVARIANT: the window must
  // sit well inside the TTL, so continuous traffic always refreshes
  // touched_at before the sweep cutoff — with sweepIntervalMs/2 alone, a
  // ttlMs shorter than the sweep interval would let an actively-used
  // session's stamp go a full window stale, cross the cutoff, and the claim
  // leg would re-read that SAME stale stamp and erase a live session
  // mid-use. sweepIntervalMs/2 bounds the wire chatter; ttlMs/4 enforces the
  // safety margin. ttlMs 0 disables the sweep entirely (runSweep), so the
  // zero window it produces (every touch rides the wire) is merely
  // conservative, never wrong.
  const { store, sessions: sessionOps } = selectStore(
    config.store,
    Math.min(
      Math.floor(sessionsConfig.sweepIntervalMs / 2),
      Math.floor(sessionsConfig.ttlMs / 4),
    ),
  );
  const sandbox = selectSandbox(config.sandbox);
  // Secrets, selected by the adapter rule at this composition seam
  // (selectSecrets above): explicit provider → env chained over the
  // VENDO_API_KEY Cloud provider → env alone. Consumed by machine env
  // building and the apps block (redaction) below.
  const secrets = selectSecrets(config.secrets);
  // Inference, selected by the adapter rule at this composition seam
  // (resolveModels, models-config.ts) — the agent model the agent and apps
  // blocks consume, plus the composed paint knob (family fast pick when the
  // agent slot rides the ladder; the deprecated paint.model otherwise).
  const inference = resolveModels(config);
  // models.judge feeds the judge the host wired from vendoModel("vendo-judge"):
  // the model rides Judge.model, and composition binds THIS instance's config
  // onto exactly that model (bindVendoModelSlots — per createVendo instance,
  // no process-level registry). A custom judge without a model, or a judge
  // built on a BYO model object, is untouched — and there is NO judge default.
  bindVendoModelSlots(config.judge?.model, config.models);
  // cse lane 3 — the Cloud hosted-config adapter, selected at THIS composition
  // seam from VENDO_API_KEY (adapter rule: the surfaces themselves never read
  // the key; cloudKeyOptions lives only here). Constructing it is PURE (closures
  // only, no fetch). It is READ only from LAZY call sites — the block provider
  // seams (design-rules/theme/semantics/domains thunks, the brief resolver, the
  // guard policy fallback, the actions overrides injection) — never at compose,
  // so createVendo stays I/O-free at module init (portability-gate). The
  // snapshot warms on its first (cold) read and revalidates in the background,
  // so a host that resolves no cloud surface makes no config call at all.
  const configCloudOptions = cloudKeyOptions();
  const configCloud: CloudConfig | undefined =
    configCloudOptions === undefined ? undefined : cloudConfig(configCloudOptions);
  // The .vendo surface reader, bound to the pinned compose-time root so the
  // LATER lazy reads (per-generation, per-turn) see the same project every
  // other .vendo input came from (a host that chdirs mid-run). Task 15a: an
  // explicit profileDir wins over the process cwd, so every surface read
  // (theme, design-rules, overrides, brief, policy) resolves under the same
  // root the actions files came from.
  const surfaceRoot = config.profileDir ?? dotVendoRoot();
  const readSurfaceFile = (name: ConfigSurfaceName): string | undefined =>
    dotVendoFile(name, surfaceRoot);
  // Memoize the first DEFINED resolution of a BOOT-ONCE surface (theme,
  // overrides): the surface locks to its first resolved value and never
  // hot-reloads, yet a cold cloud snapshot (warming in the background) still
  // lets a later resolution lock the value in. LIVE surfaces
  // (design-rules/brief) skip this and re-resolve on every read.
  const memoizeOnce = <T>(resolve: () => T | undefined): (() => T | undefined) => {
    let cached: T | undefined;
    let locked = false;
    return () => {
      if (locked) return cached;
      const value = resolve();
      if (value !== undefined) {
        cached = value;
        locked = true;
      }
      return value;
    };
  };
  // Construction stays PURE — no I/O, no timers — because the common edge
  // wiring calls createVendo() at module init, where Workers forbids both
  // (Mohamed's field report: "Disallowed operation called within global
  // scope"). The first handler/emit touch starts schema readiness and the
  // background sweep together through this once-latch; on Node the first
  // request pays the same cost the old eager kick merely front-loaded.
  let startBackgroundSweep: () => void = () => undefined;
  let readyState: Promise<void> | undefined;
  const ready = (): Promise<void> => {
    if (readyState === undefined) {
      readyState = store.ensureSchema();
      // No unhandled rejection before a handler/emit awaits the latch.
      void readyState.catch(() => undefined);
      startBackgroundSweep();
    }
    return readyState;
  };
  let resolveAppToolRisk: AppsRuntime["agentToolRisk"] | undefined;
  // Task 15a: profile.policy is the parsed policy.json document held in
  // memory — the hosted try venue's demo policy, where the local venue
  // writes the file instead (cli/try/extract.ts). Precedence keeps the
  // sibling pieces' discipline: the longer-standing explicit `policy` knob
  // wins outright; otherwise the piece feeds the guard as inline rules +
  // directions (defaulted like an absent file key), which replace the
  // file/cloud legs entirely (inline wins with no merge — 00-overview
  // decision 19); an unset piece leaves the guard's own file/cloud reads
  // unchanged.
  const configPolicy: PolicyConfig | undefined = config.policy ?? (
    config.profile?.policy === undefined ? undefined : {
      rules: config.profile.policy.rules ?? [],
      directions: config.profile.policy.directions ?? [],
    }
  );
  const guard = createGuard({
    store,
    // The resolver is installed immediately after createApps below. Keeping the
    // hook in guard means chat/SSE and the MCP door reach the same decision.
    resolveRisk: (call, _descriptor, ctx) => resolveAppToolRisk?.(call, ctx),
    ...(configPolicy === undefined ? {} : { policy: configPolicy }),
    // cse lane 3 — a cloud policy.json body, consulted by the resolver STRICTLY
    // AFTER the local file and only within its existing opt-in path (decision
    // 3: no change for hosts that don't configure policy). Returns the cloud
    // value only when the surface is cloud-owned; a local file is handled by
    // the guard's own file read.
    ...(configCloud === undefined ? {} : {
      policyCloudFallback: (): string | undefined => {
        const resolved = selectConfigSurface("policy.json", { readFile: readSurfaceFile, cloud: configCloud });
        return resolved.owner === "cloud" ? resolved.value : undefined;
      },
    }),
    ...(config.judge === undefined ? {} : { judge: config.judge }),
  });
  let presentCredentialsWarningEmitted = false;
  const warnPresentCredentialsNotForwarded = async (event: {
    ctx: RunContext;
    tool: ToolDescriptor;
    reason: "untrusted-host-origin" | "cross-origin-binding";
  }): Promise<void> => {
    if (presentCredentialsWarningEmitted) return;
    presentCredentialsWarningEmitted = true;
    const action = event.reason === "untrusted-host-origin"
      ? "Set VENDO_BASE_URL to the host origin and restart the server."
      : "Keep present host authentication same-origin, or use actAs/connector authentication.";
    try {
      await guard.report({
        id: `aud_${globalThis.crypto.randomUUID()}`,
        at: new Date().toISOString(),
        kind: "tool-call",
        principal: event.ctx.principal,
        venue: event.ctx.venue,
        presence: event.ctx.presence,
        ...(event.ctx.appId === undefined ? {} : { appId: event.ctx.appId }),
        ...(event.ctx.trigger === undefined ? {} : { trigger: event.ctx.trigger }),
        tool: event.tool.name,
        detail: {
          warning: {
            code: "present-credentials-not-forwarded",
            reason: event.reason,
            action,
          },
        },
      });
    } catch (error) {
      // Let a later call retry the warning if the audit sink was temporarily down.
      presentCredentialsWarningEmitted = false;
      throw error;
    }
  };
  // createActions reads baseUrl from this object at execution time. An explicit
  // VENDO_BASE_URL is a trusted, operator-set origin (credentials forward to it).
  // When unset, the handler learns the wire's own origin from a validated
  // request so route bindings execute same-origin with zero configuration — but
  // that learned origin is UNTRUSTED (baseUrlTrusted:false), so a spoofed Host
  // can never turn it into a credential-exfiltration target (04 §4).
  const configuredBaseUrl = environment("VENDO_BASE_URL");
  // 09-vendo §2 (install-dx wave 1.1 — design decision 5): a literal
  // NODE_ENV check, deliberately independent of the broader `development`
  // flag below (which also honors an explicit config.development escape
  // hatch for source capture — unrelated to credential trust).
  const nodeEnv = environment("NODE_ENV");
  const isDevelopmentEnv = nodeEnv === "development";
  const isProductionEnv = nodeEnv === "production";
  // One condition arms BOTH the boot warning and the per-call fail-closed
  // policy below, so the console.error tests pin exactly what arms refusal.
  const baseUrlMissingInProduction = configuredBaseUrl === undefined && isProductionEnv;
  if (baseUrlMissingInProduction) {
    // Loud, once, at composition — never throws (a host that never makes a
    // present-mode host tool call must keep booting). The actual refusal
    // happens per-call below via untrustedOriginPolicy: "fail".
    console.error(
      "[vendo] VENDO_BASE_URL is not set in production. Present-mode host tool "
        + "calls that need to forward the caller's credentials will fail instead "
        + "of running unauthenticated. Set VENDO_BASE_URL to this deployment's "
        + "public origin and restart the server.",
    );
  }
  // Connectors seam (adapter rule): explicit array wins, VENDO_API_KEY
  // defaults the Cloud tools connector for a wholly unset slot.
  const resolvedConnectors = selectConnectors(config.connectors, config.connectorApps);
  // #557 — cloud overrides.json feeds the actions registry's tool ENABLEMENT
  // (disabled/audience), not only app-generation semantics/domains. The registry
  // resolves `config.overrides` ONCE through its memoized `loadHost`, and every
  // tool-serving path (descriptors/execute/search/surfaceMenu) awaits loadHost
  // before it exposes anything — so a cloud-disabled tool is NEVER live before
  // the override resolves. The provider below reads AUTHORITATIVELY via
  // configCloud.fetch() (awaited), NOT the cold stale-while-revalidate
  // snapshot: the whole point of the async design is that enablement resolves
  // before the first serve, so a cloud disable can never leak on a cold boot.
  // Precedence mirrors selectConfigSurface (file → cloud): a local
  // .vendo/overrides.json wins and is read by the registry itself (provider
  // returns undefined); only a cloud-OWNED surface triggers the fetch. This is
  // now safe at compose because `missSurface` below is deferred — nothing calls
  // actions.descriptors()/loadHost at module init, so no console fetch happens
  // in Workers global scope (portability-gate).
  const overridesEnablementProvider = async (): Promise<OverridesFile | undefined> => {
    // File-owned: let the registry read the local .vendo/overrides.json (which
    // also handles v1/legacy migration). No cloud fetch decides enablement.
    if (readSurfaceFile("overrides.json") !== undefined) return undefined;
    // Cloud-owned: AWAIT the authoritative read so enablement is resolved before
    // any tool is served (boot-once on the first request).
    let result: CloudConfigResult;
    try {
      result = await configCloud!.fetch();
    } catch (error) {
      // A flaky/unreachable console must not permanently brick the registry
      // (loadHost memoizes its result). Degrade to no cloud overrides this boot,
      // the same fail-open posture as the guard policy fallback; key/meter
      // problems still surface on the first real service call.
      console.warn(
        "[vendo] hosted overrides.json fetch failed; tool enablement falls back to the local file / none "
        + `this boot: ${error instanceof Error ? error.message : String(error)}`,
      );
      return undefined;
    }
    const body = result.config?.["overrides.json"];
    if (body === undefined) return undefined;
    try {
      return overridesFileSchema.parse(JSON.parse(body));
    } catch (error) {
      console.error(
        "[vendo] hosted overrides.json is malformed; ignoring it for tool enablement this boot: "
        + `${error instanceof Error ? error.message : String(error)}`,
      );
      return undefined;
    }
  };
  const actionsConfig: {
    dir: string;
    tools?: ExtractedTool[];
    // The in-memory try-surface doc (profile.overrides) OR the cloud
    // enablement provider (#557) ride the same registry seam — both resolve
    // through loadHost to the same disabled/audience enablement path.
    overrides?: OverridesFile | (() => Promise<OverridesFile | undefined>);
    connectors?: Connector[];
    actAs?: ActAs;
    serverActions?: Record<string, ServerActionHandler>;
    baseUrl?: string;
    baseUrlTrusted?: boolean;
    fetch?: typeof fetch;
    onPresentCredentialsNotForwarded: typeof warnPresentCredentialsNotForwarded;
    untrustedOriginPolicy?: "warn" | "fail";
    invokeTool?: ToolRegistry["execute"];
  } = {
    dir: config.profileDir ?? ".",
    // Task 15a — the in-memory actions pieces ride the registry's own config
    // inputs (tools/capabilities existed; overrides is the parallel input
    // added with this seam). Inside the registry each wins over its dir-read
    // file, so per-piece precedence needs no second path here.
    ...(config.profile?.tools === undefined ? {} : { tools: config.profile.tools }),
    // Overrides seam (#557 + Task 15a): an explicitly-passed in-memory
    // profile.overrides wins (adapter rule); otherwise a cloud-configured host
    // gets the enablement provider. Both flow through the registry's single
    // `overrides` seam to the same disabled/audience enablement resolution.
    ...(config.profile?.overrides !== undefined
      ? { overrides: config.profile.overrides }
      : configCloud === undefined
        ? {}
        : { overrides: overridesEnablementProvider }),
    ...(resolvedConnectors.length === 0 ? {} : { connectors: resolvedConnectors }),
    ...(actAsSeam === undefined ? {} : { actAs: actAsSeam }),
    ...(config.serverActions === undefined ? {} : { serverActions: config.serverActions }),
    // Try-surface seam: an explicitly passed fetch always wins (adapter rule).
    ...(config.fetch === undefined ? {} : { fetch: config.fetch }),
    ...(configuredBaseUrl === undefined ? {} : { baseUrl: configuredBaseUrl, baseUrlTrusted: true }),
    onPresentCredentialsNotForwarded: warnPresentCredentialsNotForwarded,
    // 09-vendo §2 install-dx wave 1.1: production refuses a present-mode call
    // it can't authenticate rather than quietly dropping the caller's
    // credentials. Dev/test keep today's warn-and-continue (dev never reaches
    // "untrusted-host-origin" at all — see onRequestOrigin below).
    ...(baseUrlMissingInProduction ? { untrustedOriginPolicy: "fail" as const } : {}),
  };
  const actions = createActions(actionsConfig);
  const doctor = {
    present(ctx: RunContext): Promise<ToolOutcome> {
      // The probe registries carry ONLY the probe tool — dir: undefined
      // stripped the file reads before Task 15a; the in-memory profile pieces
      // are stripped the same way so a profile override/compound can never
      // leak into a doctor probe.
      const probes = createActions({ ...actionsConfig, dir: undefined, overrides: undefined, tools: [doctorPresentTool] });
      return probes.execute({ id: "call_vendo_doctor_present", tool: doctorPresentTool.name, args: {} }, ctx);
    },
    actAs(): Promise<ToolOutcome> {
      const grant: PermissionGrant = {
        id: "grt_vendo_doctor_act_as",
        subject: DOCTOR_ACT_AS_PRINCIPAL.subject,
        tool: doctorActAsTool.name,
        descriptorHash: descriptorHash(doctorActAsTool),
        scope: { kind: "tool" },
        duration: "standing",
        appId: DOCTOR_ACT_AS_APP_ID,
        source: "automation",
        grantedAt: new Date().toISOString(),
      };
      const ctx: ActionsRunContext = {
        principal: DOCTOR_ACT_AS_PRINCIPAL,
        venue: "automation",
        presence: "away",
        sessionId: "session_vendo_doctor_act_as",
        appId: DOCTOR_ACT_AS_APP_ID,
        grant,
      };
      // Same probe isolation as doctor.present above.
      const probes = createActions({ ...actionsConfig, dir: undefined, overrides: undefined, tools: [doctorActAsTool] });
      return probes.execute({ id: "call_vendo_doctor_act_as", tool: doctorActAsTool.name, args: {} }, ctx);
    },
  };
  // Discovery-discipline 2026-07-25: the connect check wraps OUTSIDE
  // guard.bind, so a call to an unconnected brokered tool returns the
  // connect-required flow BEFORE any guard decision — no approval minted on
  // any door (chat, MCP, automations, compound steps, BYO resume).
  // `connections` and the toolkit cache are declared below this composition;
  // execution only happens after createVendo returns, so the closure
  // references are safe (same pattern as the connections loadout seed).
  const connectGate = createConnectGate({
    toolkitOf: (tool) => actions.connectorToolkit(tool),
    isConnected: (toolkit, ctx) => subjectHasToolkit(toolkit, ctx),
    // A gated call never reaches guard.bind's audit — the gate reports the
    // same tool-call event (with connectorAccount enrichment) itself.
    report: (event) => guard.report(event),
  });
  const boundTools = connectGate.bind(guard.bind(actions));
  // 04 §6: compound steps route through the guard binding — grants, approvals,
  // breakers, and audit see every real call; there is no second
  // execution path. createActions reads invokeTool at execution time (same
  // pattern as baseUrl above), so assigning after guard.bind is sound.
  actionsConfig.invokeTool = (call, ctx) => boundTools.execute(call, ctx);
  // Existing-agents Lane B — parked guarded calls with no Vendo thread: the
  // parking registry the BYO tool pack executes through (guardedTools below),
  // the resume-on-decide subscriber (same onApprovalDecision seam apps and
  // automations ride), the wire's per-approval read, and the TTL sweep leg.
  const byoApprovals = createByoApprovals({ guard, tools: boundTools, store });
  const parkedCallTtlMs = validateParkedCallTtl(config.approvals);
  // Theme surface (cse lane 3, boot-once/next-load STRUCTURAL): explicit config
  // wins; else the in-memory profile piece (Task 15a); else file → cloud. The
  // compose-time `theme` value (config/profile/file only, no cloud) still feeds
  // the wire and the system-prompt catalog summary — they read a value at
  // compose. The cloud-aware boot-once PROVIDER feeds app GENERATION through
  // the apps thunk seam so a console theme publish is honored on the next-load
  // lock without a compose-time fetch.
  const configTheme = config.theme ?? config.profile?.theme;
  const theme = configTheme ?? parseVendoTheme(readSurfaceFile("theme.json"));
  const themeProvider: () => VendoTheme | undefined = configTheme !== undefined
    ? () => configTheme
    : memoizeOnce(() => parseVendoTheme(selectConfigSurface("theme.json", { readFile: readSurfaceFile, cloud: configCloud }).value));
  // App design rules (spec 2026-07-20 + cse lane 3): explicit config wins;
  // otherwise a PER-GENERATION resolution — local file → cloud published value
  // → unset — so both file edits and a console publish apply to the next
  // create/edit without a restart (LIVE, re-resolved every generation).
  // Task 15a: profile.designRules is a convenience alias into this SAME seam —
  // a non-blank apps.designRules wins over it (the longer-standing knob), and
  // a non-blank value from either fixes the rules for the instance lifetime.
  const configDesignRules = config.apps?.designRules?.trim() || config.profile?.designRules?.trim();
  const designRules = configDesignRules
    ? configDesignRules
    : () => selectConfigSurface("design-rules.md", { readFile: readSurfaceFile, cloud: configCloud }).value;
  const pinBaselines = dotVendoPinBaselines(config.profileDir);
  // W3 + cse lane 3 — field semantics + domain manifest from the merged .vendo
  // pair (generated tools.json overlaid by overrides.json). The OVERRIDES
  // surface resolves file → cloud; tools.json stays a
  // local generation input (not a cloud surface). Resolved LIVE per generation
  // (NOT memoized) — the apps block's own "re-read per generation" contract:
  // memoizing would lock a local-only merge on a cold cloud snapshot (whenever a
  // local tools.json makes the first merge defined) and drop cloud-owned
  // overrides for the process lifetime (#557 review). A tools.json read +
  // JSON.parse per generation is negligible against generation cost. Malformed
  // → loud + absent, same stance as catalog.json. Task 15a: each in-memory
  // profile piece replaces its file/cloud leg of the merge, per piece.
  const hostSemanticsProvider = (): ReturnType<typeof mergedSemanticsAndDomains> => {
    const parsedFile = (name: string): unknown => {
      const raw = dotVendoFile(name, surfaceRoot);
      return raw === undefined ? undefined : JSON.parse(raw) as unknown;
    };
    const overridesRaw = config.profile?.overrides !== undefined
      ? undefined
      : selectConfigSurface("overrides.json", { readFile: readSurfaceFile, cloud: configCloud }).value;
    try {
      return mergedSemanticsAndDomains({
        tools: config.profile?.tools !== undefined
          ? { format: VENDO_TOOLS_FORMAT, tools: config.profile.tools }
          : parsedFile("tools.json"),
        overrides: config.profile?.overrides
          ?? (overridesRaw === undefined ? undefined : JSON.parse(overridesRaw) as unknown),
      });
    } catch (error) {
      console.error(`[vendo] Failed to load .vendo tool semantics: ${error instanceof Error ? error.message : String(error)}. Run "vendo sync" to regenerate .vendo/tools.json.`);
      return undefined;
    }
  };
  // Task 15a: an in-memory profile.catalog replaces the DISK leg of the merge
  // (it normalizes through the same validator-building path as the file
  // read); explicit createVendo({ catalog }) registrations still win by name.
  const catalog = mergeRuntimeCatalog(
    config.profile?.catalog !== undefined
      ? runtimeCatalogFromFile(config.profile.catalog)
      : runtimeCatalogFromJson(dotVendoFile("catalog.json", config.profileDir)),
    normalizeCatalogConfig(config.catalog),
  );
  // execution-v2 Lane C — the per-app box bearer store (hash rows are the
  // authority) shared by the machine-env assembler below (mint at provision)
  // and the wire's /box verification.
  const appTokens = createAppTokens(store);
  // The box env assembler the machine lifecycle calls at provision: rotate the
  // app token, compose the callback doors from the operator-set public origin
  // (the wire lives under it at BASE_PATH), and inject granted secrets — the
  // apps runtime resolves the app's active grants and passes them here (Lane
  // E), so only declared ∩ granted secret values enter the box. A BYO model
  // key is just such a secret: declare it, grant it, and it rides the same
  // injection path as any other key.
  // execution-v2 Wave 3 — the box's inference door (the in-box coding agent's
  // model). Explicit VENDO_INFERENCE_URL/KEY win; otherwise the BYO Anthropic
  // key rides api.anthropic.com; otherwise VENDO_API_KEY rides the console's
  // Anthropic-compatible model gateway — the same key that provisions the
  // Cloud machine funds its model (chat inference already does, via vendoModel's
  // vendo-cloud rung; a machine without this rung fails every in-box task).
  const boxInference = (): { url: string; key: string; model?: string } | undefined => {
    const url = environment("VENDO_INFERENCE_URL");
    const key = environment("VENDO_INFERENCE_KEY");
    const model = environment("VENDO_INFERENCE_MODEL");
    if (url !== undefined && key !== undefined) {
      return { url, key, ...(model === undefined ? {} : { model }) };
    }
    const anthropic = environment("ANTHROPIC_API_KEY");
    if (anthropic !== undefined) {
      return { url: "https://api.anthropic.com", key: anthropic, ...(model === undefined ? {} : { model }) };
    }
    const cloud = cloudKeyOptions();
    if (cloud !== undefined) {
      // The gateway base mirrors vendoModel's vendo-cloud rung: `<console>/api/v1`.
      const base = (cloud.baseUrl ?? "https://console.vendo.run").replace(/\/+$/, "");
      // The gateway serves the vendo model family as literal ids (`vendo` is
      // the flagship); the box harness's own default is a raw claude-* id the
      // gateway would grace-remap, so pin the family name unless the operator
      // chose a model via VENDO_INFERENCE_MODEL.
      return {
        url: base.endsWith("/api/v1") ? base : `${base}/api/v1`,
        key: cloud.apiKey,
        model: model ?? "vendo",
      };
    }
    return undefined;
  };
  const machineEnv = async (
    app: AppDocument,
    grants?: { grantedSecrets: ReadonlySet<string> },
  ): Promise<Record<string, string>> => {
    const record = await store.records("vendo_apps").get(app.id);
    const subject = record?.refs?.["subject"];
    if (typeof subject !== "string") {
      throw new VendoError("not-found", `app not found: ${app.id}`);
    }
    if (configuredBaseUrl === undefined) {
      throw new VendoError(
        "validation",
        "machine provisioning requires VENDO_BASE_URL — the box's callback URLs must be this deployment's public origin",
      );
    }
    const boxBase = `${configuredBaseUrl.replace(/\/+$/, "")}${BASE_PATH}/box`;
    const inferenceEndpoint = boxInference();
    const built = await buildEnv(app, {
      granted: grants?.grantedSecrets ?? new Set<string>(),
      secrets,
      storeUrl: boxBase,
      hostUrl: boxBase,
      appToken: await appTokens.mint(app.id, subject),
      // The in-box agent's model door (box-env sets VENDO_INFERENCE_URL/KEY).
      ...(inferenceEndpoint === undefined ? {} : { inference: async () => ({ url: inferenceEndpoint.url, key: inferenceEndpoint.key }) }),
    });
    // Pass the box's model choice through as a plain env var the harness reads.
    if (inferenceEndpoint?.model !== undefined) built.env["VENDO_INFERENCE_MODEL"] = inferenceEndpoint.model;
    return built.env;
  };
  // Lane E — the implicit skin domains for the machine egress allowlist: the
  // box must always reach its own boundary (store + host-callback surface on
  // the deployment origin, and — Wave 3 — the inference endpoint host), never
  // subject to declaration or approval. Assembled here because this file owns
  // the same URLs it injects as VENDO_STORE_URL / VENDO_HOST_URL / inference.
  const implicitMachineDomains = (): string[] => {
    const domains = new Set<string>();
    const add = (value: string | undefined): void => {
      if (value === undefined) return;
      try { domains.add(new URL(value).hostname); } catch { /* not a URL */ }
    };
    add(configuredBaseUrl);
    add(boxInference()?.url);
    return [...domains];
  };
  const boxTemplate = environment("VENDO_BOX_TEMPLATE");
  const boxEditTimeoutMs = positiveIntegerEnv("VENDO_BOX_EDIT_TIMEOUT_MS");
  const boxEditPollMs = positiveIntegerEnv("VENDO_BOX_EDIT_POLL_MS");
  // ADAPTER RULE, share/publish seam: the apps block never reads the
  // environment — VENDO_API_KEY fills its CloudAppsClient slot HERE, at the
  // composition seam; unfilled, share/publish refuse with cloud-required.
  const appsCloud = cloudKeyOptions();
  // Wave 9 — the arming seam for ladder-authored automations: filled with the
  // automations engine composed BELOW (arming only happens inside requests,
  // which run after createVendo returns, so the closure reference is safe —
  // same pattern as the connections loadout seed).
  let automationsForArming: AutomationsEngine | undefined;
  const apps = createApps({
    store,
    guard,
    tools: boundTools,
    model: inference.agent.model,
    catalog,
    pinBaselines,
    // execution-v2 Waves 4+9 — the layer-2/3 experimental opt-ins, host-config
    // only (never an env var: enabling machine-backed execution or a surface
    // that runs generated web apps is a deliberate per-project decision).
    ...(config.apps?.experimentalServedApps === undefined ? {} : { experimentalServedApps: config.apps.experimentalServedApps }),
    ...(config.apps?.experimentalMachines === undefined ? {} : { experimentalMachines: config.apps.experimentalMachines }),
    // Wave 9 — a ladder-authored automation is armed through the automations
    // engine's own enable(), so the 07 §3 grant-capture flow runs at creation
    // and the missing standing-grant approvals surface on the edit result.
    armAutomation: async (appId, armCtx) => {
      if (automationsForArming === undefined) {
        throw new VendoError("not-implemented", "the automations engine is not composed yet");
      }
      return automationsForArming.enable(appId, armCtx);
    },
    // Paint invisibility (models spec 2026-07-22): the composed knob — the
    // family fast pick when the agent slot rides the ladder, the deprecated
    // paint.model otherwise; paint.disabled survives as the one-lane switch.
    ...(inference.paint === undefined ? {} : { paint: inference.paint }),
    ...(config.apps?.pipeline === undefined ? {} : { pipeline: config.apps.pipeline }),
    // cse lane 3 — theme/semantics/domains flow as PROVIDER thunks so a
    // cloud-owned surface applies without a compose-time fetch. semantics/domains
    // resolve live per generation (pick up cloud overrides as the snapshot warms);
    // theme is boot-once via memoizeOnce (structural, next-load). Each returns
    // undefined when unset, which the engine treats exactly as an omitted value.
    theme: themeProvider,
    designRules,
    ...(appsCloud === undefined ? {} : { cloud: cloudApps(appsCloud) }),
    semantics: () => hostSemanticsProvider()?.semantics,
    domains: () => hostSemanticsProvider()?.domains,
    // Re-gate 2026-07-26 finding 2 — the create-time shape sampler skips
    // connector tools whose toolkit is not connected for the caller. Backed by
    // the same connections lookup (and per-subject cache) the agent's
    // connected-toolkit loadout seed rides; `connectedToolkitsFor` is a
    // hoisted function declaration defined next to that seed below.
    connectedToolkits: (toolkitCtx) => connectedToolkitsFor(toolkitCtx),
    secrets,
    // execution-v2 — the machine lifecycle's seams: the selected v2 adapter
    // (every provider speaks the canonical seam since the Wave 5 Cloud port)
    // and Lane C's env assembly. The box template (Node + the in-box agent
    // harness) is set by VENDO_BOX_TEMPLATE.
    machine: {
      ...(sandbox.adapter === undefined ? {} : { sandbox: sandbox.adapter }),
      buildEnv: machineEnv,
      implicitDomains: implicitMachineDomains(),
      ...(boxTemplate === undefined ? {} : { template: boxTemplate }),
      // The in-box agent edit is a minutes-long loop; operators tune its
      // long-poll budget when a base image or task needs longer than the
      // 8-minute default.
      ...(boxEditTimeoutMs === undefined ? {} : { boxEditTimeoutMs }),
      ...(boxEditPollMs === undefined ? {} : { boxEditPollMs }),
    },
  });
  resolveAppToolRisk = apps.agentToolRisk;
  actions.add(apps.agentTools());
  // Knowledge K1 — the tool exists exactly when an adapter is configured;
  // no adapter, no `vendo_knowledge_search` in any descriptor surface.
  const knowledge = selectKnowledge(config.knowledge, store);
  // K14 — the calibrated band + verifier ride exactly the engine they were
  // calibrated against (the Cloud default); a host-passed adapter keeps the
  // uncalibrated defaults it has today.
  if (knowledge !== undefined) {
    actions.add(createKnowledgeTools(knowledge, knowledgeToolOptions(config.knowledge !== undefined, config.models)));
  }
  // Knowledge k8 (ENG-368) — the prompt index rides exactly when the tool
  // composes. Byte-stable at a fixed sync state, refreshed when the sync
  // manifest changes (never rebuilt per-turn); knowledge.json is an
  // ingestion input, not a config surface, so it reads through the raw
  // fail-soft reader like catalog.json.
  const knowledgeIndex = knowledge === undefined
    ? undefined
    : knowledgeIndexResolver(knowledge, {
        readConfig: () => dotVendoFile("knowledge.json", surfaceRoot),
        readManifest: () => dotVendoFile("knowledge-manifest.json", surfaceRoot),
      });
  // #557 — the capability-miss surface is DEFERRED to first use behind a
  // memoized promise. Building it eagerly at compose would call
  // actions.descriptors() → loadHost → the cloud overrides fetch at module
  // init, which Workers forbids in global scope (portability-gate). It resolves
  // ONCE, on the first capability-miss upload or detector report — the same
  // boot-once posture as the enablement provider it now shares loadHost with.
  // (The zero-live-tools warning, emitted inside loadHost, therefore fires on
  // that first request rather than at compose.)
  let missSurfacePromise: Promise<CapabilitySurfaceSnapshot> | undefined;
  const missSurface = (): Promise<CapabilitySurfaceSnapshot> =>
    (missSurfacePromise ??= actions.descriptors()
      .then(capabilitySurfaceSnapshot)
      .catch(() => capabilitySurfaceSnapshot([])));
  // ADAPTER RULE, miss-upload seam: capability-misses.ts never reads the
  // environment for its Cloud uploader — VENDO_API_KEY fills the slot HERE,
  // like the share/publish seam above; unfilled, misses stay local-only.
  const missCloud = cloudKeyOptions();
  const missCapture = createCapabilityMissCapture({
    surface: missSurface,
    ...(missCloud === undefined ? {} : { cloud: missCloud }),
  });
  // AGENT-1/2 — 03 §3: the host product brief (init writes .vendo/brief.md)
  // and the catalog+theme summary feed the system prompt; prompt.ts places
  // them (brief = Product section; summary only where trees render).
  // cse lane 3 — brief is a prompt-family surface, so it resolves LIVE: with a
  // key present, product is a RESOLVER (file → cloud) re-read per turn by
  // assembleSystemPrompt, so a console publish applies to the next turn with no
  // restart. Without a key, product is the compose-time file/explicit value (no
  // snapshot read → no I/O at compose). A programmatic `brief` wins over the
  // file either way. Task 15a: the in-memory profile.brief sits between them —
  // below the explicit `brief` knob, above the file/cloud surface — and an
  // explicitly empty one means "no brief" (it never falls through to disk).
  const resolveBrief = (cloud?: CloudConfig): string | undefined => {
    const explicit = config.brief?.trim();
    if (explicit) return explicit;
    if (config.profile?.brief !== undefined) return config.profile.brief.trim() || undefined;
    return selectConfigSurface("brief.md", {
      readFile: readSurfaceFile,
      ...(cloud === undefined ? {} : { cloud }),
    }).value?.trim() || undefined;
  };
  const product: string | (() => string | undefined) | undefined = configCloud === undefined
    ? resolveBrief()
    : () => resolveBrief(configCloud);
  const promptCatalog = catalogThemeSummary(catalog, theme);
  const hostInstructions = config.agent?.instructions?.trim();
  const system = product !== undefined || hostInstructions || promptCatalog !== undefined || knowledgeIndex !== undefined
    ? {
        ...(product === undefined ? {} : { product }),
        ...(promptCatalog === undefined ? {} : { catalog: promptCatalog }),
        ...(knowledgeIndex === undefined ? {} : { knowledge: knowledgeIndex }),
        ...(hostInstructions ? { instructions: hostInstructions } : {}),
      }
    : undefined;
  const agent = createAgent({
    model: inference.agent.model,
    tools: boundTools,
    guard,
    store,
    ...(system === undefined ? {} : { system }),
    context: {
      toolOutputCap: config.agent?.toolOutputCap ?? DEFAULT_TOOL_OUTPUT_CAP,
      ...(config.agent?.maxOutputTokens === undefined ? {} : { maxOutputTokens: config.agent.maxOutputTokens }),
      ...(config.agent?.historyWindow === undefined ? {} : { historyWindow: config.agent.historyWindow }),
      ...(config.agent?.maxSteps === undefined ? {} : { maxSteps: config.agent.maxSteps }),
    },
    capabilityMiss: {
      hostId: missCapture.hostId,
      surface: () => missSurface().then(({ hash }) => ({ format: "vendo/tools@1" as const, hash })),
      emit: (event) => missCapture.record(event),
    },
    // ENG-252: the agent starts with a bounded loadout and discovers the rest via
    // `vendo_tools_search`. The search seam is the SAME guard-bound registry the
    // agent executes through — a searched-in tool has no unguarded path.
    toolSearch: {
      // A curated agent menu has to hold at BOTH doors into the toolset: the
      // per-turn seed below and search, which materializes hits into the live
      // toolset mid-turn. Filtering only the seed would let the model search
      // its way back to an off-menu tool. The expansion cap (discovery
      // discipline) rides the same call: it bounds how many lazy toolkits one
      // query may pull in before the menu filter runs.
      search: async (query, options) => onAgentMenu(
        await actions.search(query, {
          ...options,
          ...(config.agent?.maxSearchExpansions === undefined ? {} : { maxExpansions: config.agent.maxSearchExpansions }),
        }),
        (match) => match.name,
      ),
      // Connection-scoped loadout seed (spec 2026-07-20): each turn starts
      // with host tools + the principal's connected toolkits — never an
      // alphabetical slice of a lazy catalog. `connections` is declared below
      // this composition; turns only run after createVendo returns, so the
      // closure reference is safe.
      seed: (ctx) => loadoutSeedFor(ctx),
      // The curated agent menu also binds an explicit `agent.loadout`: host
      // config chooses WITHIN the menu, it does not escape it.
      menu: async () => {
        const menu = await agentMenu();
        return menu === undefined ? undefined : [...menu];
      },
      ...(config.agent?.maxInitialTools === undefined ? {} : { maxInitialTools: config.agent.maxInitialTools }),
      ...(config.agent?.loadout === undefined ? {} : { loadout: config.agent.loadout }),
    },
    // Discovery-discipline: the same connect check the gate-wrapped registry
    // runs, exposed so needsApproval never mints an approval for a call the
    // gate will refuse with a connect card.
    preflight: (call, ctx) => connectGate.check(call, ctx),
  });
  // Per-subject connected-toolkit lookups are cached briefly so a turn never
  // pays a broker round-trip it doesn't need; failures degrade to host tools
  // only (warn, never the turn). Bounded so long-lived deployments don't grow.
  // Shared by the loadout seed AND the pre-guard connect gate above.
  const CONNECTED_TOOLKITS_TTL_MS = 60_000;
  const connectedToolkitsCache = new Map<string, { at: number; toolkits: string[] }>();
  // `surfaces.agent` (.vendo/overrides.json): the host's curated agent menu.
  // Enforced HERE, at the composition seam, and not inside the registry —
  // `actions.descriptors()` is also what the MCP door and the host's own code
  // read, and those surfaces have their own menus. Successes are cached for the
  // process (a menu is boot config); failures are warned and never cached (see
  // memoizedSurfaceMenu).
  const agentMenu = memoizedSurfaceMenu(() => actions.surfaceMenu("agent"));
  /** Keep only entries the agent menu offers. Vendo's OWN `vendo_*` runtime
   *  tools are never curated away: surfaces curate a product's API surface, not
   *  the runtime's plumbing (gating `vendo_apps_*` or `vendo_tools_search` out
   *  would break the product, not trim it). */
  async function onAgentMenu<T>(entries: T[], nameOf: (entry: T) => string): Promise<T[]> {
    const menu = await agentMenu();
    if (menu === undefined) return entries;
    return entries.filter((entry) => {
      const name = nameOf(entry);
      return name.startsWith(VENDO_TOOL_PACK_PREFIX) || menu.has(name);
    });
  }
  function cacheConnectedToolkits(subject: string, toolkits: string[]): void {
    if (connectedToolkitsCache.size > 1_000) connectedToolkitsCache.clear();
    connectedToolkitsCache.set(subject, { at: Date.now(), toolkits });
  }
  function cachedConnectedToolkits(subject: string): string[] | undefined {
    const cached = connectedToolkitsCache.get(subject);
    return cached !== undefined && Date.now() - cached.at < CONNECTED_TOOLKITS_TTL_MS
      ? cached.toolkits
      : undefined;
  }
  async function fetchConnectedToolkits(principal: Principal): Promise<string[]> {
    const accounts = await connections.list(principal);
    const toolkits = [...new Set(accounts.filter((account) => account.status === "active").map((account) => account.toolkit))];
    cacheConnectedToolkits(principal.subject, toolkits);
    return toolkits;
  }
  /** The connect gate's lookup. A cached HIT rules the call in without a
      round-trip; a cached MISS refetches fresh before ruling it out — a user
      who just finished OAuth must never be blocked by a 60s-old entry.
      Lookup failure returns undefined: the gate fails OPEN and the
      broker-side connect-required outcome still catches the call. */
  async function subjectHasToolkit(toolkit: string, ctx: RunContext): Promise<boolean | undefined> {
    if (cachedConnectedToolkits(ctx.principal.subject)?.includes(toolkit)) return true;
    try {
      return (await fetchConnectedToolkits(ctx.principal)).includes(toolkit);
    } catch {
      return undefined;
    }
  }
  // Hoisted (function declaration): the apps composition above references it
  // as the AppsConfig.connectedToolkits seam; `connections` is declared below
  // and only read at request time (same pattern as loadoutSeedFor). Built on
  // the discovery-lane cache primitives: cached hit serves, miss fetches and
  // caches; lookup failure degrades to "no connected toolkits" this call.
  async function connectedToolkitsFor(ctx: RunContext): Promise<string[]> {
    const cached = cachedConnectedToolkits(ctx.principal.subject);
    if (cached !== undefined) return cached;
    try {
      return await fetchConnectedToolkits(ctx.principal);
    } catch (error) {
      console.warn(
        "[vendo] connected-toolkits lookup failed; treating every toolkit as unconnected:",
        error instanceof Error ? error.message : error,
      );
      const toolkits: string[] = [];
      cacheConnectedToolkits(ctx.principal.subject, toolkits);
      return toolkits;
    }
  }
  async function loadoutSeedFor(ctx: RunContext): Promise<string[]> {
    const toolkits = await connectedToolkitsFor(ctx);
    return onAgentMenu(await actions.loadoutSeed(toolkits), (name) => name);
  }
  // 02-store §4 (kill-list B3) TTL sweep: erase every idle ephemeral session's
  // disk rows, then cascade each swept subject into the agent's in-memory
  // threads (store-first — a concurrent request then fails closed at the store
  // rather than finding threads without store state). Disabled when ttlMs is 0.
  const runSweep = async (): Promise<void> => {
    // Existing-agents Lane B — expire orphaned parked BYO calls on the same
    // cadence (deny path, idempotent); disabled by parkedCallTtlMs 0.
    if (parkedCallTtlMs > 0) {
      await byoApprovals.sweepExpired(parkedCallTtlMs, sessionNow());
      // Spec 2026-07-20 (#5): the same backstop over the general approvals
      // collection. Chat approvals are abandoned on the next thread turn and
      // BYO parked calls swept above, but away/automation/app approvals and
      // approvals stranded by a mid-stream turn failure have no resuming turn —
      // this TTL sweep denies them (idempotent) so the queue self-heals instead
      // of piling up. Shares the parked-call TTL; disabled by the same 0.
      if (guard.sweepExpiredApprovals !== undefined) {
        try {
          await guard.sweepExpiredApprovals(parkedCallTtlMs, sessionNow());
        } catch (error) {
          console.error("[vendo] approval TTL sweep failed", {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
    if (sessionsConfig.ttlMs <= 0) return;
    for (const subject of await sessionOps.sweep(sessionsConfig.ttlMs, sessionNow())) {
      agent.evictSubject(subject);
    }
  };
  const sweepEnabled = sessionsConfig.ttlMs > 0 || parkedCallTtlMs > 0;
  // Long-lived hosts also get a background sweep on an UNREF'd timer (automations
  // engine pattern) so an idle process still reclaims sessions with no traffic;
  // unref'd means it never keeps the event loop alive. Torn down with the store.
  if (sweepEnabled) {
    // Armed by the ready() latch above, NOT at construction: timers are
    // illegal in Workers global scope, and a process that never serves a
    // request has nothing to sweep.
    startBackgroundSweep = (): void => {
      const sweepTimer = setInterval(() => {
        runSweep().catch((error: unknown) => {
          console.warn(`[vendo] session sweep failed; will retry next interval: ${error instanceof Error ? error.message : String(error)}`);
        });
      }, sessionsConfig.sweepIntervalMs);
      (sweepTimer as unknown as { unref?: () => void }).unref?.();
      const closeStore = store.close.bind(store);
      store.close = async (): Promise<void> => {
        clearInterval(sweepTimer);
        await closeStore();
      };
    };
  }
  // Wave 2 (Cloud auto): a keyed deployment's schedule- and external-triggered
  // automations already run on Vendo Cloud — its scheduler fires due schedules and
  // Composio delivers external events straight to Cloud. If this LOCAL engine also
  // fired them, a keyed deployment would double-run every automation. Under the hosted
  // store, Cloud is the firing authority for those two kinds; host-event automations
  // (vendo.emit) are untouched — they're invoked directly by this host process, not
  // scheduled or delivered, so there's nothing for Cloud to duplicate. One warn per
  // composition (not per tick), same posture as hostedSessionOps' door warn above.
  const hostedStoreComposed = isHostedStore(store);
  if (hostedStoreComposed) {
    console.warn(
      "[vendo] Vendo Cloud is the hosted store for this deployment: schedule and external-trigger "
      + "automations are Cloud's job (its scheduler and Composio delivery already fire them for this "
      + "deployment) — the local automations engine will not fire them itself, to avoid double-running "
      + "them. Host-event automations (vendo.emit) are unaffected.",
    );
  }
  const automations = createAutomations({
    apps,
    tools: boundTools,
    guard,
    store,
    runner: agent.asRunner(),
    ...(hostedStoreComposed ? { localTriggerKinds: new Set<"schedule" | "external">() } : {}),
  });
  automationsForArming = automations;
  // 04-actions §3 — per-principal connected accounts, selected by the adapter
  // rule at this composition seam (selectConnections above).
  //
  // Disconnect INVALIDATES the subject's connected-toolkit cache. Without
  // this, the 60s TTL keeps answering "connected" for up to a minute after
  // the user disconnects, so the connect gate waves the call through, the
  // guard mints an approval, and the user is asked to approve a call that
  // cannot run — the exact failure the gate exists to prevent, inverted. The
  // wrapper sits at the composition seam (never inside an adapter), so it
  // holds for every posture: BYO brokers and the Cloud adapter alike.
  //
  // `selectedConnections` is what the adapter rule chose and is what
  // `vendo.connections` exposes, UNTOUCHED — an explicitly passed adapter must
  // stay the very object the host handed in (server.test.ts asserts identity).
  // Everything the product itself calls (the wire's DELETE route, the loadout
  // seed, the connect gate) goes through the invalidating wrapper instead.
  // Out-of-band revocation — a host calling the adapter directly, or a user
  // revoking in the provider's own dashboard — stays bounded by the 60s TTL,
  // which no cache can improve on.
  const selectedConnections = selectConnections(config.connections, resolvedConnectors, config.connectorApps);
  const connections = withDisconnectInvalidation(
    selectedConnections,
    (subject) => connectedToolkitsCache.delete(subject),
  );
  // 10-mcp §1 — construct the door from the parts already assembled: the SAME
  // guard-bound registry chat/apps/automations use, the guard (its core seam is
  // what the door holds for auth audit), the store (a StoreAdapter for the door's
  // own protocol state), the host's oauth seam, and an AppsPort view of `apps`.
  // `mcp: true` and `mcp: {…}` both open the door; the object form carries
  // door options (an explicit `baseUrl` overrides the VENDO_BASE_URL default).
  const mcpOptions = typeof config.mcp === "object" && config.mcp !== null
    ? config.mcp
    : config.mcp === true
      ? {}
      : undefined;
  let door: McpDoor | undefined;
  if (mcpOptions !== undefined) {
    if (oauthSeam === undefined) {
      throw new VendoError(
        "validation",
        "createVendo({ mcp: true }) requires a HostOAuthAdapter (10-mcp §3) — from `oauth` or an `auth` preset carrying one: the door mints door principals through it and cannot open without one.",
      );
    }
    // AppsRuntime.open adds a "resuming" variant AppsPort (tree | http) does not
    // carry. The door is a viewer + runner (10-mcp §4), so a server app still
    // waking up has no surface to hand back over MCP — signal it as an in-band
    // tool error (the door catches VendoError and preserves the code).
    const appsPort: AppsPort = {
      list: (ctx) => apps.list(ctx),
      async open(appId, ctx) {
        const opened = await apps.open(appId, ctx);
        if (opened.kind === "tree") return { kind: "tree", payload: opened.payload };
        if (opened.kind === "http") return { kind: "http", url: opened.url };
        throw new VendoError(
          "not-implemented",
          "This is a server app resuming in-product; open it in the host to use it over MCP.",
        );
      },
      call: (appId, ref, args, ctx) => apps.call(appId, ref, args, ctx),
    };
    // 10-mcp §5 — pin the door's canonical mount so a cold umbrella's server
    // card advertises the right transport URL (BASE_PATH/mcp) before any request
    // teaches it, and learned paths never override it. The door's canonical
    // public base (discovery origins + RFC 8707 audience) is the operator-set
    // VENDO_BASE_URL — behind a reverse proxy the request URL carries the
    // proxy-INTERNAL origin and must not shape what discovery advertises
    // (ENG-333). An explicit `mcp.baseUrl` overrides the env default for
    // compositions whose door origin differs from the route-binding origin.
    const doorBaseUrl = mcpOptions.baseUrl ?? configuredBaseUrl;
    door = createMcpDoor({
      tools: boundTools,
      guard,
      store,
      oauth: oauthSeam,
      apps: appsPort,
      // The host's curated door menu (`surfaces.mcp`). Passed as a provider
      // because composition is sync and resolving the authored file is not; the
      // door resolves it once. The DOOR never reads `.vendo` itself — block
      // layering keeps mcp off actions, so the file stays the umbrella's to
      // read and the wire stays the door's to shape.
      menuTools: () => actions.surfaceMenu("mcp"),
      mount: MCP_MOUNT,
      ...(doorBaseUrl === undefined ? {} : { baseUrl: doorBaseUrl }),
      // 10-mcp §3.1/§3.2 — broker-fronted compositions: trust the external
      // authorization server's tokens and answer its login federation.
      ...(mcpOptions.remoteAs === undefined ? {} : { remoteAs: mcpOptions.remoteAs }),
      ...(mcpOptions.federation === undefined ? {} : { federation: mcpOptions.federation }),
      ...(theme === undefined ? {} : { theme }),
    });
  }
  // Minted on first request via the deps getter below — Workers forbids
  // generating random values in global scope, and createVendo runs at module
  // init in the edge wiring. Still one fallback id per process.
  let processSessionId: string | undefined;
  const sessionId = (): string => (processSessionId ??= `session_${globalThis.crypto.randomUUID()}`);
  // Anonymous principals are minted per-CLIENT in the handler (opaque cookie
  // pointer; the store's vendo_sessions row is the authority — kill-list B3).
  // An https VENDO_BASE_URL means TLS terminates at a trusted proxy and requests
  // arrive here as http — anon cookies must still be Secure/__Host- then.
  const trustedBaseIsHttps = ((): boolean => {
    if (configuredBaseUrl === undefined) return false;
    try {
      return new URL(configuredBaseUrl).protocol === "https:";
    } catch {
      return false;
    }
  })();
  const development = config.development !== undefined
    ? config.development !== false
    : isDevelopmentEnv;
  // profileDir fills the capture-root default (its out then derives under it);
  // an explicit development.root/out always wins.
  const developmentPaths = {
    ...(config.profileDir === undefined ? {} : { root: config.profileDir }),
    ...(typeof config.development === "object" ? config.development : {}),
  };
  const runtimeCapture = development ? createRuntimeCapture(developmentPaths) : null;
  const handler = createWireHandler({
    principal: resolvePrincipal,
    ready,
    trustedBaseIsHttps,
    get sessionId() { return sessionId(); },
    store,
    telemetry: telemetryClient(config.telemetry),
    agent,
    guard,
    apps,
    // execution-v2 Lane C — the /box surfaces: tool calls through the SAME
    // guard binding, bearer verification over the composed store.
    tools: boundTools,
    appTokens,
    automations,
    byoApprovals,
    connections,
    sandbox: sandbox.venue,
    model: inference.agent.venue,
    doctor,
    mcp: mcpOptions !== undefined,
    development,
    sessions: {
      ttlMs: sessionsConfig.ttlMs,
      sweepIntervalMs: sessionsConfig.sweepIntervalMs,
      now: sessionNow,
    },
    sessionStore: sessionOps,
    sweep: runSweep,
    sweepEnabled,
    ...(door === undefined ? {} : { door }),
    ...(runtimeCapture === null ? {} : { runtimeCapture }),
    onRequestOrigin: (origin) => {
      // Same-origin default for route-binding execution (04): no VENDO_BASE_URL
      // → the wire's own origin, learned from the first VALIDATED request and
      // then fixed.
      if (actionsConfig.baseUrl === undefined) {
        actionsConfig.baseUrl = origin;
        // 09-vendo §2 install-dx wave 1.1: NODE_ENV=development trusts its own
        // learned origin — credentials forward to the wire's own route
        // bindings with zero config. Every other environment (including
        // NODE_ENV=test) keeps the learned origin UNTRUSTED exactly as
        // before, so a spoofed Host on any early request can never turn it
        // into a credential-exfiltration target (04 §4).
        actionsConfig.baseUrlTrusted = isDevelopmentEnv;
      }
    },
  });

  return {
    handler,
    async emit(event, payload, principal) {
      await ready();
      return automations.emit(event, payload, principal);
    },
    agent,
    guard,
    // The BYO seam (ai-sdk.ts / mastra.ts tool packs) reaches the store
    // without ever touching handler/emit, so its execute leg arms the same
    // ready() latch — the composed-block head start the old eager kick gave
    // such hosts, without the construction-time I/O Workers forbids. Direct
    // vendo.store/automations reach-ins still own their readiness (await
    // store.ensureSchema(), as the mastra example and defer tests do).
    guardedTools: {
      ...byoApprovals.registry,
      execute: async (call, ctx) => {
        await ready();
        return byoApprovals.registry.execute(call, ctx);
      },
    },
    apps,
    automations,
    actions,
    // The adapter rule's object, exactly as selected: an explicitly passed
    // adapter is handed back untouched. The cache-invalidating wrapper is an
    // internal composition detail (see selectedConnections above).
    connections: selectedConnections,
    store,
  };
}

/** 09-vendo §2 — adapt the fetch handler to a Next.js catch-all route module.
    PATCH stays exported even with no PATCH-only wire route left: Next.js
    405s any method the module does not export before the request ever
    reaches `vendo.handler`, so dropping it would turn e.g. `PATCH
    /api/vendo/orgs/:id/members/:subject` into a framework 405 instead of
    the wire's own `cloud-required` seam (the org routes matched ANY
    method — orgsRoutes in wire/misc.ts). PUT carries the box callback
    surface's durable-row writes (execution-v2 Lane C:
    PUT /api/vendo/box/rows/:collection/:id). */
export function nextVendoHandler(vendo: Vendo): {
  GET(request: Request): Promise<Response>;
  POST(request: Request): Promise<Response>;
  PUT(request: Request): Promise<Response>;
  PATCH(request: Request): Promise<Response>;
  DELETE(request: Request): Promise<Response>;
} {
  const handle = (request: Request): Promise<Response> => vendo.handler(request);
  return { GET: handle, POST: handle, PUT: handle, PATCH: handle, DELETE: handle };
}

/** 10-mcp §5 — adapt the fetch handler to a Next.js `app/.well-known/[...vendo]/
    route.ts` module. The four discovery documents the door serves (RFC 9728/
    8414 metadata for its fixed mount, plus the SEP-2127 server card) live at
    ORIGIN-ROOT paths, outside BASE_PATH — a host's `/api/vendo` catch-all route
    never sees them, because Next.js dispatches by directory structure, not by
    the wire's own routing. This file exists so that directory gets a handler
    too, one that shares DOOR_WELL_KNOWN_PATHS with the wire itself (the SAME
    set `isDoorPath` matches) instead of a hand-copied allowlist that can drift
    from it. A request whose pathname is exactly one of those four paths
    forwards to `vendo.handler` (which independently confirms it's a door path
    and, if `mcp` is configured, serves it — the check here is only about
    which requests reach the wire at all); anything else answers 404 with an
    empty body, mirroring the hand-written route this replaces. With `mcp` left
    unconfigured, `vendo.handler` still recognizes these four paths but has no
    door to serve them, so the request falls through to the wire's ordinary
    not-found response — never a 500. */
export function wellKnownVendoHandler(vendo: Vendo): {
  GET(request: Request): Promise<Response>;
  POST(request: Request): Promise<Response>;
} {
  const handle = (request: Request): Promise<Response> => {
    const { pathname } = new URL(request.url);
    return DOOR_WELL_KNOWN_PATHS.has(pathname)
      ? vendo.handler(request)
      : Promise.resolve(new Response(null, { status: 404 }));
  };
  return { GET: handle, POST: handle };
}
