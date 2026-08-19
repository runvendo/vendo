/**
 * 09-vendo §2 — the umbrella's public entry: the wire route table, the fetch
 * handler, and `createVendo`.
 *
 * The composition itself lives beside its contract now (compose-context.ts and
 * the phase modules it wires); the type surface lives in types.ts. Everything
 * this file re-exports is re-exported from HERE because `@vendoai/vendo/server`
 * is where a host names it.
 */
import { provideCloudAdapters } from "@vendoai/agents";
import { isJsonRequest, relativePath } from "@vendoai/agents/http";
import { isVendoError, log, VendoError } from "@vendoai/core";
import { announceBootSummary, bootSummaryFor } from "./boot-summary.js";
import { createComposition } from "./compose-context.js";
import { vendoInstance, wireDepsFor } from "./compose-wire.js";
import { setDelegateRunner } from "./delegate.js";
import { doorWellKnownPaths, isDoorPath } from "./door-paths.js";
import { cloudSandbox } from "./sandbox.js";
import type { CreateVendoConfig, Vendo } from "./types.js";
import { appRoutes } from "./wire/apps.js";
import { approvalRoutes, grantRoutes } from "./wire/approvals.js";
import { automationRoutes, runRoutes } from "./wire/automations.js";
import { boxRoutes, fnProxyRoutes, servedProxyRoutes } from "./wire/box.js";
import { channelRoutes } from "./wire/channels.js";
import { connectionRoutes } from "./wire/connections.js";
import { createContextResolver } from "./wire/context.js";
import { doctorBaseUrlRoutes, doctorRoutes } from "./wire/doctor.js";
import {
  activityRoutes,
  devRoutes,
  orgsRoutes,
  statusRoutes,
  syncImpactRoutes,
  systemRoutes,
  webhookRoutes,
} from "./wire/misc.js";
import {
  BASE_PATH,
  dispatchRoutes,
  errorResponse,
  internalError,
  routeSegments,
  type RouteEntry,
  type WireContext,
  type WireDeps,
} from "./wire/shared.js";
import { slotRoutes } from "./wire/slots.js";
import { fileRoutes } from "./wire/files.js";
import { threadRoutes } from "./wire/threads.js";

// 09-vendo §2 — the composition's own type surface, re-exported from the entry
// every importer already names it through.
export type { CreateVendoConfig, TextChannelApi, Vendo, VendoChannels } from "./types.js";

// Architecture §3 — the harness runtime and the default thinker. `vendo()` is
// composed HERE (not by the host) when `harness:` is unset (compose-harness.ts);
// its prompt and descriptor catalog reach it on the turn, never at construction
// — and re-exported, because §10's one-line opt-in is `harness: vendo()`. Without
// this, naming the default harness costs a SECOND direct dependency on
// `@vendoai/harnesses` — a documented one-liner that does not compile from the
// package the host installed. Alias it at the import when your own composed
// value is called `vendo` (`import { vendo as vendoHarness }`).
export { vendo, type VendoHarnessDeps, type VendoHarnessOptions } from "@vendoai/harnesses";

// The screen assembler moved home to this package (it needs `vendo()` from
// harnesses AND the render seam from apps, so only the umbrella can hold it).
// Re-exported because it was public on `@vendoai/harnesses` before the move and
// has an outside reader (genbench drives it against a bare registry).
export { screenAssembler, type ScreenAssemblerDeps } from "./screen-agent.js";

// Both types already sit in the PUBLIC signatures below — `apps:` is typed off
// `AppsConfig`, `Vendo.harness` is a `HarnessTurns` — so a host reads them
// today and simply cannot name them. Exported so it can (and so the quickstart
// config listing, which is compiled against these very interfaces, can too).
export type { HarnessTurns } from "./harness-turn.js";
export type { AppsConfig } from "@vendoai/apps";

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

// entry: the lazily-resolving env ladder createVendo composes when the host
// passes none, exported for host code too (judge wiring, host features). No
// argument means `vendo` semantics (per-rung defaults); a name passes through
// VERBATIM to the resolved rung.
export { vendoModel, type VendoModelOptions, type VendoModelSlot } from "#dev-creds/model";

export { type ModelsConfig } from "./models-config.js";

// The shipped connections adapters ride the server surface so a host can pass
// one explicitly via createVendo({ connections }) — see selectConnections.
export {
  byoConnections,
  cloudConnections,
  unconfiguredConnections,
  type CloudConnectionsOptions,
  type ConnectionsService,
} from "./connections.js";

