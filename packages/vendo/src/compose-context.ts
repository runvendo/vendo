/**
 * The closure `createVendo` used to be.
 *
 * 09-vendo §2 composes eleven blocks around one guard choke point, and it did
 * that inside a single 2,000-line function whose bindings all reached each
 * other by scope. This interface is that closure, named: every phase module
 * below takes the composition, reads the fields it needs, and returns its own
 * slice of it. `createComposition` wires the phases in the SAME order the one
 * function ran them, because the order is load-bearing (a boot warning, a
 * refusal, and three registry `add`s all have to land where they landed).
 *
 * A handful of fields are filled LATER than the phase that declares them —
 * the app-tool risk resolver, the learned loopback origin, the MCP posture.
 * They were `let` bindings read from closures that only run inside a request;
 * they are mutable fields here, read the same way, at the same time.
 *
 * Internal — not exported from the package root.
 */
import type {
  ActionsRegistry,
  Connector,
  ExtractedTool,
  OverridesFile,
  ServerActionHandler,
} from "@vendoai/actions";
import type { AgentComposition } from "@vendoai/agents";
import type { AppsRuntime, SeedBaseline } from "@vendoai/apps";
import type { AutomationsEngine } from "@vendoai/automations";
import type {
  ActAs,
  AgentRunner,
  CreateAutomation,
  FilesAdapter,
  Harness,
  Principal,
  RiskLabel,
  RunContext,
  SecretsProvider,
  StoreOps,
  ToolCall,
  ToolRegistry,
} from "@vendoai/core";
import type {
  BriefingPack,
  VendoTheme,
} from "@vendoai/apps/contract";
import type { VendoGuard, RiskResolver } from "@vendoai/guard";
import type { CapabilityMissConfig } from "@vendoai/harnesses";
import type { VendoToolSearchConfig } from "@vendoai/harnesses/vendo";
import type { McpDoor, TurnCredentials } from "@vendoai/mcp";
import type { VendoStore } from "@vendoai/store";
import type { createByoApprovals } from "./byo-approvals.js";
import type { McpBundle } from "./cloud-mcp.js";
import type { CapabilitySurfaceSnapshot } from "./capability-misses.js";
import type { MergedCapability } from "./capability/index.js";
import type { mergeRuntimeCatalog } from "./catalog.js";
import type { CloudDirectory } from "./cloud-directory.js";
import { composeActions } from "./compose-actions.js";
import { composeApps } from "./compose-apps.js";
import { composeAutomations } from "./compose-automations.js";
import { composeChannels } from "./compose-channels.js";
import { composeAdapters, composeReady } from "./compose-adapters.js";
import { composeConfig } from "./compose-config.js";
import { composeConnections, composeDiscovery } from "./compose-discovery.js";
import { composeGuard } from "./compose-guard.js";
import { composeHarness } from "./compose-harness.js";
import { composeMcp } from "./compose-mcp.js";
import { composePrompt } from "./compose-prompt.js";
import { composeSurfaces } from "./compose-surfaces.js";
import { composeSweep } from "./compose-sweep.js";
import { composeTools, emitDeploymentBoot } from "./compose-tools.js";
import { composeLimits, type Limiter } from "./limits.js";
import type { ConfigSurfaceName } from "./config-surface.js";
import type { ResolvedSweep } from "./compose-config.js";
import type { ChannelDoor, ChannelsService } from "./channels.js";
import type { ConnectionsService } from "./connections.js";
import type { HarnessTurns } from "./harness-turn.js";
import type { resolveModels } from "./models-config.js";
import type { TenantConnectors } from "./tenant-connectors.js";
import type { AppsOptions, CreateVendoConfig } from "./types.js";
import type { resolveVendoUrls } from "./urls.js";
import type { WireDeps } from "./wire/shared.js";
import type { createConnectGate, mergedHostSemantics } from "@vendoai/actions";
import type { createAppTokens } from "@vendoai/apps";
import type { selectSandbox } from "@vendoai/apps";
import type { appAccess } from "@vendoai/store";
import type { HostAuthPreset } from "./auth-presets/index.js";

/** The actions registry config object, named because composition MUTATES two of
 *  its fields after `createActions` has read the rest (`invokeTool` after the
 *  guard binding, `baseUrl` when the wire learns its own origin). */
