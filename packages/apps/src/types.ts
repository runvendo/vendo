/**
 * @vendoai/apps — the block's type surface (06-apps §1).
 *
 * The `AppsRuntime` contract and the shapes its verbs speak, split out of
 * `runtime.ts` so the contract and its implementation stop sitting ~2,000 lines
 * apart in one file. Declarations only — no values, so nothing here can create
 * an import cycle. `runtime.ts` re-exports every name for the package's
 * existing importers.
 */
import type {
  AccessLevel,
  AppAccess,
  AppDocument,
  AppFloor,
  AppGrantRecord,
  AppId,
  ApprovalId,
  ApprovalRequest,
  FilesAdapter,
  Guard,
  IsoDateTime,
  Json,
  NormalizedCatalog,
  RiskLabel,
  RunContext,
  ScreenAssembler,
  SecretsProvider,
  StoreAdapter,
  ToolCall,
  ToolOutcome,
  ToolRegistry,
  ToolSemantics,
  Trigger,
  UIPayload,
  VendoTheme,
  VendoViewPart,
  WireCompileResult,
  WorkspaceFs,
} from "@vendoai/core";
import type { LanguageModel } from "ai";
import type { Check, Finding } from "./checking/types.js";
import type { CloudAppsClient, PublishRecord, ShareSnapshot } from "./cloud.js";
import type { GenerationDependencies } from "./engine.js";
import type { InClientVerdict } from "./inclient.js";
import type { BuildMachineEnv, LifecycleClock } from "./machine-lifecycle.js";
import type { AppMachineStatus, ManifestTriggerSync } from "./manifest-triggers.js";
import type { InClientApproval, PinBaseline, PinDrift } from "./pins.js";
import type { RemixRejection, ReviewQueueEntry } from "./review.js";
import type { SandboxAdapter, SandboxMachine } from "./sandbox.js";
import type { ShipDiff } from "./ship-diff.js";

