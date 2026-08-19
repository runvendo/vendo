/**
 * The connect/discovery lane: who is connected to what, the host's curated
 * agent menu, and which connector owns a broker slug.
 *
 * Every lookup here is read by seams composed EARLIER (the pre-guard connect
 * gate, the guard's risk chain, the discovery ports, the loadout seed) and only
 * ever runs inside a request, which is why the composition is handed around as
 * one object instead of threaded in dependency order.
 */
import type { Connector } from "@vendoai/actions";
import type { Principal, RiskLabel, RunContext, ToolCall } from "@vendoai/core";
import type { VendoComposition } from "./compose-context.js";
import { selectConnections, withDisconnectInvalidation } from "./compose-selection.js";
import { USE_SERVICE_TOOL } from "./connector-discovery.js";
import { memoizedSurfaceMenu } from "./surface-menu.js";

/** The host's curated agent menu (`surfaces.agent`). Resolved here at the
 *  composition seam, and BOUND at the harness door's registry projection
 *  (`withAgentMenu` in compose-harness.ts) so it curates every brain's
 *  `turn.tools.list()` — not inside the registry, because
 *  `actions.descriptors()` is also what the MCP door and the host's own code
 *  read, and those surfaces have their own menus. Successes are cached for the
 *  process (a menu is boot config); failures are warned and never cached (see
 *  memoizedSurfaceMenu). */
const agentMenuFor = (composition: VendoComposition): Pick<VendoComposition, "agentMenu"> => {
  const { actions } = composition;
  return { agentMenu: memoizedSurfaceMenu(() => actions.surfaceMenu("agent")) };
};

/** Per-subject connected-toolkit lookups, cached briefly. */
const connectedToolkits = (composition: VendoComposition): Pick<VendoComposition,
  "connectedToolkitsCache" | "subjectHasToolkit" | "connectedToolkitsFor"> => {
  // Per-subject connected-toolkit lookups are cached briefly so a turn never
  // pays a broker round-trip it doesn't need; failures degrade to host tools
  // only (warn, never the turn). Bounded so long-lived deployments don't grow.
  // Shared by the loadout seed AND the pre-guard connect gate above.
  const CONNECTED_TOOLKITS_TTL_MS = 60_000;
  /** How long a NEGATIVE answer is trusted (see subjectHasToolkit). Sized to
   *  span one tool call's two connect checks and nothing more: the clock starts
   *  at the lookup that told the user they are not connected, and nobody
   *  completes a provider OAuth round trip and issues another call inside a
   *  second. */
  const UNCONNECTED_TTL_MS = 1_000;
  const connectedToolkitsCache = new Map<string, { at: number; toolkits: string[] }>();
  function cacheConnectedToolkits(subject: string, toolkits: string[]): void {
    if (connectedToolkitsCache.size > 1_000) connectedToolkitsCache.clear();
    connectedToolkitsCache.set(subject, { at: Date.now(), toolkits });
  }
  function cachedConnectedToolkits(subject: string, ttlMs = CONNECTED_TOOLKITS_TTL_MS): string[] | undefined {
    const cached = connectedToolkitsCache.get(subject);
    return cached !== undefined && Date.now() - cached.at < ttlMs
      ? cached.toolkits
      : undefined;
  }
  async function fetchConnectedToolkits(principal: Principal): Promise<string[]> {
    const accounts = await composition.connections.list(principal);
    const toolkits = [...new Set(accounts.filter((account) => account.status === "active").map((account) => account.toolkit))];
    cacheConnectedToolkits(principal.subject, toolkits);
    return toolkits;
  }
  /** The connect gate's lookup. A cached HIT rules the call in without a
      round-trip; a cached MISS refetches fresh before ruling it out — a user
      who just finished OAuth must never be blocked by a 60s-old entry. It IS
      ruled out off an entry seconds old, because the gate runs twice for one
      tool call (the tool-bridge preflight and the gate-wrapped registry), and
      without that a refusal cost two broker round trips to say the same no.
      Lookup failure returns undefined: the gate fails OPEN and the
      broker-side connect-required outcome still catches the call. */
  async function subjectHasToolkit(toolkit: string, ctx: RunContext): Promise<boolean | undefined> {
    if (cachedConnectedToolkits(ctx.principal.subject)?.includes(toolkit)) return true;
    if (cachedConnectedToolkits(ctx.principal.subject, UNCONNECTED_TTL_MS) !== undefined) return false;
    try {
      return (await fetchConnectedToolkits(ctx.principal)).includes(toolkit);
    } catch {
      return undefined;
    }
  }
  // Hoisted (function declaration): the apps composition above references it;
  // `connections` is declared below and only read at request time. Built on
  // the discovery-lane cache primitives: cached hit serves, miss fetches and
  // caches; lookup failure degrades to "no connected toolkits" this call.
  async function connectedToolkitsFor(ctx: RunContext): Promise<string[]> {
    const cached = cachedConnectedToolkits(ctx.principal.subject);
    if (cached !== undefined) return cached;
    try {
      return await fetchConnectedToolkits(ctx.principal);
    } catch (error) {
      console.warn(
        "[vendo] connected-toolkits lookup failed; treating every toolkit as unconnected:",
        error instanceof Error ? error.message : error,
      );
      const toolkits: string[] = [];
      cacheConnectedToolkits(ctx.principal.subject, toolkits);
      return toolkits;
    }
  }
  return { connectedToolkitsCache, subjectHasToolkit, connectedToolkitsFor };
};