// The shipped channel adapters ride the same surface, for the same reason: a
// host can pass one explicitly the day it brings its own messaging account.
export {
  cloudTextChannel,
  unconfiguredChannels,
  type ChannelsService,
  type CloudTextChannelOptions,
  type InboundEvent,
  type InboundLinkEvent,
  type InboundTextEvent,
  type TextChannelRegistration,
} from "./channels.js";

// The Cloud sandbox adapter rides the server surface like the connections
// adapters: a host can pass it explicitly via createVendo({ sandbox }) with
// its own options instead of relying on the VENDO_API_KEY default.
export { cloudSandbox, type CloudSandboxOptions } from "./sandbox.js";

// The Cloud secrets provider and its chaining helper ride the server surface
// like the other Cloud adapters: a host can compose them explicitly via
// createVendo({ secrets: chainSecrets(envSecrets(), cloudSecrets({...})) })
// instead of relying on the VENDO_API_KEY default (selectSecrets below).
export { chainSecrets, cloudSecrets, type CloudSecretsOptions } from "./cloud-secrets.js";

// The Cloud tools adapter (the execution half of the zero-key Composio seam)
// rides the server surface the same way: pass it explicitly via
// createVendo({ connectors: [cloudTools({...})] }) to scope with `apps`.
export { cloudTools, type CloudToolsOptions } from "./cloud-tools.js";

// The hosted tenant directory and the policy it feeds ride the server surface
// like the other Cloud adapters — and the console's cross-repo seam test drives
// all three against the SHIPPING code, which is the only way a producer and a
// consumer can ever disagree in a test.
export { cloudDirectory, type CloudDirectory, type CloudDirectoryOptions } from "./cloud-directory.js";
export { tenantLimits } from "./tenant-limits.js";
export { createLimiter, type Limiter, type LimitVerdict } from "./limits.js";

// The BYO connectors a host passes to createVendo({ connectors }), named from
// here so bringing an MCP server or a third-party REST API in is one import
// from the umbrella — no direct @vendoai/actions dependency.
export {
  mcpConnector,
  openApiConnector,
  type ConnectorAuthContext,
  type ConnectorHeadersResolver,
} from "@vendoai/actions";

// The config resolution seam: per surface, a value passed in code → the local
// `.vendo/<name>` file → unset. Nothing remote participates.
export {
  selectConfigSurface,
  isConfigSurface,
  CONFIG_SURFACES,
  type ConfigSurfaceName,
  type ConfigSurfaceOwner,
} from "./config-surface.js";

// The hosted-store adapter rides the server surface like the other Cloud
// adapters: a host can pass it explicitly via createVendo({ store }) with its
// own options instead of relying on the VENDO_API_KEY default.
export { hostedStore, hostedStoreOps, type HostedStore, type HostedStoreOptions } from "@vendoai/store";

// The composition merge, for anyone re-expressing a `ToolRegistry` as the
// `tools:` entries createVendo takes.
export {
  mergeCapability,
  toolsFromRegistry,
  type Contribution,
  type MergedCapability,
} from "./capability/index.js";
export { UNATTENDED_IRREVERSIBILITY_RULE } from "@vendoai/automations";

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
export type {
  VendoNavigation,
  VendoRoute,
  VendoRouteMap,
  VendoTheme,
} from "@vendoai/apps/contract";
export type { PolicyFile } from "@vendoai/guard";
// The `guard:` slot's two arms, named from here for the same reason as
// `ServerActionHandler` and `ComposedAgent`: a host must be able to name what
// it passes without adding a direct dependency on the block the value came
// from. `guard()` itself is re-exported below, beside `vendo()`.
export { guard, createGuard, type GuardRules, type VendoGuard } from "@vendoai/guard";

// The standalone agent runtime leaves its Cloud rungs as a seam because their
// implementations ship here (it may not import the umbrella). Registered at
// IMPORT time, not at compose: `agent()` resolves its own slots at
// CONSTRUCTION, which is before createVendo ever runs. Pure closure
// assignment, no I/O — safe at module scope under workerd (portability gate).
provideCloudAdapters({ sandbox: cloudSandbox });

/** The door path set of each composition, keyed by its own instance: the wire
    matches it (`isDoorPath`) and `wellKnownVendoHandler` must match the SAME
    one, and the base-path prefix it is built from is a composition fact rather
    than a module constant. */
const doorWellKnownByInstance = new WeakMap<Vendo, ReadonlySet<string>>();