/** 06-apps §1 plus block-plan decisions 3–4. */
export interface AppsConfig {
  store: StoreAdapter;
  guard: Guard;
  tools: ToolRegistry;
  /**
   * execution-v2 — machine lifecycle seams. `sandbox` is the sandbox adapter
   * (Lane A's shrunk seam); `buildEnv` is Lane C's env assembly, injected so
   * the lanes do not collide. No adapter → layer-2 lifecycle operations fail
   * with the existing sandbox-unavailable VendoError; layer-1 apps are
   * unaffected.
   */
  machine?: {
    sandbox?: SandboxAdapter;
    buildEnv?: BuildMachineEnv;
    /**
     * Lane E — the implicit skin domains merged into every machine's egress
     * allowlist (the box must always reach its own boundary: store surface,
     * host-callback surface, inference endpoint). The host assembles them
     * from the same origins it injects as VENDO_STORE_URL / VENDO_HOST_URL /
     * VENDO_INFERENCE_URL. They are never subject to declaration or approval.
     */
    implicitDomains?: string[];
    template?: string;
    idleMs?: number;
    clock?: LifecycleClock;
    /**
     * execution-v2 Wave 3 — the in-box agent edit is a minutes-long loop the
     * host long-polls. These tune that poll; defaults suit a live box (8-min
     * budget). Tests shrink them to run without real time.
     */
    boxEditPollMs?: number;
    boxEditTimeoutMs?: number;
  };
  /**
   * Build contract §9.2–§9.6 — the multi-party half. `appAccess` is `can()`
   * over whatever store the host wired (the umbrella composes it at the
   * composition seam); `multiParty` is the Cloud gate, filled from
   * `cloudKeyOptions() !== undefined` — sharing is multi-party coordination,
   * so grant/revoke/promote refuse with `cloud-required` without it.
   * `can()` itself is OSS and NEVER key-conditional: with no key no grant row
   * can exist, so it degenerates to ownership.
   *
   * `appAccess` unset ⇒ ownership only, exactly today's behavior.
   */
  appAccess?: AppAccess;
  multiParty?: boolean;
  /**
   * Build contract §9.5 — promote's ROW half. A promote crosses subjects, which
   * 02-store §2 otherwise forbids, and it moves the app's workspace documents
   * with it; both are raw-row work the store owns, so the umbrella fills this
   * seam (`appStore().promote` + `workspaceStore().promoteApp`). Unset, promote
   * refuses rather than half-moving an app.
   */
  promoteApp?: (appId: AppId, fromSubject: string, orgId: string) => Promise<void>;
  /**
   * Build contract §9.8 — where this deployment serves the authenticated proxy
   * for an ORG-owned served app (`<wire base>/apps/<id>/serve/`). The wire owns
   * its base path, so the umbrella fills this; unset, an org served app has no
   * proxy to point at and `open()` refuses rather than handing out the
   * provider's URL, which would bypass the per-request `can(viewer)`.
   */
  servedProxyPath?: (appId: AppId) => string;
  /**
   * Build contract §9.9 (lane H's other half) — called after a successful
   * document persist, with the previous document, the next one, and the
   * editing subject. The automations side implements it (a sponsorship is
   * invalidated when `editor !== sponsor`); the runtime just rings the bell.
   * A throw here must never fail the edit that already landed.
   */
  onDocumentEdit?: (previous: AppDocument, next: AppDocument, editor: string) => Promise<void>;
  /**
   * Build contract §9.9 (lane H's other half) — an ADDITIVE, ctx-aware venue
   * state merged into the open payload beside the in-client verdict. Lane H's
   * adoption card rides it, which is why it takes the RunContext: the card is
   * served only to callers with `can(editor)`, so the decision is per-caller,
   * not per-document. Returned keys spread onto the payload; `inClient`,
   * `data` and `pinDrift` are reserved and never overwritten.
   */
  venueState?: (app: AppDocument, ctx: RunContext) => Promise<Record<string, unknown> | undefined>;
  /**
   * execution-v2 Wave 9 — the arming seam for ladder-authored automations
   * (the same seam pattern as AutomationsConfig.runner: this block never
   * imports the automations engine). When set, a freshly authored trigger is
   * armed through it — the umbrella wires `automations.enable`, which runs
   * the 07 §3 grant-capture flow and surfaces the missing standing-grant
   * approvals (they ride EditResult.automation.pendingGrants). Unset, the
   * runtime arms the stored row directly and grant capture stays lazy: the
   * first away run's ungranted step parks the normal approval card.
   */
  armAutomation?: (appId: AppId, triggerId: string, ctx: RunContext) => Promise<{ enabled: boolean; missing: ApprovalRequest[] }>;
  /**
   * Contract §3.2 — the workspace's OWN blob seam, for source past
   * {@link WORKSPACE_INLINE_MAX_BYTES}. The SAME `FilesAdapter` the workspace rows
   * spill to (the umbrella's `selectFiles`), never a second spill mechanism: a
   * source file and a workspace file are the same bytes in two projections.
   *
   * Unset, `commitSource` is inline-only and an oversized file is refused LOUDLY
   * rather than dropped — a silently missing source file is a lost app.
   */
  files?: FilesAdapter;
  model?: LanguageModel;
  /** The island smoke-render gate (on unless explicitly `false`): every
   *  generated island renders once headless before it can reach a screen. */
  pipeline?: GenerationDependencies["pipeline"];
  /** The host's own checks over a generated app (checking/types.ts). APPENDED
   *  to the built-in fact checks and the reviewer — a host can add findings,
   *  never remove or replace a built-in one. */
  checks?: readonly Check[];
  /** The composition-normalized catalog (01 §14): derived schemas included.
   *  The provider (function) form of theme/semantics below mirrors
   *  designRules: it is resolved lazily per create/edit (in
   *  generationDependencies), never eagerly, so the umbrella can back it with a
   *  first-request cloud read without doing I/O at compose time. */
  catalog: NormalizedCatalog;
  theme?: VendoTheme | (() => VendoTheme | undefined);
  secrets?: SecretsProvider;
  /** Host design rules for generation prompts; the function form is re-read
   *  per create/edit (engine.ts GenerationDependencies). */
  designRules?: string | (() => string | undefined);
  pinBaselines?: PinBaseline[];
  /** Remix review (round-2 hardening 2026-08-02) — the host's reviewer
   *  assertion for the review-kind lifecycle. Reviewing crosses owner
   *  boundaries, so it is never inferred from a principal alone: `reviewer`
   *  answers whether THIS caller may read the full queue, reject, and approve
   *  review-kind remixes. Unset, the queue serves only the caller's own
   *  submissions and reject/approve-as-reviewer refuse, naming this hook. */
  review?: {
    reviewer?(ctx: RunContext): boolean | Promise<boolean>;
  };
  /** ADAPTER RULE — the share/publish seam (see cloud.ts): the umbrella wires
   * the Cloud console client when VENDO_API_KEY fills the unset slot; this
   * block never reads the environment. Unset → share/publish fail with
   * VendoError("cloud-required"). */
  cloud?: CloudAppsClient;
  /** W3 — per-tool field semantics from `.vendo/semantics.json`, passed to
   *  the generation engine (annotated shape cards, law checks, Kit format
   *  defaults). Provider form resolved per generation (see catalog note). */
  semantics?: Readonly<Record<string, ToolSemantics>> | (() => Readonly<Record<string, ToolSemantics>> | undefined);
  /**
   * UI-generation blueprint §1 point 2 — the screen agent. "The seam routes, not
   * the caller": every `vendo_make` request starts in the cheap assembly loop,
   * and this block never decides which engine a request deserves.
   *
   * An ADAPTER SLOT, for the reason every other one here is: the screen agent is a
   * lean loop in `@vendoai/harnesses` and this block depends on `core` alone, so
   * the two sides meet on core's `ScreenAssembler` and composition is the only
   * place that fills it. Explicitly passed always wins.
   *
   * REQUIRED for `vendo_make`, as of the conductor's retirement. There is no
   * second engine behind this seam: an `unavailable`, an assembler that could not
   * run, a throw, an `assembled` that left no app ROW behind, and an unfilled slot
   * all answer with a FAILED receipt that says what happened. A quiet fall-through
   * is how a composition bug ships — the deployment reads all-green while every
   * ask is served by an engine nobody chose. An `escalate` is the one answer that
   * is neither: it is a request for the build, and the build is what it gets (see
   * `vendo_make` in agent-tools.ts).
   */
  screen?: ScreenAssembler;
  /**
   * §4.5's other half — the plan an escalating screen agent left behind, read
   * back so the build ANCHORS on it instead of re-planning from the ask alone.
   *
   * The plan is a FILE (`/user/apps/<appId>/plan.vendo`, written through the same
   * `commit()` that painted its skeleton), and this block holds no workspace
   * (§3.5 — a sandboxed harness holds a workspace and never a store). So the seam
   * is the same shape as `screen` above and composition, which already built the
   * workspace the assembler wrote through, is the one place that reads it back.
   *
   * Best-effort by design: `undefined` — unfilled slot, no plan file, an
   * unreadable workspace — means the build plans from the ask, which is exactly
   * what it did before this seam existed. A build is never lost to a missing brief.
   */
  escalatedPlan?: (appId: AppId, ctx: RunContext) => Promise<string | undefined>;
}

