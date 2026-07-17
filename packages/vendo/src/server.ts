import {
  createActions,
  type ActionsRegistry,
  type ActionsRunContext,
  type Connector,
  type ExtractedTool,
  type ServerActionHandler,
} from "@vendoai/actions";
import { createAgent, type VendoAgent } from "@vendoai/agent";
import {
  createApps,
  pinBaselineSchema,
  type AppsRuntime,
  type PinBaseline,
  type SandboxAdapter,
} from "@vendoai/apps";
import { e2bInstalled, e2bSandbox } from "@vendoai/apps/e2b";
import { modalInstalled, modalSandbox } from "@vendoai/apps/modal";
import {
  createAutomations,
  type AutomationsEngine,
  type RunStatus,
} from "@vendoai/automations";
import {
  VendoError,
  descriptorHash,
  principalSchema,
  vendoThemeSchema,
  type ActAs,
  type ComponentCatalog,
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
  createStore,
  envSecrets,
  sweepEphemeralSubjects,
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
export {
  runRefine,
  type RefineChange,
  type RefineDrop,
  type RefineOptions,
  type RefineProbe,
  type RefineProbeCheck,
  type RefineProposals,
  type RefineResult,
  type RefineTranscript,
} from "./refine.js";
import { initTelemetry, type Telemetry } from "@vendoai/telemetry";
import type { LanguageModel } from "ai";
import {
  capabilitySurfaceSnapshot,
  createCapabilityMissCapture,
} from "./capability-misses.js";
import { catalogThemeSummary, mergeRuntimeCatalog, runtimeCatalogFromJson } from "./catalog.js";
import { createConnections, type ConnectionsService } from "./connections.js";
import { createRuntimeCapture } from "./runtime-capture.js";
import { computeImpact } from "./sync-impact.js";
import {
  BASE_PATH,
  VERSION,
  constantTimeEqual,
  createContextResolver,
  dispatchRoutes,
  environment,
  errorResponse,
  hex,
  internalError,
  json,
  orgsCloudRequired,
  requestJson,
  routeSegments,
  string,
  withAnonCookie,
  type AnonSession,
  type SandboxVenue,
  type WireContext,
  type WireDeps,
} from "./wire/shared.js";
import { appRoutes } from "./wire/apps.js";
import { approvalRoutes, grantRoutes } from "./wire/approvals.js";
import { threadRoutes } from "./wire/threads.js";

/** 10-mcp §5 — the door's canonical mount under the wire's own prefix. */
const MCP_MOUNT = `${BASE_PATH}/mcp`;
const DOCTOR_PRESENT_AUTHORIZATION = "Bearer vendo-doctor-present";
const DOCTOR_PRESENT_COOKIE = "vendo_doctor_present=1";
const DOCTOR_ACT_AS_PRINCIPAL: Principal = { kind: "user", subject: "vendo_doctor_act_as" };
const DOCTOR_ACT_AS_APP_ID = "app_vendo_doctor" as const;

const doctorPresentTool: ExtractedTool = {
  name: "vendo_doctor_present",
  description: "Vendo doctor present credential round-trip",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  risk: "read",
  binding: { kind: "route", method: "GET", path: `${BASE_PATH}/doctor/present/echo`, argsIn: "query" },
};

const doctorActAsTool: ExtractedTool = {
  name: "vendo_doctor_act_as",
  description: "Vendo doctor actAs mint and verification round-trip",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  risk: "read",
  binding: { kind: "route", method: "GET", path: `${BASE_PATH}/doctor/act-as/echo`, argsIn: "query" },
};

export interface Vendo {
  handler: (req: Request) => Promise<Response>;
  emit(event: string, payload: Json, principal: Principal): Promise<RunId[]>;
  agent: VendoAgent;
  guard: VendoGuard;
  apps: AppsRuntime;
  automations: AutomationsEngine;
  actions: ActionsRegistry;
  connections: ConnectionsService;
  store: VendoStore;
}

export interface CreateVendoConfig {
  model: LanguageModel;
  principal: (req: Request) => Promise<Principal | null>;
  /** Host components available to generated apps; entry names must mirror the client-side components map 1:1. */
  catalog?: ComponentCatalog;
  store?: VendoStore;
  sandbox?: SandboxAdapter;
  connectors?: Connector[];
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
}

/** ENG-237 recommended defaults (documented in the PR body; Yousef-gated as
    09-vendo contract text). */
const DEFAULT_SESSION_TTL_MS = 30 * 60_000;
const DEFAULT_SESSION_SWEEP_INTERVAL_MS = 60_000;

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

/** Default char cap on a single tool result before it reaches the model (03-agent §2).
    Generous enough for normal host responses, small enough that a runaway payload is
    truncated to a preview instead of blowing the context window. Override via config.agent. */
const DEFAULT_TOOL_OUTPUT_CAP = 32_000;

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
    return { adapter: e2bSandbox({ apiKey: e2bApiKey }), venue: "e2b" };
  }

  const modalTokenId = environment("MODAL_TOKEN_ID");
  const modalTokenSecret = environment("MODAL_TOKEN_SECRET");
  if (modalTokenId !== undefined && modalTokenSecret !== undefined && modalInstalled()) {
    return {
      adapter: modalSandbox({ tokenId: modalTokenId, tokenSecret: modalTokenSecret }),
      venue: "modal",
    };
  }

  return { adapter: undefined, venue: false };
}

