import { VendoError } from "./errors.js";

/** Named in every refusal so a caller can tell "this name was never an engine
    collection" from "this build's list is older than yours". Bump it whenever
    ENGINE_COLLECTIONS or ENGINE_COLLECTION_PATTERNS changes. */
// 6: v5's list plus `vendo_tenant_connectors`, which shipped missing from it. A
// refusal still quoting v5 would be describing a build without that entry.
// 7: dropped `vendo_inclient_approvals` and `vendo_remix_rejections` with the
// removal of in-client native execution and the remix review flow.
// 8: added `vendo_parked_build`, the approval-keyed record of a build nobody
// has consented to yet.
// 9: dropped `vendo_app_tokens` with the per-app box bearer — a sealed bundle
// is served by the host and holds no store credential of its own.
// 10: dropped `vendo_egress_approval` with the persistent-machine egress flow —
// a build box's registry egress is granted for the build minute, not stored.
export const ENGINE_ALLOWLIST_VERSION = 10;

/** What a collection HOLDS. `knowledge` is the retrieval corpus — documents and
    the chunks an engine mints from them; everything else is `storage`.
    Deliberately a property of the DATA, not of anyone's billing: Vendo Cloud
    meters the two kinds apart, but a category like "unmetered" is a price list,
    not a data kind, and does not belong in a contract every BYO mount reads. */
export type CollectionKind = "storage" | "knowledge";

/** What the registry declares about one engine collection. */
export interface EngineCollectionSpec {
  kind: CollectionKind;
  /** The fields an `engine.list` watermark may bound, because THIS collection
      keeps them indexed. Absent for the 36 collections with nothing to walk
      forward through: an unindexed bound is a full table scan wearing a filter's
      clothes, so it is refused rather than served slowly. */
  indexed?: readonly string[];
}

/** The collections the `engine` op family may touch: Vendo's OWN internal
    drawers, nothing a host or a generated app owns. The registry lives in core
    because guard, automations and apps all need it and none of them may import
    @vendoai/store (layering); core imports nothing, so it is a literal here and
    a drift test in @vendoai/store holds it to the real constants.

    ONE registry, not a list plus a side-table of attributes: a second place
    naming these collections is how the allowlist rots, and `kind` and `indexed`
    are facts ABOUT an entry, so they live on the entry. */
