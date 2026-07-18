import type { AppsRuntime } from "@vendoai/apps";
import type { AutomationsEngine } from "@vendoai/automations";
import {
  VendoError,
  type Principal,
  type RunContext,
  type ToolOutcome,
  type VendoErrorCode,
} from "@vendoai/core";
import type { VendoGuard } from "@vendoai/guard";
import type { McpDoor } from "@vendoai/mcp";
import type { VendoStore } from "@vendoai/store";
import type { Telemetry } from "@vendoai/telemetry";
import type { VendoAgent } from "@vendoai/agent";
import type { ConnectionsService } from "../connections.js";
import type { RuntimeCaptureHandler } from "../runtime-capture.js";

/** The shared wire toolkit (kill-list B4): the route-table types and matcher,
    the JSON/error envelope helpers, and the param validators every wire area
    shares. The anonymous-session + RunContext resolution lives in
    wire/context.ts; server.ts assembles the table from the per-area modules
    under src/wire/. */

export const VERSION = "0.3.0";
export const BASE_PATH = "/api/vendo";

export type SandboxVenue = "e2b" | "modal" | "cloud" | "custom" | false;

/** How inference is served: "custom" (a host-passed model — BYO provider or
    devModel), "cloud" (VENDO_API_KEY → Vendo Cloud managed inference), or off. */
export type ModelVenue = "custom" | "cloud" | false;

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
  model: ModelVenue;
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
    production gate) — never decodes, exactly like the old startsWith arms.
    Raw string match, no segment boundary — include the trailing slash. */
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

function object(value: unknown, label: string): Record<string, unknown> {
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

/** Bytes → lowercase hex. Used by wire/context.ts's session-id mint and
    wire/misc.ts's timing-safe digest compare. */
export function hex(bytes: ArrayBuffer | Uint8Array): string {
  let out = "";
  for (const b of bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)) out += b.toString(16).padStart(2, "0");
  return out;
}