function jsonMutationRequired(request: Request, path: string): boolean {
  if (!["POST", "PUT", "PATCH", "DELETE"].includes(request.method)) return false;
  // /box/ is the app-token bearer surface (execution-v2 Lane C): no cookies,
  // no ambient credentials, curl-able from any language inside the box — so
  // the CSRF json gate doesn't apply; JSON-bodied box routes validate their
  // own content-type like the webhook surface does.
  // `/files` carries the dropped file's own bytes under its own media type, so
  // it cannot be JSON either. It does NOT get the media-type toll `/apps/import`
  // pays — an upload's Content-Type is the file's own, and `text/plain` is
  // CORS-safelisted — so it requires the UPLOAD_HEADER instead (wire/files.ts).
  if (path === "/apps/import" || path === "/files" || path === "/tick" || path.startsWith("/webhooks/") || path.startsWith("/box/")) return false;
  return true;
}

/** The wire route TABLE (kill-list B4): every route as (method, pattern,
    handler), assembled from the per-area modules under src/wire/. Entries are
    matched IN ORDER, preserving the old if-chain's precedence exactly:
    1. the dev-only injection seams (fall through in production),
    2. /doctor/base-url, then the doctor probe routes — mounted only in a
       development composition,
    3. the machine surfaces — webhooks, tick, sync impact — all raw-path
       matches ahead of any segment decoding,
    4. the user surfaces: threads → approvals → connections → grants →
       the orgs cloud-required seam → apps → automations → runs →
       activity/status.
    A handler returning undefined falls through to later entries (grouped
    handlers keep the old chain's method/operation fall-out), and no match at
    all answers not-found. */
const wireRoutesFor = (deps: WireDeps): readonly RouteEntry[] => [
  ...devRoutes,
  // Mounted everywhere on purpose — it reports a PRODUCTION misconfiguration.
  ...doctorBaseUrlRoutes,
  // The doctor probes take no principal, and one of them (POST /doctor/act-as)
  // makes the composition mint host actAs material on demand, so mounting them
  // is the whole access control. A composition that did not say it is
  // development never gets the routes.
  ...(deps.development ? doctorRoutes : []),
  ...(deps.mounted.automations ? webhookRoutes : []),
  ...systemRoutes,
  // The `vendo sync` blast-radius probe takes no principal and reads the whole
  // deployment's apps and grants, so mounting it is the ONLY thing standing
  // between it and an anonymous caller. A composition that did not say it is
  // development never gets the route.
  ...(deps.development ? syncImpactRoutes : []),
  // execution-v2 Lane C: the box callback surface is a machine surface like
  // webhooks/tick — raw prefix match, bearer-authenticated, ahead of the user
  // surfaces; the fn proxy sits just before the grouped /apps arm so
  // /apps/:id/fn/:name resolves here, not through the grouped fall-through.
  ...boxRoutes,
  ...threadRoutes,
  // The drop door sits beside the turns it feeds: a file is saved first, and
  // the message that follows carries only where it landed.
  ...fileRoutes,
  ...approvalRoutes,
  ...connectionRoutes,
  // The text channel: the link surface a person opens, Vendo Cloud's inbound
  // machine door, and the API-only status/unlink pair.
  ...channelRoutes,
  ...grantRoutes,
  ...orgsRoutes,
  // The whole /apps surface goes with app generation: with `apps: false` there
  // is nothing to open, fork, serve or import, so the door is not there either.
  ...(deps.mounted.apps
    ? [
      ...fnProxyRoutes,
      // Build contract §9.8 — ahead of the grouped /apps arm for the same reason
      // the fn proxy is: /apps/:id/serve/** must resolve here, not fall through it.
      ...servedProxyRoutes,
      ...appRoutes,
      // The slot registry rides the same mount: with `apps: false` nothing can
      // be built for a slot, so there is nothing to register one for either.
      ...slotRoutes,
    ]
    : []),
  ...(deps.mounted.automations ? [...automationRoutes, ...runRoutes] : []),
  ...activityRoutes,
  ...statusRoutes,
];

