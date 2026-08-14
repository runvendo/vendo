import { VendoError } from "./errors.js";

/** Named in every refusal so a caller can tell "this name was never an engine
    collection" from "this build's list is older than yours". Bump it whenever
    ENGINE_COLLECTIONS or ENGINE_COLLECTION_PATTERNS changes. */
export const ENGINE_ALLOWLIST_VERSION = 2;

/** The collections the `engine` op family may touch: Vendo's OWN internal
    drawers, nothing a host or a generated app owns. The list lives in core
    because guard, automations and apps all need it and none of them may import
    @vendoai/store (layering); core imports nothing, so it is a literal here and
    a drift test in @vendoai/store holds it to the real constants. */
export const ENGINE_COLLECTIONS = [
  // Reserved, routed through typed doors — mirrors RESERVED_COLLECTIONS,
  // packages/store/src/routing.ts:53-63.
  "vendo_grants",
  "vendo_approvals",
  "vendo_audit",
  "vendo_threads",
  "vendo_runs",
  "vendo_apps",
  "vendo_state",
  "vendo_effects",
  "vendo_app_grants",

  // Dedicated tables — mirrors DEDICATED_RECORD_COLLECTIONS,
  // packages/store/src/routing.ts:65-70.
  "vendo_mcp_clients",
  "vendo_mcp_grants",
  "vendo_knowledge_docs",
  "vendo_knowledge_chunks",

  // Generic-table collections the blocks own.
  "vendo_parked_call", // PARKED_COLLECTION, packages/vendo/src/byo-approvals.ts:47
  // PARKED_CALL_OUTCOME_COLLECTION, packages/core/src/parked-outcome.ts — written
  // by BOTH parked-call lanes (byo-approvals.ts, parked-action.ts), read by one.
  "vendo_parked_call_outcome",
  // The next two, and guard:controls below, write rows carrying NEITHER a
  // subject ref NOR an app ref, and that is deliberate: they are HOST-LEVEL
  // CONFIG — the host's component registry, the pinned-baseline seed, the
  // guard's freeze switch — not any user's or any app's data, so the erase
  // cascade correctly never sweeps them. Do not "fix" them by adding a ref.
  "vendo_host_components", // HOST_COMPONENTS_COLLECTION, packages/vendo/src/cli/cloud/host-components.ts:34
  "vendo_pin_baselines", // PIN_BASELINES_COLLECTION, packages/vendo/src/cli/cloud/seed-baselines.ts:26
  "vendo_placements", // PLACEMENTS_COLLECTION, packages/apps/src/server/persistence/placements.ts:48
  "vendo_placement_slots", // PLACEMENT_SLOTS_COLLECTION, packages/apps/src/server/persistence/placements.ts:54
  "vendo_app_tokens", // APP_TOKEN_COLLECTION, packages/apps/src/server/persistence/app-token.ts:12
  "vendo_parked_action", // COLLECTION, packages/apps/src/server/persistence/parked-action.ts:50
  "vendo_egress_approval", // COLLECTION, packages/apps/src/server/escalation/egress-approval.ts:96
  "vendo_inclient_approvals", // COLLECTION, packages/apps/src/server/remix/inclient.ts:76
  "vendo_remix_rejections", // COLLECTION, packages/apps/src/server/remix/review.ts:65
  "vendo_slots", // SLOTS_COLLECTION, packages/apps/src/server/persistence/slots.ts:24
  "vendo_workspace_commits", // WORKSPACE_COMMITS, packages/store/src/ops.ts:27
  "automations:captures", // CAPTURES, packages/automations/src/types.ts:29
  "automations:armed", // ARMED, packages/automations/src/types.ts:43
  "automations:schedule", // SCHEDULE, packages/automations/src/types.ts:30
  "automations:webhook", // WEBHOOK, packages/automations/src/types.ts:31
  "automations:deliveries", // DELIVERIES, packages/automations/src/types.ts:32
  "automations:sponsorships", // SPONSORSHIPS, packages/automations/src/sponsorship.ts:17
  "automations:sponsored", // SPONSORED, packages/automations/src/sponsorship.ts:29
  "guard:controls", // CONTROLS_COLLECTION, packages/guard/src/guard.ts:117 — host-level config, see above
  "guard:approval-claims", // APPROVAL_CLAIMS_COLLECTION, packages/guard/src/guard.ts:111
  "vendo_channel_links", // LINK_COLLECTION, packages/vendo/src/channel-links.ts:22
  "vendo_channel_events", // EVENT_COLLECTION, packages/vendo/src/channel-links.ts:25
  "vendo_channel_asks", // ASK_COLLECTION, packages/vendo/src/channel-links.ts:33
] as const;