/** 06-apps §1 */
export interface EditResult {
  app: AppDocument;
  version: VersionEntry;
  issues?: string[];
  /** Additive failure detail: when present, no edit was persisted. */
  failure?: EditFailure;
  /** Additive 06 §8 drift report: pins whose host baseline changed under the
   * fork. Present on every edit result over a drifted app so drift is loud at
   * edit time, not only in sync output or the ship-diff. */
  driftedPins?: PinDrift[];
  /**
   * execution-v2 Wave 3 — set when this edit graduated the app 1→2 (or edited
   * an already-graduated app's server): the machine was provisioned, the box
   * agent wrote/updated the server code, and the tree gained its fn: bindings.
   */
  graduated?: boolean;
  /** The in-box agent's structured report for a graduating/server edit (DATA:
   * it carries no host authority — approvals still gate every mutation). */
  box?: { ok: boolean; summary: string; fns?: string[]; filesChanged?: string[] };
  /**
   * execution-v2 Wave 3 — a graduating edit whose server code declares egress
   * the owner has not approved surfaces the parked approval HERE (not a silent
   * failure). The code is written and snapshotted; the fn does real egress only
   * once the owner approves this card.
   */
  pendingEgress?: { approvalId?: ApprovalId; domains: string[] };
  /**
   * execution-v2 Wave 9 — set when this edit rode the escalation ladder to an
   * automation instead of a box: the authored trigger was written onto the
   * document and ARMED on the existing automations engine (the enabled row the
   * tick/emit machinery fires). Grant capture stays lazy — an away run's first
   * ungranted mutating step parks the normal approval card. No machine is
   * involved. `resultsCollection` names the app records collection the
   * automation writes displayable results into (the rows the tree queries).
   * `pendingGrants` carries the standing-grant approvals the arming seam's
   * capture flow parked — approving them lets away runs complete unattended.
   */
  automation?: {
    mode: "steps" | "agentic";
    trigger: Trigger;
    /** What the arming actually produced — false when the seam left the
     * trigger disarmed or arming threw (the issues entry says why). The
     * thread's automation card needs the true state, not an inference. */
    enabled: boolean;
    resultsCollection?: string;
    pendingGrants?: ApprovalRequest[];
  };
}

export interface EditFailure {
  code: "edit-rejected";
  retryable: boolean;
  message: string;
}

/** execution-v2 Wave 3 — the outcome of a machine.editApp() box edit. */
export interface MachineEditResult {
  ok: boolean;
  /** The in-box agent's summary (data-only; carries no host authority). */
  summary: string;
  fns?: string[];
  filesChanged?: string[];
  /** The synced document after a successful edit (schedules + egress declaration). */
  app?: AppDocument;
  /** A parked egress-approval card for the domains the server code declared. */
  pendingEgress?: { approvalId?: ApprovalId; domains: string[] };
}

/** 06-apps §1 */
export interface VersionEntry {
  at: IsoDateTime;
  intent: string;
  rung: 1 | 2 | 3 | 4;
}

/** 06-apps §1 */
export type OpenSurface =
  | { kind: "tree"; payload: UIPayload; components?: Record<string, string> }
  | { kind: "http"; url: string }
  | { kind: "resuming"; cover?: string }
  /**
   * The build turn terminally FAILED (model error, quota, timeout): the app
   * will never become servable. Surfaced so the embed resolves promptly with
   * the reason instead of polling to its client deadline — the same prompt
   * resolution the approval embed gets from denied/expired. `prompt` (when
   * the record carries it) lets the embed's retry affordance re-issue the
   * exact create.
   */
  | { kind: "failed"; reason: string; retryable?: boolean; prompt?: string };

/** execution-v2 Lane C — one HTTP request across the skin of the box (the
 * shape SandboxMachine.request speaks, named at the runtime surface). */
export interface BoxRequest {
  method: string;
  path: string;
  headers?: Record<string, string>;
  body?: Uint8Array | string;
}

/** execution-v2 Lane C — the box's answer, relayed verbatim by the caller. */
export interface BoxResponse {
  status: number;
  headers: Record<string, string>;
  body: Uint8Array;
}

/**
 * ENG-345 — the in-sandbox status of one declared secret for one app.
 * `handle` is the Option B default; `exposed` means an active owner-approved
 * grant places its real value in the sandbox env; `pending` means a flip-on is
 * parked awaiting the high-risk guard approval.
 */
export interface SecretExposureState {
  secretName: string;
  status: "handle" | "pending" | "exposed";
  approvalId?: ApprovalId;
}

