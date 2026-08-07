/**
 * The slice of `createApps`' closure its modules read.
 *
 * `createApps` is an ASSEMBLER: every door it returns, and every helper those
 * doors lean on, lives in a module beside its contract and is handed the pieces
 * of the closure it needs. Every one of them names its dependencies as a `Pick`
 * of this one type, and returns a `Pick` of it too, which keeps a single
 * description of what the closure offers and lets `createRuntimeContext` below
 * wire them in dependency order.
 *
 * Internal — not exported from the package root.
 */
import type {
  AccessLevel,
  AppAccess,
  AppDocument,
  AppId,
  AppPlan,
  ApprovalId,
  Json,
  RecordStore,
  RunContext,
  ToolCall,
  ToolDescriptor,
  VendoRecord,
} from "@vendoai/core";
import { createAccessChecks } from "./access-checks.js";
import type { AppDataAccess } from "./app-data.js";
import { createAuditReporters } from "./audit-reports.js";
import { createApprovalFlow } from "./approval-flow.js";
import { createBoxLane, createMachineLane } from "./box-lane.js";
import type { BoxEditResult } from "./box-agent.js";
import { createAppCaller, type AppCaller } from "./call.js";
import type { Finding } from "./checking/types.js";
import { createEditJournal } from "./edit-journal.js";
import type { EgressApprovals } from "./egress-approval.js";
import type { GenerationDependencies } from "./engine.js";
import { createFnCaller, type FnCaller } from "./fn.js";
import { createGenerationContext } from "./generation-context.js";
import { resolveProvider } from "./generation-context.js";
import { createAppHistory, type AppHistoryAccess, type PinIntentKind } from "./history.js";
import { createInClientApprovals, type InClientApprovalAccess } from "./inclient.js";
import { createAppInterchange, type AppInterchange } from "./interchange.js";
import type { MachineLifecycle } from "./machine-lifecycle.js";
import { createManifestTriggers } from "./manifest-triggers.js";
import { createAppData } from "./app-data.js";
import { createAppOpener } from "./open.js";
import { createParkedActions, type ParkedActions } from "./parked-action.js";
import { updateAppRow } from "./persistence.js";
import { placementStore, type PlacementRow, type PlacementStore } from "./placements.js";
import { createPlacementRows } from "./placement-surface.js";
import { createEgressApprovals } from "./egress-approval.js";
import { createReviewLifecycle, type ReviewLifecycle } from "./review.js";
import { createSecretExposure, type SecretExposure } from "./secret-exposure.js";
import { VendoError } from "@vendoai/core";
import type {
  AppsConfig,
  AppsRuntime,
  BoxRequest,
  BoxResponse,
  EditResult,
  PlacementEntry,
  VersionEntry,
} from "./types.js";

export interface AppsRuntimeContext {
  config: AppsConfig;
  /** The `vendo_apps` collection every door reads and writes. */
  apps: RecordStore;
  /** Placement rows — "show this app in that slot" (placements.ts). */
  placementRows: PlacementStore;
  /** The app's own workspace documents (app-data.ts). */
  data: AppDataAccess;
  /** The capped version log and its pin-intent trail (history.ts). */
  history: AppHistoryAccess;
  /** ENG-345 — per-secret × per-app in-sandbox exposure grants. */
  exposure: SecretExposure;
  /** Lane E — the undecided egress approval cards (egress-approval.ts). */
  egressApprovals: EgressApprovals;
  /** W0 — the undecided in-app actions the guard parked (parked-action.ts). */
  parkedActions: ParkedActions;
  /** The stored in-client approvals (inclient.ts). */
  inClientApprovals: InClientApprovalAccess;
  /** The review-kind remix lifecycle (review.ts). */
  review: ReviewLifecycle;
  /** execution-v2 — provision/wake/sleep/destroy (machine-lifecycle.ts). */
  lifecycle: MachineLifecycle;
  /** The box manifest's schedules, folded into document triggers. */
  manifestTriggers: ReturnType<typeof createManifestTriggers>;
  /** Export/import of an app and its documents (interchange.ts). */
  interchange: AppInterchange;
  /** The v2 box door `fn:` refs resolve over (fn.ts). */
  fnCaller: FnCaller;
  /** The guard-bound caller every query and action rides. */
  caller: AppCaller;
  /** The one read path a client opens an app through (open.ts). */
  opener: ReturnType<typeof createAppOpener>;
  /** Host-tunable box-edit poll interval, when the composition set one. */
  boxEditPollMs: number | undefined;
  /** Host-tunable box-edit timeout, when the composition set one. */
  boxEditTimeoutMs: number | undefined;
  /** Bounded read-mutate-CAS on the app row. */
  updateAppDocument(appId: AppId, mutate: (doc: AppDocument) => AppDocument): Promise<AppDocument>;

