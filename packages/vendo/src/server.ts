import {
  createActions,
  type ActionsRegistry,
  type ActionsRunContext,
  type Connector,
  type ExtractedTool,
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
  approvalDecisionSchema,
  descriptorHash,
  isReservedSubject,
  orgPrincipal,
  principalSchema,
  vendoThemeSchema,
  type ActAs,
  type ApprovalDecision,
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
  type VendoErrorCode,
  type VendoTheme,
} from "@vendoai/core";
import { createGuard, type Judge, type PolicyConfig, type VendoGuard } from "@vendoai/guard";
import { createMcpDoor, type AppsPort, type HostOAuthAdapter, type McpDoor } from "@vendoai/mcp";
import { adoptEphemeralSubject, createStore, envSecrets, registerEphemeralSubject, type VendoStore } from "@vendoai/store";
// 02-store §5: the erase API ships on the umbrella's runtime surface so hosts
// reach it without installing @vendoai/store directly.
export { eraseStore, type EraseReport, type EraseTable } from "@vendoai/store";
import { initTelemetry, type Telemetry } from "@vendoai/telemetry";
import type { LanguageModel } from "ai";
import {
  capabilitySurfaceSnapshot,
  createCapabilityMissCapture,
} from "./capability-misses.js";
import { mergeRuntimeCatalog, runtimeCatalogFromJson } from "./catalog.js";
import { createConnections, type ConnectionsService } from "./connections.js";
import { createOrgs, type OrgsService } from "./orgs.js";
import { createRuntimeCapture, type RuntimeCaptureHandler } from "./runtime-capture.js";
import { computeImpact } from "./sync-impact.js";

const VERSION = "0.3.0";
const BASE_PATH = "/api/vendo";
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

const STATUS_BY_CODE: Record<VendoErrorCode, number> = {
  validation: 400,
  "not-found": 404,
  blocked: 403,
  conflict: 409,
  "cloud-required": 402,
  "sandbox-unavailable": 501,
  "not-implemented": 501,
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
  orgs: OrgsService;
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
  };
}

/** Default char cap on a single tool result before it reaches the model (03-agent §2).
    Generous enough for normal host responses, small enough that a runaway payload is
    truncated to a preview instead of blowing the context window. Override via config.agent. */
const DEFAULT_TOOL_OUTPUT_CAP = 32_000;

type SandboxVenue = "e2b" | "modal" | "custom" | false;

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

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

function errorResponse(error: VendoError): Response {
  return json({ error: { code: error.code, message: error.message } }, STATUS_BY_CODE[error.code]);
}