/** ENG-345 — the outcome of a setExposure() call. */
export type SetExposureResult =
  | { status: "handles" }
  | { status: "exposed" }
  | { status: "pending-approval"; approvalId: ApprovalId };

/**
 * 06-apps §8 — the outcome of one pin rebase. `failed` persists NOTHING: the
 * pre-rebase version stays live, and the report says which recorded intents
 * replayed cleanly, which one failed, and which were never attempted.
 * Fail-closed by construction — a rebase is all-or-nothing, never a silent
 * half-rebase.
 */
export type PinRebaseResult =
  | {
    status: "rebased";
    app: AppDocument;
    version: VersionEntry;
    slot: string;
    /** The NEW baseline hash the pin now records as its `base`. */
    baseHash: string;
    /** The pin intents replayed onto the new baseline, in recorded order. */
    replayed: string[];
  }
  | {
    status: "failed";
    slot: string;
    baseHash: string;
    replayed: string[];
    failed: { intent: string; issues: string[] };
    remaining: string[];
  };

/**
 * 06-apps §8 — gesture-owned forking (2026-07-21): the input of pins.fork().
 * The fork itself is DETERMINISTIC (engine copies the captured baseline and
 * records the pin — no model call); the model never decides to fork. With no
 * `appId` the gesture mints a minimal app around the fork (the empty-slot
 * Remix affordance). An `instruction` then rides the ORDINARY edit path,
 * already scoped to the forked component.
 */
export interface PinForkInput {
  appId?: AppId;
  slot: string;
  /** The wrapper's serializable live props at fork time (2026-08-02 final
   *  shape). Stored as the pinned node's props — the fork's dashboard seed
   *  when it is placed away from the host page; in place the wrapper streams
   *  live props over the frame boundary on every render instead. */
  props?: Record<string, Json>;
  instruction?: string;
}

/** 06-apps §8 — the outcome of one gesture fork. `version` describes the
 *  deterministic fork itself; `edit` (present only when the gesture carried an
 *  instruction) is the scoped follow-up edit — its failure never rolls the
 *  fork back, so `app` is always at least the faithful fork. */
export interface PinForkResult {
  app: AppDocument;
  version: VersionEntry;
  slot: string;
  /** The generated-component name the fork ships under (`pinComponentName`). */
  componentName: string;
  edit?: EditResult;
}

/**
 * What a files-first save answers with: the resolved query data for the tree it
 * stored, and — when a query FAILED to resolve — the honest marker that says so.
 * Without the second half the seam could only tell the truth about a whole app
 * half that THREW, and a query that answered "error", "blocked" or
 * "connect-required" would render "—" everywhere and read as "you have no data"
 * (see `ProgressiveQueryResolver.dataUnavailable`).
 */
export interface AuthoredAppResult {
  data: Record<string, Json>;
  dataUnavailable?: true;
}

/** One slot's answer: what is in it, and where that app's build stands.
 *  `status` is derived from the app record every read — never stored, so a
 *  build that lands (or fails) needs no second write to correct the slot. */
export interface PlacementEntry {
  slot: string;
  app: AppId;
  /** The app's name, or "" while the build has not landed (there is no
   *  document yet to take a title from). */
  title: string;
  status: "ready" | "building" | "failed";
}

