import type { AppsRuntime, AppTokens } from "@vendoai/apps";
import type { SandboxVenue } from "@vendoai/apps/sandbox-ladder";
import type { AutomationsEngine } from "@vendoai/automations";
import {
  VendoError,
  type Json,
  type Membership,
  type Principal,
  type ResolvedPerson,
  type RunContext,
  type ToolOutcome,
  type ToolRegistry,
  type VendoErrorCode,
} from "@vendoai/core";
import type { VendoGuard } from "@vendoai/guard";
import type { McpDoor } from "@vendoai/mcp";
import type { SubjectMergeReport, VendoStore } from "@vendoai/store";
import type { Telemetry } from "@vendoai/telemetry";
import type { ByoApprovalResolution } from "../byo-approvals.js";
import type { HarnessTurns } from "../harness-turn.js";
import type { ConnectionsService } from "../connections.js";

/** The shared wire toolkit (kill-list B4): the route-table types and matcher,
    the JSON/error envelope helpers, and the param validators every wire area
    shares. The anonymous-session + RunContext resolution lives in
    wire/context.ts; server.ts assembles the table from the per-area modules
    under src/wire/. */

export const VERSION = "0.8.0";
export const BASE_PATH = "/api/vendo";

/** Re-exported, not redeclared: the venue tag is what the ONE sandbox ladder
    returns (@vendoai/apps/sandbox-ladder), and /status reports it verbatim. */
export type { SandboxVenue };

/** How inference is served: "custom" (a host-passed model) or "ladder" (the
    composed vendoModel default — provider env key, then VENDO_API_KEY via the
    Cloud model gateway, then the honest keyless failure; the ladder resolves
    lazily, so /status cannot name the rung without forcing a resolution). */
export type ModelVenue = "custom" | "ladder";

const STATUS_BY_CODE: Record<VendoErrorCode, number> = {
  validation: 400,
  "not-found": 404,
  blocked: 403,
  // Build contract §9.4 — the caller sees the thing but may not do this to it.
  forbidden: 403,
  conflict: 409,
  "cloud-required": 402,
  "sandbox-unavailable": 501,
  "not-implemented": 501,
};

export interface WireDeps {
  principal: (req: Request) => Promise<Principal | null>;
  /** Build contract §9.1 — the host's own org query, resolved once per context
      resolution in createContextResolver and stashed on the ctx, so every door
      downstream of one `context()` call reads the same answer. Unset → no orgs
      asserted → `can()` degenerates to ownership. */
  memberships?: (principal: Principal) => Promise<Membership[]>;
  /** Spec 2026-08-05 §1 — the auth preset's request→facts seam (ONE session
      decode with `principal`; the preset memoizes per Request). Resolved once
      per context resolution and stashed as `ctx.user`; unset → no [User] block. */
  userFacts?: (req: Request) => Promise<Record<string, Json> | undefined>;
  /** Build contract §9.1 companion — the host's own directory lookup, behind the
      owner gate on the Share dialog's door. Takes the ASKER so the host can scope
      its directory to them. Unset → /status says so and the dialog does not offer
      to share with one person. */
  resolvePerson?: (query: string, asker: Principal) => Promise<ResolvedPerson | null>;
  ready: () => Promise<void>;
  /** VENDO_BASE_URL is https → TLS terminates upstream; see secureRequest. */
  trustedBaseIsHttps: boolean;
  sessionId: string;
  store: VendoStore;
  telemetry?: Telemetry;
  /** Architecture §3 — the composed `Harness` door, and the ONLY one: every
      chat turn is served here — `harness:` when the host named one, `vendo()`
      when they did not.

      `threads` needs nothing from the store beyond the adapter seam, so the
      lifecycle works on a hosted store as it always did. `stream` needs
      somewhere to keep the transcript and the workspace (build contract
      §3.3/§6), and a store that offers neither a SQL handle nor a StoreOps
      surface refuses THAT TURN, loudly, naming both options — where the old
      probe silently routed the whole deployment onto the legacy door. */
  harness: Pick<HarnessTurns, "stream" | "threads">;
  guard: VendoGuard;
  /** Which optional subsystems this deployment mounted (`createVendo({ apps:
      false })` / `{ automations: false }`). An unmounted subsystem's routes are
      not in the table at all, so its surface answers not-found rather than
      answering as an empty version of itself. */
  mounted: { apps: boolean; automations: boolean };
  apps: AppsRuntime;
  /** execution-v2 Lane C — the guard-bound registry (the SAME binding chat and
      automations execute through); the /box tools callback rides it so
      approvals and audit see box-originated calls like any other. */
  tools: ToolRegistry;
  /** execution-v2 Lane C — verify a presented per-app box bearer
      (createAppTokens over the composed store; mint lives with provision). */
  appTokens: Pick<AppTokens, "verify">;
  automations: AutomationsEngine;
  /** Existing-agents Lane B — the per-approval state read `<VendoApprovalEmbed>`
      polls: pending (with the full request for the consent card), executed
      (with the resumed call's outcome), declined, or expired. */
  byoApprovals: {
    read(approvalId: string, principal: Principal): Promise<ByoApprovalResolution>;
  };
  connections: ConnectionsService;
  sandbox: SandboxVenue;
  model: ModelVenue;
  doctor: {
    present(ctx: RunContext): Promise<ToolOutcome>;
    actAs(): Promise<ToolOutcome>;
  };
  /** The mcp block's /status posture (connections-posture pattern): false
      when the door is closed, "local" when it serves its own OAuth surface,
      "broker" when an external authorization server fronts it. */
  mcp: "local" | "broker" | false;
  /** The broker seam's selection as CHOSEN at composition (dev-only
      /doctor/mcp probe): the /status posture above collapses an explicit
      `mcp.remoteAs` and the Cloud-managed broker into one "broker", but
      doctor must keep the seam's explicit-wins precedence — it never ensures
      a tenant for an explicitly configured authorization server. Unlike the
      posture this never degrades: it records what the seam chose. */
  mcpSelection: "off" | "explicit" | "broker" | "local";
  door?: McpDoor;
  /** True only in a development composition — gates the local injection seams. */
  development: boolean;
  onRequestOrigin?: (origin: string) => void;
  /** 02-store §4 (kill-list B3) ephemeral-session policy. `now` reads the
      (possibly injected) session clock; `sweep` runs the store TTL sweep and
      cascades swept subjects into the agent. */
  sessions: { ttlMs: number; sweepIntervalMs: number; now: () => number };
  /** True when any sweep leg is active (session TTL, parked-approval TTL) —
      gates the amortized on-request sweep; each leg still no-ops itself. */
  sweepEnabled: boolean;
  /** The session doors bound to the composed store (selectStore): the local
      engine's SQL registry, or the hosted store's wire doors. */
  sessionStore: {
    register(subject: string, now: number): Promise<void>;
    adopt(from: string, to: string): Promise<SubjectMergeReport | null>;
  };
  sweep: () => Promise<void>;
  /** True when the composed store carries the HOSTED session doors — the
      authenticated /tick then drives `sweep` too. A serverless deployment
      never fires the composition's interval timer, so the tick is the only
      cadence its idle hosted sessions have. Safe against a timer that DOES
      fire: the hosted claim leg is a single-winner election server-side. */
  sweepOnTick: boolean;
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
  /** Run this request's TTL sweep pass, awaiting the one the handler may
      already have started before routing — at most one pass per request. The
      rejection is the caller's to answer with; the pre-routing leg only warns. */
  sweep(): Promise<void>;
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