function createWireHandler(deps: WireDeps): (request: Request) => Promise<Response> {
  // Assembled once per composition, not per request: what is mounted is a boot
  // fact.
  const wireRoutes = wireRoutesFor(deps);
  // Amortized on-request sweep bookkeeping — lives in the shared handler closure
  // (persists across requests), NOT per-invocation. The serverless-safe leg:
  // Next.js gives no timer guarantee, so every request may trigger the sweep.
  // Awaited BEFORE the request is handled, so a request arriving past a TTL
  // sees the swept state rather than racing its own sweep. A sweep failure is
  // caught and logged, never surfaced to the innocent request that triggered
  // it (same posture as the background timer leg) — a failed sweep just means
  // expired rows live until the next interval.
  let lastSweepAt = deps.sweepNow();
  /** Starts a sweep pass and books the cadence, or answers undefined when the
      interval has not elapsed. `force` is for a route that ASKED for the sweep
      (POST /tick): a serverless process re-seeds lastSweepAt on every
      invocation, so the interval gate would never let one of those through. */
  const startSweep = (force: boolean): Promise<void> | undefined => {
    if (!deps.sweepEnabled) return undefined;
    const now = deps.sweepNow();
    if (!force && now - lastSweepAt < deps.sweepIntervalMs) return undefined;
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
  //      ordinary entries at their old chain positions);
  //   8. no match → not-found.
  return async (request) => {
    // ONE sweep pass per request, shared with any route that drives the sweep
    // itself (POST /tick) so a tick can never run two scans of the same
    // registry. The amortized leg only WARNS — an innocent request must not
    // 500 for a sweep it merely happened to trigger — but the pass keeps its
    // rejection, so a route that asked for the sweep still answers with it.
    let sweepPass = startSweep(false);
    await sweepPass?.catch((error: unknown) => {
      log({
        code: "vendo.ttl-sweep-retry",
        level: "warn",
        message: `[vendo] TTL sweep failed; will retry next interval: ${error instanceof Error ? error.message : String(error)}`,
      });
    });
    // The one shared context-resolution pass (see wire/shared.ts).
    const context = createContextResolver(deps);

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
      if (deps.door !== undefined && isDoorPath(url.pathname, deps.doorWellKnown)) {
        await deps.ready();
        return await deps.door.handler(request);
      }
      const path = relativePath(BASE_PATH, url);
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
      // `isVendoError`, not `instanceof`: a host bundle's second @vendoai/core
      // copy mints a different class, and 0.27.0 answered 501 to every one of
      // its refusals — a blocked collection read as "Internal Vendo error".
      if (isVendoError(error)) return errorResponse(error);
      // The wire response stays generic (no internals leak to clients), but
      // the host operator gets the real failure on their own server log.
      log({
        code: "vendo.unhandled-wire-error",
        level: "error",
        message: "[vendo] unhandled wire error:",
        data: { error },
      });
      return internalError();
    }
  };
}

/**
 * 09-vendo §2 — compose every live block around the guard choke point.
 *
 * An assembler, and nothing else: `createComposition` wires the phases
 * (compose-context.ts), `wireDepsFor` hands the wire what they produced, and
 * `vendoInstance` is the handle the host holds.
 */
export function createVendo(input: CreateVendoConfig): Vendo {
  const composition = createComposition(input);
  // What this deployment actually composed, said once, to the operator
  // (boot-summary.ts). Composed facts only — no filesystem, nothing awaited.
  announceBootSummary(bootSummaryFor(composition));
  const instance = vendoInstance(composition, createWireHandler(wireDepsFor(composition)));
  // D5 — the tool pack's `vendo_delegate` motor, carried internally rather than
  // on the host surface (see delegate.ts).
  setDelegateRunner(instance, composition.delegateRunner);
  // Same idea: `wellKnownVendoHandler` forwards by the SAME path set the wire
  // matches, and that set is this composition's, not a module constant.
  doorWellKnownByInstance.set(instance, composition.doorWellKnown);
  return instance;
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
    too, one that shares this composition's own door path set with the wire
    itself (the SAME set `isDoorPath` matches — `doorWellKnownPaths`, so a
    path-mounted deployment answers both spellings here too) instead of a
    hand-copied allowlist that can drift from it. A request whose pathname is
    exactly one of those paths
    forwards to `vendo.handler` (which independently confirms it's a door path
    and, if `mcp` is configured, serves it — the check here is only about
    which requests reach the wire at all); anything else answers 404 with an
    empty body, mirroring the hand-written route this replaces. With `mcp` left
    unconfigured, `vendo.handler` still recognizes these paths but has no
    door to serve them, so the request falls through to the wire's ordinary
    not-found response — never a 500. */
export function wellKnownVendoHandler(vendo: Vendo): {
  GET(request: Request): Promise<Response>;
  POST(request: Request): Promise<Response>;
} {
  const wellKnown = doorWellKnownByInstance.get(vendo) ?? doorWellKnownPaths("");
  const handle = (request: Request): Promise<Response> => {
    const { pathname } = new URL(request.url);
    return wellKnown.has(pathname)
      ? vendo.handler(request)
      : Promise.resolve(new Response(null, { status: 404 }));
  };
  return { GET: handle, POST: handle };
}