/** 06-apps §1 */
export interface AppsRuntime {
  create(input: {
    prompt: string;
    /**
     * The id this build must use, when the caller already minted one.
     *
     * The front door mints before it routes to the screen agent (§4.5): an
     * escalation's `plan.vendo` is already written at `/user/apps/<appId>/` and
     * its skeleton is already on `vendoViewStreamId(appId)`, so a conductor that
     * minted its own id would paint the finished app onto a SECOND stream and
     * leave the plan's skeleton stranded beside it as a permanently-building
     * card. Absent — every caller but the front door — one is minted here.
     */
    appId?: AppId;
    /**
     * §4.5 — the plan the escalating screen agent already wrote, verbatim.
     *
     * The build ANCHORS on it: the person is already looking at its skeleton, so
     * re-planning from the ask alone is how the outline they are watching turns
     * into a different app. It is a brief for the brain, never a substitute for
     * one — the ask still travels verbatim, and the brain is free to say the plan
     * is wrong. Absent — every caller but an escalation — the brain plans from
     * the ask exactly as it always has.
     */
    plan?: string;
    /**
     * The host slot this build is FOR. The placement row is written the moment
     * the id is minted — before a single token is generated — so the slot shows
     * the build forming instead of staying empty until it lands, and shows the
     * failure if it never does.
     */
    slot?: string;
    /** Additive per-call stream hook used by the agent bridge. */
    onView?: (part: VendoViewPart) => void;
    /** Called when the app was generated and STREAMED to the surface but the
     *  store refused to persist it: the view is on screen, the app is not in
     *  the user's list and cannot be reopened. The create still resolves with
     *  the document — losing a working view to a storage fault is the worse
     *  failure — so this is the only signal that the app is view-only, and
     *  the agent bridge turns it into an honest sentence instead of an
     *  apology for something the user can see. */
    onUnsaved?: (reason: string) => void;
  }, ctx: RunContext): Promise<AppDocument>;
  /**
   * Build contract §1.6 / redesign D4 — the files-first counterpart of
   * {@link AppsRuntime.create}: the app a HARNESS wrote with its own hands, as
   * `app.vendo` in the workspace.
   *
   * Nothing else makes such an app an APP: with no row it never lists and never
   * opens (`vendo_apps_open` masks it as `not-found`), and with no document its
   * queries resolve to nothing, so every value renders "—" while the real host
   * data sits one call away. This closes both halves — it upserts the row through
   * the writer generation persists with, and resolves the tree's queries through
   * the guard-bound caller `open()` uses (one guard decision per query, the
   * person's own authority, the app venue).
   *
   * Deliberately NOT generation: no model, no conductor, no checking floor. The
   * `validate` verb is this loop's review floor (D7's skill law), and a mid-turn
   * save is partial by design — refusing to store what the person can already see
   * would be the worse failure.
   *
   * The render seam (`@vendoai/harnesses`) is the only caller; it hands over the
   * compile it already did, so the stored tree is byte-identical to the painted one.
   */
  authored(
    input: { appId: AppId; compiled: WireCompileResult },
    ctx: RunContext,
  ): Promise<AuthoredAppResult>;
  /**
   * Contract §3.2/§2.2 — the app's own SOURCE, landed in its row.
   *
   * The sibling of {@link AppsRuntime.authored}, on the same interception point and
   * with the same one caller: the render seam's `commit()` proxy. `changed` is
   * `CommitResult.changed` verbatim, and this is the store half of it —
   * `commitApp` diffs the paths inside THIS app's directory back into
   * `doc.source`, leaving everything else in the document (`trigger` above all)
   * untouched. A commit is not a generation.
   *
   * This exists because `machine.snapshotRef` was an app's only home: the box's
   * writes reach the store through the workspace façade and nowhere else, so this
   * is where the row becomes the truth. Without it, losing a snapshot loses the
   * customer's app.
   *
   * `workspace` is passed in rather than held: this block never owns a workspace
   * (§3.5 — a sandboxed harness holds a workspace and never a store), and the
   * caller is the one with the façade whose commit just landed.
   */
  commitSource(
    input: { appId: AppId; changed: readonly string[]; workspace: WorkspaceFs },
    ctx: RunContext,
  ): Promise<void>;