export type EngineCollection = typeof ENGINE_COLLECTIONS[number];

/** The id grammar the app-history pattern accepts. Shared by the builder so a
    name that cannot pass the gate is never composed in the first place. */
const APP_HISTORY_ID = /^[A-Za-z0-9_-]{1,128}$/;

/** The ONE dynamic engine collection: the per-app capped version log and
    pin-intent trail, assembled at
    packages/apps/src/server/persistence/history.ts:84. Pin intents are rows
    INSIDE this collection, not a second drawer — there is one builder and one
    pattern, and a second of either is how an allowlist rots.
    Throws `validation` on an id the pattern would not accept: an empty or
    colon-bearing id composes a name that lands in some other app's drawer. */
export function engineAppHistory(appId: string): string {
  if (!APP_HISTORY_ID.test(appId)) {
    throw new VendoError(
      "validation",
      `app id ${JSON.stringify(appId)} is not a legal engine app-history id (expected ${APP_HISTORY_ID.source})`,
    );
  }
  return `vendo:app-history:${appId}`;
}

/** Anchored and length-bounded on purpose: an unanchored or unbounded id part
    matches any string that merely CONTAINS the prefix, which turns the
    allowlist into a wildcard and the gate into decoration. */
export const ENGINE_COLLECTION_PATTERNS = [
  /^vendo:app-history:[A-Za-z0-9_-]{1,128}$/,
] as const;

export function isEngineCollection(collection: string): boolean {
  return (ENGINE_COLLECTIONS as readonly string[]).includes(collection)
    || ENGINE_COLLECTION_PATTERNS.some((pattern) => pattern.test(collection));
}

/** Classic two-row Levenshtein — small enough that a dependency would cost more
    than it saves, and it runs only on the refusal path. */
function distance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      current.push(Math.min(
        (previous[j] ?? 0) + 1,
        (current[j - 1] ?? 0) + 1,
        (previous[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1),
      ));
    }
    previous = current;
  }
  return previous[b.length] ?? 0;
}

/** Nearest allowed name, or undefined when nothing is close enough to be a
    typo. The dynamic patterns are not searched — there is no fixed string to
    suggest. The bound is tight on purpose: at a loose one every wrong name
    collects a confident, unrelated suggestion ("users" → "vendo_runs" is only
    seven edits apart), which reads as Vendo guessing rather than helping. */
function nearest(collection: string): string | undefined {
  let best: string | undefined;
  let bestDistance = 4; // exclusive bound: suggest only within distance 3
  for (const candidate of ENGINE_COLLECTIONS) {
    const d = distance(collection, candidate);
    if (d < bestDistance) {
      best = candidate;
      bestDistance = d;
    }
  }
  return best;
}

/** The gate itself. Refusals point at the right door, because "blocked" with no
    alternative reads as a bug in Vendo rather than a wrong call. */
export function assertEngineCollection(collection: string): void {
  if (isEngineCollection(collection)) return;
  const suggestion = nearest(collection);
  throw new VendoError(
    "blocked",
    `collection ${JSON.stringify(collection)} is not an engine collection `
    + `(engine allowlist v${ENGINE_ALLOWLIST_VERSION})`
    + (suggestion === undefined ? "." : ` — did you mean ${JSON.stringify(suggestion)}?`)
    + " App data belongs to the appData family (ops.appData.*), which takes an"
    + " { appId, collection, owner } target.",
  );
}
