import type { AppsRuntime } from "@vendoai/apps";
import type { AutomationsEngine } from "@vendoai/automations";
import {
  VendoError,
  isReservedSubject,
  principalSchema,
  type Principal,
  type RunContext,
  type ToolOutcome,
  type VendoErrorCode,
} from "@vendoai/core";
import type { VendoGuard } from "@vendoai/guard";
import type { McpDoor } from "@vendoai/mcp";
import {
  adoptEphemeralSubject,
  registerEphemeralSubject,
  type VendoStore,
} from "@vendoai/store";
import type { Telemetry } from "@vendoai/telemetry";
import type { VendoAgent } from "@vendoai/agent";
import type { ConnectionsService } from "../connections.js";
import type { RuntimeCaptureHandler } from "../runtime-capture.js";

/** Shared per-request wire plumbing (kill-list B4): the route-table types and
    matcher, the JSON/error envelope helpers, the param validators, and the
    anonymous-session + RunContext resolution every wire area shares. server.ts
    assembles the table; the per-area modules under src/wire/ export entries. */

export const VERSION = "0.3.0";
export const BASE_PATH = "/api/vendo";

export type SandboxVenue = "e2b" | "modal" | "custom" | false;

const STATUS_BY_CODE: Record<VendoErrorCode, number> = {
  validation: 400,
  "not-found": 404,
  blocked: 403,
  conflict: 409,
  "cloud-required": 402,
  "sandbox-unavailable": 501,
  "not-implemented": 501,
};

export interface WireDeps {
  principal: (req: Request) => Promise<Principal | null>;
  ready: Promise<void>;
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
  /** 02-store §4 (kill-list B3) ephemeral-session policy. `now` reads the
      (possibly injected) session clock; `sweep` runs the store TTL sweep and
      cascades swept subjects into the agent. */
  sessions: { ttlMs: number; sweepIntervalMs: number; now: () => number };
  sweep: () => Promise<void>;
}

/** The per-request view a route handler receives: the raw request, its parsed
    URL, the wire-relative path, lazily decoded segments, the matched entry's
    `:param` captures, the anon-session-aware RunContext resolver, and the
    composed deps. */
export interface WireContext {
  request: Request;
  url: URL;
  /** Wire-relative raw path (output of the server's relativePath). */
  path: string;
  /** Decoded path segments — computed lazily on first access so raw-matched
      routes (exact/prefix) never decode; malformed encoding throws the same
      validation error the old eager routeSegments call threw. */
  readonly segments: string[];
  /** `:param` captures from the matched pattern (decoded segment values). */
  params: Record<string, string>;
  /** Resolve this request's RunContext for a venue. */
  context(venue: RunContext["venue"]): Promise<RunContext>;
  deps: WireDeps;
}

/** A handler answers with a Response, or returns undefined to FALL THROUGH to
    the next entry — mirroring the old if-chain, where a matched-path block
    whose method/operation checks all missed simply fell out the bottom (any
    side effects it ran, e.g. context resolution, stand). */
export type RouteHandler = (wire: WireContext) => Promise<Response | undefined>;

type RoutePattern =
  /** Raw-path equality — no decoding, matching the old `path === "/x"` arms. */
  | { kind: "exact"; path: string }
  /** Raw-path prefix — matching the old `path.startsWith("/x/")` arms. */
  | { kind: "prefix"; prefix: string }
  /** Decoded-segment match: literals compare against decoded values, `:name`
      captures, a trailing rest wildcard allows ZERO or more extra segments —
      matching the old `head === "x" && segments.length >= n` arms. */
  | { kind: "segments"; parts: string[]; rest: boolean };

export interface RouteEntry {
  /** Exact method, or "*" for grouped handlers that dispatch methods inside. */
  method: string;
  pattern: RoutePattern;
  handler: RouteHandler;
}

/** Table entry from a pattern string: no `:param` and no trailing `/*` means
    raw-path equality; otherwise decoded-segment matching (trailing `/*` = rest
    wildcard, zero or more segments). */
export function route(method: string, pattern: string, handler: RouteHandler): RouteEntry {
  if (!pattern.includes(":") && !pattern.endsWith("/*")) {
    return { method, pattern: { kind: "exact", path: pattern }, handler };
  }
  const rest = pattern.endsWith("/*");
  const parts = (rest ? pattern.slice(0, -2) : pattern).split("/").filter(Boolean);
  return { method, pattern: { kind: "segments", parts, rest }, handler };
}