/** Which connector owns a broker slug, and the grade IT assigned. */
const serviceCatalogLookups = (composition: VendoComposition): Pick<VendoComposition,
  "serviceToolOwner" | "serviceToolRisk"> => {
  /** Which connector owns a broker slug, and the grade IT assigned.
   *
   * `toolRisk` answers ownership and grading in one call: the adapter contract
   * defines `undefined` as "this slug is not mine" and every other answer —
   * `ungraded` included — as a real grade. Using ONE predicate for both means
   * the risk the guard decided on and the connector that runs the call can never
   * disagree. Searched over `catalogConnectors` — exactly the set the tool pair
   * was projected for — so every row the model was shown is dispatchable and
   * nothing else is. First owner wins. */
  async function serviceToolOwner(slug: string): Promise<{ connector: Connector; risk: RiskLabel } | undefined> {
    for (const connector of composition.catalogConnectors) {
      const risk = await connector.toolRisk!(slug);
      if (risk !== undefined) return { connector, risk };
    }
    return undefined;
  }
  /** The per-slug half of `use_service_tool`'s grade. Its DESCRIPTOR is
   * `ungraded` — one tool name standing in for a whole third-party catalog
   * cannot carry a real grade — and this replaces it with the grade the broker
   * assigned to the slug THIS call names, which is the grading nobody else can
   * do at catalog scale.
   *
   * A slug nobody owns grades `read`: the dispatcher answers "no such tool"
   * without touching anything, and leaving it `ungraded` would park an approval
   * card for a call that CANNOT run — the approval spam the pre-guard connect
   * gate exists to stop. That is safe only because ownership and grading are the
   * same lookup above: unowned means unrunnable, not merely ungraded. */
  async function serviceToolRisk(call: ToolCall): Promise<RiskLabel | undefined> {
    if (call.tool !== USE_SERVICE_TOOL) return undefined;
    const slug = (call.args as { slug?: unknown } | undefined)?.slug;
    if (typeof slug !== "string") return undefined;
    return (await serviceToolOwner(slug))?.risk ?? "read";
  }
  return { serviceToolOwner, serviceToolRisk };
};

/** The discovery lane, composed as one. */
export const composeDiscovery = (composition: VendoComposition): Pick<VendoComposition,
  "connectedToolkitsCache" | "agentMenu" | "subjectHasToolkit"
  | "connectedToolkitsFor" | "serviceToolOwner" | "serviceToolRisk"> => ({
  ...connectedToolkits(composition),
  ...agentMenuFor(composition),
  ...serviceCatalogLookups(composition),
});

/** 04-actions §3 — per-principal connected accounts, selected by the adapter
 *  rule at this composition seam (selectConnections). */
export const composeConnections = (composition: VendoComposition): Pick<VendoComposition,
  "selectedConnections" | "connections"> => {
  const { config, resolvedConnectors, connectorToolkits, connectedToolkitsCache } = composition;
  // 04-actions §3 — per-principal connected accounts, selected by the adapter
  // rule at this composition seam (selectConnections above).
  //
  // Disconnect INVALIDATES the subject's connected-toolkit cache. Without
  // this, the 60s TTL keeps answering "connected" for up to a minute after
  // the user disconnects, so the connect gate waves the call through, the
  // guard mints an approval, and the user is asked to approve a call that
  // cannot run — the exact failure the gate exists to prevent, inverted. The
  // wrapper sits at the composition seam (never inside an adapter), so it
  // holds for every posture: BYO brokers and the Cloud adapter alike.
  //
  // `selectedConnections` is what the adapter rule chose and is what
  // `vendo.connections` exposes, UNTOUCHED — an explicitly passed adapter must
  // stay the very object the host handed in (server.test.ts asserts identity).
  // Everything the product itself calls (the wire's DELETE route, the loadout
  // seed, the connect gate) goes through the invalidating wrapper instead.
  // Out-of-band revocation — a host calling the adapter directly, or a user
  // revoking in the provider's own dashboard — stays bounded by the 60s TTL,
  // which no cache can improve on.
  const selectedConnections = selectConnections(config.connections, resolvedConnectors, connectorToolkits);
  const connections = withDisconnectInvalidation(
    selectedConnections,
    (subject) => connectedToolkitsCache.delete(subject),
  );
  return { selectedConnections, connections };
};