function internalError(): Response {
  return errorResponse(new VendoError("not-implemented", "Internal Vendo error"));
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new VendoError("validation", `${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new VendoError("validation", `${label} must be a non-empty string`);
  }
  return value;
}

async function requestJson(request: Request): Promise<Record<string, unknown>> {
  try {
    return object(await request.json(), "request body");
  } catch (error) {
    if (error instanceof VendoError) throw error;
    throw new VendoError("validation", "request body must be valid JSON");
  }
}

function isJsonRequest(request: Request): boolean {
  return request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase()
    === "application/json";
}

function environment(name: string): string | undefined {
  if (typeof process === "undefined") return undefined;
  const value = process.env[name];
  return typeof value === "string" && value.length > 0 ? value : undefined;
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

function routeSegments(path: string): string[] {
  try {
    return path.split("/").filter(Boolean).map(decodeURIComponent);
  } catch {
    throw new VendoError("validation", "route contains invalid URL encoding");
  }
}

function requestHeaders(request: Request): Record<string, string> {
  return Object.fromEntries(request.headers.entries());
}

function jsonMutationRequired(request: Request, path: string): boolean {
  if (!["POST", "PUT", "PATCH", "DELETE"].includes(request.method)) return false;
  if (path === "/apps/import" || path === "/tick" || path.startsWith("/webhooks/")) return false;
  return true;
}

/** Lazily-minted random per-process HMAC key for constant-time secret compares
    (WebCrypto only — NO node:crypto — so the module keeps bundling for edge/
    Worker targets; cf. newAnonKey). */
let compareKeyPromise: Promise<CryptoKey> | undefined;
function compareKey(): Promise<CryptoKey> {
  compareKeyPromise ??= newAnonKey();
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

function ephemeralPrincipal(subject: string): Principal {
  return { kind: "user", subject, ephemeral: true };
}

/** 00 overview ("no host principal resolver → an ephemeral session-scoped
    principal"), 01-core §2, 02-store §4. When `principal(req)` returns null the
    visitor is anonymous, and each CLIENT gets its OWN ephemeral principal —
    session-scoped, never persisted — carried by a signed httpOnly cookie so two
    anonymous visitors never share threads, grants, approvals, or apps. */
const ANON_COOKIE = "vendo_anon_session";
/** Secure requests use the `__Host-` prefix against session fixation (cookie
    tossing): a sibling subdomain could otherwise plant an attacker's validly
    signed cookie via `Domain=` and read everything the victim's anonymous
    session then accrues — browsers refuse `__Host-*` cookies that set Domain or
    arrive from another host. `__Host-` REQUIRES Secure + Path=/ + no Domain. */
const ANON_COOKIE_SECURE = `__Host-${ANON_COOKIE}`;

function anonCookieName(secure: boolean): string {
  return secure ? ANON_COOKIE_SECURE : ANON_COOKIE;
}

/** Whether a request counts as secure for cookie purposes: its own URL is
    https, OR the operator-set VENDO_BASE_URL (the TRUSTED origin channel —
    never x-forwarded-*) is https — i.e. TLS terminates at a proxy and the
    request reaches this process as http. */
function secureRequest(url: URL, trustedBaseIsHttps: boolean): boolean {
  return url.protocol === "https:" || trustedBaseIsHttps;
}

/** Per-process HMAC key for the anonymous-session cookie, generated at
    createVendo() time with WebCrypto only (globalThis.crypto — NO node:crypto),
    so this module keeps loading/bundling on edge/Worker targets (cf.
    dotVendoFile). Restart semantics: a new process mints a new key, which
    invalidates every outstanding cookie and resets all anonymous sessions —
    acceptable because ephemeral sessions never persist past the process anyway
    (00 overview; 02-store §4). */
function newAnonKey(): Promise<CryptoKey> {
  const raw = new Uint8Array(32);
  globalThis.crypto.getRandomValues(raw);
  return globalThis.crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
}

function hex(bytes: ArrayBuffer | Uint8Array): string {
  let out = "";
  for (const b of bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)) out += b.toString(16).padStart(2, "0");
  return out;
}

function randomId(): string {
  const raw = new Uint8Array(16); // 128-bit session id
  globalThis.crypto.getRandomValues(raw);
  return hex(raw);
}

async function anonSign(key: CryptoKey, id: string): Promise<string> {
  return hex(await globalThis.crypto.subtle.sign("HMAC", key, new TextEncoder().encode(id)));
}

/** Length-independent-leak-free digest compare (both are equal-length hex when
    the cookie is well-formed; unequal lengths simply fail). */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function readCookie(header: string | null, name: string): string | null {
  if (header === null) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

/** Verify the `<id>.<sig>` anon cookie against the per-process key; return the id
    when the HMAC matches, else null (absent, malformed, or tampered → the caller
    mints a fresh session). Looks up the name matching the CURRENT request's
    secure determination — a client switching protocols just gets a fresh
    ephemeral session. */
async function verifyAnonCookie(key: CryptoKey, cookieHeader: string | null, secure: boolean): Promise<string | null> {
  const raw = readCookie(cookieHeader, anonCookieName(secure));
  if (raw === null) return null;
  const dot = raw.lastIndexOf(".");
  if (dot <= 0 || dot === raw.length - 1) return null;
  const id = raw.slice(0, dot);
  const sig = raw.slice(dot + 1);
  return constantTimeEqual(sig, await anonSign(key, id)) ? id : null;
}

/** The Set-Cookie for a freshly minted anonymous session. Secure requests get
    the fixation-proof `__Host-` form (Secure + Path=/, per the prefix rules);
    insecure (localhost http dev) keeps the plain name scoped to the wire base. */
async function buildAnonCookie(key: CryptoKey, id: string, secure: boolean): Promise<string> {
  const value = `${id}.${await anonSign(key, id)}`;
  return secure
    ? `${ANON_COOKIE_SECURE}=${value}; Path=/; HttpOnly; SameSite=Lax; Secure`
    : `${ANON_COOKIE}=${value}; Path=${BASE_PATH}; HttpOnly; SameSite=Lax`;
}

/** The Set-Cookie that CLEARS the anonymous session (block-actions design §C:
    the first authenticated request carrying a valid anon cookie merges the
    session's data and retires the cookie). Same attributes as buildAnonCookie
    so the browser matches the stored cookie; Max-Age=0 expires it. */
function clearedAnonCookie(secure: boolean): string {
  return secure
    ? `${ANON_COOKIE_SECURE}=; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=0`
    : `${ANON_COOKIE}=; Path=${BASE_PATH}; HttpOnly; SameSite=Lax; Max-Age=0`;
}

/** Append the minted Set-Cookie to the response. Stream/SSE responses carry
    immutable headers, so re-wrap via `new Response(body, response)` (copies
    status/statusText/headers into a fresh mutable Headers) before appending. */
function withAnonCookie(response: Response, setCookie: string | undefined): Response {
  if (setCookie === undefined) return response;
  const rewrapped = new Response(response.body, response);
  rewrapped.headers.append("set-cookie", setCookie);
  return rewrapped;
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

function createWireHandler(deps: {
  principal: CreateVendoConfig["principal"];
  ready: Promise<void>;
  anonKey: Promise<CryptoKey>;
  /** VENDO_BASE_URL is https → TLS terminates upstream; see secureRequest. */
  trustedBaseIsHttps: boolean;
  sessionId: string;
  store: VendoStore;
  telemetry?: Telemetry;
  agent: VendoAgent;
  guard: VendoGuard;
  apps: AppsRuntime;
  automations: AutomationsEngine;
  connections: ConnectionsService;
  orgs: OrgsService;
  sandbox: SandboxVenue;
  doctor: {
    present(ctx: RunContext): Promise<ToolOutcome>;
    actAs(): Promise<ToolOutcome>;
  };
  mcp: boolean;
  door?: McpDoor;
  /** True only in a development composition — gates the local injection seams. */
  development: boolean;
  runtimeCapture?: RuntimeCaptureHandler;
  onRequestOrigin?: (origin: string) => void;
}): (request: Request) => Promise<Response> {
  return async (request) => {
    // Per-request anonymous-session state. This handler closure is shared across
    // requests, so the minted-cookie state MUST live here (per-invocation) — a
    // shared one would leak one visitor's session to the next. INVARIANT: one
    // request resolves to at most ONE anonymous id — `anon.id` caches the first
    // resolution so a route that calls context() twice on a cookie-less request
    // can never mint a second id (which would silently split one request across
    // two subjects and overwrite the Set-Cookie).
    const anon: { id?: string; setCookie?: string } = {};
    const context = async (req: Request, venue: RunContext["venue"]): Promise<RunContext> => {
      const resolved = await deps.principal(req);
      let principal: Principal;
      // Host-resolved principals keep the process-wide fallback sessionId; only
      // anonymous requests fall back to their per-client cookie id (below).
      let sessionId = req.headers.get("x-vendo-session-id") ?? deps.sessionId;
      if (resolved === null) {
        const key = await deps.anonKey;
        const secure = secureRequest(new URL(req.url), deps.trustedBaseIsHttps);
        let id = anon.id ?? await verifyAnonCookie(key, req.headers.get("cookie"), secure);
        if (id === null) {
          id = randomId();
          anon.setCookie = await buildAnonCookie(key, id, secure);
        }
        anon.id = id;
        principal = ephemeralPrincipal(`anonymous_${id}`);
        // 02-store §4: ephemeral subjects never touch disk. Declare this session
        // ephemeral to the store up front so EVERY subsequent write this turn
        // routes to the in-memory overlay — including the raw records() paths
        // (apps, state, app-data) that only self-register on the typed helpers,
        // and which persist mid-turn before any helper has seen the subject.
        registerEphemeralSubject(deps.store, principal.subject);
        // 05-guard §2: session/task grants bind to ctx.sessionId. Anonymous
        // sessions bind per CLIENT (the cookie id), not per PROCESS, so one
        // visitor's session grant never authorizes another's calls. The explicit
        // x-vendo-session-id header still wins when the client sets it.
        if (req.headers.get("x-vendo-session-id") === null) sessionId = `anon_${id}`;
      } else {
        const parsed = principalSchema.safeParse(resolved);
        if (!parsed.success) {
          throw new VendoError("validation", "principal resolver returned an invalid principal");
        }
        // Block-actions design §C: host resolvers mint USER principals only —
        // org context is derived from membership, never resolved — and the
        // `vendo:` namespace is reserved for runtime-minted subjects (webhook
        // trigger principals, org subjects). Both rejections are LOUD: a
        // resolver colliding with the reserved namespace could otherwise act
        // as an org or a webhook principal.
        if (parsed.data.kind !== "user") {
          throw new VendoError("validation", "principal resolver must mint kind:\"user\" principals; org context is derived from org membership");
        }
        if (isReservedSubject(parsed.data.subject)) {
          throw new VendoError("validation", "principal resolver produced a reserved subject (the vendo: namespace is runtime-minted only)");
        }
        principal = parsed.data;
        // Anonymous→signed-in auto-merge (block-actions design §C): the FIRST
        // authenticated request still carrying a valid anonymous-session
        // cookie adopts that session's threads/apps/state into the signed-in
        // subject (grants, approvals, and connected accounts deliberately do
        // NOT transfer — consent doesn't change identities), then retires the
        // cookie. Idempotent: a replay finds nothing to merge and just clears
        // the cookie again. A merge failure must never take down the request:
        // the cookie stays, and the next authenticated request retries.
        if (principal.ephemeral !== true) {
          const key = await deps.anonKey;
          const secure = secureRequest(new URL(req.url), deps.trustedBaseIsHttps);
          const anonId = await verifyAnonCookie(key, req.headers.get("cookie"), secure);
          if (anonId !== null) {
            try {
              const merged = await adoptEphemeralSubject(deps.store, `anonymous_${anonId}`, principal.subject);
              anon.setCookie = clearedAnonCookie(secure);
              if (merged !== null) {
                await deps.guard.report({
                  id: `aud_${globalThis.crypto.randomUUID()}`,
                  at: new Date().toISOString(),
                  kind: "principal",
                  principal,
                  venue,
                  presence: "present",
                  detail: { event: "anon-merge", from: `anonymous_${anonId}`, ...merged },
                });
              }
            } catch (error) {
              console.warn(`[vendo] anonymous-session merge failed; will retry next request: ${error instanceof Error ? error.message : String(error)}`);
            }
          }
        }
      }
      return {
        principal,
        venue,
        presence: "present",
        sessionId,
        requestHeaders: requestHeaders(req),
      };
    };

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

      const segments = routeSegments(path);
      const head = segments[0];

      if (request.method === "POST" && path === "/threads") {
        const body = await requestJson(request);
        const ctx = await context(request, "chat");
        void deps.telemetry?.track("agent_run", {});
        return await deps.agent.stream({
          ...(body["threadId"] === undefined ? {} : { threadId: string(body["threadId"], "threadId") }),
          message: body["message"] as never,
          ctx,
        });
      }
      if (request.method === "GET" && path === "/threads") {
        return json(await deps.agent.threads.list(await context(request, "chat")));
      }
      if (head === "threads" && segments.length === 2) {
        const ctx = await context(request, "chat");
        const id = string(segments[1], "thread id");
        if (request.method === "GET") {
          const thread = await deps.agent.threads.get(id, ctx);
          if (thread === null) throw new VendoError("not-found", `thread not found: ${id}`);
          return json(thread);
        }
        if (request.method === "DELETE") {
          await deps.agent.threads.delete(id, ctx);
          return json({});
        }
      }

      // Block-actions design §C: `?org=<id>` / body.org switch the approvals
      // surface to an org's queue — ADMIN-gated (members run; admins approve).
      if (request.method === "GET" && path === "/approvals") {
        const ctx = await context(request, "chat");
        const org = url.searchParams.get("org");
        const scoped = org === null ? ctx : await deps.orgs.adminContext(ctx, org);
        return json(await deps.guard.approvals.pending(scoped.principal));
      }
      if (request.method === "POST" && path === "/approvals/decide") {
        const body = await requestJson(request);
        const ids = Array.isArray(body["ids"]) ? body["ids"].map((id) => string(id, "approval id")) : [];
        if (ids.length === 0) throw new VendoError("validation", "ids must contain at least one approval id");
        const decision = approvalDecisionSchema.safeParse(body["decision"]);
        if (!decision.success) throw new VendoError("validation", "decision is invalid");
        const ctx = await context(request, "chat");
        const scoped = body["org"] === undefined ? ctx : await deps.orgs.adminContext(ctx, string(body["org"], "org"));
        await deps.guard.approvals.decide(ids, decision.data as ApprovalDecision, scoped.principal);
        return json({});
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

      // Same admin-gated `?org=` scoping as approvals: admins manage the org's
      // standing grants.
      if (request.method === "GET" && path === "/grants") {
        const ctx = await context(request, "chat");
        const org = url.searchParams.get("org");
        const scoped = org === null ? ctx : await deps.orgs.adminContext(ctx, org);
        return json(await deps.guard.grants.list(scoped.principal));
      }
      if (request.method === "DELETE" && head === "grants" && segments.length === 2) {
        const ctx = await context(request, "chat");
        const org = url.searchParams.get("org");
        const scoped = org === null ? ctx : await deps.orgs.adminContext(ctx, org);
        await deps.guard.grants.revoke(string(segments[1], "grant id"), scoped.principal);
        return json({});
      }

      // Block-actions design §C — org management (key-gated; every deps.orgs
      // call posture-errors without an entitled VENDO_API_KEY).
      if (path === "/orgs" && (request.method === "GET" || request.method === "POST")) {
        const ctx = await context(request, "chat");
        if (request.method === "GET") return json({ orgs: await deps.orgs.list(ctx.principal), posture: deps.orgs.posture });
        const body = await requestJson(request);
        const org = await deps.orgs.create(ctx.principal, string(body["name"], "org name"));
        await deps.guard.report({
          id: `aud_${globalThis.crypto.randomUUID()}`,
          at: new Date().toISOString(),
          kind: "principal",
          principal: ctx.principal,
          venue: ctx.venue,
          presence: "present",
          detail: { event: "org-created", org: org.id, name: org.name },
        });
        return json(org);
      }
      if (head === "orgs" && segments.length >= 2) {
        const orgId = string(segments[1], "org id");
        const ctx = await context(request, "chat");
        if (request.method === "GET" && segments.length === 2) {
          return json(await deps.orgs.get(ctx.principal, orgId));
        }
        if (request.method === "POST" && segments[2] === "members" && segments.length === 3) {
          const body = await requestJson(request);
          const member = await deps.orgs.addMember(
            ctx.principal,
            orgId,
            string(body["subject"], "member subject"),
            (body["role"] === undefined ? "member" : string(body["role"], "role")) as never,
          );
          await deps.guard.report({
            id: `aud_${globalThis.crypto.randomUUID()}`,
            at: new Date().toISOString(),
            kind: "principal",
            principal: ctx.principal,
            venue: ctx.venue,
            presence: "present",
            detail: { event: "org-member-added", org: orgId, subject: member.subject, role: member.role },
          });
          return json(member);
        }
        if (segments[2] === "members" && segments.length === 4) {
          const subject = string(segments[3], "member subject");
          if (request.method === "PATCH") {
            const body = await requestJson(request);
            const member = await deps.orgs.setRole(ctx.principal, orgId, subject, string(body["role"], "role") as never);
            await deps.guard.report({
              id: `aud_${globalThis.crypto.randomUUID()}`,
              at: new Date().toISOString(),
              kind: "principal",
              principal: ctx.principal,
              venue: ctx.venue,
              presence: "present",
              detail: { event: "org-member-role", org: orgId, subject, role: member.role },
            });
            return json(member);
          }
          if (request.method === "DELETE") {
            await deps.orgs.removeMember(ctx.principal, orgId, subject);
            await deps.guard.report({
              id: `aud_${globalThis.crypto.randomUUID()}`,
              at: new Date().toISOString(),
              kind: "principal",
              principal: ctx.principal,
              venue: ctx.venue,
              presence: "present",
              detail: { event: "org-member-removed", org: orgId, subject },
            });
            return json({});
          }
        }
        if (request.method === "POST" && segments[2] === "apps" && segments.length === 3) {
          const body = await requestJson(request);
          const appId = string(body["appId"], "appId");
          await deps.orgs.transferApp(ctx.principal, orgId, appId);
          await deps.guard.report({
            id: `aud_${globalThis.crypto.randomUUID()}`,
            at: new Date().toISOString(),
            kind: "principal",
            principal: ctx.principal,
            venue: ctx.venue,
            presence: "present",
            appId,
            detail: { event: "org-app-transferred", org: orgId, appId },
          });
          return json({});
        }
      }

      if (path === "/apps") {
        const ctx = await context(request, "app");
        if (request.method === "GET") {
          // Org-owned apps the caller can run (block-actions design §C) join
          // the personal listing; memberships() degrades to [] when orgs are
          // unactivated (paid gate). Listings fan out in parallel.
          const [own, memberships] = await Promise.all([
            deps.apps.list(ctx),
            deps.orgs.memberships(ctx.principal),
          ]);
          const orgApps = await Promise.all(memberships.map((membership) => deps.apps.list({
            ...ctx,
            principal: orgPrincipal(membership.id, membership.name),
            actor: ctx.principal,
          })));
          return json([...own, ...orgApps.flat()]);
        }
        if (request.method === "POST") {
          const body = await requestJson(request);
          return json(await deps.apps.create({ prompt: string(body["prompt"], "prompt") }, ctx));
        }
      }
      if (request.method === "POST" && path === "/apps/import") {
        // The CSRF floor exempts import (binary body), so it must instead require
        // a non-CORS-safelisted media type — forcing a cross-origin preflight so
        // a simple credentialed form/text POST cannot silently import (09 §3).
        const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
        if (contentType !== "application/octet-stream" && contentType !== "application/vnd.vendo.app") {
          throw new VendoError("validation", "import requires Content-Type: application/octet-stream");
        }
        const ctx = await context(request, "app");
        return json(await deps.apps.importApp(new Uint8Array(await request.arrayBuffer()), ctx));
      }
      if (head === "apps" && segments.length >= 2) {
        const appId = string(segments[1], "app id");
        const baseCtx = await context(request, "app");
        // Org-owned apps (block-actions design §C): re-contextualize a member's
        // request onto the org principal (actor = the human, for audit). Reads
        // and calls are member-level ("run"); every mutation needs an admin
        // ("manage"). Non-org apps pass through unchanged.
        const operationName = segments[2];
        const need: "run" | "manage" = request.method === "GET"
          || (request.method === "POST" && operationName === "call")
          ? "run"
          : "manage";
        const ctx = await deps.orgs.appContext(baseCtx, appId, need);
        if (segments.length === 2) {
          if (request.method === "GET") {
            const app = await deps.apps.get(appId, ctx);
            if (app === null) throw new VendoError("not-found", `app not found: ${appId}`);
            return json(app);
          }
          if (request.method === "DELETE") {
            await deps.apps.delete(appId, ctx);
            return json({});
          }
        }
        const operation = operationName;
        if (request.method === "GET" && operation === "open" && segments.length === 3) {
          return json(await deps.apps.open(appId, ctx));
        }
        if (request.method === "POST" && operation === "call" && segments.length === 3) {
          const body = await requestJson(request);
          return json(await deps.apps.call(appId, string(body["ref"], "ref"), body["args"] as Json, ctx));
        }
        if (request.method === "POST" && operation === "edit" && segments.length === 3) {
          const body = await requestJson(request);
          return json(await deps.apps.edit(appId, string(body["instruction"], "instruction"), ctx));
        }
        if (operation === "history" && segments.length === 3) {
          if (await deps.apps.get(appId, ctx) === null) throw new VendoError("not-found", `app not found: ${appId}`);
          if (request.method === "GET") return json(await deps.apps.history(appId).list());
          if (request.method === "POST") {
            const body = await requestJson(request);
            if (body["op"] !== "undo") throw new VendoError("validation", "history op must be undo");
            return json(await deps.apps.history(appId).undo());
          }
        }
        // 06-apps §8–§9 — additive: the reviewable diff of what this app ships
        // relative to the captured host baselines, hash-pinned to the version
        // an in-client approval would cover. Owner-scoped like every app route.
        if (request.method === "GET" && operation === "ship-diff" && segments.length === 3) {
          return json(await deps.apps.inClient.shipDiff(appId, ctx));
        }
        // 06-apps §8 — additive drift→rebase surface, owner-scoped like every
        // app route. A rebase rewrites content, so it is only ever invoked
        // explicitly here or via the vendo_apps_rebase_pin agent tool — drift
        // detection never auto-rebases.
        if (request.method === "GET" && operation === "pin-drift" && segments.length === 3) {
          return json(await deps.apps.pins.drift(appId, ctx));
        }
        if (request.method === "POST" && operation === "rebase-pin" && segments.length === 3) {
          const body = await requestJson(request);
          return json(await deps.apps.pins.rebase({ appId, slot: string(body["slot"], "slot") }, ctx));
        }
        if (request.method === "GET" && operation === "export" && segments.length === 3) {
          const bytes = await deps.apps.exportApp(appId, ctx);
          return new Response(bytes as BodyInit, {
            headers: {
              "content-type": "application/octet-stream",
              "content-disposition": `attachment; filename="${appId}.vendoapp"`,
            },
          });
        }
        if (request.method === "POST" && operation === "fork" && segments.length === 3) {
          return json(await deps.apps.fork(appId, ctx));
        }
      }

      if (request.method === "GET" && path === "/automations") {
        return json(await deps.automations.list(await context(request, "automation")));
      }
      if (head === "automations" && segments.length === 3 && request.method === "POST") {
        const appId = string(segments[1], "app id");
        // Org-owned automations: enabling/disabling is managing (admin-gated
        // through the same org re-contextualization as app mutations, §C);
        // dry-run is a read-only preview of a run — member-level, like running.
        const ctx = await deps.orgs.appContext(
          await context(request, "automation"),
          appId,
          segments[2] === "dry-run" ? "run" : "manage",
        );
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
            // Block-actions design §C — org workspaces are key-gated: "cloud"
            // when VENDO_API_KEY is set (activation still requires the plan's
            // `orgs` capability), false otherwise.
            orgs: deps.orgs.posture,
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
    baseUrl?: string;
    baseUrlTrusted?: boolean;
    onPresentCredentialsNotForwarded: typeof warnPresentCredentialsNotForwarded;
    invokeTool?: ToolRegistry["execute"];
  } = {
    dir: ".",
    ...(config.connectors === undefined ? {} : { connectors: config.connectors }),
    ...(config.actAs === undefined ? {} : { actAs: config.actAs }),
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
  // breakers, scanners, and audit see every real call; there is no second
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
  const agent = createAgent({
    model: config.model,
    tools: boundTools,
    guard,
    store,
    context: {
      toolOutputCap: config.agent?.toolOutputCap ?? DEFAULT_TOOL_OUTPUT_CAP,
      ...(config.agent?.maxOutputTokens === undefined ? {} : { maxOutputTokens: config.agent.maxOutputTokens }),
      ...(config.agent?.historyWindow === undefined ? {} : { historyWindow: config.agent.historyWindow }),
    },
    capabilityMiss: {
      hostId: missCapture.hostId,
      surface: missSurface.then(({ hash }) => ({ format: "vendo/tools@1" as const, hash })),
      emit: (event) => missCapture.record(event),
    },
  });
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
  // Block-actions design §C — org workspaces: machinery is OSS, activation is
  // key-gated via the console's /keys/validate (the `orgs` capability).
  const orgs = createOrgs({ store });
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
  // Per-process signing key for anonymous-session cookies (WebCrypto only; see
  // newAnonKey). Anonymous principals are minted per-CLIENT in the handler.
  const anonKey = newAnonKey();
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
    anonKey,
    trustedBaseIsHttps,
    sessionId,
    store,
    telemetry: telemetryClient(config.telemetry),
    agent,
    guard,
    apps,
    automations,
    connections,
    orgs,
    sandbox: sandbox.venue,
    doctor,
    mcp: mcpOptions !== undefined,
    development,
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
    orgs,
    store,
  };
}

/** 09-vendo §2 — adapt the fetch handler to a Next.js catch-all route module.
    PATCH joined the wire with the org member role route (ENG-263). */
export function nextVendoHandler(vendo: Vendo): {
  GET(request: Request): Promise<Response>;
  POST(request: Request): Promise<Response>;
  PATCH(request: Request): Promise<Response>;
  DELETE(request: Request): Promise<Response>;
} {
  const handle = (request: Request): Promise<Response> => vendo.handler(request);
  return { GET: handle, POST: handle, PATCH: handle, DELETE: handle };
}