/** Table entry matching on a raw path prefix (webhooks, proxy, the doctor
    production gate) — never decodes, exactly like the old startsWith arms. */
export function prefixRoute(method: string, prefix: string, handler: RouteHandler): RouteEntry {
  return { method, pattern: { kind: "prefix", prefix }, handler };
}

function matchRoute(entry: RouteEntry, wire: WireContext): Record<string, string> | null {
  if (entry.method !== "*" && entry.method !== wire.request.method) return null;
  const pattern = entry.pattern;
  if (pattern.kind === "exact") return pattern.path === wire.path ? {} : null;
  if (pattern.kind === "prefix") return wire.path.startsWith(pattern.prefix) ? {} : null;
  // Segment access may throw the invalid-encoding validation error — only ever
  // reached after every raw pre-route entry has had its chance, preserving the
  // old chain's ordering (prefix routes served /proxy/%zz; /threads/%zz threw).
  const segments = wire.segments;
  if (pattern.rest ? segments.length < pattern.parts.length : segments.length !== pattern.parts.length) {
    return null;
  }
  const params: Record<string, string> = {};
  for (let i = 0; i < pattern.parts.length; i++) {
    const part = pattern.parts[i]!;
    if (part.startsWith(":")) params[part.slice(1)] = segments[i]!;
    else if (part !== segments[i]) return null;
  }
  return params;
}

/** Scan the table in order; a handler returning undefined keeps scanning
    (fall-through). No match → undefined; the caller answers not-found. */
export async function dispatchRoutes(
  routes: readonly RouteEntry[],
  wire: WireContext,
): Promise<Response | undefined> {
  for (const entry of routes) {
    const params = matchRoute(entry, wire);
    if (params === null) continue;
    wire.params = params;
    const response = await entry.handler(wire);
    if (response !== undefined) return response;
  }
  return undefined;
}

export function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

export function errorResponse(error: VendoError): Response {
  return json({ error: { code: error.code, message: error.message } }, STATUS_BY_CODE[error.code]);
}

export function internalError(): Response {
  return errorResponse(new VendoError("not-implemented", "Internal Vendo error"));
}

/** Orgs are a Vendo Cloud capability, not an OSS one (kill-list A5): every
    /orgs route and every org-scoped param on /approvals and /grants answers
    this, unconditionally — there is no key-gated activation path left in the
    OSS wire (contrast the old block-actions design §C org machinery, which
    this seam replaces). */
export function orgsCloudRequired(): never {
  throw new VendoError("cloud-required", "orgs are a Vendo Cloud capability");
}