export interface VendoActionsConfig {
  dir: string;
  tools?: ExtractedTool[];
  /** The in-memory doc (profile.overrides); otherwise the registry reads
   *  `.vendo/overrides.json` off `dir` itself. */
  overrides?: OverridesFile | (() => Promise<OverridesFile | undefined>);
  connectors?: Connector[];
  actAs?: ActAs;
  serverActions?: Record<string, ServerActionHandler>;
  baseUrl?: string;
  baseUrlTrusted?: boolean;
  fetch?: typeof fetch;
  onPresentCredentialsNotForwarded: (event: {
    ctx: RunContext;
    tool: import("@vendoai/core").ToolDescriptor;
    reason: "untrusted-host-origin" | "cross-origin-binding";
  }) => Promise<void>;
  untrustedOriginPolicy?: "warn" | "fail";
  invokeTool?: ToolRegistry["execute"];
}

export interface VendoComposition {
  // ── compose-config.ts ──────────────────────────────────────────────────────
  /** Whether app generation mounts (`apps: false` folds away to no options). */
  appsMounted: boolean;
  /** Whether the automations engine mounts. */
  automationsMounted: boolean;
  /** The host's config with `apps: false` folded away. */
  config: Omit<CreateVendoConfig, "apps"> & { apps?: AppsOptions };
  /** What `agent()` from @vendoai/agents composed, when the host adopted one. */
  composed: AgentComposition | undefined;
  resolvePrincipal: (req: Request) => Promise<Principal | null>;
  actAsSeam: ActAs | undefined;
  oauthSeam: HostAuthPreset["oauth"];
  /** Build contract §9.1 — the host org query the wire, the harness, the
   *  automations engine and the MCP door all resolve the SAME answer through. */
  membershipsSeam: HostAuthPreset["memberships"];
  /** The hosted tenant directory, when VENDO_API_KEY filled a `memberships`
   *  seam the host left unset — `undefined` whenever the host asserted its own.
   *  Read a second time by composeLimits, off the SAME cache. */
  directory: CloudDirectory | undefined;
  userFactsSeam: HostAuthPreset["facts"];
  userPoolsSeam: HostAuthPreset["pools"];
  sweepConfig: ResolvedSweep;
  sweepNow: () => number;

  // ── limits.ts ──────────────────────────────────────────────────────────────
  /** The host's `limits` policy, bound to the store's meter — `undefined` when
   *  the host set no policy, which is what every choke point checks. */
  limiter: Limiter | undefined;

  // ── compose-adapters.ts ────────────────────────────────────────────────────
  store: VendoStore;
  /** THE files adapter for this deployment (build contract §3.4). */
  files: FilesAdapter;
  /** The 42-op StoreOps surface for this deployment — the store's own when it
   *  carries one, the local backend over its SQL handle otherwise, and absent
   *  when the store offers neither (`backendOf`'s third answer). */
  ops: StoreOps | undefined;
  sandbox: ReturnType<typeof selectSandbox>;
  secrets: SecretsProvider;
  inference: ReturnType<typeof resolveModels>;
  /** One resolution cycle happened: re-hash the five resolved surfaces and
   *  report them if they moved (config-report.ts). No-op without a key. */
  reportConfig: () => void;
  surfaceRoot: string | undefined;
  readSurfaceFile: (name: ConfigSurfaceName) => string | undefined;
  memoizeOnce: <T>(resolve: () => T | undefined) => () => T | undefined;
  /** Armed by the ready() latch, never at construction (Workers forbids timers
   *  in global scope). Filled by compose-sweep.ts. */
  startBackgroundSweep: () => void;
  /** A DEVELOPMENT process drives its own scheduler tick — the production tick
   *  is an external caller's job (POST /tick, or Cloud for hosted deploys) and
   *  no laptop has one. Same ready()-latch arming as the sweep. Filled by
   *  compose-automations.ts; a no-op outside development. */
  startDevAutomationsTicker: () => void;
  /** The other half: a DEPLOYED process is woken by Cloud's heartbeat, which can
   *  only knock on a door it has been told about. Same ready()-latch firing;
   *  never rejects, and shouts if it could not enrol. Filled by
   *  compose-automations.ts. */
  enrolForCloudTicks: () => Promise<void>;
  /** The boot-once latch every handler/emit touch awaits. */
  ready: () => Promise<void>;
  /** Filled by compose-apps.ts, read by `resolveRisk` inside a later check. */
  resolveAppToolRisk?: AppsRuntime["agentToolRisk"];