  // ── access-checks.ts ───────────────────────────────────────────────────────
  /** Build contract §9.3 — the ONE permission check. */
  holds(
    appId: AppId,
    ctx: RunContext,
    level: AccessLevel,
    known?: VendoRecord | null,
  ): Promise<boolean>;
  /** The document, when this caller holds it at `level` — otherwise null. */
  owned(appId: AppId, ctx: RunContext, level?: AccessLevel): Promise<AppDocument | null>;
  /** §9.4's posture: unviewable stays `not-found`, a denied viewer gets `forbidden`. */
  requireOwned(appId: AppId, ctx: RunContext, level?: AccessLevel): Promise<AppDocument>;
  /** Build contract §9.6 — the ONE Cloud gate on this block. */
  requireMultiParty(what: string): void;
  /** The app-access seam, or a loud refusal when the host wired none. */
  requireAccess(): AppAccess;
  /** The app rows this caller reaches WITHOUT owning them (§9.3). */
  grantedRecords(ctx: RunContext, already: Set<string>): Promise<VendoRecord[]>;
  /** Whether the host's `apps.review.reviewer` assertion covers this caller. */
  reviewerAsserted(ctx: RunContext): Promise<boolean>;

  // ── audit-reports.ts ───────────────────────────────────────────────────────
  /** An app-lifecycle audit event under an explicit subject. */
  reportGuard(
    principalSubject: string,
    appId: AppId,
    ctx: Pick<RunContext, "venue" | "presence" | "trigger" | "turnId">,
    detail: Record<string, Json>,
  ): Promise<void>;
  /** The `share` audit kind. */
  reportShare(appId: AppId, ctx: RunContext, detail: Record<string, Json>): Promise<void>;
  /** The `app-lifecycle` audit kind, under the calling principal. */
  reportLifecycle(
    operation: "create" | "delete" | "fork" | "promote" | "in-client-approve" | "pin-fork" | "pin-rebase" | "machine-provision" | "machine-destroy" | "place" | "unplace",
    appId: AppId,
    ctx: RunContext,
    extra?: Record<string, Json>,
  ): Promise<void>;

  // ── approval-flow.ts ───────────────────────────────────────────────────────
  /** Wave 7 — mark a provisioned machine's env stale after a grant change. */
  markMachineEnvStale(appId: AppId): Promise<void>;
  /** Lane E — ask for the app's declared-but-unapproved egress, without throwing. */
  requestEgressApproval(
    app: AppDocument,
    ctx: RunContext,
  ): Promise<
    | { status: "none" }
    | { status: "approved"; domains: string[] }
    | { status: "pending"; approvalId: ApprovalId; domains: string[] }
  >;
  /** Lane E — the ctx-carrying pre-flight every provision/wake/box surface runs. */
  ensureEgressApproved(app: AppDocument, ctx: RunContext): Promise<void>;
  /** ENG-345 — the high-risk descriptor turning a secret on is checked against. */
  exposureDescriptor(): ToolDescriptor;
  /** The stable call id the park/approve phases both match on. */
  exposureCall(appId: AppId, secretName: string): ToolCall;

