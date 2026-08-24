import {
  dispatchRoutes as dispatchHttpRoutes,
  prefixRoute as httpPrefixRoute,
  route as httpRoute,
  type RouteEntry as HttpRouteEntry,
  type RouteHandler as HttpRouteHandler,
} from "@vendoai/agents/http";
import type { AppsRuntime } from "@vendoai/apps";
import type { SandboxVenue } from "@vendoai/apps";
import type { AutomationsEngine } from "@vendoai/automations";
import {
  VendoError,
  type Json,
  type Membership,
  type Principal,
  type RunContext,
  type StoreOps,
  type ToolOutcome,
  type ToolRegistry,
} from "@vendoai/core";
import type { VendoGuard } from "@vendoai/guard";
import type { McpDoor } from "@vendoai/mcp";
import type { VendoStore } from "@vendoai/store";
import type { Telemetry } from "@vendoai/telemetry";
import type { ByoApprovalResolution } from "../byo-approvals.js";
import type { FilesVenue } from "../compose-store.js";
import type { HarnessTurns } from "../harness-turn.js";
import type { ChannelDoor } from "../channels.js";
import type { ConnectionsService } from "../connections.js";

/** The shared wire toolkit (kill-list B4). The generic half — the route-table
    types and matcher, the envelope helpers, the param validators — lives in
    `@vendoai/agents/http` now, so there is exactly ONE route runtime; it is
    re-exported here, so every wire area keeps its `./shared.js` import. What
    stays is what only the umbrella has. The per-request RunContext resolution
    lives in wire/context.ts; server.ts assembles the table from the per-area
    modules under src/wire/. */
export { errorResponse, hex, internalError, json, object, requestJson, routeSegments, string } from "@vendoai/agents/http";

/** Re-exported, not redeclared: the one version literal lives in
    @vendoai/core, beside the deployment-identity headers that stamp it. */
export { VERSION } from "@vendoai/core";
export const BASE_PATH = "/api/vendo";

/** Re-exported, not redeclared: the venue tag is what the ONE sandbox ladder
    returns (@vendoai/apps), and /status reports it verbatim. */
export type { SandboxVenue };

/** Re-exported for the same reason: `selectFiles` is what decides it. */
export type { FilesVenue };

/** How inference is served: "custom" (a host-passed model) or "ladder" (the
    composed vendoModel default — provider env key, then VENDO_API_KEY via the
    Cloud model gateway, then the honest keyless failure; the ladder resolves
    lazily, so /status cannot name the rung without forcing a resolution). */
