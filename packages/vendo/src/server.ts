import {
  createActions,
  createConnectGate,
  mergedHostSemantics,
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
import { askUserRegistry, connectorDiscoveryRegistry, createAgent, vendoVerbsRegistry, USE_SERVICE_TOOL, VENDO_TOOL_PACK_PREFIX, type CapabilityMissConfig, type ToolSearchConfig, type VendoAgent } from "@vendoai/agent";
import { assembleSystemPrompt } from "@vendoai/agent/internal";
// Architecture §3 — the harness runtime and the default thinker. `vendo()` is
// composed HERE (not by the host) when `harness:` is unset; its prompt and
// descriptor catalog reach it on the turn, never at construction.
import { assertHarnessComposable, reportHire, vendo } from "@vendoai/harnesses";
// …and re-exported, because §10's one-line opt-in is `harness: vendo()`. Without
// this, naming the default harness costs a SECOND direct dependency on
// `@vendoai/harnesses` — a documented one-liner that does not compile from the
// package the host installed. Alias it at the import when your own composed
// value is called `vendo` (`import { vendo as vendoHarness }`).
export { vendo, type VendoHarnessDeps, type VendoHarnessOptions } from "@vendoai/harnesses";
// The specialist, same reason: `harness: instant()` has to compile from the one
// package the host installed (architecture §6).
export { instant, type InstantHarnessDeps, type InstantHarnessOptions } from "@vendoai/harnesses";
import { createHarnessTurns, type HarnessTurns } from "./harness-turn.js";
// Both types already sit in the PUBLIC signatures below — `apps:` is typed off
// `AppsConfig`, `Vendo.harness` is a `HarnessTurns` — so a host reads them
// today and simply cannot name them. Exported so it can (and so the quickstart
// config listing, which is compiled against these very interfaces, can too).
export type { HarnessTurns } from "./harness-turn.js";
export type { AppsConfig } from "@vendoai/apps";
import { warnDeprecatedConfigKeys } from "./config-keys.js";
import { orgPolicyPath, orgPolicyResolver, workspacePolicySource } from "./org-policy.js";
import { createPromoteApp } from "./promote-app.js";
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
import { selectSandbox } from "@vendoai/apps/sandbox-ladder";
import {
  agentComposition,
  provideCloudAdapters,
  type AgentComposition,
  type VendoAgent as ComposedAgent,
} from "@vendoai/agents";
import {
  createAutomations,
  type AutomationsEngine,
} from "@vendoai/automations";
import {
  ADOPTION_VENUE_KEY,
  RESERVED_SUBJECT_PREFIX,
  VendoError,
  descriptorHash,
  vendoThemeSchema,
  type ActAs,
  type AppDocument,
  type AppId,
  type ComponentCatalog,
  type ComponentRegistry,
  type FilesAdapter,
  type Harness,
  type Json,
  type KnowledgeAdapter,
  type PackProvider,
  type PermissionGrant,
  type Principal,
  type RiskLabel,
  type RunContext,
  type RunId,
  type SecretsProvider,
  type StoreAdapter,
  type ToolCall,
  type ToolDescriptor,
  type ToolOutcome,
  type ToolRegistry,
  type VendoTheme,
} from "@vendoai/core";
import { createGuard, type Judge, type PolicyConfig, type PolicyFile, type RiskResolver, type VendoGuard } from "@vendoai/guard";
import {
  bindKnowledgeStore,
  cloudKnowledge,
  createKnowledgeTools,
  entailmentVerifier,
  knowledgeIndexResolver,
  type KnowledgeToolsOptions,
} from "@vendoai/knowledge";
import {
  createMcpDoor,
  createTurnCredentials,
  type AppsPort,
  type HostOAuthAdapter,
  type McpDoor,
  type TurnCredentials,
} from "@vendoai/mcp";
import {
  adoptEphemeralSubject,
  appAccess,
  appStore,
  createStore,
  envSecrets,
  registerEphemeralSubject,
  storeFiles,
  sweepEphemeralSubjects,
  threadMessageStore,
  workspaceStore,
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
import { catalogThemeSummary, mergeRuntimeCatalog, normalizeCatalogConfig, runtimeCatalogFromFile, runtimeCatalogFromJson, searchRuntimeCatalog } from "./catalog.js";
import {
  DEFAULT_PACKS,
  hostPackToolCollision,
  hostToolNamesIn,
  mergePacks,
  missingAppsPackWarning,
  vendoDirOf,
  type PackContext,
} from "./packs/index.js";
import { bindVendoModelSlots, vendoModel } from "#dev-creds/model";
// Models spec 2026-07-22 — `vendoModel(name?)` is the vendo model family
// entry: the lazily-resolving env ladder createVendo composes when the host
// passes none, exported for host code too (judge wiring, host features). No
// argument means `vendo` semantics (per-rung defaults); a name passes through
// VERBATIM to the resolved rung. `devModel` stays as the deprecated alias.
export { devModel, vendoModel, type DevModelOptions, type VendoModelOptions, type VendoModelSlot } from "#dev-creds/model";
import { withUniqueToolTitles } from "./duplicate-titles.js";
import { resolveModels } from "./models-config.js";
export { type ModelsConfig } from "./models-config.js";
import type { ModelsConfig, ResolveModelsInput } from "./models-config.js";
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
// The standalone agent runtime leaves its Cloud rungs as a seam because their
// implementations ship here (it may not import the umbrella). Registered at
// IMPORT time, not at compose: `agent()` resolves its own slots at
// CONSTRUCTION, which is before createVendo ever runs. Pure closure
// assignment, no I/O — safe at module scope under workerd (portability gate).
//
// The store rung stays deliberately unfilled: tenant-store access is under
// redesign (2026-08-04 hold), and the HTTP hosted store cannot serve a harness
// transcript or a workspace (storeServesHarnessTurns below), so filling it
// would hand back a store the agent's own sessions cannot use. A
// VENDO_API_KEY-only `agent()` therefore still fails loudly, naming
// `store: postgres(url)`, instead of composing something broken.
provideCloudAdapters({ sandbox: cloudSandbox });
import { cloudApps } from "./cloud-apps.js";
import { cloudMcpTenant } from "./cloud-mcp.js";
import { selectMcpBroker } from "./mcp-broker-select.js";
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
import { createTourScript, type TourEntry } from "./tours/index.js";
// Tour mode is plain OSS config — the entry types ride the server surface so a
// host can name them (`const tours: TourEntry[] = [...]`) without reaching
// into a subpath.
export type { TourApp, TourEntry, TourPart, TourResponse } from "./tours/index.js";
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
// Packs — the composition side (architecture §5). `definePack` is on the root
// entry instead, because pack modules are imported on the client too.
export {
  APPS_PACK_NAME,
  AUTOMATIONS_PACK_NAME,
  DEFAULT_PACKS,
  UNATTENDED_IRREVERSIBILITY_RULE,
  apps,
  automations,
  mergePacks,
  toolsFromRegistry,
  type MergedPacks,
  type PackContext,
} from "./packs/index.js";
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
import { boxRoutes, fnProxyRoutes, servedProxyRoutes } from "./wire/box.js";
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
  /** Architecture §3 — turns served through the composed `Harness` (`harness:`,
      or `vendo()`). Post-flip (wave 2) `POST /threads` routes here whether or not
      the host named a harness; the only deployment left on `agent.stream` is one
      whose store has no SQL handle, since the transcript and the workspace are
      tables (`storeServesHarnessTurns`). This door is exposed either way so a
      host — and the live proofs — can drive a harness turn directly; on a store
      without SQL it raises the not-implemented refusal rather than degrading. */
  harness: HarnessTurns;
}

// Task 15a — the profile piece types, named from THIS entry so they sit
// beside createVendo/CreateVendoConfig: the hosted try venue (a Worker in the
// console repo) composes typed `profile` pieces against the umbrella alone,
// without adding a direct @vendoai/actions or @vendoai/core dependency.
// ServerActionHandler rides along for the same reason: it is the value type of
// the documented `serverActions` config key, so a host must be able to name it
// without adding a direct @vendoai/actions dependency.
export type { CatalogFile, ExtractedTool, OverridesFile, ServerActionHandler } from "@vendoai/actions";
// The second arm of the `agent:` key — what `agent()` from @vendoai/agents
// returns — named from here for the same reason as ServerActionHandler: a host
// must be able to name what it passes without adding a direct dependency on the
// block the value came from.
export type { VendoAgent as ComposedAgent } from "@vendoai/agents";
export type { VendoTheme } from "@vendoai/core";
export type { PolicyFile } from "@vendoai/guard";

/** 03-agent — chat context controls, the non-agent arm of `createVendo({ agent })`.
    All optional. `toolOutputCap` defaults to DEFAULT_TOOL_OUTPUT_CAP so one huge
    host-tool response can't blow the context; pass 0 to disable. `historyWindow`
    bounds messages re-sent per turn (default: full). */
export interface AgentOptions {
  /** Host voice and standing guidance, appended to the agent's system
      prompt every turn (03 §3 `instructions`) — tone, formatting, what to
      emphasize. Policy belongs in guard directions, not here. */
  instructions?: string;
  toolOutputCap?: number;
  maxOutputTokens?: number;
  historyWindow?: number;
  /** ENG-252 — cap on the uncurated initial tool loadout; the rest stay
      discoverable via `find_tools`. Defaults to the agent block's
      DEFAULT_MAX_INITIAL_TOOLS. */
  maxInitialTools?: number;
  /** ENG-252 — explicit curated initial loadout by tool name. When set,
      exactly these host tools (that exist and are enabled) start active —
      the cap is not applied; the rest stay discoverable via
      `find_tools`. Vendo's own `vendo_*` tools are always active. */
  loadout?: string[];
  /** AGENT-7: agent-loop step cap per turn (default 20). Exhaustion streams a
      renderable `data-vendo-step-limit` part instead of ending silently. */
  maxSteps?: number;
}

/** The slots a composed agent brings, and therefore the keys that may not also
    be passed at the top level. Kept beside the adoption in `adoptAgent` so the
    error can never drift from what is actually taken. */
const AGENT_OWNED_KEYS = ["harness", "store", "files", "sandbox"] as const;

/** `agent()` returns `{ name, session }`; the chat-knobs arm has no `session`. */
const isComposedAgent = (agent: AgentOptions | ComposedAgent | undefined): agent is ComposedAgent =>
  typeof (agent as ComposedAgent | undefined)?.session === "function";

/** The seam: read what `agent()` composed, and refuse a config that fills any
    of the same slots twice. Runs before anything is constructed, so a miswired
    config leaks no resources. */
function adoptAgent(config: CreateVendoConfig): AgentComposition | undefined {
  if (!isComposedAgent(config.agent)) return undefined;
  const composed = agentComposition(config.agent);
  if (composed === undefined) {
    throw new VendoError(
      "validation",
      "createVendo({ agent }) was handed an object with a session() method that `agent()` from @vendoai/agents did not build — pass the value that `agent({ … })` returned, or the chat-context knobs object.",
    );
  }
  const conflicts = AGENT_OWNED_KEYS.filter((key) => config[key] !== undefined);
  if (conflicts.length > 0) {
    throw new VendoError(
      "validation",
      `createVendo({ agent }) already brings ${conflicts.map((key) => `\`${key}\``).join(", ")} from the agent it was built with; remove ${conflicts.length === 1 ? "it" : "them"} from createVendo, or move ${conflicts.length === 1 ? "it" : "them"} into agent({ … }) — one slot, one owner.`,
    );
  }
  return composed;
}

export interface CreateVendoConfig {
  /** @deprecated Superseded by `models.agent` (models spec 2026-07-22);
      still functional for one release. The agent's LLM — the inference
      adapter seam (03-agent §1): any ai-SDK LanguageModel. An explicitly
      passed model always wins (BYO-LLM); when absent the seam resolves a
      real key from the environment — provider keys via vendoModel's ladder,
      then VENDO_API_KEY → Vendo Cloud managed inference — and fails honestly
      with instructions when none exists (precedence: resolveModels). */
  model?: LanguageModel;
  /** @deprecated The `model` half is superseded by `models.paint`. There is ONE
      generation pipeline now, so `disabled` no longer disables a lane — it means
      "compose no separate fast tier", and the group fill workers then run on the
      agent model instead of a cheaper one. */
  paint?: ResolveModelsInput["paint"];
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
  /** Architecture §10 — THE host's own tools, as `vendo init` / `vendo sync`
      extract them: the declarations `.vendo/tools.json` carries, passed in
      memory instead of read from disk.

      This is the explicit override, not the quickstart: day one is one key
      (`createVendo({ auth })`) reading `.vendo/` off the project root, and a
      host reaches for `tools:` when the declarations live somewhere the
      filesystem cannot be — a Worker, a per-tenant venue composing from a
      database, a test.

      Precedence: `tools:` wins over the deprecated `profile.tools` (the same
      value under its pre-§10 spelling), which wins over the `profileDir` /
      cwd `tools.json` read. Unset, nothing changes — the file is read exactly
      as before. */
  tools?: ExtractedTool[];
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
  /** Build contract §3.4 / architecture §10 — where workspace file CONTENT
      lives once it outgrows a database row. Unset, the store's own `vendo_blobs`
      backs it up to `FILES_STORE_MAX_BYTES` (5 MiB) and the first over-cap write
      fails naming this key; `s3({ bucket, … })` is the shipped implementation
      and covers S3/R2/Supabase/MinIO.

      Resolved ONCE, inside `selectStore`, and handed to every consumer from
      there — the workspace that writes blobs, and the erase/adoption/sweep
      cascade that must delete the same ones. Two adapters would leak objects
      forever behind deleted rows, so the resolution has exactly one home. */
  files?: FilesAdapter;
  sandbox?: SandboxAdapter;
  /** Architecture §3 / §10 — WHO THINKS. Any `Harness`: the built-in `vendo()`,
      a spawned driver, or the host's own via `defineHarness`. Unset means
      `vendo()` — today's loop, on the contract.

      A harness declaring `requires: { sandbox: true }` with no `sandbox`
      adapter is a BOOT error, never a turn that dies in front of a user. */
  harness?: Harness<never>;
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
  /** Development-only injection seams (e.g. /dev/inclient-approval).
      NODE_ENV=development enables them; `false` disables the environment
      default. */
  development?: boolean;
  /** Unified try surface — the project root the `.vendo/` profile is read
      under: the actions files (tools.json/overrides.json, read by the actions
      registry this composition builds with `dir`), theme.json, brief.md,
      catalog.json, the per-generation design-rules.md read, and the remixable
      pin baselines all resolve against it. Unset keeps today's
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
  /** EITHER the chat-context knobs ({@link AgentOptions}) OR a whole agent
      built by `agent()` from `@vendoai/agents` — the seam the agents-v0 spec
      names ("Vendo's embed consumes it across a real seam").

      Handed an agent, this deployment ADOPTS what that agent already composed:
      its harness (who thinks), its store and blob adapter (where the
      transcript and the workspace live), its sandbox (with the agent-level
      egress skin and its boot audit row), and its `instructions`. Passing any
      of those a second time at the top level is a conflict and throws at
      construction rather than letting one side silently lose.

      What stays this deployment's: the guard (the embed's choke point carries
      org policy and app-tool risk grading a standalone agent has no notion of)
      and the host tool surface (`.vendo/tools.json`). The agent's own guard and
      tools keep serving its own `session()` calls. */
  agent?: AgentOptions | ComposedAgent;
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
    /** Remix review (round-2 hardening 2026-08-02) — the host's reviewer
        assertion for the review-kind remix lifecycle: whether THIS caller may
        read the full review queue, reject, and approve review-kind remixes.
        Reviewing crosses owner boundaries, so it is never inferred from a
        principal alone. Unset, the dev review-queue route serves only the
        caller's own submissions, reject refuses naming this hook, and a user
        can never approve their own review-kind remix. The same gate rides the
        runtime surface (`vendo.apps.review` / `vendo.apps.inClient.approve`)
        — the production path a self-hoster mounts an admin-authenticated
        route over; Cloud's console is the hosted equivalent. */
    review?: {
      reviewer?(ctx: RunContext): boolean | Promise<boolean>;
    };
    /** The island smoke-render gate: every generated island renders once in a
        headless DOM before it can reach a screen. ON unless explicitly false. */
    pipeline?: AppsConfig["pipeline"];
    /** Groups filled at the same time during app generation (default 2). */
    fillConcurrency?: AppsConfig["fillConcurrency"];
    /** The host's own checks over a generated app: each one reports findings
        (`block` stops the app shipping as-is, `warn` rides along) the same way
        the built-in fact checks and the AI reviewer do. APPENDED to the
        built-ins — a host adds findings, it never removes one. */
    checks?: AppsConfig["checks"];
    /** Host design rules for app generation (spec 2026-07-20): the same prose
        `.vendo/design-rules.md` carries, for hosts that prefer programmatic
        config. A non-blank string wins over the file and is fixed for the
        instance lifetime; unset/blank falls through to a PER-GENERATION read
        of the file, so editing it applies to the next create/edit without a
        restart. */
    designRules?: string;
  };
  /** Packs — the only way capability arrives (architecture §5). Each one
      contributes to four slots that already exist: tools → the one registry
      (guarded and projected like every other tool), skills → the workspace
      mount, checks → the checking floor, components → the catalog. Names are
      global as authored and a collision fails at boot naming both packs; nothing
      is ever auto-prefixed.

      Unset means `[apps()]`. A pack whose tools need a platform handle is
      written as a plain function of the boot context — which is exactly what
      `apps()` is, so it has no privileged path a third party lacks. */
  packs?: readonly PackProvider<PackContext>[];
  /** Tour mode — deterministic scripted responses in front of the real agent,
      for demos and onboarding tours. An ordered list of `{ prompt, respond }`
      entries: an entry fires only on a close variant of its own frozen prompt
      (normalized similarity, not keywords) and only ONCE per thread, replaying
      its recorded prose and app documents at a live turn's cadence. Every
      other ask — including a follow-up about what a tour just put on screen —
      falls through to the live agent untouched. Plain config: no key, no Cloud
      dependency, identical behavior with and without VENDO_API_KEY. */
  tours?: readonly TourEntry[];
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
         paths (`httpKnowledge({ url })`, `vendoKnowledge()`), which is how a
         Cloud subscriber keeps its own engine by construction. A zero-config
         `vendoKnowledge()` is handed the composed store here
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
  // The seat is spelled `verifier` in the new vocabulary and `knowledgeVerifier`
  // in the old one; the slot binder only knows the old name, so normalise here.
  // The new spelling wins, same rule as every other seat.
  bindVendoModelSlots(model, models === undefined ? undefined : {
    ...models,
    ...(models.verifier === undefined ? {} : { knowledgeVerifier: models.verifier }),
  });
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

/** Both doors erase workspace content, so both need the SAME files adapter the
    workspace wrote it with (build contract §3.4) — an erase against a different
    adapter drops the rows and leaves the objects, which is the blob-leak class
    lane B spent three rounds killing. `files` is therefore a required argument
    here, resolved once in {@link selectStore} and never defaulted locally. */
function localSessionOps(store: VendoStore, files: FilesAdapter): SessionOps {
  return {
    register: (subject, now) => registerEphemeralSubject(store, subject, now),
    adopt: (from, to) => adoptEphemeralSubject(store, from, to, { files }),
    sweep: (idleMs, now) => sweepEphemeralSubjects(store, { idleMs, now, files }),
  };
}

function hostedSessionOps(store: HostedStore, touchDebounceMs: number): SessionOps {
  // Last successful WIRE touch per subject. Presence means the subject is
  // registered on the console; entries retire with the session (adopt/sweep),
  // so the map tracks at most the live anonymous sessions of this process.
  const wireTouched = new Map<string, number>();
  // A console that answers a BARE 404 (no error envelope) on a session door is
  // not serving that surface at all. The doors then go quiet for the process —
  // one warn, no per-request failures, no per-interval sweep retries — because
  // anonymous traffic must keep serving and there is nothing to retry INTO.
  // The latch is per-process and re-arms on the next composition, so a console
  // that grows the doors back needs no client change (history:
  // docs/verification/existing-agents/polish/hosted-sessions-404.md).
  let doorsMissing = false;
  const disableDoors = (): void => {
    if (doorsMissing) return;
    doorsMissing = true;
    console.warn(
      "[vendo] Vendo Cloud console did not serve the hosted session doors (/api/v1/store/sessions/* answered a bare 404): "
      + "anonymous-session registration, the anonymous→signed-in merge, and the hosted TTL sweep are disabled for this process. "
      + "Hosted anonymous sessions will not be swept until the console serves those doors again.",
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
    // every claimed subject through the erase cascade. A claim COMMITS by
    // deleting the registry row, so a failed erase would leave the subject's
    // rows unreachable by every later stale scan — compensated below.
    async sweep(idleMs, now) {
      if (doorsMissing) return [];
      const evicted: string[] = [];
      try {
        for (const subject of await store.sessions.stale(idleMs, now)) {
          if (!(await store.sessions.claim(subject, idleMs, now))) continue;
          try {
            await store.erase.bySubject(subject);
          } catch (error) {
            // Put the claimed row back, stamped one tick past the idleness
            // cutoff so the very next sweep re-claims it instead of waiting
            // out another TTL. Best-effort: if the console is down for this
            // too, the erase failure is the one worth reporting.
            //
            // RELIES ON a console guarantee: register/touch never moves a
            // subject's touched_at BACKWARD (vendo-web
            // apps/console/lib/core/session-registry.ts, `touch` bumps under
            // `last_seen < seenAt`). Without that clamp this backdated write
            // would overwrite the fresh stamp of a visitor who returned
            // between the claim and here, and the next sweep would erase a
            // LIVE session. The client cannot enforce it — only the registry
            // can compare-and-set atomically. Pinned by "a fresh touch from a
            // returning visitor survives the compensation" below.
            await store.sessions.register(subject, now - idleMs - 1).catch(() => undefined);
            throw error;
          }
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

/** Per-process latch for the hosted-store automations notice below — a dev
    server recomposes on nearly every request, and the paragraph is a boot
    fact, not a per-request one (self-serve audit F7). */
let hostedStoreNoticePrinted = false;

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
/** ADAPTER RULE, files seam (build contract §3.4): the one place a
    `FilesAdapter` is chosen. Explicit `files:` wins (BYO — s3/R2/Supabase/MinIO
    via `s3()`, or the host's own); unset, the store's `vendo_blobs` backs it up
    to `FILES_STORE_MAX_BYTES`, and the over-cap error names `files:` by name.

    Deliberately NOT defaulted at each call site. The workspace writes blobs and
    the erase cascade deletes them, and if those two ever resolve separately, a
    host who wires `files:` gets rows deleted and objects left behind forever.
    One resolution, returned beside the store it may be backed by, so every
    consumer is handed the same instance. */
function selectFiles(configured: FilesAdapter | undefined, store: VendoStore): FilesAdapter {
  if (configured !== undefined) return configured;
  // Deferred to first use, not built at compose: `storeFiles` resolves a blob
  // handle off the store, and `createVendo` must stay I/O-free at module init
  // (the portability gate — Workers forbids work in global scope). Memoized, so
  // every consumer still shares ONE adapter, which is the whole point.
  let backing: FilesAdapter | undefined;
  const blobs = (): FilesAdapter => (backing ??= storeFiles(store));
  return {
    put: (key, bytes, meta) => blobs().put(key, bytes, meta),
    get: (key) => blobs().get(key),
    delete: (key) => blobs().delete(key),
  };
}

/**
 * Can this store serve a harness turn? The transcript (build contract §6) and the
 * workspace (§3.3) are SQL tables; `threadMessageStore` resolves the handle as its
 * first act and throws for a store that has none — the Cloud hosted store, or a
 * host's own non-SQL adapter. Probing is a WeakMap lookup, never I/O, so it is
 * safe where `createVendo` runs at module init (Workers).
 *
 * This is the ONE thing that keeps the wave-2 default-route flip honest: a
 * deployment that cannot serve harness turns keeps the shipped `agent.stream`
 * path, which needs neither table, instead of failing every chat turn.
 */
function storeServesHarnessTurns(store: VendoStore): boolean {
  try {
    threadMessageStore(store);
    return true;
  } catch {
    return false;
  }
}

function selectStore(
  configured: VendoStore | undefined,
  touchDebounceMs: number,
  configuredFiles: FilesAdapter | undefined,
): {
  store: VendoStore;
  sessions: SessionOps;
  /** THE files adapter for this deployment. Every consumer takes it from here. */
  files: FilesAdapter;
} {
  const selected = ((): VendoStore => {
    if (configured !== undefined) return configured;
    const cloud = cloudKeyOptions();
    if (cloud !== undefined) return hostedStore(cloud);
    const encryptionKey = environment("VENDO_STORE_ENCRYPTION_KEY");
    return createStore(encryptionKey === undefined
      ? { allowUnencryptedSecrets: environment("NODE_ENV") !== "production" }
      : { encryption: { key: encryptionKey } });
  })();
  const files = selectFiles(configuredFiles, selected);
  return {
    store: selected,
    files,
    sessions: isHostedStore(selected)
      ? hostedSessionOps(selected, touchDebounceMs)
      : localSessionOps(selected, files),
  };
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

/** A synchronous, throw-free read of one file, for the compose-time gates. */
function readFileSyncOrUndefined(path: string): string | undefined {
  try {
    const proc = (globalThis as { process?: { getBuiltinModule?: (id: string) => unknown } }).process;
    const fs = proc?.getBuiltinModule?.("node:fs") as typeof import("node:fs") | undefined;
    if (fs === undefined) return undefined;
    return fs.readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

/**
 * The host's own tool names, as far as composition can know them without doing
 * any I/O beyond one file read: the in-memory `profile.tools` piece, else
 * `tools.json` from the SAME directory the tool registry resolves it from.
 *
 * `vendoDirOf` is the registry's own rule (`profileDir` may be the host root or
 * the `.vendo` directory itself). Using anything else here made the gate read a
 * different file — or no file — and a gate that reads nothing passes everything.
 */
function hostToolNames(config: CreateVendoConfig): string[] {
  const inMemory = selectHostTools(config);
  if (inMemory !== undefined) return inMemory.map((tool) => tool.name);
  return hostToolNamesIn(readFileSyncOrUndefined(`${vendoDirOf(config.profileDir ?? ".")}/tools.json`));
}

/**
 * ADAPTER RULE, host-tool declarations (§10's `tools:` slot): the ONE place the
 * in-memory host-tool list is chosen, so the compose-time gate, the actions
 * registry and the development-capture baseline can never read different sets.
 *
 * `tools:` beats the deprecated `profile.tools` rather than the other way round.
 * The `apps.designRules` precedent — longer-standing knob wins — is about two
 * knobs of equal standing; this is a slot and its own former spelling, and a host
 * who adds the documented slot expects it to take effect.
 */
function selectHostTools(config: CreateVendoConfig): ExtractedTool[] | undefined {
  return config.tools ?? config.profile?.tools;
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

/** Is this origin THIS machine, and only this machine? The one question that
 *  makes a request-derived origin safe to hand a turn credential: a loopback
 *  address cannot carry the credential off the host, whoever set the Host
 *  header. `URL` throws on opaque origins (the literal string "null"), which
 *  are likewise not loopback. */
function isLoopbackOrigin(origin: string): boolean {
  let hostname: string;
  try {
    hostname = new URL(origin).hostname;
  } catch {
    return false;
  }
  // IPv6 hostnames arrive bracketed (`[::1]`).
  const host = hostname.replace(/^\[|\]$/g, "");
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

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
  // Build contract §9.8 — ahead of the grouped /apps arm for the same reason
  // the fn proxy is: /apps/:id/serve/** must resolve here, not fall through it.
  ...servedProxyRoutes,
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
  /** Starts a sweep pass and books the cadence, or answers undefined when the
      interval has not elapsed. `force` is for a route that ASKED for the sweep
      (POST /tick): a serverless process re-seeds lastSweepAt on every
      invocation, so the interval gate would never let one of those through. */
  const startSweep = (force: boolean): Promise<void> | undefined => {
    if (!deps.sweepEnabled) return undefined;
    const now = deps.sessions.now();
    if (!force && now - lastSweepAt < deps.sessions.sweepIntervalMs) return undefined;
    lastSweepAt = now;
    return deps.sweep();
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
    // ONE sweep pass per request, shared with any route that drives the sweep
    // itself (POST /tick) so a tick can never run two scans of the same
    // registry. The amortized leg only WARNS — an innocent request must not
    // 500 for a sweep it merely happened to trigger — but the pass keeps its
    // rejection, so a route that asked for the sweep still answers with it.
    let sweepPass = startSweep(false);
    await sweepPass?.catch((error: unknown) => {
      console.warn(`[vendo] session sweep failed; will retry next interval: ${error instanceof Error ? error.message : String(error)}`);
    });
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
        sweep: () => (sweepPass ??= startSweep(true) ?? Promise.resolve()),
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
  // §10 consolidation — a deprecated key still works, and says where it went.
  // Once per key per process: a deployment composes once, but a multi-tenant
  // venue composes per session and repeated advice is noise nobody reads.
  warnDeprecatedConfigKeys(config as Record<string, unknown>);
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
  // agents-v0 §Product — the embed's seam onto @vendoai/agents. Checked here,
  // beside the auth mixing check and for the same reason: a slot filled twice
  // is a wiring mistake the host hears about before anything is constructed.
  const composed = adoptAgent(config);
  // Whichever arm of `agent:` this is, the chat knobs read from ONE place. A
  // composed agent carries only `instructions`; the rest are the embed's own
  // context controls, which a standalone agent has no equivalent of.
  const agentOptions: AgentOptions = composed === undefined
    ? (config.agent as AgentOptions | undefined) ?? {}
    : composed.instructions === undefined ? {} : { instructions: composed.instructions };
  // The three seams the identity story fills: from the preset, from the
  // per-seam trio, or — with neither `auth` nor `principal` — the anonymous
  // default resolver (every session ephemeral, 00 conventions "identity
  // optional" / 02-store §4). Absent preset halves leave their seams unset.
  const resolvePrincipal = config.auth?.principal ?? config.principal ?? (async () => null);
  const actAsSeam = config.auth === undefined ? config.actAs : config.auth.actAs;
  const oauthSeam = config.auth === undefined ? config.oauth : config.auth.oauth;
  // Build contract §9.1 — the fourth seam. It rides the preset (there is no
  // per-seam twin: the org query has no meaning without an identity story) and
  // is handed to the wire, the automations engine, and the schedule engine, so
  // an attended request and an unattended fire resolve the SAME answer.
  const membershipsSeam = config.auth?.memberships;
  // Build contract §9.1 companion — the fifth seam, on the same preset and for
  // the same reason: Vendo holds no directory, so only the host can turn what
  // someone typed into the Share dialog into one of its own subjects. Unset, the
  // dialog does not offer to share with one person at all.
  const resolvePersonSeam = config.auth?.resolvePerson;
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
  const { store, sessions: sessionOps, files } = selectStore(
    composed?.store ?? config.store,
    Math.min(
      Math.floor(sessionsConfig.sweepIntervalMs / 2),
      Math.floor(sessionsConfig.ttlMs / 4),
    ),
    composed?.files ?? config.files,
  );
  // The sandbox seam, resolved by THE ladder — the one in @vendoai/apps that
  // `agent()` calls too (explicit → E2B_API_KEY → the Cloud rung → nothing).
  // "Nothing" is this deployment's dark venue: server apps answer
  // sandbox-unavailable and assertHarnessComposable below refuses a harness
  // that needed a machine.
  const sandbox = selectSandbox(composed?.sandbox ?? config.sandbox, cloudSandbox);
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
  // seams (design-rules/theme/semantics thunks, the brief resolver, the
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
  // Assigned at the door composition below when the broker arm of the mcp
  // seam is selected: the ensure-tenant call rides this SAME boot-once latch
  // as ensureSchema — an awaited compose step, resolved before the first
  // request is served — never construction-time I/O (createVendo runs at
  // module init in the edge wiring, where Workers forbids fetch).
  let warmMcpBroker: (() => Promise<void>) | undefined;
  let readyState: Promise<void> | undefined;
  const ready = (): Promise<void> => {
    if (readyState === undefined) {
      readyState = warmMcpBroker === undefined
        ? store.ensureSchema()
        : Promise.all([store.ensureSchema(), warmMcpBroker()]).then(() => undefined);
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
  // The resolver is installed immediately after createApps below. Keeping the
  // hook in guard means chat/SSE and the MCP door reach the same decision.
  //
  // Two resolvers, chained, app first: an app's own tool grade is a decision a
  // person made in this deployment, so it outranks a broker's catalog tag —
  // and the two can never collide anyway, since only `use_service_tool`
  // reaches the second leg.
  //
  // Named rather than inlined because the automations engine takes the SAME
  // function: arm-time capture has to grade a declared connector call exactly
  // as the away call will be graded, or the grant it mints is hashed against a
  // label the guard never sees and is invalidated on first use.
  const resolveRisk: RiskResolver = async (call, _descriptor, ctx) =>
    (await resolveAppToolRisk?.(call, ctx)) ?? await serviceToolRisk(call);
  const guard = createGuard({
    store,
    resolveRisk,
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
    // Build contract §9.10 — the org-admin layer, composed at the seam like
    // every other adapter choice: the guard evaluates rules, this reads them.
    // Callers with no asserted memberships (every unkeyed deployment, and any
    // request whose host asserted none) resolve to no rules at all.
    //
    // A per-ORG failure (unreadable or malformed policy.json) skips that org's
    // rules and lands on the audit trail, so the admin whose file is broken can
    // see their policy is not in force. Reported through the guard that is being
    // constructed here — the callback only ever runs inside a later check, which
    // is the same late-binding `resolveRisk` above uses.
    orgPolicy: orgPolicyResolver(workspacePolicySource(store), async (org, reason) => {
      console.warn(
        `[vendo] org policy for "${org}" was not applied: ${reason} `
        + `(its rules live at ${orgPolicyPath(org)}) — until then this org's rules are not in force.`,
      );
      await guard.report({
        id: `aud_${globalThis.crypto.randomUUID()}`,
        at: new Date().toISOString(),
        kind: "policy-decision",
        // A broken org file is nobody's personal event, so it is audited under
        // the runtime's own reserved namespace (`vendo:`, block-actions §C)
        // rather than pinned to whichever member happened to trigger the read.
        principal: { kind: "user", subject: `${RESERVED_SUBJECT_PREFIX}org-policy:${org}` },
        venue: "chat",
        presence: "away",
        detail: { reason: "org-policy-unavailable", org, message: reason },
      });
    }),
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
  // (disabled/audience), not only app-generation semantics. The registry
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
    ...(selectHostTools(config) === undefined ? {} : { tools: selectHostTools(config) }),
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
  // Design §12: a deployment where two tools share a `title` cannot render an
  // honest consent card, so it must not serve. Composition installs the check
  // here — the one place the deployment's whole registry is assembled — and it
  // fires the instant the descriptor set first resolves, which is the earliest
  // this is knowable (createVendo is synchronous; descriptors are not).
  const boundTools = withUniqueToolTitles(connectGate.bind(guard.bind(actions)));
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
  // W3 + cse lane 3 — field semantics from the merged .vendo
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
  const hostSemanticsProvider = (): ReturnType<typeof mergedHostSemantics> => {
    const parsedFile = (name: string): unknown => {
      const raw = dotVendoFile(name, surfaceRoot);
      return raw === undefined ? undefined : JSON.parse(raw) as unknown;
    };
    const overridesRaw = config.profile?.overrides !== undefined
      ? undefined
      : selectConfigSurface("overrides.json", { readFile: readSurfaceFile, cloud: configCloud }).value;
    try {
      return mergedHostSemantics({
        tools: selectHostTools(config) !== undefined
          ? { format: VENDO_TOOLS_FORMAT, tools: selectHostTools(config) }
          : parsedFile("tools.json"),
        // The AI layer's semantics, read live off the same local disk leg as
        // tools.json: judgments.json is not a cloud config surface, and there
        // is no in-memory profile piece for it.
        judgments: parsedFile("judgments.json"),
        overrides: config.profile?.overrides
          ?? (overridesRaw === undefined ? undefined : JSON.parse(overridesRaw) as unknown),
      });
    } catch (error) {
      console.error(`[vendo] Failed to load .vendo tool semantics: ${error instanceof Error ? error.message : String(error)}. Run "vendo sync" to regenerate .vendo/tools.json.`);
      return undefined;
    }
  };
  // ONE composition call for every configured pack (architecture §5). It runs
  // here, before the catalog and the apps runtime, because two of its four slots
  // feed them: components → the catalog below, checks → the checking floor
  // createApps() is built with. The apps runtime it hands back to a pack tool is
  // a thunk for that reason — composed further down, resolved when a tool
  // actually runs, which is always inside a request.
  let appsForPacks: AppsRuntime | undefined;
  const packContext: PackContext = {
    apps: () => {
      if (appsForPacks === undefined) {
        throw new VendoError("not-implemented", "the apps runtime is not composed yet");
      }
      // A NEW object carrying only what the handle names, not the runtime with a
      // narrower type on it. `delete`, `publish` and `exportApp` live on the
      // runtime, and "no reaching into other packs" cannot rest on a type a pack
      // author is free to cast away — so the reach is closed by construction.
      return { agentTools: appsForPacks.agentTools.bind(appsForPacks) };
    },
  };
  const packs = mergePacks(config.packs ?? DEFAULT_PACKS, packContext);
  // A pack claiming one of the host's own tool names is a BOOT error, naming both
  // parties: the tool registry would refuse it anyway, but only on some later
  // request and only as "added registry". Compared against the host tool names
  // composition already has in hand — deliberately no I/O, so composing never
  // reaches the network to find out.
  const toolCollision = hostPackToolCollision(packs.toolOwners, hostToolNames(config));
  if (toolCollision !== undefined) throw toolCollision;
  // An explicit `packs:` without apps() leaves the agent unable to build apps.
  // Legitimate, but never silent.
  const noAppsPack = missingAppsPackWarning(config.packs === undefined ? undefined : packs.names);
  if (noAppsPack !== undefined) console.warn(noAppsPack);
  // Task 15a: an in-memory profile.catalog replaces the DISK leg of the merge
  // (it normalizes through the same validator-building path as the file
  // read); explicit createVendo({ catalog }) registrations still win by name,
  // and both win over a pack's components — the host has the last word about
  // its own screens.
  const catalog = mergeRuntimeCatalog(
    mergeRuntimeCatalog(
      config.profile?.catalog !== undefined
        ? runtimeCatalogFromFile(config.profile.catalog, "createVendo({ profile: { catalog } })")
        : runtimeCatalogFromJson(dotVendoFile("catalog.json", config.profileDir)),
      normalizeCatalogConfig(packs.components),
    ),
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
  // ADAPTER RULE, multi-party seam (build contract §9.6): sharing is
  // multi-party coordination, so the WRITES that create it need a key —
  // filled HERE, from the same one read every other Cloud default uses. The
  // enforcement half below (`appAccess`) is OSS and never key-conditional:
  // with no key no grant row can exist, so `can()` degenerates to ownership.
  const multiParty = appsCloud !== undefined;
  // §9.5's promote crosses subjects and moves workspace rows — raw-row work
  // that needs a local engine handle. A Cloud-hosted store answers through the
  // wire door instead and has none, so the seam stays unset there and promote
  // refuses loudly rather than half-moving an app. Resolved on FIRST PROMOTE,
  // never at compose: a host-passed store that is not a local engine handle
  // must not take down createVendo for a verb it may never call.
  const promoteRows = isHostedStore(store) ? undefined : {
    get rows() { return appStore(store); },
    get workspace() { return workspaceStore(store, { files }); },
  };
  // Wave 9 — the arming seam for ladder-authored automations: filled with the
  // automations engine composed BELOW (arming only happens inside requests,
  // which run after createVendo returns, so the closure reference is safe —
  // same pattern as the connections loadout seed).
  let automationsForArming: AutomationsEngine | undefined;
  // Build contract §9.3 — ONE `can()` over the host's store, held by the apps
  // runtime and the automations engine alike, so one rule answers both sides.
  const access = appAccess(store);
  const apps = createApps({
    store,
    guard,
    tools: boundTools,
    model: inference.agent.model,
    catalog,
    pinBaselines,
    // Build contract §9 — the multi-party half. `can()` over whatever store the
    // host wired (OSS, unconditional); `multiParty` is the Cloud gate on the
    // three writes that create sharing; `promoteApp` is the store's sanctioned
    // cross-subject door; `memberships` lets an unattended schedule fire assert
    // the same orgs a request does.
    appAccess: access,
    multiParty,
    // §9.5's order and its rollback rule live in promote-app.ts, where the
    // failure interleavings are testable; the getters keep `dbFor` lazy.
    ...(promoteRows === undefined ? {} : { promoteApp: createPromoteApp(promoteRows) }),
    ...(membershipsSeam === undefined ? {} : { memberships: membershipsSeam }),
    // Build contract §9.9 — sponsorship's two halves, composed HERE because
    // they cross the apps↔automations line and neither block may reach into
    // the other. Both ride the same late binding as `armAutomation` above
    // (automations is constructed after apps; every call happens later).
    //
    // The edit hook is what makes "anyone else editing invalidates the
    // sponsorship" true: the apps runtime knows who edited, the automations
    // engine knows who sponsors.
    //
    // Why these two seams NO-OP on an unset engine while `armAutomation` below
    // THROWS (F26 — deliberate, not an oversight): all three are unreachable
    // today, because nothing in this composition can skip constructing the
    // engine. If the invariant ever broke, the difference is what the caller
    // asked for. Arming is a request to CHANGE something; silently not arming an
    // automation the person just authored is the exact "quietly dropped work"
    // failure, so it refuses out loud. These two are enrichments of somebody
    // else's write and read: an app open and a landed edit must not fail because
    // the automations half is missing — there is simply no card and no
    // invalidation to report.
    onDocumentEdit: async (previous, next, editor) =>
      automationsForArming?.onDocumentEdit(previous, next, editor),
    // The adoption card is additive venue state on the open payload, under the
    // one key the tree renderer reads. Without this line the card exists and
    // nothing can ever show it, so a stopped automation would wait forever.
    venueState: async (app, ctx) => {
      // F24 — an app with no trigger has never been an automation, so it has no
      // sponsorship and nothing to adopt. Answering that from the document the
      // opener already holds keeps the adoption lookup's two store reads off
      // EVERY app open in every deployment, including the single-player ones
      // that have no automations at all.
      if (app.trigger === undefined) return undefined;
      const card = await automationsForArming?.adoption(app.id, ctx);
      return card === undefined ? undefined : { [ADOPTION_VENUE_KEY]: card };
    },
    // Build contract §9.8 — where the authenticated served-app proxy lives. The
    // wire owns its base path, so it is filled here and nowhere else; the apps
    // block never invents a URL for a door it does not mount.
    //
    // ABSOLUTE, like the personal branch's provider URL: an MCP client (or
    // anything not already sitting on the host origin) cannot resolve a relative
    // path. Serving an app means a machine, and machine provisioning already
    // requires VENDO_BASE_URL (see machineEnv), so the origin is always there —
    // and when it is not, the refusal names it rather than handing out a URL
    // nobody can follow.
    servedProxyPath: (appId: AppId) => {
      if (configuredBaseUrl === undefined) {
        throw new VendoError(
          "validation",
          "serving a team app needs VENDO_BASE_URL — the app's URL has to be absolute for anything "
          + "that is not already on this origin (an MCP client, a native app). Set it to this "
          + "deployment's public origin and restart.",
        );
      }
      return `${configuredBaseUrl.replace(/\/+$/, "")}${BASE_PATH}/apps/${encodeURIComponent(appId)}/serve/`;
    },
    // execution-v2 Waves 4+9 — the layer-2/3 experimental opt-ins, host-config
    // only (never an env var: enabling machine-backed execution or a surface
    // that runs generated web apps is a deliberate per-project decision).
    ...(config.apps?.experimentalServedApps === undefined ? {} : { experimentalServedApps: config.apps.experimentalServedApps }),
    ...(config.apps?.experimentalMachines === undefined ? {} : { experimentalMachines: config.apps.experimentalMachines }),
    // Round-2 hardening — the host's reviewer assertion for the review-kind
    // remix lifecycle, threaded verbatim (see the CreateVendoConfig comment).
    ...(config.apps?.review === undefined ? {} : { review: config.apps.review }),
    // Wave 9 — a ladder-authored automation is armed through the automations
    // engine's own enable(), so the 07 §3 grant-capture flow runs at creation
    // and the missing standing-grant approvals surface on the edit result.
    armAutomation: async (appId, armCtx) => {
      if (automationsForArming === undefined) {
        throw new VendoError("not-implemented", "the automations engine is not composed yet");
      }
      return automationsForArming.enable(appId, armCtx);
    },
    // The fast fill tier (models spec 2026-07-22, `models.paint` on the public
    // surface): the family fast pick when the agent slot rides the ladder, the
    // deprecated paint.model otherwise. There is ONE pipeline now, so the old
    // single-lane `disabled` switch has nothing left to disable.
    ...(inference.paint?.model === undefined ? {} : { fill: { model: inference.paint.model } }),
    ...(config.apps?.pipeline === undefined ? {} : { pipeline: config.apps.pipeline }),
    ...(config.apps?.fillConcurrency === undefined ? {} : { fillConcurrency: config.apps.fillConcurrency }),
    // The floor's plugged checks: the host's own, then every pack's. Appended,
    // never replacing — and a pack's judgment rules ride along here too, which
    // the floor splits out into the reviewer's rubric rather than running.
    checks: [...(config.apps?.checks ?? []), ...packs.checks],
    // cse lane 3 — theme/semantics flow as PROVIDER thunks so a
    // cloud-owned surface applies without a compose-time fetch. semantics
    // resolves live per generation (picks up cloud overrides as the snapshot warms);
    // theme is boot-once via memoizeOnce (structural, next-load). Each returns
    // undefined when unset, which the engine treats exactly as an omitted value.
    theme: themeProvider,
    designRules,
    ...(appsCloud === undefined ? {} : { cloud: cloudApps(appsCloud) }),
    semantics: hostSemanticsProvider,
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
  appsForPacks = apps;
  // Every pack's tools reach the ONE registry here — the same `add` the app
  // tools used to arrive through directly, so they are guarded, audited, and
  // projected identically. `apps()` is in `packs` by default, which is why
  // `apps.agentTools()` is no longer added by name: it comes in as a pack.
  actions.add(packs.tools);
  // Design §4's vendo verbs, projected onto the SAME registry as everything else
  // — guarded, audited, and searchable by `find_tools`, with no privileged side
  // door. `records_list/put/delete` are deliberately absent: they already ship as
  // `vendo_apps_data_*` through the apps pack, and those names are written inside
  // stored app documents (contract §8's lane-D ratification — renaming would
  // invalidate live apps for cosmetics).
  //
  // The building-apps skill teaches `validate` BY NAME, and a skill body is
  // copied to a harness verbatim rather than translated, so this name has to
  // resolve or the skill points the model at a tool that does not exist.
  // Design §4's one door for questions, on the same registry as everything else,
  // so the guard, the audit trail and `find_tools` see it like any host tool. A
  // question is TURN-ENDING (build contract §8 cuts steering): the door records
  // the question, the loop stops, and the answer arrives as the next turn's
  // message — so it needs no thread binding, no answer door and no surface.
  actions.add(askUserRegistry());
  actions.add(vendoVerbsRegistry({
    // The ctx is the CALLER's, handed down by the registry's own `execute` — not
    // assembled here and never read off the model's input. Both app-touching
    // verbs are owner-scoped behind it.
    validate: (input, ctx) => apps.validate(
      {
        ...(input.appId === undefined ? {} : { appId: input.appId as AppId }),
        ...(input.document === undefined ? {} : { document: input.document }),
      },
      ctx,
    ),
    searchComponents: async (query, limit) =>
      searchRuntimeCatalog(catalog, query, limit) as unknown as Json,
    schedule: async ({ appId, cron }, ctx) =>
      await apps.schedule(appId as AppId, cron, ctx) as unknown as Json,
  }));
  // One value, three readers: the agent's context, the harness bridge, and the
  // discovery registry — which bounds its own search under it rather than being
  // cut by it (the cap slices serialized JSON, so a search that reaches it loses
  // a schema mid-object).
  const toolOutputCap = agentOptions.toolOutputCap ?? DEFAULT_TOOL_OUTPUT_CAP;
  // The connector-discovery tools (design 2026-08-03), on the SAME registry, each
  // only as far as an adapter backs it — the "no adapter, no tool" rule knowledge
  // follows below, applied per tool rather than per registry.
  //
  // `list_connections` answers a standalone question ("what can I connect?") and
  // needs nothing but a connector. The CATALOG PAIR needs all THREE halves of the
  // find → use loop from the same connector: only the broker can index tens of
  // thousands of third-party tools (`searchTools`), only it can grade them
  // (`toolRisk`, which is also how a slug is claimed below), and only it can run
  // them (`executeSlug`). Anything less projects a tool the model can see and can
  // never successfully use — there is deliberately no fallback, no keyword scoring
  // (design §Deletions) and no name-based inference (§12, #747). The zero-key Cloud
  // default connector has no search backend, so a Cloud-default host is projected
  // `list_connections` alone rather than a search that answers nothing.
  //
  // The ports read seams declared BELOW this line (`connections`,
  // `connectedToolkitsFor`), the established pattern here: a port body only runs on
  // a real tool call, long after createVendo has returned.
  const catalogConnectors = resolvedConnectors.filter((connector) =>
    connector.searchTools !== undefined
    && connector.toolRisk !== undefined
    && connector.executeSlug !== undefined);
  const serviceCatalog = catalogConnectors.length > 0;
  if (resolvedConnectors.length > 0) {
    actions.add(connectorDiscoveryRegistry({
      ...(serviceCatalog ? {
        // The BROKER's own search, not ours. Composio is never named here — a
        // connector fills the slot or nothing does. `findCtx` is the CALLER's, so
        // each match's `connected` is that person's answer, not the deployment's,
        // and the fan-out is over the SAME connectors `use_service_tool` can
        // reach, or the model would be handed rows it can never run.
        find: async (need, findCtx) => (await Promise.all(
          catalogConnectors.map((connector) => connector.searchTools!(need, findCtx)),
        )).flat(),
        // The outcome travels back VERBATIM: the guard lifts its `connectorAccount`
        // passthrough onto the audit row, which is how a connector call gets its
        // toolkit named without a second audit path. `undefined` = no connector
        // serves this slug, and the tool turns that into "search first".
        use: async (slug, args, useCtx) => {
          const owner = await serviceToolOwner(slug);
          return owner === undefined ? undefined : await owner.connector.executeSlug!(slug, args, useCtx);
        },
      } : {}),
      // The connect dock's catalog (toolkits with an enabled auth config),
      // annotated per subject from the same cache the connect gate reads.
      list: async (listCtx) => {
        const [connectable, connected] = await Promise.all([
          connections.catalog(),
          connectedToolkitsFor(listCtx).then((toolkits) => new Set(toolkits)),
        ]);
        return connectable.map((entry) => ({
          toolkit: entry.toolkit,
          ...(entry.label === undefined ? {} : { label: entry.label }),
          ...(entry.description === undefined ? {} : { description: entry.description }),
          connected: connected.has(entry.toolkit),
        })) as unknown as Json;
      },
    }, { toolOutputCap }));
  }
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
  const hostInstructions = agentOptions.instructions?.trim();
  const system = product !== undefined || hostInstructions || promptCatalog !== undefined || knowledgeIndex !== undefined
    ? {
        ...(product === undefined ? {} : { product }),
        ...(promptCatalog === undefined ? {} : { catalog: promptCatalog }),
        ...(knowledgeIndex === undefined ? {} : { knowledge: knowledgeIndex }),
        ...(hostInstructions ? { instructions: hostInstructions } : {}),
      }
    : undefined;
  // ONE definition of each discovery rail, driven by BOTH thinkers: `createAgent`
  // below and the harness runtime after it. Written twice, they would drift — and
  // a rail that exists on one path and not the other is exactly why `POST /threads`
  // could not be pointed at the harness by default.
  const capabilityMiss: CapabilityMissConfig = {
    hostId: missCapture.hostId,
    surface: () => missSurface().then(({ hash }) => ({ format: "vendo/tools@1" as const, hash })),
    emit: (event) => missCapture.record(event),
  };
  // ENG-252: the agent starts with a bounded loadout and discovers the rest via
  // `find_tools`. The search seam is the SAME guard-bound registry the
  // agent executes through — a searched-in tool has no unguarded path.
  const toolSearch: ToolSearchConfig = {
    // Annotate results the subject cannot run yet. The tool description and the
    // system prompt both promise this, and the connect-card flow depends on it;
    // same predicate the connect gate executes against, so the annotation and
    // the refusal can never disagree.
    connectRequired: async (toolkit, toolkitCtx) => !(await subjectHasToolkit(toolkit, toolkitCtx)),
    // A curated agent menu has to hold at BOTH doors into the toolset: the
    // per-turn seed below and search. Filtering only the seed would let the
    // model search its way back to an off-menu tool.
    search: async (query, options) => onAgentMenu(
      await actions.search(query, options),
      (match) => match.name,
    ),
    // Connection-scoped loadout seed (spec 2026-07-20): each turn starts
    // with host tools + the principal's connected toolkits — never an
    // alphabetical slice of a lazy catalog. `connections` is declared below
    // this composition; turns only run after createVendo returns, so the
    // closure reference is safe.
    seed: () => loadoutSeedFor(),
    // The curated agent menu also binds an explicit `agent.loadout`: host
    // config chooses WITHIN the menu, it does not escape it.
    menu: async () => {
      const menu = await agentMenu();
      return menu === undefined ? undefined : [...menu];
    },
    ...(agentOptions.maxInitialTools === undefined ? {} : { maxInitialTools: agentOptions.maxInitialTools }),
    ...(agentOptions.loadout === undefined ? {} : { loadout: agentOptions.loadout }),
  };
  const agent = createAgent({
    model: inference.agent.model,
    tools: boundTools,
    guard,
    store,
    ...(system === undefined ? {} : { system }),
    context: {
      toolOutputCap,
      ...(agentOptions.maxOutputTokens === undefined ? {} : { maxOutputTokens: agentOptions.maxOutputTokens }),
      ...(agentOptions.historyWindow === undefined ? {} : { historyWindow: agentOptions.historyWindow }),
      ...(agentOptions.maxSteps === undefined ? {} : { maxSteps: agentOptions.maxSteps }),
    },
    capabilityMiss,
    toolSearch,
    // Discovery-discipline: the same connect check the gate-wrapped registry
    // runs, exposed so needsApproval never mints an approval for a call the
    // gate will refuse with a connect card.
    preflight: (call, ctx) => connectGate.check(call, ctx),
    // Tour mode. Composed only when a host configured tours, so a deployment
    // without them has no seam to pay for and no way to grow one.
    ...(config.tours === undefined || config.tours.length === 0
      ? {}
      : { scripted: createTourScript({ tours: config.tours, apps }) }),
  });
  // Architecture §3 — WHO THINKS, composed ONCE.
  //
  // This used to be two constructions: a throwaway `vendo()` here for the boot
  // gate, and a second `vendo({ onHire: reportHire })` inside harness-turn.ts as
  // the fallback that actually ran. The gate was therefore asserting a value that
  // was never served, and the two differed (only one reported its hires). One
  // value now, resolved here and passed down, so the harness the gate checks IS
  // the harness the turn runs.
  //
  // `assertHarnessComposable` is the BOOT gate: a harness that needs a machine to
  // live on and has none is a wiring mistake the host hears about here, not a turn
  // that dies in front of a user. Checked against the resolved harness because a
  // default is still a choice that has to hold.
  // A composed agent IS a harness choice (its brain, with its knobs already
  // bound and its sandbox already injected), so it takes the same slot.
  const harness = (composed?.harness ?? config.harness ?? vendo({ onHire: reportHire })) as Harness;
  assertHarnessComposable(harness, sandbox.adapter === undefined ? {} : { sandbox: sandbox.adapter });
  // The harness runtime, wired to everything a turn needs: the store handle (its
  // transcript and its workspace), the ONE guard-bound registry, the merged pack
  // skills projected into `/host/skills`, and the resolved model seats. The
  // per-turn halves it cannot know (thread, workspace, ctx-shaped prompt and
  // descriptor catalog) are resolved in harness-turn.ts.
  // Hoisted above the harness runtime: a harness whose thinker runs on a
  // MACHINE needs to know whether a door exists at all before it can be told
  // where to reach it. `mcp: true` and `mcp: {…}` both open the door; the
  // object form carries door options.
  const mcpOptions = typeof config.mcp === "object" && config.mcp !== null
    ? config.mcp
    : config.mcp === true
      ? {}
      : undefined;
  /**
   * THE COMPOSITION RULE — the two decisions are decoupled.
   *
   * `mcp` is the host saying "my users may connect third-party agents to my
   * product", and it opens the whole door. A harness that thinks outside this
   * process reaches `turn.tools` over the same door (10-mcp §3b) and needs one
   * whether or not the host ever said that — so declaring `requires.toolDoor`
   * mounts the INTERNAL half by itself, with no config value to write and
   * nothing exposed. `mcp` set wins: the full door already serves both spaces.
   */
  const internalDoorOnly = mcpOptions === undefined && harness.requires?.toolDoor === true;
  /**
   * The one origin a machine-less thinker may dial when the operator named
   * none — learned from the wire, and kept separate from the base route
   * bindings resolve against because the two answer different questions.
   *
   * A request origin is the Host header, which the caller controls. Both
   * learners are therefore fenced to LOOPBACK, and each is fixed by the first
   * request that qualifies: a spoofed `Host: attacker.evil` is never a
   * candidate, and a second loopback Host cannot displace the first. Loopback
   * is exactly where a machine-less thinker's subprocess lives, so zero-config
   * development loses nothing.
   *
   * This one gates whether a turn credential may be MINTED against an origin;
   * `baseUrlTrusted` below gates whether the CALLER's cookie and bearer may
   * ride one. Both were poisonable before they were fenced.
   */
  let learnedLoopbackOrigin: string | undefined;
  /**
   * Where the harness's thinker dials the door.
   *
   * The operator-set public origin is the only one a MACHINE may ever be given:
   * a box holding a live turn credential must never be pointed anywhere a
   * request header could name, and loopback is not reachable from a box in any
   * case. A harness that needs NO machine thinks inside this host's own
   * process, so it may fall back to the learned loopback origin — which is what
   * lets `claudeCode({ machine: "local" })` run with nothing configured at all.
   *
   * This rule is about the HARNESS's door target, so it applies identically to
   * an `mcp: true` composition and to an internal-only one.
   */
  const doorBase = (): string | undefined => mcpOptions?.baseUrl
    ?? configuredBaseUrl
    ?? (harness.requires?.sandbox === true ? undefined : learnedLoopbackOrigin);

  const harnessTurns = createHarnessTurns({
    harness: harness as Harness<never>,
    // The composed sandbox adapter, threaded through so a spawned harness's
    // machine slot is filled by the SAME adapter the boot gate approved.
    // Without this line, `createVendo({ sandbox, harness: claudeCode() })`
    // boots green and then refuses every turn (wave-2 lane E blocker B2).
    ...(sandbox.adapter === undefined ? {} : { sandbox: sandbox.adapter }),
    store,
    // The SAME adapter the erase cascade deletes through (selectStore) — the
    // whole point of resolving it once.
    files,
    guard,
    tools: boundTools,
    packSkills: packs.skills,
    // The SAME normalized catalog the prompt summary is built from, so the
    // reference files on the mount and the components the model is told about
    // can never name different sets.
    catalog,
    models: inference.seats,
    system: async (ctx, opts) => assembleSystemPrompt(
      guard,
      ctx,
      system,
      // Both rails now reach the harness path (`createDiscoveryRails`), so the
      // prompt may promise them — and must, or the model is handed the miss
      // reporter and a discovery rail with no instructions about either. WHICH
      // discovery section rides is the turn's to say: an uncurated surface has no
      // `find_tools`, so teaching it would name a tool that is not there.
      true,
      opts?.discovery ?? "find-tools",
    ),
    // Projected for THIS ctx, so THE LAW's unattended filter (design §12) decides
    // what the model is even shown — not just what it is allowed to run.
    descriptors: (ctx) => boundTools.descriptors(ctx),
    // THE SAME rail values `createAgent` above was handed, so the two thinkers
    // cannot diverge on discovery, curation, or honest refusal.
    toolSearch,
    capabilityMiss,
    // The SAME condition the catalog pair is gated on above. The section teaches
    // `find_service_tools` and `use_service_tool` by name, so it rides only where
    // they are projected — a deployment with `list_connections` alone (the
    // zero-key Cloud default) is taught nothing rather than two tools that are
    // not on its listing.
    connectorDiscovery: serviceCatalog,
    bridge: () => ({ toolOutputCap, preflight: (call, ctx) => connectGate.check(call, ctx) }),
    // §1.6's app half. Without it a files-first app (D4) is a PICTURE of an app: no
    // store row, so it never lists and `vendo_apps_open` masks it as not-found, and
    // no query data, so every value renders "—" with the real host data one call away.
    render: (ctx) => ({ authoredApp: (input) => apps.authored(input, ctx) }),
    // Build contract §9.1/§9.7 — the same host org query the wire resolves per
    // request, so a harness turn's façade mounts the team's files too.
    ...(membershipsSeam === undefined ? {} : { memberships: membershipsSeam }),
    // Every turn, published for the door's turn credential. Publishing is not a
    // grant: without a credential minted from inside the turn there is nothing
    // to resolve, and the credential's authority window IS this publication.
    liveTurn: ({ threadId, ctx, tools }) => turnCredentials.publish(threadId, { ctx, tools }),
    // The other half, for a harness whose thinker is not in this process: where
    // the door is, and how to mint one conversation's credential for it. `url`
    // is undefined when nothing this harness may dial exists — a machine cannot
    // reach a door nobody can name, and the harness says so in the operator's
    // voice rather than opening a session that would 401 on its first tool call.
    // Read per turn, not captured: with no operator base the origin is learned
    // from the wire's first validated request, which is the one that arrives.
    ...(mcpOptions !== undefined || internalDoorOnly ? {
      toolDoor: {
        get url(): string | undefined {
          const base = doorBase();
          return base === undefined ? undefined : new URL(MCP_MOUNT, base).toString();
        },
        // Which of the two mounts this is, stated rather than inferred. With no
        // origin the harness has to tell a host whose `mcp` cannot be reached
        // (refuse — they asked for a door) from a host who never asked at all
        // (run workspace-only — nothing is misconfigured). `internalDoorOnly`
        // is exactly that fact and it is only known HERE.
        autoMounted: internalDoorOnly,
        mint: (threadId: string) => turnCredentials.mint(threadId),
        revoke: (token: string) => turnCredentials.revoke(token),
      },
    } : {}),
    // Tour mode, composed on THIS door too. `createAgent` below takes the same
    // hook, but post-flip the harness door is the one `POST /threads` reaches
    // for every SQL-capable store — wiring only the agent would leave tours
    // silently dead on the shipped default. One script, both doors.
    ...(config.tours === undefined || config.tours.length === 0
      ? {}
      : { scripted: createTourScript({ tours: config.tours, apps }) }),
  });
  /**
   * THE harness door — one object, served two ways.
   *
   * `vendo.harness` (the host's/proofs' direct handle) and the wire's chat route
   * are the SAME value. They used to be two: the returned door wrapped the
   * `ready()` latch around `harnessTurns`, and `createWireHandler` was handed the
   * raw one. That was harmless while the wire path was opt-in and the wire
   * awaited `ready()` itself, but the wave-2 flip makes this the path every host
   * takes, and two objects means "what a host can drive" and "what a request
   * actually runs" can drift. `ready()` is an idempotent latch, so latching twice
   * on the wire path costs a resolved promise.
   */
  const harnessDoor: HarnessTurns = {
    stream: async (input) => {
      await ready();
      return harnessTurns.stream(input);
    },
    workspace: async (principal, opts) => {
      await ready();
      return harnessTurns.workspace(principal, opts);
    },
  };
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
   *  the runtime's plumbing (gating `vendo_apps_*` or `find_tools` out
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
  // No `connectedToolkitsFor` read: the seed stopped narrowing by connected
  // toolkit when lazy expansion went, and keeping the call would have spent a
  // broker round-trip per turn on an argument nobody reads.
  async function loadoutSeedFor(): Promise<string[]> {
    return onAgentMenu(await actions.loadoutSeed(), (name) => name);
  }
  /** Which connector owns a broker slug, and the grade IT assigned.
   *
   * `toolRisk` answers ownership and grading in one call: the adapter contract
   * defines `undefined` as "this slug is not mine" and every other answer —
   * `ungraded` included — as a real grade. Using ONE predicate for both means
   * the risk the guard decided on and the connector that runs the call can never
   * disagree. Searched over `catalogConnectors` — exactly the set the tool pair
   * was projected for — so every row the model was shown is dispatchable and
   * nothing else is. First owner wins. */
  async function serviceToolOwner(slug: string): Promise<{ connector: Connector; risk: RiskLabel } | undefined> {
    for (const connector of catalogConnectors) {
      const risk = await connector.toolRisk!(slug);
      if (risk !== undefined) return { connector, risk };
    }
    return undefined;
  }
  /** The per-slug half of `use_service_tool`'s grade. Its DESCRIPTOR is
   * `ungraded` — one tool name standing in for a whole third-party catalog
   * cannot carry a real grade — and this replaces it with the grade the broker
   * assigned to the slug THIS call names, which is the grading nobody else can
   * do at catalog scale.
   *
   * A slug nobody owns grades `read`: the dispatcher answers "no such tool"
   * without touching anything, and leaving it `ungraded` would park an approval
   * card for a call that CANNOT run — the approval spam the pre-guard connect
   * gate exists to stop. That is safe only because ownership and grading are the
   * same lookup above: unowned means unrunnable, not merely ungraded. */
  async function serviceToolRisk(call: ToolCall): Promise<RiskLabel | undefined> {
    if (call.tool !== USE_SERVICE_TOOL) return undefined;
    const slug = (call.args as { slug?: unknown } | undefined)?.slug;
    if (typeof slug !== "string") return undefined;
    return (await serviceToolOwner(slug))?.risk ?? "read";
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
  // PROCESS (self-serve audit F7: a dev server recomposes on nearly every request,
  // so "once per composition" printed this paragraph 29 times in one short
  // session), same latch posture as hostedSessionOps' door warn above.
  const hostedStoreComposed = isHostedStore(store);
  if (hostedStoreComposed && !hostedStoreNoticePrinted) {
    hostedStoreNoticePrinted = true;
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
    resolveRisk,
    // Build contract §9.3 — the fire-time sponsorship gate and the adoption
    // card ask `can(editor)` through this seam. Unwired it would silently fall
    // back to ownership and an editor-adopted automation would stop dead at its
    // next fire.
    appAccess: access,
    // Build contract §9.1 — an away run asserts the owner's orgs the same way a
    // request does; the callback is host server code in this deployment, so the
    // absence of a session is not in its way.
    ...(membershipsSeam === undefined ? {} : { memberships: membershipsSeam }),
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
  /**
   * 10-mcp §3b — the process's own turn-credential registry.
   *
   * Created unconditionally and BEFORE the door, because both ends attach to it:
   * the harness runtime publishes every live turn here, and a composed door
   * resolves harness bearers through it. It grants nothing on its own — a
   * credential only exists once a harness mints one from inside its own turn.
   */
  const turnCredentials: TurnCredentials = createTurnCredentials();
  let door: McpDoor | undefined;
  // The /status posture for the mcp block (connections-posture pattern):
  // false when the door is closed, "local" when it serves its own OAuth
  // surface, "broker" when an external authorization server fronts it —
  // ensured from the Cloud broker or explicitly configured. A `let` read
  // through a deps getter, so the ensure-failure degrade below reports what
  // actually composed.
  let mcpPosture: "local" | "broker" | false = false;
  // The seam's selection, kept beside the posture for the dev-only
  // /doctor/mcp probe (wire/doctor.ts): the posture collapses explicit
  // `mcp.remoteAs` and the Cloud-managed broker into "broker", and doctor
  // needs the distinction to never ensure a tenant for an explicit AS.
  let mcpSelection: "off" | "explicit" | "broker" | "local" = "off";
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
    const composeDoor = (
      remoteAs = mcpOptions.remoteAs,
      federation = mcpOptions.federation,
    ): McpDoor => createMcpDoor({
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
      // Build contract §9.1 — the FOURTH door gets the same seam as the wire,
      // the harness and the automations engine. `can()` reads the caller's orgs
      // off the ctx and never queries them (§9.3), so without this an
      // `org:`/`team:` grant can never match here: a team app shared with the
      // caller would be absent from list and not-found on open, over MCP only.
      ...(membershipsSeam === undefined ? {} : { memberships: membershipsSeam }),
      // The door's SECOND credential space (10-mcp §3b): a harness bearer is
      // answered from the live turn it names, with that turn's venue, presence,
      // equipped tools and approval card. The outside-agent path is untouched —
      // the two spaces never meet (`mcp-door-outside-agent.e2e.test.ts`).
      turnCredentials,
      mount: MCP_MOUNT,
      ...(doorBaseUrl === undefined ? {} : { baseUrl: doorBaseUrl }),
      // 10-mcp §3.1/§3.2 — broker-fronted compositions: trust the external
      // authorization server's tokens and answer its login federation.
      ...(remoteAs === undefined ? {} : { remoteAs }),
      ...(federation === undefined ? {} : { federation }),
      ...(theme === undefined ? {} : { theme }),
    });
    // ADAPTER RULE, mcp seam (selectMcpBroker — cloned from selectConnections
    // above): explicit `mcp.remoteAs` wins verbatim; else VENDO_API_KEY plus a
    // PUBLIC base URL default the hosted broker (an idempotent ensure-tenant
    // call wires remoteAs + federation from the response); else the local
    // door, byte-identical to today. The localhost rule and the ensure wire
    // are frozen in the provisioning plan.
    const mcpCloud = cloudKeyOptions();
    const selection = selectMcpBroker(mcpOptions, mcpCloud, doorBaseUrl, MCP_MOUNT);
    mcpSelection = selection.mode;
    if (selection.mode === "broker" && mcpCloud !== undefined) {
      mcpPosture = "broker";
      // Boot-once, awaited: the first door construction rides the ready latch
      // (warmMcpBroker above) so the trust anchor is resolved before the first
      // request is served — and the wrapper below awaits the same latch, so a
      // door request can never race a half-composed door.
      let brokerDoor: Promise<McpDoor> | undefined;
      const composeBrokerDoor = async (): Promise<McpDoor> => {
        try {
          const { tenant, federationSecret } = await cloudMcpTenant(mcpCloud).ensure(selection.ensure);
          return composeDoor(
            { issuer: tenant.issuer, audience: tenant.audience },
            { secret: federationSecret },
          );
        } catch (error) {
          // Same degrade posture as the hosted overrides fetch above: a
          // console blip must not kill boot. Loud, once, then the local door
          // for this composition's lifetime; the next boot re-ensures.
          mcpPosture = "local";
          console.warn(
            "[vendo] hosted MCP broker ensure-tenant failed; the door serves its own local OAuth "
            + `surface this boot: ${error instanceof Error ? error.message : String(error)}`,
          );
          return composeDoor();
        }
      };
      const doorReady = (): Promise<McpDoor> => (brokerDoor ??= composeBrokerDoor());
      warmMcpBroker = async () => { await doorReady(); };
      door = {
        handler: async (request) => (await doorReady()).handler(request),
        revokeClient: async (subject, clientId) => (await doorReady()).revokeClient(subject, clientId),
      };
    } else {
      mcpPosture = selection.mode === "explicit" ? "broker" : "local";
      door = composeDoor();
    }
  } else if (internalDoorOnly) {
    // The INTERNAL half alone. It answers one live turn's credential and
    // nothing else, so it is handed only what that leg reads: the credential
    // registry and where it lives. No oauth (there is no space to sign into),
    // no apps ride-alongs, no `surfaces.mcp` menu, no theme — a turn's tools,
    // curation and rendering are all decided by the turn. The broker seam
    // (selectMcpBroker above) never applies here: there is no outside OAuth
    // surface for an external authorization server to front, so this half
    // keeps `mcp: false` posture like any closed door.
    door = createMcpDoor({
      internal: true,
      tools: boundTools,
      guard,
      store,
      turnCredentials,
      mount: MCP_MOUNT,
      ...(configuredBaseUrl === undefined ? {} : { baseUrl: configuredBaseUrl }),
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
  const handler = createWireHandler({
    principal: resolvePrincipal,
    ...(membershipsSeam === undefined ? {} : { memberships: membershipsSeam }),
    ...(resolvePersonSeam === undefined ? {} : { resolvePerson: resolvePersonSeam }),
    ready,
    trustedBaseIsHttps,
    get sessionId() { return sessionId(); },
    store,
    telemetry: telemetryClient(config.telemetry),
    agent,
    // THE FLIP (wave 2). Every chat turn goes through the harness runtime —
    // `harness:` when the host named one, `vendo()` when they did not. The four
    // rails this waited on (`find_tools`, the connection-scoped loadout, the
    // curated agent menu, capability-miss detection) reach the harness path, and
    // the assembled prompt rides the turn, so the two paths are the same turn with
    // one swappable thinker. Keeping the default on `agent.stream` meant every
    // harness improvement shipped to nobody.
    //
    // ONE exception, and it is a capability fact rather than a preference: serving
    // a turn through a harness needs the transcript and workspace TABLES (build
    // contract §3.3/§6). A store with no SQL handle — the Cloud hosted store in
    // wave 1, or a host's own non-SQL adapter — cannot serve them, and flipping
    // such a deployment would turn every chat turn into a boot-shaped error. Those
    // stay on `agent.stream`, which needs neither table. The probe is a WeakMap
    // lookup inside @vendoai/store, not I/O, so it is safe at module init.
    ...(storeServesHarnessTurns(store) ? { harness: harnessDoor } : {}),
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
    get mcp() { return mcpPosture; },
    mcpSelection,
    development,
    sessions: {
      ttlMs: sessionsConfig.ttlMs,
      sweepIntervalMs: sessionsConfig.sweepIntervalMs,
      now: sessionNow,
    },
    sessionStore: sessionOps,
    sweep: runSweep,
    sweepEnabled,
    // Serverless hosts (the hosted store's typical deployment) fire no
    // interval timer, so the authenticated tick carries the sweep for them.
    sweepOnTick: sweepEnabled && hostedStoreComposed,
    ...(door === undefined ? {} : { door }),
    onRequestOrigin: (origin) => {
      // Same-origin default for route-binding execution (04): no VENDO_BASE_URL
      // → the wire's own origin, learned from the first VALIDATED request and
      // then fixed.
      if (actionsConfig.baseUrl === undefined) {
        actionsConfig.baseUrl = origin;
        // 09-vendo §2 install-dx wave 1.1: NODE_ENV=development trusts its own
        // learned origin, so present-mode calls forward the caller's `cookie`
        // and `authorization` to it. That trust is fenced to LOOPBACK, because
        // a request origin IS the Host header: without the fence, one request
        // carrying `Host: attacker.evil` fixed the base process-wide and sent
        // the caller's real session cookie and bearer to the attacker on every
        // present-mode call after it (measured, `server.test.ts` SECURITY pins).
        // Same rule and same predicate as the tool door below — one authority.
        //
        // Only the TRUST is fenced, never the base itself: resolving route
        // bindings same-origin with zero config is what the learner is for, and
        // an untrusted base still resolves, exactly as it does in production.
        actionsConfig.baseUrlTrusted = isDevelopmentEnv && isLoopbackOrigin(origin);
      }
      // The TOOL DOOR's own learned origin, kept separate because it answers a
      // different question — not "may credentials ride this?" but "may a turn
      // credential be MINTED against this?". Same loopback rule, first one wins.
      if (learnedLoopbackOrigin === undefined && isDevelopmentEnv && isLoopbackOrigin(origin)) {
        learnedLoopbackOrigin = origin;
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
    // The SAME door the wire's chat route runs (see `harnessDoor`), latched by
    // `ready()` because a harness turn reads the transcript and writes workspace
    // rows, so the schema has to be there first.
    harness: harnessDoor,
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
