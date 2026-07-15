import { createActions, type ActionsRegistry, type Connector } from "@vendoai/actions";
import { createAgent, type VendoAgent } from "@vendoai/agent";
import { createApps, type AppsRuntime, type SandboxAdapter } from "@vendoai/apps";
import { e2bSandbox } from "@vendoai/apps/e2b";
import { modalSandbox } from "@vendoai/apps/modal";
import {
  createAutomations,
  type AutomationsEngine,
  type RunStatus,
} from "@vendoai/automations";
import {
  VendoError,
  approvalDecisionSchema,
  principalSchema,
  vendoThemeSchema,
  type ActAs,
  type ApprovalDecision,
  type ComponentCatalog,
  type Json,
  type Principal,
  type RunContext,
  type RunId,
  type SecretsProvider,
  type VendoErrorCode,
  type VendoTheme,
} from "@vendoai/core";
import { createGuard, type Judge, type PolicyConfig, type VendoGuard } from "@vendoai/guard";
import { createMcpDoor, type AppsPort, type HostOAuthAdapter, type McpDoor } from "@vendoai/mcp";
import { createStore, envSecrets, registerEphemeralSubject, type VendoStore } from "@vendoai/store";
import { initTelemetry, type Telemetry } from "@vendoai/telemetry";
import type { LanguageModel } from "ai";
import {
  capabilitySurfaceSnapshot,
  createCapabilityMissCapture,
} from "./capability-misses.js";
import { computeImpact } from "./sync-impact.js";

const VERSION = "0.3.0";
const BASE_PATH = "/api/vendo";
/** 10-mcp §5 — the door's canonical mount under the wire's own prefix. */
const MCP_MOUNT = `${BASE_PATH}/mcp`;

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
  /** 10-mcp §1 — the one flag: open the MCP door so outside agents (Claude,
      ChatGPT, Cursor) reach the host's tools through the SAME guard-bound path.
      Opening it is a host decision (10-mcp §2), so it is off by default. */
  mcp?: boolean;
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

  const e2bApiKey = environment("E2B_API_KEY");
  if (e2bApiKey !== undefined) {
    return { adapter: e2bSandbox({ apiKey: e2bApiKey }), venue: "e2b" };
  }

  const modalTokenId = environment("MODAL_TOKEN_ID");
  const modalTokenSecret = environment("MODAL_TOKEN_SECRET");
  if (modalTokenId !== undefined && modalTokenSecret !== undefined) {
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
  sandbox: SandboxVenue;
  mcp: boolean;
  door?: McpDoor;
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
        principal = parsed.data;
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

      if (request.method === "GET" && path === "/approvals") {
        const ctx = await context(request, "chat");
        return json(await deps.guard.approvals.pending(ctx.principal));
      }
      if (request.method === "POST" && path === "/approvals/decide") {
        const body = await requestJson(request);
        const ids = Array.isArray(body["ids"]) ? body["ids"].map((id) => string(id, "approval id")) : [];
        if (ids.length === 0) throw new VendoError("validation", "ids must contain at least one approval id");
        const decision = approvalDecisionSchema.safeParse(body["decision"]);
        if (!decision.success) throw new VendoError("validation", "decision is invalid");
        const ctx = await context(request, "chat");
        await deps.guard.approvals.decide(ids, decision.data as ApprovalDecision, ctx.principal);
        return json({});
      }

      if (request.method === "GET" && path === "/grants") {
        const ctx = await context(request, "chat");
        return json(await deps.guard.grants.list(ctx.principal));
      }
      if (request.method === "DELETE" && head === "grants" && segments.length === 2) {
        const ctx = await context(request, "chat");
        await deps.guard.grants.revoke(string(segments[1], "grant id"), ctx.principal);
        return json({});
      }

      if (path === "/apps") {
        const ctx = await context(request, "app");
        if (request.method === "GET") return json(await deps.apps.list(ctx));
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
        const ctx = await context(request, "app");
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
        const operation = segments[2];
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
        const ctx = await context(request, "automation");
        const appId = string(segments[1], "app id");
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
          },
        });
      }

      throw new VendoError("not-found", "unknown Vendo route");
    } catch (error) {
      if (error instanceof VendoError) return errorResponse(error);
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
  const store = config.store ?? createStore();
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
  } = {
    dir: ".",
    ...(config.connectors === undefined ? {} : { connectors: config.connectors }),
    ...(config.actAs === undefined ? {} : { actAs: config.actAs }),
    ...(configuredBaseUrl === undefined ? {} : { baseUrl: configuredBaseUrl, baseUrlTrusted: true }),
  };
  const actions = createActions(actionsConfig);
  const boundTools = guard.bind(actions);
  const theme = dotVendoTheme();
  const designRules = dotVendoFile("design-rules.md");
  const apps = createApps({
    store,
    guard,
    tools: boundTools,
    model: config.model,
    catalog: config.catalog ?? [],
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
  // 10-mcp §1 — construct the door from the parts already assembled: the SAME
  // guard-bound registry chat/apps/automations use, the guard (its core seam is
  // what the door holds for auth audit), the store (a StoreAdapter for the door's
  // own protocol state), the host's oauth seam, and an AppsPort view of `apps`.
  let door: McpDoor | undefined;
  if (config.mcp === true) {
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
    // teaches it, and learned paths never override it.
    door = createMcpDoor({
      tools: boundTools,
      guard,
      store,
      oauth: config.oauth,
      apps: appsPort,
      mount: MCP_MOUNT,
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
    sandbox: sandbox.venue,
    mcp: config.mcp === true,
    ...(door === undefined ? {} : { door }),
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
    store,
  };
}

/** 09-vendo §2 — adapt the fetch handler to a Next.js catch-all route module. */
export function nextVendoHandler(vendo: Vendo): {
  GET(request: Request): Promise<Response>;
  POST(request: Request): Promise<Response>;
  DELETE(request: Request): Promise<Response>;
} {
  const handle = (request: Request): Promise<Response> => vendo.handler(request);
  return { GET: handle, POST: handle, DELETE: handle };
}