function isJsonRequest(request: Request): boolean {
  return request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase()
    === "application/json";
}

/** 09 §4 — the .vendo/ files feeding the generation seat, read fail-soft (the
    composition works without them; on non-Node runtimes they just stay unset).
    Reads `node:fs` through the runtime built-in accessor so this module carries
    NO static Node import and still loads/bundles for edge/Worker targets. */
function dotVendoFile(name: string): string | undefined {
  try {
    const proc = (globalThis as { process?: { getBuiltinModule?: (id: string) => unknown } }).process;
    const fs = proc?.getBuiltinModule?.("node:fs") as typeof import("node:fs") | undefined;
    if (fs === undefined) return undefined;
    return fs.readFileSync(`.vendo/${name}`, "utf8");
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
  if (path === "/apps/import" || path === "/tick" || path.startsWith("/webhooks/")) return false;
  return true;
}

/** Lazily-minted random per-process HMAC key for constant-time secret compares
    (WebCrypto only — NO node:crypto — so the module keeps bundling for edge/
    Worker targets; cf. dotVendoFile). */
let compareKeyPromise: Promise<CryptoKey> | undefined;
function compareKey(): Promise<CryptoKey> {
  compareKeyPromise ??= (() => {
    const raw = new Uint8Array(32);
    globalThis.crypto.getRandomValues(raw);
    return globalThis.crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  })();
  return compareKeyPromise;
}

/** Constant-time string equality via WebCrypto, matching the webhook HMAC path
    (which leans on crypto.subtle.verify for the same guarantee). HMACs both
    inputs under a random per-process key so the digests are equal-length 32-byte
    values regardless of input length — equal digests iff equal inputs (SHA-256
    collision resistance) — and the byte compare leaks neither length nor content
    through timing. Replaces the `===` bearer compare, a classic timing oracle. */
async function timingSafeEqual(a: string, b: string): Promise<boolean> {
  const key = await compareKey();
  const encoder = new TextEncoder();
  const [da, db] = await Promise.all([
    globalThis.crypto.subtle.sign("HMAC", key, encoder.encode(a)),
    globalThis.crypto.subtle.sign("HMAC", key, encoder.encode(b)),
  ]);
  return constantTimeEqual(hex(da), hex(db));
}

async function tickAuthorized(request: Request): Promise<boolean> {
  const secret = environment("VENDO_TICK_SECRET");
  if (secret === undefined) return false;
  return timingSafeEqual(request.headers.get("authorization") ?? "", `Bearer ${secret}`);
}

function telemetryClient(enabled: boolean | undefined): Telemetry | undefined {
  if (enabled !== true) return undefined;
  try {
    return initTelemetry({ version: VERSION, runtime: true });
  } catch {
    return undefined;
  }
}

function doctorProbeOk(outcome: ToolOutcome): boolean {
  if (outcome.status !== "ok" || typeof outcome.output !== "object" || outcome.output === null) return false;
  return "ok" in outcome.output && outcome.output.ok === true;
}

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
    if (deps.sessions.ttlMs <= 0) return;
    const now = deps.sessions.now();
    if (now - lastSweepAt < deps.sessions.sweepIntervalMs) return;
    lastSweepAt = now;
    try {
      await deps.sweep();
    } catch (error) {
      console.warn(`[vendo] session sweep failed; will retry next interval: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
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
        await deps.ready;
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
      await deps.ready;

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

      // This dispatch exists only in a development composition. Production
      // handlers receive no runtimeCapture dependency and fall through to the
      // ordinary 404, so there is no guarded-but-mounted production endpoint.
      if (deps.runtimeCapture !== undefined && request.method === "POST" && path === "/dev/remixable-source") {
        const body = await requestJson(request);
        // Capture writes .vendo/remixable baselines on the developer's disk, so
        // it requires a HOST-resolved principal — an anonymous visitor's minted
        // ephemeral session is not enough, even in a development composition.
        const captureContext = await context(request, "app");
        if (captureContext.principal.ephemeral === true) {
          return json({ error: { code: "blocked", message: "runtime capture requires a host-resolved principal" } }, 401);
        }
        if (typeof body["exportable"] !== "boolean") {
          throw new VendoError("validation", "exportable must be a boolean");
        }
        return json(await deps.runtimeCapture.capture({
          slot: string(body["slot"], "slot"),
          source: string(body["source"], "source"),
          exportable: body["exportable"],
        }));
      }

      // 06-apps §9 — the documented LOCAL injection seam for in-client approval
      // records (demos and dev; Cloud's review console mints these in
      // production). Development compositions only: production handlers fall
      // through to the ordinary 404, exactly like /dev/remixable-source, so no
      // production surface can self-approve an app into the host page.
      if (deps.development && request.method === "POST" && path === "/dev/inclient-approval") {
        const body = await requestJson(request);
        // Approving a host-page mount is a HOST trust decision — an anonymous
        // visitor's minted ephemeral session is not enough, even in dev.
        const approvalContext = await context(request, "app");
        if (approvalContext.principal.ephemeral === true) {
          return json({ error: { code: "blocked", message: "in-client approval injection requires a host-resolved principal" } }, 401);
        }
        const approvedBy = body["approvedBy"] === undefined
          ? "local-dev"
          : string(body["approvedBy"], "approvedBy");
        return json(await deps.apps.inClient.approve({
          appId: string(body["appId"], "appId"),
          approvedBy,
        }, approvalContext));
      }

      // Doctor targets a running dev server. Keep its synthetic mint/echo routes
      // out of production entirely; in development they expose no credential
      // material (the echo halves return booleans only).
      if (path.startsWith("/doctor/") && environment("NODE_ENV") === "production") {
        throw new VendoError("not-found", "unknown Vendo route");
      }
      if (request.method === "GET" && path === "/doctor/present/echo") {
        return json({
          ok: request.headers.get("authorization") === DOCTOR_PRESENT_AUTHORIZATION
            && request.headers.get("cookie") === DOCTOR_PRESENT_COOKIE,
        });
      }
      if (request.method === "GET" && path === "/doctor/act-as/echo") {
        const resolved = await deps.principal(request);
        const parsed = principalSchema.safeParse(resolved);
        const accepted = parsed.success && parsed.data.subject === DOCTOR_ACT_AS_PRINCIPAL.subject;
        return json({ ok: accepted }, accepted ? 200 : 401);
      }
      if (request.method === "POST" && path === "/doctor/present") {
        const outcome = await deps.doctor.present(await context(request, "chat"));
        if (doctorProbeOk(outcome)) return json({ ok: true });
        return json({
          ok: false,
          error: {
            code: "present-credentials-not-forwarded",
            message: "Present credentials did not reach the host API. Set VENDO_BASE_URL to the running host origin and restart the dev server.",
          },
        }, 409);
      }
      if (request.method === "POST" && path === "/doctor/act-as") {
        const outcome = await deps.doctor.actAs();
        if (doctorProbeOk(outcome)) return json({ ok: true });
        if (outcome.status === "error" && outcome.error.code === "not-implemented") {
          return json({
            ok: false,
            error: {
              code: "act-as-not-configured",
              message: "actAs is not configured; pass createVendo({ actAs }) before enabling away host actions.",
            },
          }, 501);
        }
        return json({
          ok: false,
          error: {
            code: "act-as-verification-failed",
            message: "actAs returned no usable AuthMaterial, or the host API did not accept it. Check the matching verifier middleware and principal resolver.",
          },
        }, 409);
      }

      if (request.method === "POST" && path.startsWith("/webhooks/")) {
        return await deps.automations.webhook(request);
      }
      if (request.method === "POST" && path === "/tick") {
        if (!await tickAuthorized(request)) {
          return json({ error: { code: "blocked", message: "invalid tick credential" } }, 401);
        }
        return json({ runIds: await deps.automations.tick() });
      }
      if (request.method === "POST" && path === "/sync/impact") {
        if (process.env.NODE_ENV === "production") {
          throw new VendoError("blocked", "sync impact is only available on a dev server");
        }
        const body = await requestJson(request);
        const tools = body["tools"];
        if (!Array.isArray(tools) || tools.length > 200 || tools.some((tool) => typeof tool !== "string")) {
          throw new VendoError("validation", "tools must be an array of at most 200 strings");
        }
        return json({ impact: await computeImpact(deps.store, tools) });
      }
      if (path.startsWith("/proxy/")) {
        const proxyPath = path.slice("/proxy".length);
        const proxyUrl = new URL(request.url);
        proxyUrl.pathname = proxyPath;
        return await deps.apps.proxy.handler(new Request(proxyUrl, request));
      }

      const segments = wire.segments;
      const head = segments[0];

      {
        const routed = await dispatchRoutes(threadRoutes, wire);
        if (routed !== undefined) return routed;
      }

      {
        const routed = await dispatchRoutes(approvalRoutes, wire);
        if (routed !== undefined) return routed;
      }

      // 04-actions §3 (block-actions design §B) — per-principal connected
      // accounts. Subject scoping happens HERE: the wire passes exactly the
      // resolved principal; no caller-supplied subject exists on this surface.
      if (request.method === "GET" && path === "/connections") {
        const ctx = await context(request, "chat");
        return json({ connections: await deps.connections.list(ctx.principal) });
      }
      if (request.method === "POST" && path === "/connections/initiate") {
        const body = await requestJson(request);
        const ctx = await context(request, "chat");
        return json(await deps.connections.initiate(ctx.principal, {
          toolkit: string(body["toolkit"], "toolkit"),
          ...(body["connector"] === undefined ? {} : { connector: string(body["connector"], "connector") }),
          ...(body["callbackUrl"] === undefined ? {} : { callbackUrl: string(body["callbackUrl"], "callbackUrl") }),
        }));
      }
      if (head === "connections" && segments.length === 2) {
        const connectionId = string(segments[1], "connection id");
        const connector = url.searchParams.get("connector") ?? "composio";
        const ctx = await context(request, "chat");
        if (request.method === "GET") {
          const connection = await deps.connections.status(ctx.principal, connector, connectionId);
          if (connection === null) throw new VendoError("not-found", `connection not found: ${connectionId}`);
          return json(connection);
        }
        if (request.method === "DELETE") {
          await deps.connections.disconnect(ctx.principal, connector, connectionId);
          return json({});
        }
      }

      {
        const routed = await dispatchRoutes(grantRoutes, wire);
        if (routed !== undefined) return routed;
      }

      // routeSegments splits on "/", so head is the whole first segment:
      // "orgs" matches only /orgs and /orgs/*, never a lookalike like
      // /organizations. Matching on `head` alone (not `path === "/orgs"` plus
      // a segments-length check) also covers a trailing-slash `/orgs/`.
      if (head === "orgs") orgsCloudRequired();

      {
        const routed = await dispatchRoutes(appRoutes, wire);
        if (routed !== undefined) return routed;
      }

      if (request.method === "GET" && path === "/automations") {
        return json(await deps.automations.list(await context(request, "automation")));
      }
      if (head === "automations" && segments.length === 3 && request.method === "POST") {
        const appId = string(segments[1], "app id");
        const ctx = await context(request, "automation");
        if (segments[2] === "enable") return json(await deps.automations.enable(appId, ctx));
        if (segments[2] === "disable") {
          await deps.automations.disable(appId, ctx);
          return json({});
        }
        if (segments[2] === "dry-run") return json(await deps.automations.dryRun(appId, ctx));
      }

      if (request.method === "GET" && path === "/runs") {
        const status = url.searchParams.get("status") ?? undefined;
        const allowed: RunStatus[] = ["running", "ok", "error", "stopped", "pending-approval"];
        if (status !== undefined && !allowed.includes(status as RunStatus)) {
          throw new VendoError("validation", "run status is invalid");
        }
        const filter = {
          ...(url.searchParams.get("appId") === null ? {} : { appId: url.searchParams.get("appId")! }),
          ...(status === undefined ? {} : { status: status as RunStatus }),
          ...(url.searchParams.get("cursor") === null ? {} : { cursor: url.searchParams.get("cursor")! }),
        };
        return json(await deps.automations.runs.list(filter, await context(request, "automation")));
      }
      if (head === "runs" && segments.length >= 2) {
        const ctx = await context(request, "automation");
        const runId = string(segments[1], "run id");
        if (request.method === "GET" && segments.length === 2) {
          const run = await deps.automations.runs.get(runId, ctx);
          if (run === null) throw new VendoError("not-found", `run not found: ${runId}`);
          return json(run);
        }
        if (request.method === "POST" && segments[2] === "stop" && segments.length === 3) {
          await deps.automations.runs.stop(runId, ctx);
          return json({});
        }
      }

      if (request.method === "GET" && path === "/activity") {
        const ctx = await context(request, "chat");
        const limitValue = url.searchParams.get("limit");
        const limit = limitValue === null ? undefined : Number(limitValue);
        if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0)) {
          throw new VendoError("validation", "activity limit must be a positive integer");
        }
        const activity = await deps.guard.audit.query({
          principal: ctx.principal,
          ...(url.searchParams.get("cursor") === null ? {} : { cursor: url.searchParams.get("cursor")! }),
          ...(limit === undefined ? {} : { limit }),
        });
        // 09 §3: the wire returns AuditEvent[] — the block's {events,cursor}
        // envelope stays internal (the client pages by last event id).
        return json(activity.events);
      }
      if (request.method === "GET" && path === "/status") {
        await context(request, "chat");
        return json({
          posture: deps.guard.status().posture,
          version: VERSION,
          blocks: {
            store: true,
            agent: true,
            actions: true,
            guard: true,
            apps: true,
            automations: true,
            sandbox: deps.sandbox,
            // 10-mcp §1 — the door is off by default; true only when
            // createVendo({ mcp: true }) opened it.
            mcp: deps.mcp,
            // 04-actions §3 — how per-user connected accounts are brokered:
            // "byo" (host's own Composio key), "cloud" (VENDO_API_KEY), or off.
            connections: deps.connections.posture,
          },
        });
      }

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
  // 02-store §4 default-on encryption: when the host doesn't hand us a store,
  // the composed default picks up VENDO_STORE_ENCRYPTION_KEY (provisioned into
  // .env by `vendo init`) so stored secrets are encrypted with zero extra
  // wiring. An explicitly configured store always wins as-is.
  const encryptionKey = environment("VENDO_STORE_ENCRYPTION_KEY");
  const store = config.store
    ?? createStore(encryptionKey === undefined ? {} : { encryption: { key: encryptionKey } });
  // 02-store §4 (kill-list B3) — ephemeral session policy. Validated like the
  // agent's context config; defaults are the recommended knobs. The store takes
  // the clock per call (register/sweep), so one time source needs no seam.
  const sessionsConfig = validateSessionsConfig(config.sessions);
  const sessionNow = sessionsConfig.now ?? Date.now;
  const sandbox = selectSandbox(config.sandbox);
  const ready = store.ensureSchema();
  // Keep eager schema readiness for hosts that reach into composed blocks,
  // while preventing an unhandled rejection before the first handler/emit awaits it.
  void ready.catch(() => undefined);
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
  const actionsConfig: {
    dir: string;
    connectors?: Connector[];
    actAs?: ActAs;
    serverActions?: Record<string, ServerActionHandler>;
    baseUrl?: string;
    baseUrlTrusted?: boolean;
    onPresentCredentialsNotForwarded: typeof warnPresentCredentialsNotForwarded;
    invokeTool?: ToolRegistry["execute"];
  } = {
    dir: ".",
    ...(config.connectors === undefined ? {} : { connectors: config.connectors }),
    ...(config.actAs === undefined ? {} : { actAs: config.actAs }),
    ...(config.serverActions === undefined ? {} : { serverActions: config.serverActions }),
    ...(configuredBaseUrl === undefined ? {} : { baseUrl: configuredBaseUrl, baseUrlTrusted: true }),
    onPresentCredentialsNotForwarded: warnPresentCredentialsNotForwarded,
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
  const theme = dotVendoTheme();
  const designRules = dotVendoFile("design-rules.md");
  const pinBaselines = dotVendoPinBaselines();
  const catalog = mergeRuntimeCatalog(
    runtimeCatalogFromJson(dotVendoFile("catalog.json")),
    config.catalog,
  );
  const apps = createApps({
    store,
    guard,
    tools: boundTools,
    model: config.model,
    catalog,
    pinBaselines,
    ...(theme === undefined ? {} : { theme }),
    ...(designRules === undefined ? {} : { designRules }),
    secrets: config.secrets ?? envSecrets(),
    ...(sandbox.adapter === undefined ? {} : { sandbox: sandbox.adapter }),
    ...(environment("VENDO_PROXY_URL") === undefined ? {} : { proxyUrl: environment("VENDO_PROXY_URL") }),
  });
  resolveAppToolRisk = apps.agentToolRisk;
  actions.add(apps.agentTools());
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
    model: config.model,
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
      ...(config.agent?.maxInitialTools === undefined ? {} : { maxInitialTools: config.agent.maxInitialTools }),
    },
  });
  // 02-store §4 (kill-list B3) TTL sweep: erase every idle ephemeral session's
  // disk rows, then cascade each swept subject into the agent's in-memory
  // threads (store-first — a concurrent request then fails closed at the store
  // rather than finding threads without store state). Disabled when ttlMs is 0.
  const runSweep = async (): Promise<void> => {
    if (sessionsConfig.ttlMs <= 0) return;
    for (const subject of await sweepEphemeralSubjects(store, { idleMs: sessionsConfig.ttlMs, now: sessionNow() })) {
      agent.evictSubject(subject);
    }
  };
  // Long-lived hosts also get a background sweep on an UNREF'd timer (automations
  // engine pattern) so an idle process still reclaims sessions with no traffic;
  // unref'd means it never keeps the event loop alive. Torn down with the store.
  if (sessionsConfig.ttlMs > 0) {
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
  }
  const automations = createAutomations({
    apps,
    tools: boundTools,
    guard,
    store,
    runner: agent.asRunner(),
  });
  // 04-actions §3 — per-principal connected accounts. A BYO connector's own
  // connections capability wins (connections must live where its tools
  // execute); with none, VENDO_API_KEY routes to the Vendo Cloud broker.
  const connections = createConnections({ connectors: config.connectors ?? [] });
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
    if (config.oauth === undefined) {
      throw new VendoError(
        "validation",
        "createVendo({ mcp: true }) requires an `oauth` HostOAuthAdapter (10-mcp §3): the door mints door principals through it and cannot open without one.",
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
      oauth: config.oauth,
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
  const sessionId = `session_${globalThis.crypto.randomUUID()}`;
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
  const explicitDevelopment = config.development !== undefined && config.development !== false;
  const development = explicitDevelopment
    || (config.development !== false && environment("NODE_ENV") === "development");
  const developmentPaths = typeof config.development === "object" ? config.development : {};
  const runtimeCapture = development ? createRuntimeCapture(developmentPaths) : null;
  const handler = createWireHandler({
    principal: config.principal,
    ready,
    trustedBaseIsHttps,
    sessionId,
    store,
    telemetry: telemetryClient(config.telemetry),
    agent,
    guard,
    apps,
    automations,
    connections,
    sandbox: sandbox.venue,
    doctor,
    mcp: mcpOptions !== undefined,
    development,
    sessions: {
      ttlMs: sessionsConfig.ttlMs,
      sweepIntervalMs: sessionsConfig.sweepIntervalMs,
      now: sessionNow,
    },
    sweep: runSweep,
    ...(door === undefined ? {} : { door }),
    ...(runtimeCapture === null ? {} : { runtimeCapture }),
    onRequestOrigin: (origin) => {
      // Same-origin default for route-binding execution (04): no VENDO_BASE_URL
      // → the wire's own origin, learned from the first VALIDATED request and
      // then fixed. Marked untrusted so credentials never forward to it.
      if (actionsConfig.baseUrl === undefined) {
        actionsConfig.baseUrl = origin;
        actionsConfig.baseUrlTrusted = false;
      }
    },
  });

  return {
    handler,
    async emit(event, payload, principal) {
      await ready;
      return automations.emit(event, payload, principal);
    },
    agent,
    guard,
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
    method — orgsCloudRequired() above). */
export function nextVendoHandler(vendo: Vendo): {
  GET(request: Request): Promise<Response>;
  POST(request: Request): Promise<Response>;
  PATCH(request: Request): Promise<Response>;
  DELETE(request: Request): Promise<Response>;
} {
  const handle = (request: Request): Promise<Response> => vendo.handler(request);
  return { GET: handle, POST: handle, PATCH: handle, DELETE: handle };
}