  /**
   * The checks floor bound to this caller's host surface (§7.1) — the production
   * compile dialect, and the deterministic fact checks over what it compiled.
   *
   * The render seam is the caller, for the same reason it is `authored`'s: it is
   * the one place that sees every write to `app.vendo`, whoever made it. Handing it
   * the floor is what makes the checks run for EVERY author instead of only for
   * apps our own conductor built — the seam used to compile with no options at
   * all, so a lying binding was invisible and an inline tool reference lost its
   * binding silently.
   *
   * Its `deps` are resolved lazily and once per returned floor: building them
   * lists the host's tools, and a floor is built per turn but called per commit.
   */
  floor(ctx: RunContext): AppFloor;
  /**
   * What every tool a binding may name really RETURNS, annotated with this
   * host's own field semantics — the `:money.cents`, `:date.iso`, `:enum(a|b)`
   * marks that decide whether a number is dollars or cents on screen.
   *
   * A documented host seam (`.vendo/semantics.json` plus the cloud-owned
   * overrides) that used to reach the model through the fill worker's query
   * brief and nowhere else. The fill worker is gone, so this is how the
   * annotations reach the one thing that writes bindings now. Composition reads
   * it off the runtime and fills the assembler's `system` slot, the same shape as
   * every other seam here — this block depends on `core` alone and cannot reach
   * a harness.
   *
   * The host's DESIGN configuration is a different key with a different owner:
   * `apps.designRules` and the theme ride `hostDesignBrief` into the assembler's
   * `design` slot and the `claudeCode()` builder's prompt, so both writers read
   * one rendering of them. Nothing about design belongs here.
   *
   * Resolved PER CALL, never memoized: the semantics provider is re-resolved so a
   * local `tools.json` edit and the cloud-owned overrides both keep merging live.
   *
   * ALWAYS a section, listing EVERY tool — a tool whose response shape nothing
   * could read prints the unknown sentence rather than being silently absent.
   * Silence reads as "this tool has no interesting output", which is how a
   * model ends up binding to fields it invented.
   */
  toolShapeBrief(ctx: RunContext): Promise<string>;
  /** Speed lane — best-effort page-open warm-up of the generation model(s)
   *  (full + paint), so the first create reuses a live connection. Safe to
   *  call on surface mount; never throws. */
  prewarm(): Promise<void>;
  get(appId: AppId, ctx: RunContext): Promise<AppDocument | null>;
  list(ctx: RunContext): Promise<AppDocument[]>;
  delete(appId: AppId, ctx: RunContext): Promise<void>;
  fork(appId: AppId, ctx: RunContext): Promise<AppDocument>;
  /**
   * Placement (2026-08-05) — "show this app in that slot", as a ROW keyed by
   * (subject, slot) rather than a string on the document.
   *
   * Viewer-scoped: placing an app in YOUR OWN slot is part of seeing it. One
   * app per slot — the write replaces whatever held it, and the displaced app
   * comes back as `evicted` so the surface can say so.
   */
  place(input: { app: AppId; slot: string }, ctx: RunContext): Promise<{ evicted?: string }>;
  /** Clear the slot — but only when it is still THIS app that holds it, so a
   *  stale client can never evict the app that replaced it. Idempotent. */
  unplace(input: { app: AppId; slot: string }, ctx: RunContext): Promise<void>;
  /** What is in the caller's slots. `slots` narrows the answer to the slots a
   *  surface actually has mounted; omitted, every placement the caller holds. */
  placements(input: { slots?: readonly string[] }, ctx: RunContext): Promise<PlacementEntry[]>;
  /**
   * Build contract §9.5 — the second of sharing's two verbs. Moves the
   * canonical app into an org the caller is asserted a member of: the row
   * subject becomes the org id verbatim, the app's workspace documents move to
   * `/orgs/<orgId>/apps/<id>/**`, and the promoter keeps an `owner` grant.
   * Requires ownership + an asserted membership + the Cloud key (§9.6);
   * `promote` and `fork` are the only two ways an app crosses a workspace.
   */
  promote(appId: AppId, orgId: string, ctx: RunContext): Promise<AppDocument>;
  /**
   * Build contract §9.2–§9.3 — the Share dialog's door. `list` is viewer-gated
   * and OSS; `grant`/`revoke` are owner-gated AND Cloud-gated (sharing is
   * multi-party coordination). `can()` behind them is never key-conditional.
   */
  access: {
    list(appId: AppId, ctx: RunContext): Promise<AppGrantRecord[]>;
    grant(appId: AppId, principal: string, level: AccessLevel, ctx: RunContext): Promise<void>;
    revoke(appId: AppId, principal: string, ctx: RunContext): Promise<void>;
    /** The caller's own level, or null when they cannot see the app at all —
     *  what the surface reads to decide between "Edit" and the fork offer. */
    levelFor(appId: AppId, ctx: RunContext): Promise<AccessLevel | null>;
    /** Who HOLDS the app: a person's subject, or an org id for a promoted one
     *  (§9.5 — the row subject is the org verbatim). Null when the caller
     *  cannot see the app. The Share dialog reads it to know whether sharing
     *  has to promote first, and into which org. */
    holder(appId: AppId, ctx: RunContext): Promise<string | null>;
  };
  edit(appId: AppId, instruction: string, ctx: RunContext): Promise<EditResult>;
  /**
   * The app's memory, and the ONE door that writes it.
   *
   * A screen or build run is stateless; the ARTIFACT is what carries its context
   * forward, and this is where that context lands. `ask` is appended verbatim —
   * the front door passes the person's own `request`, never the `<context>`-fenced
   * composite it briefs an engine with. `decisions` REPLACES whatever was there:
   * it describes the app as it stands, so a superseded one kept beside the new
   * one reads as a current constraint. Both are capped here (`app-memory.ts`)
   * rather than in the schema, so a stored row survives a cap that changes.
   *
   * There is deliberately no second row-write door for this. Every caller —
   * `vendo_make`'s create arms, its edit arm, the screen assembler's decisions —
   * comes through here, which is also the one place the `editor` level is
   * checked. A caller treats a rejection as a non-event: memory is never worth
   * failing a make over.
   */
  remember(input: { appId: AppId; ask?: string; decisions?: string }, ctx: RunContext): Promise<void>;
  /**
   * The capped version log, and the one-step rollback over it.
   *
   * Build contract §9.3 — this takes the ctx (06 §1's `history(appId)` widened
   * by the wave-3 ruling): `list` needs `viewer`, `undo` needs `EDITOR`,
   * because rolling back the team's app is an edit. Without the ctx here the
   * only boundary would be the wire route — and one door is not a boundary.
   */
  history(appId: AppId, ctx: RunContext): { list(): Promise<VersionEntry[]>; undo(): Promise<AppDocument> };
  open(appId: AppId, ctx: RunContext): Promise<OpenSurface>;
  call(appId: AppId, ref: string, args: Json, ctx: RunContext): Promise<ToolOutcome>;
  exportApp(appId: AppId, ctx: RunContext): Promise<Uint8Array>;
  importApp(source: Uint8Array | AppDocument, ctx: RunContext): Promise<AppDocument>;
  share(appId: AppId, ctx: RunContext): Promise<ShareSnapshot>;
  publish(appId: AppId, ctx: RunContext): Promise<PublishRecord>;
  agentTools(): ToolRegistry;
  /** Contextual policy projection for Vendo-owned agent tools. Undefined means
   * the static descriptor remains authoritative. */
  agentToolRisk(call: ToolCall, ctx: RunContext): Promise<RiskLabel | undefined>;
  /**
   * Design §4's `validate` verb, as a door rather than a generation internal.
   *
   * The checking floor already exists and already runs inside create/edit; the
   * verb is the same floor, callable. That matters because the building-apps
   * skill teaches the model to `validate` after every edit — "it is faster and
   * surer than re-reading your own work" — so the loop is validate → fix, and
   * without this door the tool had nothing behind it.
   *
   * Findings, never a throw: an error reads to a model as "the tool is broken"
   * and findings read as "your document is wrong". Only the second one gets
   * fixed. Give `appId` to check what is stored, or `document` to check wire
   * text before committing it.
   */
  validate(
    input: { appId?: AppId; document?: string },
    ctx: RunContext,
  ): Promise<{ ok: boolean; findings: Finding[] }>;
  /**
   * Design §4's `schedule` verb: set or change WHEN an app's automation runs.
   *
   * Only a cron change, and only on an app that already declares a schedule
   * trigger — authoring a trigger from nothing is `edit`'s job, because it needs
   * a run model. Re-arms through the composed automations engine afterwards, so
   * the 07 §3 grant-capture flow runs and any missing standing grants come back
   * on `missing` rather than failing silently at the first firing.
   *
   * `write`, not `read`: arming future unattended behaviour is a write (build
   * contract §8's lane-D ratification).
   */
  schedule(
    appId: AppId,
    cron: string,
    ctx: RunContext,
  ): Promise<{ appId: AppId; cron: string; enabled: boolean; missing: number }>;
  /**
   * Build contract §9.8 — the served-app door. One request forwarded into the
   * app's machine after `can(viewer)` is re-checked against LIVE rows, so a
   * mid-session revoke bites the next request even though what the session
   * already rendered stands. Viewer-level by design: `viewer` is see + use.
   *
   * Separate from {@link AppsRuntime.box}.request, which is the editor-level fn
   * door — the two have different callers and deliberately different levels.
   */
  serve(appId: AppId, request: BoxRequest, ctx: RunContext): Promise<BoxResponse>;
  box: {
    /**
     * execution-v2 skin contract (Lane C) — the box door the wire's fn proxy
     * route rides: wake the app's machine on demand and proxy ONE HTTP request
     * to its $PORT (the box serves `POST /fn/<name>` per the contract; the
     * caller shapes the path). Editor-scoped: writing through someone else's
     * app is an edit. Additive like `proxy`/`inClient` — not part of the frozen
     * §1 method table. Lane B's machine lifecycle owns the wake internals
     * behind this door.
     */
    request(appId: AppId, request: BoxRequest, ctx: RunContext): Promise<BoxResponse>;
    /**
     * Lane E — scrub the app's known secret values out of a JSON-ish value
     * (defensive redaction guard). The /box wire surface runs every callback
     * outcome and row payload through this before it can land in a response,
     * a store row, or a log line. Not an authority operation: it only ever
     * REMOVES information.
     */
    redact(appId: AppId, value: Json): Promise<Json>;
  };
  /**
   * 06-apps §9 — additive trust-axis surface (like `proxy`/`agentToolRisk`,
   * not part of the frozen §1 method table). OSS carries the enforcement
   * machinery: the ship-diff a reviewer reads, the stored approval records,
   * and the hash-pin verdict `open()` rides to the client. Cloud's review
   * console MINTS approvals in production; `approve` is the documented local
   * injection seam (demos, dev, host-built review flows).
   */
  inClient: {
    shipDiff(appId: AppId, ctx: RunContext): Promise<ShipDiff>;
    approvals(appId: AppId, ctx: RunContext): Promise<InClientApproval[]>;
    verdict(appId: AppId, ctx: RunContext): Promise<InClientVerdict>;
    approve(input: { appId: AppId; approvedBy: string }, ctx: RunContext): Promise<InClientApproval>;
  };
  /**
   * Remix final shape (2026-08-02) — additive review-kind lifecycle surface
   * (same additive precedent as `inClient`/`pins`). A review-kind remix (an
   * app forked from a baseline captured with `review: true`) is invisible to
   * its own user until a host reviewer approves; the approved version then
   * mounts natively in place, riding the §9 hash-pin machinery. These two
   * methods are the reviewer's side and cross owner boundaries BY DESIGN
   * (the reviewer is not the remixing user), so both are gated on the host's
   * reviewer assertion ({@link AppsConfig.review} `reviewer`): this is the
   * production path — a self-hoster mounts their own admin-authenticated
   * route over it (Cloud's console is the hosted equivalent). Without the
   * hook, `queue` serves only the caller's own submissions and `reject`
   * refuses, naming the hook.
   */
  review: {
    /** Every review-kind version awaiting review, oldest submission first —
     *  the full queue for an asserted reviewer, the caller's own items
     *  otherwise. */
    queue(ctx: RunContext): Promise<ReviewQueueEntry[]>;
    /** Reject the app's CURRENT version with a note the user's panel surfaces.
     *  The work is not deleted; a new version supersedes the rejection. */
    reject(input: { appId: AppId; note: string }, ctx: RunContext): Promise<RemixRejection>;
  };
  /**
   * 06-apps §8 — additive drift→rebase surface (same additive precedent as
   * `inClient`, not part of the frozen §1 method table). `drift` reports the
   * pins whose captured host baseline changed under a fork; `rebase` re-forks
   * ONE drifted pin from the NEW baseline and replays its recorded pin-intent
   * trail (history.pinIntents) through the real model edit path, producing a
   * new version whose pin `base` is the new baseline hash. A rebase is a
   * content change, so it is NEVER invoked automatically: the agent tool
   * `vendo_apps_rebase_pin` and the wire route are the invocation surfaces,
   * and the new version drops in-client approval by construction (§9).
   */
  pins: {
    drift(appId: AppId, ctx: RunContext): Promise<PinDrift[]>;
    rebase(input: { appId: AppId; slot: string }, ctx: RunContext): Promise<PinRebaseResult>;
    /**
     * Gesture-owned forking (2026-07-21) — the deterministic fork the user's
     * Remix gesture invokes: the engine copies the captured baseline into the
     * pinned generated component and records the pin, with NO model call. The
     * model lost the fork decision entirely (<ForkPin> is retired from the
     * edit dialect; the op still compiles for stored apps). An optional
     * instruction runs afterwards as an ordinary edit, already scoped to the
     * forked component; its failure leaves the faithful fork in place.
     */
    fork(input: PinForkInput, ctx: RunContext): Promise<PinForkResult>;
  };
  /**
   * execution-v2 — additive machine lifecycle surface (same additive precedent
   * as `inClient`/`pins`/`secrets`). An app with no `machine` on its document
   * is a layer-1 tree app; presence of `machine` means layer 2+ — the layer is
   * always derived from presence, never stored. Wake single-flight and idle
   * auto-sleep live in-process; a multi-instance host can wake one app twice
   * (known v2 limit — the last sleep's CAS wins).
   */
  machine: {
    /**
     * Can this deployment run a machine at all — i.e. is a `sandbox` adapter
     * configured?
     *
     * The ONE gate on machine-backed execution, and deliberately not a
     * capability boolean: a host configures a sandbox or it does not, and the
     * presence of the adapter IS the deliberate opt-in (CLAUDE.md — "gating is
     * valid key + meter, nothing else: no capability booleans"). Exposed because
     * the front door has to answer an escalation honestly BEFORE it starts a
     * build it cannot finish (agent-tools.ts); everything downstream of that
     * decision still fails loudly on its own (`sandbox-unavailable`).
     */
    available(): boolean;
    /** Create the machine from the base template, snapshot it, store the ref. Idempotent. */
    provision(appId: AppId, ctx: RunContext): Promise<AppDocument>;
    /** Resume the stored snapshot; concurrent wakes coalesce to one machine. */
    wake(appId: AppId, ctx: RunContext): Promise<SandboxMachine>;
    /** Snapshot the live machine, store the new ref, stop it. No-op when not awake. */
    sleep(appId: AppId, ctx: RunContext): Promise<AppDocument>;
    /**
     * execution-v2 Wave 3 — send one edit instruction to the IN-BOX agent of
     * an already-graduated app: wake the box, re-inject the current env, run
     * the agent, and on success sync schedules + the egress declaration and
     * snapshot. On failure the box is discarded and the app rolls back to its
     * pre-edit snapshot. This edits the SERVER only; graduation (runtime.edit)
     * is what also lands the tree's fn: bindings.
     */
    editApp(appId: AppId, instruction: string, ctx: RunContext): Promise<MachineEditResult>;
    /** Destroy the sandbox and clear the document's machine field (de-graduation). */
    destroy(appId: AppId, ctx: RunContext): Promise<AppDocument>;
    /**
     * Wave 7 H2 — the embed surface's keepalive: one cheap HEAD through the
     * idle-tracked machine wrapper, so user activity on an embedded served
     * app counts as machine activity (re-arms the idle timer and rides any
     * provider TTL extension). A sleeping machine wakes and reports "woke" —
     * the embed's signal that its URL is stale and it should re-open once
     * awake. Viewer-scoped, like `serve`: a keepalive for an embed someone was
     * shared is theirs to send, and it grants no more than seeing the app does.
     */
    ping(appId: AppId, ctx: RunContext): Promise<{ state: "awake" | "woke" }>;
    /**
     * Re-read the box's `vendo.json` and fold its `schedules` into the app's
     * doc triggers (manifest-triggers.ts): each declaration becomes a schedule
     * trigger running `fn:<name>`, armed through the arming seam and fired by
     * the automations tick — the ONE scheduler. Editor-scoped, like every other
     * edit: re-reading a shared app's manifest is part of editing it. Called
     * automatically after a box server-edit; exposed because a manifest edited
     * inside the box (an agent session, a layer-3 app) has no other way in.
     */
    syncManifest(appId: AppId, ctx: RunContext): Promise<ManifestTriggerSync>;
    /** Dev-only reporting for the doctor: which apps carry a machine, whether
     *  they are awake, and what their manifests schedule. */
    report(): Promise<AppMachineStatus[]>;
  };
  /**
   * ENG-345 — additive guarded per-secret in-sandbox exposure surface (same
   * additive precedent as `inClient`/`pins`, not part of the frozen §1 method
   * table). Option B (handles + egress substitution) stays the default; this is
   * the exception path, off by default, per-secret × per-app, OWNER-ONLY, and
   * gated by the guard's existing high-risk approval flow. The grant NEVER
   * travels with a copy: it lives in its own store collection keyed by the app
   * id, so exportApp/importApp/fork/share/publish (all of which mint or copy a
   * fresh app id) can never carry it. Requires a docs/contracts/06-apps.md §4.3
   * amendment (parked, Yousef-gated).
   */
  secrets: {
    /** Current in-sandbox status of every declared secret for one app (owner-only). */
    exposure(appId: AppId, ctx: RunContext): Promise<SecretExposureState[]>;
    /**
     * Flip one secret's in-sandbox exposure. Turning ON routes through the
     * guard's high-risk approval flow and returns `pending-approval` until the
     * owner decides it; turning OFF reverts to handles immediately.
     */
    setExposure(
      input: { appId: AppId; secretName: string; expose: boolean },
      ctx: RunContext,
    ): Promise<SetExposureResult>;
  };
}