  // ── edit-journal.ts ────────────────────────────────────────────────────────
  /** The layer ladder, derived from the document (never a stored rung). */
  rungFor(app: AppDocument, declared?: VersionEntry["rung"]): VersionEntry["rung"];
  /** 06-apps §8 — every edit result over a drifted app carries the drift report. */
  withPinDrift(result: EditResult): EditResult;
  /** An edit result that persisted nothing, with the drift report attached. */
  failedEdit(
    app: AppDocument,
    instruction: string,
    issues: string[],
    retryable?: boolean,
  ): EditResult;
  /** The ONE document write: version append, optimistic concurrency, row put. */
  persistEdit(
    previous: AppDocument,
    app: AppDocument,
    version: VersionEntry,
    subject: string,
    pinSlots?: readonly string[],
    options?: { armTrigger?: boolean; pinIntentKind?: PinIntentKind },
  ): Promise<AppDocument>;
  /** Build contract §9.9 — the ONE announcement every change to what an app IS. */
  reportDocumentEdit(previous: AppDocument, next: AppDocument, subject: string): Promise<void>;
  /** Drop an undo point the write it was appended FOR never landed for. */
  discardVersion(appId: AppId, versionId: string): Promise<void>;
  /** The 50-version cap, applied once the newest version's write has landed. */
  pruneHistory(appId: AppId): Promise<void>;
  /** The person's own words for a save THIS runtime asked the assembler for. */
  editIntents: Map<AppId, string>;
  /** The version row an edit's own save APPENDED, keyed by app. */
  editVersions: Map<AppId, VersionEntry>;
  /** Why an edit's own save did NOT land, keyed by app. */
  editRefusals: Map<AppId, { intent: string; reason: string }>;
  /** THIS edit's captured row, or nothing. */
  takeEditVersion(appId: AppId, instruction: string): VersionEntry | undefined;
  /** ONE instruction through the ONE builder. */
  assembleEdit(
    appId: AppId,
    instruction: string,
    ctx: RunContext,
  ): Promise<
    | { kind: "assembled"; app: AppDocument }
    | { kind: "escalate" }
    | { kind: "failed"; issues: string[] }
  >;

  // ── generation-context.ts ──────────────────────────────────────────────────
  /** The host tool list and the live shape cards a generation runs against. */
  generationToolContext(ctx: RunContext): Promise<Pick<GenerationDependencies, "tools" | "toolShapes">>;

  // ── box-lane.ts ────────────────────────────────────────────────────────────
  /** The box server-edit primitive: wake, instruct, sync, snapshot. */
  editServerViaBox(
    app: AppDocument,
    instruction: string,
    ctx: RunContext,
    options?: { served?: boolean },
  ): Promise<
    | { ok: true; result: BoxEditResult; doc: AppDocument; servedOk: boolean }
    | { ok: false; result: BoxEditResult }
  >;
  /** Run the server work a plan declared, on an app that is already STORED. */
  runServerWork(
    input: { plan: AppPlan; planText?: string; document: AppDocument; request: string },
    ctx: RunContext,
    deps: GenerationDependencies,
  ): Promise<{
    document: AppDocument;
    findings: Finding[];
    automation?: EditResult["automation"];
    graduated?: boolean;
    issues?: string[];
    failed?: string[];
  }>;
  /** Forward ONE already-authorized request into the app's machine. */
  forwardToBox(app: AppDocument, request: BoxRequest, ctx: RunContext): Promise<BoxResponse>;

  // ── placement-surface.ts ───────────────────────────────────────────────────
  /** A host-authored slot name, checked at the one place every caller passes. */
  requireSlot(slot: string): string;
  /** B1 — claim the slot the moment the app id EXISTS. */
  claimSlot(appId: AppId, slot: string, ctx: RunContext): Promise<void>;
  /** The terminal record for an id no engine will ever land. */
  markUnbuilt(appId: AppId, name: string, reason: string, ctx: RunContext): Promise<void>;
  /** Where a placed app's build stands, read off its record every time. */
  entryFor(row: PlacementRow, ctx: RunContext): Promise<PlacementEntry | undefined>;