export const ENGINE_COLLECTION_REGISTRY = {
  // Reserved, routed through typed doors — mirrors RESERVED_COLLECTIONS,
  // packages/store/src/routing.ts:53-63.
  vendo_grants: { kind: "storage" },
  vendo_approvals: { kind: "storage" },
  vendo_audit: { kind: "storage" },
  vendo_threads: { kind: "storage" },
  // The ONE collection with a watermark field today: `vendo_runs.started_at` is
  // a real column with its own index (packages/store/src/schema.ts:120), and a
  // meter that reconciles runs it has already counted has to walk forward from
  // where it stopped. Every other collection is read newest-first and needs no
  // forward walk — which is why this list is per-collection and not a blanket
  // "any timestamp column".
  vendo_runs: { kind: "storage", indexed: ["started_at"] },
  vendo_apps: { kind: "storage" },
  vendo_automations: { kind: "storage" }, // AUTOMATIONS, packages/automations/src/types.ts:20
  vendo_state: { kind: "storage" },
  vendo_effects: { kind: "storage" },
  vendo_app_grants: { kind: "storage" },

  // Dedicated tables — mirrors DEDICATED_RECORD_COLLECTIONS,
  // packages/store/src/routing.ts:65-70.
  vendo_mcp_clients: { kind: "storage" },
  vendo_mcp_grants: { kind: "storage" },
  // The retrieval corpus: the document rows and the chunks an engine mints from
  // them. The only two `knowledge` entries in the registry, and the reason the
  // kind exists — a footprint that cannot tell a corpus from a drawer cannot
  // answer "what is the index costing me".
  vendo_knowledge_docs: { kind: "knowledge" },
  vendo_knowledge_chunks: { kind: "knowledge" },

  // Generic-table collections the blocks own.
  vendo_parked_call: { kind: "storage" }, // PARKED_COLLECTION, packages/vendo/src/byo-approvals.ts:47
  // PARKED_CALL_OUTCOME_COLLECTION, packages/core/src/parked-outcome.ts — written
  // by BOTH parked-call lanes (byo-approvals.ts, parked-action.ts), read by one.
  vendo_parked_call_outcome: { kind: "storage" },
  // The next two, and guard:controls below, write rows carrying NEITHER a
  // subject ref NOR an app ref, and that is deliberate: they are HOST-LEVEL
  // CONFIG — the host's component registry, the pinned-baseline seed, the
  // guard's freeze switch — not any user's or any app's data, so the erase
  // cascade correctly never sweeps them. Do not "fix" them by adding a ref.
  vendo_host_components: { kind: "storage" }, // HOST_COMPONENTS_COLLECTION, packages/vendo/src/cli/cloud/host-components.ts:34
  vendo_pin_baselines: { kind: "storage" }, // PIN_BASELINES_COLLECTION, packages/vendo/src/cli/cloud/seed-baselines.ts:26
  vendo_placements: { kind: "storage" }, // PLACEMENTS_COLLECTION, packages/apps/src/server/persistence/placements.ts:48
  vendo_placement_slots: { kind: "storage" }, // PLACEMENT_SLOTS_COLLECTION, packages/apps/src/server/persistence/placements.ts:54
  vendo_parked_action: { kind: "storage" }, // COLLECTION, packages/apps/src/server/persistence/parked-action.ts:50
  vendo_parked_build: { kind: "storage" }, // COLLECTION, packages/apps/src/server/persistence/parked-build.ts
  vendo_slots: { kind: "storage" }, // SLOTS_COLLECTION, packages/apps/src/server/persistence/slots.ts:24
  vendo_app_seen: { kind: "storage" }, // APP_SEEN_COLLECTION, packages/apps/src/server/persistence/app-seen.ts:26
  vendo_workspace_commits: { kind: "storage" }, // WORKSPACE_COMMITS, packages/store/src/ops.ts:27
  "automations:captures": { kind: "storage" }, // CAPTURES, packages/automations/src/types.ts:29
  "automations:schedule": { kind: "storage" }, // SCHEDULE, packages/automations/src/types.ts:30
  "automations:deliveries": { kind: "storage" }, // DELIVERIES, packages/automations/src/types.ts:32
  "automations:sponsorships": { kind: "storage" }, // SPONSORSHIPS, packages/automations/src/sponsorship.ts:17
  "automations:sponsored": { kind: "storage" }, // SPONSORED, packages/automations/src/sponsorship.ts:29
  "guard:controls": { kind: "storage" }, // CONTROLS_COLLECTION, packages/guard/src/guard.ts:117 — host-level config, see above
  "guard:approval-claims": { kind: "storage" }, // APPROVAL_CLAIMS_COLLECTION, packages/guard/src/guard.ts:111
  vendo_channel_links: { kind: "storage" }, // LINK_COLLECTION, packages/vendo/src/channel-links.ts:22
  vendo_channel_events: { kind: "storage" }, // EVENT_COLLECTION, packages/vendo/src/channel-links.ts:25
  vendo_channel_asks: { kind: "storage" }, // ASK_COLLECTION, packages/vendo/src/channel-links.ts:33
  vendo_tenant_connectors: { kind: "storage" }, // COLLECTION, packages/vendo/src/tenant-connectors.ts:78
} as const satisfies Record<string, EngineCollectionSpec>;

export type EngineCollection = keyof typeof ENGINE_COLLECTION_REGISTRY;

/** The registry's names, in registry order — the allowlist itself. Derived, so
    adding a collection is one edit and the two can never disagree. */
export const ENGINE_COLLECTIONS = Object.keys(ENGINE_COLLECTION_REGISTRY) as readonly EngineCollection[];

/** One widened read of the registry. The `as const` literal types each entry
    exactly — which is what makes `indexed` a compile-time fact where it exists
    — but that same precision means the union has no `indexed` member at all on
    the entries without one, so every lookup goes through here. */
const specOf = (collection: string): EngineCollectionSpec | undefined =>
  (ENGINE_COLLECTION_REGISTRY as Record<string, EngineCollectionSpec>)[collection];

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

/** What a collection holds, for the byte accounting `footprint()` reports.
    A legal collection with no registry entry — today only the app-history
    pattern — is `storage`: `knowledge` is the closed exception (the corpus and
    its chunks), never the default, so a collection invented later is never
    silently counted as index cost. */
export function collectionKind(collection: string): CollectionKind {
  return specOf(collection)?.kind ?? "storage";
}

/** The gate on an `engine.list` watermark bound. A field this collection does
    not keep indexed is refused, not scanned: the whole point of the bound is a
    cheap forward walk, and one that degrades into a full scan under load is a
    performance cliff hidden behind a working API.

    `validation`, not `blocked`: the collection is legal and the caller's right
    to read it is not in question — the FIELD is wrong, and the message says
    which fields are right. */
export function assertIndexedField(collection: string, field: string): void {
  const fields = specOf(collection)?.indexed ?? [];
  if (fields.includes(field)) return;
  throw new VendoError(
    "validation",
    `${JSON.stringify(field)} is not an indexed field of ${JSON.stringify(collection)}`
    + (fields.length === 0
      ? ` — that collection declares none, so it cannot be walked by watermark. List it newest-first with a cursor instead.`
      : ` — it declares ${fields.map((name) => JSON.stringify(name)).join(", ")}.`),
  );
}
