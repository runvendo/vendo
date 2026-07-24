import {
  createActions,
  type ActionsRegistry,
  type ActionsRunContext,
  type Connector,
  type ServerActionHandler,
} from "@vendoai/actions";
import { createAgent, type VendoAgent } from "@vendoai/agent";
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
  semanticsFileSchema,
  vendoThemeSchema,
  type ActAs,
  type AppDocument,
  type ComponentCatalog,
  type ComponentRegistry,
  type Json,
  type PermissionGrant,
  type Principal,
  type RunContext,
  type RunId,
  type SecretsProvider,
  type ToolDescriptor,
  type ToolOutcome,
  type ToolRegistry,
  type VendoTheme,
} from "@vendoai/core";
import { createGuard, type Judge, type PolicyConfig, type VendoGuard } from "@vendoai/guard";
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
} from "./capability-misses.js";
import { catalogThemeSummary, mergeRuntimeCatalog, normalizeCatalogConfig, runtimeCatalogFromJson } from "./catalog.js";
import { devModel } from "#dev-creds/model";
// install-dx v1 — `devModel()` is the env-resolving model createVendo composes
// when the host passes none; the resolver is shared by init and doctor (one
// credential story, real keys only).
export { devModel, type DevModelOptions } from "#dev-creds/model";
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
import { cloudTools } from "./cloud-tools.js";
// The Cloud tools adapter (the execution half of the zero-key Composio seam)
// rides the server surface the same way: pass it explicitly via
// createVendo({ connectors: [cloudTools({...})] }) to scope with `apps`.
export { cloudTools, type CloudToolsOptions } from "./cloud-tools.js";
import { HostedSessionDoorsMissingError, hostedStore, type HostedStore } from "./hosted-store.js";
// The hosted-store adapter rides the server surface like the other Cloud
// adapters: a host can pass it explicitly via createVendo({ store }) with its
// own options instead of relying on the VENDO_API_KEY default.
export { hostedStore, type HostedStore, type HostedStoreOptions } from "./hosted-store.js";
import { createRuntimeCapture } from "./runtime-capture.js";
import { createPersonaTools } from "./persona/index.js";
import {
  BASE_PATH,
  VERSION,
  dispatchRoutes,
  environment,
  errorResponse,
  internalError,
  routeSegments,
  type ModelVenue,
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

export interface CreateVendoConfig {
  /** The agent's LLM — the inference adapter seam (03-agent §1): any ai-SDK
      LanguageModel. Optional since install-dx v1: an explicitly passed model
      always wins (BYO-LLM); when absent the seam resolves a real key from the
      environment — provider keys via devModel's ladder, then VENDO_API_KEY →
      Vendo Cloud managed inference — and fails honestly with instructions
      when none exists (precedence: selectModel). */
  model?: LanguageModel;
  /** v2 spec §4 — tier-0 paint lane knob for app generation. `model` is the
      no-think switch (a thinking-disabled model instance for the instant
      paint); `disabled` forces single-lane generation. */
  paint?: AppsConfig["paint"];
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
  store?: VendoStore;
  sandbox?: SandboxAdapter;
  connectors?: Connector[];
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
function selectConnectors(configured: Connector[] | undefined): Connector[] {
  if (configured !== undefined) return configured;
  const apiKey = environment("VENDO_API_KEY");
  if (apiKey !== undefined) {
    const baseUrl = environment("VENDO_CLOUD_URL");
    return [cloudTools({ apiKey, ...(baseUrl === undefined ? {} : { baseUrl }) })];
  }
  return [];
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
function selectConnections(
  configured: ConnectionsService | undefined,
  connectors: Connector[],
): ConnectionsService {
  if (configured !== undefined) return configured;
  if (connectors.some(hasConnections)) return byoConnections(connectors);
  const cloud = cloudKeyOptions();
  return cloud !== undefined ? cloudConnections(cloud) : unconfiguredConnections();
}

/** ADAPTER RULE, inference seam (cloned from selectConnections): the agent and
    apps blocks consume one ai-SDK LanguageModel; which implementation composes
    is decided HERE. Precedence, top to bottom:
      1. an explicitly passed model always wins (BYO-LLM — any ai-SDK model);
      2. otherwise devModel()'s env ladder composes as the default, and the
         remaining rungs live INSIDE it (resolveDevCredential): a provider key
         (ANTHROPIC / OPENAI / GOOGLE) via the host-installed @ai-sdk provider,
         then VENDO_API_KEY via @ai-sdk/anthropic pointed at the Cloud model
         gateway (`<console>/api/v1` — Anthropic-compatible /messages), then
         the honest keyless failure with exact instructions on first use.
    devModel is the one seam-sanctioned lazy env resolver; every other adapter
    still never reads the environment. */
function selectModel(configured: LanguageModel | undefined): {
  model: LanguageModel;
  venue: ModelVenue;
} {
  if (configured !== undefined) return { model: configured, venue: "custom" };
  return { model: devModel(), venue: "ladder" };
}

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

function dotVendoTheme(): VendoTheme | undefined {
  const raw = dotVendoFile("theme.json");
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
function dotVendoPinBaselines(): PinBaseline[] {
  const proc = (globalThis as { process?: { getBuiltinModule?: (id: string) => unknown } }).process;
  const fs = proc?.getBuiltinModule?.("node:fs") as typeof import("node:fs") | undefined;
  if (fs === undefined) return [];
  const directory = ".vendo/remixable";
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
  // Inference, selected by the adapter rule at this composition seam
  // (selectModel above) — the one model the agent and apps blocks consume.
  const inference = selectModel(config.model);
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
  const guard = createGuard({
    store,
    // The resolver is installed immediately after createApps below. Keeping the
    // hook in guard means chat/SSE and the MCP door reach the same decision.
    resolveRisk: (call, _descriptor, ctx) => resolveAppToolRisk?.(call, ctx),
    ...(config.policy === undefined ? {} : { policy: config.policy }),
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
  const resolvedConnectors = selectConnectors(config.connectors);
  const actionsConfig: {
    dir: string;
    connectors?: Connector[];
    actAs?: ActAs;
    serverActions?: Record<string, ServerActionHandler>;
    baseUrl?: string;
    baseUrlTrusted?: boolean;
    onPresentCredentialsNotForwarded: typeof warnPresentCredentialsNotForwarded;
    untrustedOriginPolicy?: "warn" | "fail";
    invokeTool?: ToolRegistry["execute"];
  } = {
    dir: ".",
    ...(resolvedConnectors.length === 0 ? {} : { connectors: resolvedConnectors }),
    ...(actAsSeam === undefined ? {} : { actAs: actAsSeam }),
    ...(config.serverActions === undefined ? {} : { serverActions: config.serverActions }),
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
      const probes = createActions({ ...actionsConfig, dir: undefined, tools: [doctorPresentTool] });
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
      const probes = createActions({ ...actionsConfig, dir: undefined, tools: [doctorActAsTool] });
      return probes.execute({ id: "call_vendo_doctor_act_as", tool: doctorActAsTool.name, args: {} }, ctx);
    },
  };
  const boundTools = guard.bind(actions);
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
  const theme = dotVendoTheme();
  // App design rules (spec 2026-07-20): explicit config wins; otherwise the
  // file is re-read per generation (from the compose-time root) so brief
  // tuning never needs a restart.
  const configDesignRules = config.apps?.designRules?.trim();
  const designRulesRoot = dotVendoRoot();
  const designRules = configDesignRules
    ? configDesignRules
    : () => dotVendoFile("design-rules.md", designRulesRoot);
  const pinBaselines = dotVendoPinBaselines();
  // W3 — .vendo/semantics.json (field semantics + domain manifest), written
  // by `vendo sync`, host-edited, treated as generation fact. Malformed →
  // loud + absent, same stance as catalog.json.
  const semanticsFile = (() => {
    const raw = dotVendoFile("semantics.json");
    if (raw === undefined) return undefined;
    try {
      return semanticsFileSchema.parse(JSON.parse(raw));
    } catch (error) {
      console.error(`[vendo] Failed to load .vendo/semantics.json: ${error instanceof Error ? error.message : String(error)}. Run "vendo sync" to regenerate the file.`);
      return undefined;
    }
  })();
  const catalog = mergeRuntimeCatalog(
    runtimeCatalogFromJson(dotVendoFile("catalog.json")),
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
  // Cloud machine funds its model (chat inference already does, via devModel's
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
      // The gateway base mirrors devModel's vendo-cloud rung: `<console>/api/v1`.
      const base = (cloud.baseUrl ?? "https://console.vendo.run").replace(/\/+$/, "");
      // The gateway serves curated aliases only (vendo-default / vendo-fast /
      // vendo-strong); the box harness's own default is a raw claude-* id the
      // gateway would grace-remap, so pin the alias unless the operator chose
      // a model via VENDO_INFERENCE_MODEL.
      return {
        url: base.endsWith("/api/v1") ? base : `${base}/api/v1`,
        key: cloud.apiKey,
        model: model ?? "vendo-default",
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
      secrets: config.secrets ?? envSecrets(),
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
    model: inference.model,
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
    ...(config.paint === undefined ? {} : { paint: config.paint }),
    ...(theme === undefined ? {} : { theme }),
    designRules,
    ...(appsCloud === undefined ? {} : { cloud: cloudApps(appsCloud) }),
    ...(semanticsFile === undefined ? {} : { semantics: semanticsFile.tools, domains: semanticsFile.domains }),
    secrets: config.secrets ?? envSecrets(),
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
  // Persona layer: two guard-bound, subject-scoped tools (load + remember)
  // folded into the same registry apps rides. They inherit the guard binding
  // above (boundTools re-reads descriptors per call), so persona reads and
  // writes are policed and audited like every other tool, with no separate path.
  actions.add(createPersonaTools(store));
  const missSurface = actions.descriptors()
    .then(capabilitySurfaceSnapshot)
    .catch(() => capabilitySurfaceSnapshot([]));
  const missCapture = createCapabilityMissCapture({ surface: missSurface });
  // AGENT-1/2 — 03 §3: the host product brief (init writes .vendo/brief.md)
  // and the catalog+theme summary feed the system prompt; prompt.ts places
  // them (brief = Product section; summary only where trees render).
  const brief = dotVendoFile("brief.md")?.trim();
  const promptCatalog = catalogThemeSummary(catalog, theme);
  const system = brief || promptCatalog !== undefined
    ? {
        ...(brief ? { product: brief } : {}),
        ...(promptCatalog === undefined ? {} : { catalog: promptCatalog }),
      }
    : undefined;
  const agent = createAgent({
    model: inference.model,
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
      surface: missSurface.then(({ hash }) => ({ format: "vendo/tools@1" as const, hash })),
      emit: (event) => missCapture.record(event),
    },
    // ENG-252: the agent starts with a bounded loadout and discovers the rest via
    // `vendo_tools_search`. The search seam is the SAME guard-bound registry the
    // agent executes through — a searched-in tool has no unguarded path.
    toolSearch: {
      search: (query, options) => actions.search(query, options),
      // Connection-scoped loadout seed (spec 2026-07-20): each turn starts
      // with host tools + the principal's connected toolkits — never an
      // alphabetical slice of a lazy catalog. `connections` is declared below
      // this composition; turns only run after createVendo returns, so the
      // closure reference is safe.
      seed: (ctx) => loadoutSeedFor(ctx),
      ...(config.agent?.maxInitialTools === undefined ? {} : { maxInitialTools: config.agent.maxInitialTools }),
      ...(config.agent?.loadout === undefined ? {} : { loadout: config.agent.loadout }),
    },
  });
  // Per-subject connected-toolkit lookups are cached briefly so a turn never
  // pays a broker round-trip it doesn't need; failures degrade to host tools
  // only (warn, never the turn). Bounded so long-lived deployments don't grow.
  const CONNECTED_TOOLKITS_TTL_MS = 60_000;
  const connectedToolkitsCache = new Map<string, { at: number; toolkits: string[] }>();
  async function loadoutSeedFor(ctx: RunContext): Promise<string[]> {
    const subject = ctx.principal.subject;
    const cached = connectedToolkitsCache.get(subject);
    let toolkits: string[];
    if (cached !== undefined && Date.now() - cached.at < CONNECTED_TOOLKITS_TTL_MS) {
      toolkits = cached.toolkits;
    } else {
      try {
        const accounts = await connections.list(ctx.principal);
        toolkits = [...new Set(accounts.filter((account) => account.status === "active").map((account) => account.toolkit))];
      } catch (error) {
        console.warn(
          "[vendo] connected-toolkits lookup failed; seeding host tools only:",
          error instanceof Error ? error.message : error,
        );
        toolkits = [];
      }
      if (connectedToolkitsCache.size > 1_000) connectedToolkitsCache.clear();
      connectedToolkitsCache.set(subject, { at: Date.now(), toolkits });
    }
    return actions.loadoutSeed(toolkits);
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
  const connections = selectConnections(config.connections, resolvedConnectors);
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
  const developmentPaths = typeof config.development === "object" ? config.development : {};
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
    model: inference.venue,
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
    connections,
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
