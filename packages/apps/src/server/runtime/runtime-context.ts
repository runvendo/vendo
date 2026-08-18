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
import {
  type AccessLevel,
  type AppId,
  type ApprovalId,
  type Json,
  type RunContext,
  VendoError,
  type VendoRecord,
} from "@vendoai/core";
import type {
  AppDocument,
  AdmissionOrigin,
} from "../../contract/index.js";
import { createAccessChecks } from "../doors/access-checks.js";
import type { AppDataAccess } from "../persistence/app-data.js";
import { engineOf, type EngineOps } from "../persistence/engine.js";
import { createAuditReporters } from "../persistence/audit-reports.js";
import { createApprovalFlow } from "../persistence/approval-flow.js";
import type { createAutomationLane } from "../automation/lane.js";
import { createBoxLane, createMachineLane } from "../escalation/box-lane.js";
import type { BoxEditResult } from "../escalation/box-agent.js";
import { createAppCaller, type AppCaller } from "../persistence/call.js";
import type { Finding } from "../checking/types.js";
import { createEditJournal } from "../persistence/edit-journal.js";
import type { EgressApprovals } from "../escalation/egress-approval.js";
import type { GenerationDependencies } from "../generation/engine.js";
import { createFnCaller, type FnCaller } from "../escalation/fn.js";
import { createGenerationContext } from "./generation-context.js";
import { resolveProvider } from "./generation-context.js";
import { createAppHistory, type AppHistoryAccess } from "../persistence/history.js";
import { createInClientApprovals, type InClientApprovalAccess } from "../remix/inclient.js";
import { createAppInterchange, type AppInterchange } from "../persistence/interchange.js";
import type { MachineLifecycle } from "../escalation/machine-lifecycle.js";
import { createManifestTriggers } from "../escalation/manifest-triggers.js";
import { createAppData } from "../persistence/app-data.js";
import { createAppOpener } from "../persistence/open.js";
import { createParkedActions, type ParkedActions } from "../persistence/parked-action.js";
import { updateAppRow } from "../persistence/persistence.js";
import { placementStore, type PlacementRow, type PlacementStore } from "../persistence/placements.js";
import { createPlacementRows } from "../doors/placement-surface.js";
import { createEgressApprovals } from "../escalation/egress-approval.js";
import { createReviewLifecycle, type ReviewLifecycle } from "../remix/review.js";
import { createSlotRegistry, type SlotRegistry } from "../persistence/slots.js";
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
  /** Vendo's own drawers, by name — `vendo_apps` above all (engine.ts). */
  engine: EngineOps;
  /** Placement rows — "show this app in that slot" (placements.ts). */
  placementRows: PlacementStore;
  /** The host's mounted slots, reported by the surfaces that render them
   *  (slots.ts). Beside placementRows because it answers the other half of the
   *  same question: which slots EXIST, not which app is in one. */
  slots: SlotRegistry;
  /** The app's own workspace documents (app-data.ts). */
  data: AppDataAccess;
  /** The capped version log and its pin-intent trail (history.ts). */
  history: AppHistoryAccess;
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
  /** The box manifest's schedules, folded into automation records. */
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
  /** The `app-lifecycle` audit kind, under the calling principal. */
  reportLifecycle(
    operation: "create" | "delete" | "fork" | "in-client-approve" | "seed" | "reseed" | "machine-provision" | "place" | "unplace",
    appId: AppId,
    ctx: RunContext,
    extra?: Record<string, Json>,
  ): Promise<void>;

  // ── approval-flow.ts ───────────────────────────────────────────────────────
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

  // ── edit-journal.ts ────────────────────────────────────────────────────────
  /** The layer ladder, derived from the document (never a stored rung). */
  rungFor(app: AppDocument, declared?: VersionEntry["rung"]): VersionEntry["rung"];
  /** 06-apps §8 — every edit result over a drifted app carries the drift report. */
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
    options: { origin: AdmissionOrigin },
  ): Promise<AppDocument>;
  /** Build contract §9.9 — the ONE announcement every change to what an app IS. */
  reportDocumentEdit(previous: AppDocument, next: AppDocument, subject: string): Promise<void>;
  /** Drop a version the write it was appended FOR never landed for. */
  discardVersion(appId: AppId, versionId: string): Promise<void>;
  /** The 50-version cap, applied once the newest version's write has landed. */
  pruneHistory(appId: AppId): Promise<void>;
  /** The person's own words for a save THIS runtime asked the assembler for. */
  editIntents: Map<AppId, string>;
  /** The version row an edit's own save APPENDED, keyed by app. */
  editVersions: Map<AppId, VersionEntry>;
  /** Why an edit's own save did NOT land, keyed by app. */
  editRefusals: Map<AppId, { intent: string; reason: string }>;
  /** The source a RE-SEED's replay starts from, published for that replay only. */
  replaySources: Map<AppId, string>;
  /** THIS edit's captured row, or nothing. */
  takeEditVersion(appId: AppId, instruction: string): VersionEntry | undefined;
  /** THIS replay's starting source, or nothing — gone once read. */
  takeReplaySource(appId: AppId): string | undefined;
  /** ONE instruction through the ONE builder. */
  assembleEdit(
    appId: AppId,
    instruction: string,
    ctx: RunContext,
  ): Promise<
    | { kind: "assembled"; app: AppDocument }
    | { kind: "escalate"; why: string }
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
  /** Run the server work an escalation asked for, on an app that is already STORED. */
  runServerWork(
    input: { document: AppDocument; request: string; why: string; served?: boolean },
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
  /** Author one automation onto a STORED app: plan, land, arm, audit. */
  authorAutomation: ReturnType<typeof createAutomationLane>;
  /** Forward ONE already-authorized request into the app's machine. */
  forwardToBox(app: AppDocument, request: BoxRequest, ctx: RunContext): Promise<BoxResponse>;

  // ── placement-surface.ts ───────────────────────────────────────────────────
  /** A host-authored slot name, checked at the one place every caller passes. */
  requireSlot(slot: string): string;
  /** B1 — claim the slot the moment the app id EXISTS. */
  claimSlot(appId: AppId, slot: string, ctx: RunContext): Promise<void>;
  /** The terminal record for an id no engine will ever land. */
  markUnbuilt(appId: AppId, name: string, reason: string, ctx: RunContext): Promise<void>;
  /** An assembler run has started for this id — `AppDocument.building`. */
  beginBuild(appId: AppId): void;
  /** Whether one is running right now, which is what makes a screen's first
   *  painting save a BUILD's rather than a harness's. */
  buildingNow(appId: AppId): boolean;
  /** The assembler came back, so the row may mount — `AppDocument.building`. */
  settleBuild(appId: AppId): Promise<void>;
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
  "engine" | "placementRows" | "slots" | "data" | "history" | "egressApprovals"
  | "parkedActions" | "inClientApprovals"> => {
  const engine = engineOf(config.ops, config.store);
  const placementRows = placementStore(engine);
  const slots = createSlotRegistry(engine);
  const data = createAppData({ ops: config.ops, store: config.store });
  const history = createAppHistory(engine);
  // Lane E — parked egress approvals (approved state lives on the document's
  // egressApproved field; this collection holds only undecided cards).
  const egressApprovals = createEgressApprovals(engine);
  // W0 — parked in-app actions: a mutating action the guard sent to approval
  // is recorded here (keyed by its approval) so onApprovalDecision can
  // re-dispatch the exact call the instant the owner approves. Holds only
  // undecided actions; both decisions clear it.
  const parkedActions = createParkedActions(engine);
  const inClientApprovals = createInClientApprovals(engine);
  return { engine, placementRows, slots, data, history, egressApprovals, parkedActions, inClientApprovals };
};

/** The composed seams the doors call through: interchange, the review-kind
 *  lifecycle, the box-aware caller, and the one opener. */
const createDoors = (
  deps: Pick<AppsRuntimeContext,
    "config" | "engine" | "history" | "inClientApprovals" | "parkedActions" | "lifecycle"
    | "requireOwned" | "updateAppDocument" | "runtime">,
): Pick<AppsRuntimeContext,
  "review" | "reviewerAsserted" | "interchange" | "fnCaller" | "manifestTriggers" | "caller" | "opener"> => {
  const { config, history, inClientApprovals, parkedActions, lifecycle } = deps;
  const { requireOwned, updateAppDocument } = deps;
  const interchange = createAppInterchange({
    engine: deps.engine,
    guard: config.guard,
    seedBaselines: config.seedBaselines,
    requireOwned,
  });

  // Remix final shape (2026-08-02) — review-kind gating over the §9 hash-pin
  // machinery: which document open() serves and the venue vocabulary the
  // client resolves ("pending-review" = show the ORIGINAL, never a jailed
  // fork; a served older approved version carries the current standing).
  const review = createReviewLifecycle({
    engine: deps.engine,
    baselines: config.seedBaselines,
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
    engine: deps.engine,
    lifecycle,
    updateDocument: updateAppDocument,
    ...(config.automations === undefined ? {} : { automations: config.automations }),
  });
  const caller = fnCaller.wrap(createAppCaller(config.tools, {
    // W0 — remember every mutating in-app action the guard parks, so the
    // approve→resume seam above can re-dispatch its exact call on approval.
    onParkedAction: (app, call, appCtx, approvalId) =>
      parkedActions.put({ approvalId, appId: app.id, owner: appCtx.principal.subject, call, ctx: appCtx }),
  }));
  const opener = createAppOpener(
    config.seedBaselines,
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
    // A stored `app.tsx` opens by RUNNING, through the same floor door the render
    // seam paints a save with — one gauntlet, so a reopened screen and a
    // just-saved one are the same picture with this instant's numbers.
    async (input, ctx) => {
      // `saves: false` — the same gauntlet, with the row half off. An open is a
      // READ: it must not create a row, must not record a refusal, and above all
      // must not store what it painted. A review-kind app serving an older
      // APPROVED snapshot (`serveDocFor`) paints that snapshot, and a writing
      // floor wrote it back over the row — silently reverting the app and
      // destroying the version awaiting review.
      const paint = deps.runtime().floor(ctx, { saves: false }).component;
      // Optional only for a floor that predates the screen engine; this runtime
      // composes its own (checking/floor.ts), so absence is a build mismatch.
      if (paint === undefined) {
        throw new VendoError(
          "not-implemented",
          "this build of @vendoai/apps carries no screen engine, so a saved screen cannot be opened",
        );
      }
      return await paint(input);
    },
    // §9.9 — the additive, ctx-aware venue-state slot lane H's adoption card
    // rides. Forwarded straight through; the runtime never interprets it.
    config.venueState,
  );
  return { review, reviewerAsserted, interchange, fnCaller, manifestTriggers, caller, opener };
};

/**
 * `AppDocument.building`, wired ONCE around the assembler rather than at each
 * door that runs one.
 *
 * A build is in flight for exactly as long as `assemble` is, so the three doors
 * that call one (`create`'s route, the `vendo_make` front door, and an edit)
 * cannot disagree about when it ends — and the `finally` means an assembler that
 * threw, escalated or came back empty settles the row just as a finished one
 * does. What the window is FOR is the screen agent's saves, which land
 * mid-`assemble`: only those mark their row unmountable, so a harness writing
 * `app.tsx` straight through the workspace is untouched.
 */
const withBuildTracking = (
  config: AppsConfig,
  { beginBuild, settleBuild }: Pick<AppsRuntimeContext, "beginBuild" | "settleBuild">,
): AppsConfig => {
  const screen = config.screen;
  if (screen === undefined) return config;
  return {
    ...config,
    screen: {
      assemble: async (input, ctx) => {
        beginBuild(input.appId);
        try {
          return await screen.assemble(input, ctx);
        } finally {
          await settleBuild(input.appId);
        }
      },
    },
  };
};

/** 06-apps §1 — `createApps`' closure, wired in dependency order. */
export const createRuntimeContext = (
  config: AppsConfig,
  runtime: () => AppsRuntime,
): AppsRuntimeContext => {
  const stores = createStores(config);
  const audit = createAuditReporters(config);
  const access = createAccessChecks({ config, engine: stores.engine });
  const machine = createMachineLane(config);
  const updateAppDocument = (
    appId: AppId,
    mutate: (doc: AppDocument) => AppDocument,
  ): Promise<AppDocument> => updateAppRow(stores.engine, appId, mutate, "box");
  // Before `base`, because the assembler `base` carries is the TRACKED one.
  const placement = createPlacementRows({ ...stores, ...audit, ...access });
  const base = {
    config: withBuildTracking(config, placement),
    ...stores, ...audit, ...access, ...machine, updateAppDocument, runtime,
  };
  const approvals = createApprovalFlow(base);
  const journal = createEditJournal(base);
  const doors = createDoors(base);
  const generation = createGenerationContext(base.config);
  const box = createBoxLane({ ...base, ...approvals, ...journal, ...doors });
  return { ...base, ...approvals, ...journal, ...doors, ...placement, ...generation, ...box };
};