  // ── compose-guard.ts ───────────────────────────────────────────────────────
  guard: VendoGuard;
  /** The app-then-broker risk chain the guard AND the automations engine take. */
  resolveRisk: RiskResolver;
  warnPresentCredentialsNotForwarded: VendoActionsConfig["onPresentCredentialsNotForwarded"];

  // ── compose-actions.ts ─────────────────────────────────────────────────────
  configuredBaseUrl: string | undefined;
  urls: ReturnType<typeof resolveVendoUrls>;
  isDevelopmentEnv: boolean;
  connectorToolkits: string[];
  resolvedConnectors: Connector[];
  actionsConfig: VendoActionsConfig;
  actions: ActionsRegistry;
  doctor: WireDeps["doctor"];
  connectGate: ReturnType<typeof createConnectGate>;
  /** The ONE guard-bound registry chat, apps, automations and the door ride. */
  boundTools: ToolRegistry;
  byoApprovals: ReturnType<typeof createByoApprovals>;
  parkedCallTtlMs: number;
  /** The dev-side per-org connector registry (tenant-connectors.ts). The
   *  overlay it selects from is composition-private; only this handle is public. */
  tenantConnectors: TenantConnectors;

  // ── compose-surfaces.ts ────────────────────────────────────────────────────
  theme: VendoTheme | undefined;
  themeProvider: () => VendoTheme | undefined;
  designRules: string | (() => string | undefined);
  /** THE briefing pack — assembled once (compose-surfaces.ts), read by both
   *  generation rungs. */
  briefing: (ctx: RunContext) => Promise<BriefingPack>;
  seedBaselines: SeedBaseline[];
  hostSemanticsProvider: () => ReturnType<typeof mergedHostSemantics>;
  capability: MergedCapability;
  catalog: ReturnType<typeof mergeRuntimeCatalog>;

  // ── compose-apps.ts ────────────────────────────────────────────────────────
  appTokens: ReturnType<typeof createAppTokens>;
  /** Build contract §9.3 — ONE `can()` the apps runtime and the engine share. */
  access: ReturnType<typeof appAccess>;
  apps: AppsRuntime;
  /** The same runtime, as the LATE slot the capability thunk resolves through:
   *  the app tools are contributed before the runtime they act through exists. */
  appsRuntime?: AppsRuntime;

  // ── compose-tools.ts ───────────────────────────────────────────────────────
  toolOutputCap: number;
  catalogConnectors: Connector[];
  serviceCatalog: boolean;
  knowledgeIndex: ReturnType<typeof import("@vendoai/knowledge").knowledgeIndexResolver> | undefined;
  missSurface: () => Promise<CapabilitySurfaceSnapshot>;
  missCapture: ReturnType<typeof import("./capability-misses.js").createCapabilityMissCapture>;

  // ── compose-prompt.ts ──────────────────────────────────────────────────────
  system: Parameters<typeof import("./prompt.js").assembleSystemPrompt>[2];
  capabilityMiss: CapabilityMissConfig;
  toolSearch: VendoToolSearchConfig;

  // ── compose-harness.ts ─────────────────────────────────────────────────────
  harness: Harness;
  mcpOptions: Exclude<CreateVendoConfig["mcp"], boolean | undefined> | undefined;
  internalDoorOnly: boolean;
  /** Fixed by the first loopback request the wire validates (compose-wire.ts). */
  learnedLoopbackOrigin?: string;
  doorBase: () => string | undefined;
  harnessTurns: HarnessTurns;
  /** The screen agent's workspace door, filled with the harness turns composed
   *  after the apps runtime that reads it (assembly only happens in a request). */
  harnessTurnsForScreens?: HarnessTurns;
  /** THE harness door — one object, served to the host and to the wire alike. */
  harnessDoor: HarnessTurns;
  delegateRunner: AgentRunner;