export function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new VendoError("validation", `${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

export function string(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new VendoError("validation", `${label} must be a non-empty string`);
  }
  return value;
}

export async function requestJson(request: Request): Promise<Record<string, unknown>> {
  try {
    return object(await request.json(), "request body");
  } catch (error) {
    if (error instanceof VendoError) throw error;
    throw new VendoError("validation", "request body must be valid JSON");
  }
}

export function environment(name: string): string | undefined {
  if (typeof process === "undefined") return undefined;
  const value = process.env[name];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function routeSegments(path: string): string[] {
  try {
    return path.split("/").filter(Boolean).map(decodeURIComponent);
  } catch {
    throw new VendoError("validation", "route contains invalid URL encoding");
  }
}

function requestHeaders(request: Request): Record<string, string> {
  return Object.fromEntries(request.headers.entries());
}

export function hex(bytes: ArrayBuffer | Uint8Array): string {
  let out = "";
  for (const b of bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)) out += b.toString(16).padStart(2, "0");
  return out;
}

function randomId(): string {
  const raw = new Uint8Array(16); // 128-bit session id
  globalThis.crypto.getRandomValues(raw);
  return hex(raw);
}

/** Length-independent-leak-free digest compare for timingSafeEqual's HMAC
    digests (always equal-length hex; unequal lengths simply fail). */
export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function ephemeralPrincipal(subject: string): Principal {
  return { kind: "user", subject, ephemeral: true };
}

/** 00 overview ("no host principal resolver → an ephemeral session-scoped
    principal"), 01-core §2, 02-store §4. When `principal(req)` returns null the
    visitor is anonymous, and each CLIENT gets its OWN ephemeral principal —
    carried by an opaque httpOnly cookie (a random 128-bit session id) so two
    anonymous visitors never share threads, grants, approvals, or apps. The
    cookie is just a pointer: the session's `vendo_sessions` row and its
    ordinary disk rows are the authority (02-store §4, kill-list B3), so it
    carries no signature — an invented id names its own empty session. */
const ANON_COOKIE = "vendo_anon_session";
/** Secure requests use the `__Host-` prefix against session fixation (cookie
    tossing): a sibling subdomain could otherwise plant an attacker's own
    session cookie via `Domain=` and read everything the victim's anonymous
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

function readCookie(header: string | null, name: string): string | null {
  if (header === null) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

/** The shape of the opaque pointer we mint: 128-bit lowercase hex (randomId). */
const ANON_ID_PATTERN = /^[0-9a-f]{32}$/;

/** Read the anonymous-session pointer from the Cookie header; return the id
    when it is a well-formed 128-bit hex pointer, else null (absent or
    malformed → the caller mints a fresh session). There is nothing to verify
    beyond shape: the session's `vendo_sessions` row is the authority, so an
    invented id merely names its own EMPTY session — guessing a live one is a
    2^128 search (kill-list B3; ids survive restarts and cross instances with
    the disk rows). Looks up the name matching the CURRENT request's secure
    determination — a client switching protocols just gets a fresh ephemeral
    session. */
function readAnonCookie(cookieHeader: string | null, secure: boolean): string | null {
  const raw = readCookie(cookieHeader, anonCookieName(secure));
  return raw !== null && ANON_ID_PATTERN.test(raw) ? raw : null;
}

/** The Set-Cookie for a freshly minted anonymous session. Secure requests get
    the fixation-proof `__Host-` form (Secure + Path=/, per the prefix rules);
    insecure (localhost http dev) keeps the plain name scoped to the wire base. */
function buildAnonCookie(id: string, secure: boolean): string {
  return secure
    ? `${ANON_COOKIE_SECURE}=${id}; Path=/; HttpOnly; SameSite=Lax; Secure`
    : `${ANON_COOKIE}=${id}; Path=${BASE_PATH}; HttpOnly; SameSite=Lax`;
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
export function withAnonCookie(response: Response, setCookie: string | undefined): Response {
  if (setCookie === undefined) return response;
  const rewrapped = new Response(response.body, response);
  rewrapped.headers.append("set-cookie", setCookie);
  return rewrapped;
}

/** Per-request anonymous-session state. The wire handler closure is shared
    across requests, so this MUST be minted per-invocation — a shared one would
    leak one visitor's session to the next. INVARIANT: one request resolves to
    at most ONE anonymous id — `id` caches the first resolution so a route that
    resolves context twice on a cookie-less request can never mint a second id
    (which would silently split one request across two subjects and overwrite
    the Set-Cookie). */
export interface AnonSession {
  id?: string;
  setCookie?: string;
}

/** The one context-resolution pass every route shares (kill-list B4): resolve
    the host principal (or mint/read the per-client anonymous session), enforce
    the resolver invariants, run the anonymous→signed-in merge, and touch the
    ephemeral session row. Returned resolver is called per route with a venue. */
export function createContextResolver(
  deps: WireDeps,
  anon: AnonSession,
): (req: Request, venue: RunContext["venue"]) => Promise<RunContext> {
  return async (req, venue) => {
    const resolved = await deps.principal(req);
    let principal: Principal;
    // Host-resolved principals keep the process-wide fallback sessionId; only
    // anonymous requests fall back to their per-client cookie id (below).
    let sessionId = req.headers.get("x-vendo-session-id") ?? deps.sessionId;
    if (resolved === null) {
      const secure = secureRequest(new URL(req.url), deps.trustedBaseIsHttps);
      let id = anon.id ?? readAnonCookie(req.headers.get("cookie"), secure);
      if (id === null) {
        id = randomId();
        anon.setCookie = buildAnonCookie(id, secure);
      }
      anon.id = id;
      principal = ephemeralPrincipal(`anonymous_${id}`);
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
        const secure = secureRequest(new URL(req.url), deps.trustedBaseIsHttps);
        const anonId = readAnonCookie(req.headers.get("cookie"), secure);
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
    // 02-store §4 (kill-list B3): anonymous rows are ordinary disk rows;
    // registering the subject (registration == touch) is what makes the
    // session sweepable and keeps it alive while the visitor is active. One
    // touch covers both anonymous and host-resolved ephemeral principals.
    if (principal.ephemeral === true) {
      await registerEphemeralSubject(deps.store, principal.subject, deps.sessions.now());
    }
    return {
      principal,
      venue,
      presence: "present",
      sessionId,
      requestHeaders: requestHeaders(req),
    };
  };
}