  /**
   * The finished runtime, as a thunk. A surface is constructed while the
   * `AppsRuntime` object literal is still forming, so the public doors one of
   * them re-enters (`pins.fork` runs an ordinary `edit`) resolve on call.
   */
  runtime(): AppsRuntime;
}

/** The store-backed collections every door reads and writes. */
const createStores = (
  config: AppsConfig,
): Pick<AppsRuntimeContext,
  "apps" | "placementRows" | "data" | "history" | "exposure" | "egressApprovals"
  | "parkedActions" | "inClientApprovals"> => {
  const apps = config.store.records("vendo_apps");
  const placementRows = placementStore(config.store);
  const data = createAppData(config.store);
  const history = createAppHistory(config.store);
  // ENG-345 — per-secret × per-app in-sandbox exposure grants. A dedicated store
  // collection, NEVER part of the app document, so no copy path can carry it.
  const exposure = createSecretExposure(config.store);
  // Lane E — parked egress approvals (approved state lives on the document's
  // egressApproved field; this collection holds only undecided cards).
  const egressApprovals = createEgressApprovals(config.store);
  // W0 — parked in-app actions: a mutating action the guard sent to approval
  // is recorded here (keyed by its approval) so onApprovalDecision can
  // re-dispatch the exact call the instant the owner approves. Holds only
  // undecided actions; both decisions clear it.
  const parkedActions = createParkedActions(config.store);
  const inClientApprovals = createInClientApprovals(config.store);
  return { apps, placementRows, data, history, exposure, egressApprovals, parkedActions, inClientApprovals };
};

/** The composed seams the doors call through: interchange, the review-kind
 *  lifecycle, the box-aware caller, and the one opener. */