  // ── compose-discovery.ts ───────────────────────────────────────────────────
  connectedToolkitsCache: Map<string, { at: number; toolkits: string[] }>;
  agentMenu: () => Promise<ReadonlySet<string> | undefined>;
  subjectHasToolkit: (toolkit: string, ctx: RunContext) => Promise<boolean | undefined>;
  connectedToolkitsFor: (ctx: RunContext) => Promise<string[]>;
  serviceToolOwner: (slug: string) => Promise<{ connector: Connector; risk: RiskLabel } | undefined>;
  serviceToolRisk: (call: ToolCall) => Promise<RiskLabel | undefined>;
  /** What the adapter rule chose, handed back on `vendo.connections` UNTOUCHED. */
  selectedConnections: ConnectionsService;
  /** The same adapter, wrapped so a disconnect invalidates the toolkit cache. */
  connections: ConnectionsService;

  // ── compose-channels.ts ────────────────────────────────────────────────────
  /** What the adapter rule chose for the text channel (`selectChannels`). */
  channels: ChannelsService;
  /** The composed door: link/status/unlink for the host and the wire, and the
   *  inbound runner the machine door drives. */
  channelDoor: ChannelDoor;
  /** The bearer Vendo Cloud presents on an inbound delivery, derived from
   *  VENDO_API_KEY; undefined when this deployment has no Cloud key. */
  channelInboundSecret: () => Promise<string | undefined>;

  // ── compose-sweep.ts ───────────────────────────────────────────────────────
  runSweep: () => Promise<void>;
  sweepEnabled: boolean;

  // ── compose-automations.ts ─────────────────────────────────────────────────
  hostedStoreComposed: boolean;
  automations: AutomationsEngine;
  /** THE one create-automation operation, as the LATE authoring seam the apps
   *  runtime holds: automations is constructed after apps, and every call
   *  happens inside a request. Never public — `vendo.automations` has no
   *  `create`; the four authoring doors reach it through here. */
  createAutomation?: CreateAutomation;
  /** `.on()` declarations → records, run once on the ready() latch (after
   *  ensureSchema, before the first request). Filled by compose-automations.ts. */
  bootReconcile: () => Promise<void>;

  // ── compose-mcp.ts ─────────────────────────────────────────────────────────
  turnCredentials: TurnCredentials;
  door: McpDoor | undefined;
  /** The /status posture: false while the door is closed, "local" when it
   *  serves its own OAuth surface, "broker" when one fronts it. */
  mcpPosture: "local" | "broker" | false;
  doorWellKnown: ReadonlySet<string>;
  /** The Cloud tenant's MCP bundle, when Vendo Cloud filled the brokerage seam:
   *  the door and `vendo.tokenFor` share this one lazy provisioning. */
  mcpBundle: (() => Promise<McpBundle>) | undefined;
}

/**
 * 09-vendo §2 — every live block, composed around the guard choke point, in the
 * order the one function composed them.
 *
 * The phases share ONE object rather than a chain of arguments because the
 * composition is genuinely cyclic: the guard's risk resolver reaches the apps
 * runtime, the connect gate reaches the connections adapter, the harness
 * reaches the MCP door's credential registry — and every one of those reads
 * happens inside a request, long after this function has returned.
 */
export const createComposition = (input: CreateVendoConfig): VendoComposition => {
  const composition = {} as VendoComposition;
  Object.assign(composition, composeConfig(input));
  Object.assign(composition, composeAdapters(composition));
  // Right after the store it needs, so a `limits` policy against a meterless
  // store refuses before anything else is constructed.
  Object.assign(composition, composeLimits(composition));
  Object.assign(composition, composeReady(composition));
  Object.assign(composition, composeGuard(composition));
  Object.assign(composition, composeActions(composition));
  Object.assign(composition, composeSurfaces(composition));
  Object.assign(composition, composeApps(composition));
  Object.assign(composition, composeTools(composition));
  Object.assign(composition, composePrompt(composition));
  Object.assign(composition, composeHarness(composition));
  Object.assign(composition, composeDiscovery(composition));
  Object.assign(composition, composeSweep(composition));
  Object.assign(composition, composeAutomations(composition));
  Object.assign(composition, composeConnections(composition));
  // After the harness door it serves turns through, and after the connections
  // lane, because the channel is another way INTO the same composed turn.
  Object.assign(composition, composeChannels(composition));
  Object.assign(composition, composeMcp(composition));
  // LAST, and it has to be: `deployment_boot` names the adapters this
  // deployment RUNS, and the connections adapter is not selected until
  // compose-discovery.ts above.
  emitDeploymentBoot(composition);
  // Boot's first resolution: the surfaces are all composed, so this is the
  // first moment the five of them have resolved values to report.
  composition.reportConfig();
  return composition;
};