export type ModelVenue = "custom" | "ladder";

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
  /** The auth preset's request→pools seam (the same session decode again).
      Resolved once per context resolution and stashed as `ctx.pools`; unset →
      the user's usage counts into no shared meter. */
  userPools?: (req: Request) => Promise<Record<string, string> | undefined>;
  ready: () => Promise<void>;
  /** VENDO_BASE_URL is https → TLS terminates upstream, so the request reaches
      this process as http. */
  trustedBaseIsHttps: boolean;
  sessionId: string;
  store: VendoStore;
  /** The SAME 35-op surface `selectStoreOps` chose for this deployment, over
      that same store and files adapter — the owner-stamped appData family is
      only reachable here. Absent when the store offers neither its own ops nor
      a SQL handle; the routes that need it refuse THAT REQUEST, naming both
      ways to give the deployment one. */
  ops: StoreOps | undefined;
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
  harness: Pick<HarnessTurns, "stream" | "threads" | "putUserFile">;
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
  automations: AutomationsEngine;
  /** Existing-agents Lane B — the per-approval state read `<VendoApprovalEmbed>`
      polls: pending (with the full request for the consent card), executed
      (with the resumed call's outcome), declined, or expired. */
  byoApprovals: {
    read(approvalId: string, principal: Principal): Promise<ByoApprovalResolution>;
  };
  connections: ConnectionsService;
  /** The composed text-channel door: the link invite, the status/unlink pair,
      and the inbound runner the machine door drives. */
  channels: ChannelDoor;
  /** The bearer an inbound delivery must present (HMAC of VENDO_API_KEY).
      Undefined with no Cloud key — the door then refuses every delivery. */
  channelInboundSecret: () => Promise<string | undefined>;
  sandbox: SandboxVenue;
  /** The resolved `createVendo({ uploadMaxBytes })`, and which backing the
      bytes it admits will land in — the drop door refuses over its cap and
      names both, so raising it past what the backing can hold is visible from
      the refusal itself. */
  uploadMaxBytes: number;
  files: FilesVenue;
  model: ModelVenue;
  doctor: {
    present(ctx: RunContext): Promise<ToolOutcome>;
    actAs(): Promise<ToolOutcome>;
  };
  /** The mcp block's /status posture (connections-posture pattern): false
      when the door is closed, "local" when it serves its own OAuth surface,
      "broker" when an external authorization server fronts it. */
  mcp: "local" | "broker" | false;
  door?: McpDoor;
  /** The exact well-known paths this composition hands the door — the door's
      four documents, plus the base-path-prefixed spelling of the two metadata
      ones when the deployment is mounted under a prefix (doorWellKnownPaths in
      door-paths.ts). Built at composition, because the prefix is a composition
      fact. */
  doorWellKnown: ReadonlySet<string>;
  /** True only in a development composition — gates the local injection seams. */
  development: boolean;
  onRequestOrigin?: (origin: string) => void;
  /** True when any sweep leg is active (parked BYO calls, stranded approvals) —
      gates the amortized on-request sweep; each leg still no-ops itself. */
  sweepEnabled: boolean;
  /** How often the amortized on-request sweep may fire, and the (possibly
      injected) clock it books that cadence against. Same pair the background
      timer runs on, so a serverless deployment and a long-lived one sweep at
      the same rate. */
  sweepIntervalMs: number;
  sweepNow: () => number;
  sweep: () => Promise<void>;
  /** True when the composed store is the HOSTED one — the authenticated /tick
      then drives `sweep` too. A serverless deployment (the hosted store's
      typical home) never fires the composition's interval timer, so the tick
      is the only cadence its TTL legs have. */
  sweepOnTick: boolean;
}

/** The per-request view a route handler receives: the raw request, its parsed
    URL, the wire-relative path, lazily decoded segments, the matched entry's
    `:param` captures, the RunContext resolver, and the composed deps. */
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

/** The umbrella's binding of the shared route runtime to its own WireContext.
    Bound as VALUES rather than re-exported generics: a handler written with an
    implicit parameter (`route("GET", "/x", async ({ deps }) => …)`) has no
    inference site, so the annotation here is what contextually types it. */
export type RouteHandler = HttpRouteHandler<WireContext>;
export type RouteEntry = HttpRouteEntry<WireContext>;
export const route: (method: string, pattern: string, handler: RouteHandler) => RouteEntry = httpRoute;
export const prefixRoute: (method: string, prefix: string, handler: RouteHandler) => RouteEntry = httpPrefixRoute;
export const dispatchRoutes: (routes: readonly RouteEntry[], wire: WireContext) => Promise<Response | undefined> =
  dispatchHttpRoutes;

/** Orgs are a Vendo Cloud capability, not an OSS one (kill-list A5): every
    /orgs route and every org-scoped param on /approvals and /grants answers
    this, unconditionally — there is no key-gated activation path left in the
    OSS wire (contrast the old block-actions design §C org machinery, which
    this seam replaces). */
export function orgsCloudRequired(): never {
  throw new VendoError("cloud-required", "orgs are a Vendo Cloud capability");
}

/** Stays here, and deliberately NOT trimmed: `vendo doctor` reads operator
    variables with this exact predicate so doctor and runtime agree on what
    counts as set (doctor-config-checks.ts, doctor-wiring-checks.ts), and
    boot-summary.ts's `keySet` documents itself as the stricter one. The trimmed
    reader in @vendoai/agents' door.ts is a different question — an ORIGIN. */
export function environment(name: string): string | undefined {
  if (typeof process === "undefined") return undefined;
  const value = process.env[name];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