const createDoors = (
  deps: Pick<AppsRuntimeContext,
    "config" | "history" | "inClientApprovals" | "parkedActions" | "lifecycle"
    | "requireOwned" | "updateAppDocument">,
): Pick<AppsRuntimeContext,
  "review" | "reviewerAsserted" | "interchange" | "fnCaller" | "manifestTriggers" | "caller" | "opener"> => {
  const { config, history, inClientApprovals, parkedActions, lifecycle } = deps;
  const { requireOwned, updateAppDocument } = deps;
  const interchange = createAppInterchange({
    store: config.store,
    guard: config.guard,
    pinBaselines: config.pinBaselines,
    requireOwned,
  });

  // Remix final shape (2026-08-02) — review-kind gating over the §9 hash-pin
  // machinery: which document open() serves and the venue vocabulary the
  // client resolves ("pending-review" = show the ORIGINAL, never a jailed
  // fork; a served older approved version carries the current standing).
  const review = createReviewLifecycle({
    store: config.store,
    baselines: config.pinBaselines,
    approvals: inClientApprovals,
    history,
  });
  // Round-2 hardening (2026-08-02) — reviewing is a HOST trust decision, so
  // it only ever comes from the composition's explicit assertion; no hook
  // means no caller is a reviewer, ever.
  const reviewerAsserted = async (ctx: RunContext): Promise<boolean> =>
    config.review?.reviewer !== undefined && await config.review.reviewer(ctx) === true;
  // execution-v2 Lane D — fn: refs on a machine-bearing app resolve over the
  // v2 box door (the same wake Lane C's wire proxy rides); the wrap leaves
  // every other ref on the existing caller. Queries hit this at open(),
  // actions at call().
  const fnCaller = createFnCaller({ wake: (app) => lifecycle.wake(app) });
  const manifestTriggers = createManifestTriggers({
    store: config.store,
    lifecycle,
    updateDocument: updateAppDocument,
    ...(config.armAutomation === undefined ? {} : { armAutomation: config.armAutomation }),
  });
  const caller = fnCaller.wrap(createAppCaller(config.tools, {
    // W0 — remember every mutating in-app action the guard parks, so the
    // approve→resume seam above can re-dispatch its exact call on approval.
    onParkedAction: (app, call, appCtx, approvalId) =>
      parkedActions.put({ approvalId, appId: app.id, owner: appCtx.principal.subject, call, ctx: appCtx }),
  }));
  const opener = createAppOpener(
    caller,
    config.pinBaselines,
    // Review-aware venue: instant-kind answers exactly the plain hash-pin
    // venue; review-kind never answers a jail state (review.ts).
    (doc) => review.venueStateFor(doc),
    // Wave 4 (layer 3) — the served surface: wake-on-open over the machine
    // lifecycle, the provider's public ingress URL for $PORT, and the theming
    // handoff (host theme tokens as a query param the served app MAY consume).
    {
      urlFor: async (app) => {
        // Build contract §9.8 — a served app is a WIRE DOOR, never a snapshot
        // handed out: the registered URL is this deployment's proxy, which
        // re-checks `can(viewer)` against live rows on every request.
        //
        // The OWNER is no exception, and used to be. Their own app was answered
        // with the sandbox provider's raw public ingress URL, on the reasoning
        // that a capability URL is harmless for the person who owns the thing.
        // It is not: that URL carries no per-request check, so it keeps working
        // for anyone it reaches — a shared screen, a copied link, a log line, a
        // pasted bug report — and it outlives the grant, the revoke, and the
        // app. One door, checked, for every caller.
        const proxy = config.servedProxyPath;
        if (proxy === undefined) {
          // Two ways to get here, so the sentence names both: no wire mounted at
          // all, or a wire with no public origin to build an absolute URL from
          // (the umbrella supplies this seam only once VENDO_BASE_URL is set).
          throw new VendoError(
            "not-implemented",
            "this app is served by a machine, and serving it needs the wire's authenticated proxy — mount the Vendo wire (createVendo().handler) so /apps/:appId/serve/** is reachable, and set VENDO_BASE_URL to this deployment's public origin so the app's URL can be absolute",
          );
        }
        // No wake here: the proxy wakes the machine on the first forwarded
        // request, AFTER it has re-checked access. Waking first would spend a
        // machine on a caller the very next check might refuse.
        //
        // The served app MAY consume the host's tokens, and the proxy forwards
        // the query string into the box, so it renders in the host's brand —
        // the same handoff the provider-URL branch used to do inline.
        const theme = resolveProvider(config.theme);
        return theme === undefined
          ? proxy(app.id)
          : `${proxy(app.id)}?vendoTheme=${encodeURIComponent(JSON.stringify(theme))}`;
      },
    },
    // §9.9 — the additive, ctx-aware venue-state slot lane H's adoption card
    // rides. Forwarded straight through; the runtime never interprets it.
    config.venueState,
  );
  return { review, reviewerAsserted, interchange, fnCaller, manifestTriggers, caller, opener };
};

/** 06-apps §1 — `createApps`' closure, wired in dependency order. */
export const createRuntimeContext = (
  config: AppsConfig,
  runtime: () => AppsRuntime,
): AppsRuntimeContext => {
  const stores = createStores(config);
  const audit = createAuditReporters(config);
  const access = createAccessChecks({ config, apps: stores.apps });
  const machine = createMachineLane(config, stores.exposure);
  const updateAppDocument = (
    appId: AppId,
    mutate: (doc: AppDocument) => AppDocument,
  ): Promise<AppDocument> => updateAppRow(stores.apps, appId, mutate);
  const base = { config, ...stores, ...audit, ...access, ...machine, updateAppDocument, runtime };
  const approvals = createApprovalFlow(base);
  const journal = createEditJournal(base);
  const doors = createDoors(base);
  const placement = createPlacementRows(base);
  const generation = createGenerationContext(config);
  const box = createBoxLane({ ...base, ...approvals, ...journal, ...doors });
  return { ...base, ...approvals, ...journal, ...doors, ...placement, ...generation, ...box };
};
