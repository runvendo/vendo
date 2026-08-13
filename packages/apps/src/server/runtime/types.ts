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
  AppId,
  ApprovalId,
  ApprovalRequest,
  FilesAdapter,
  Guard,
  IsoDateTime,
  Json,
  PlacementEntry,
  RiskLabel,
  RunContext,
  SecretsProvider,
  StoreAdapter,
  StoreOps,
  ToolCall,
  ToolOutcome,
  ToolRegistry,
  ToolSemantics,
  Trigger,
  UIPayload,
  VendoViewPart,
  WorkspaceFs,
} from "@vendoai/core";
import type {
  AppDocument,
  BriefingPack,
  NormalizedCatalog,
  ScreenAssembler,
  VendoTheme,
  WireCompileResult,
  AppFloor,
} from "../../contract/index.js";
import type { LanguageModel } from "ai";
import type { ScreenToolchain } from "../checking/toolchain.js";
import type { Check, Finding } from "../checking/types.js";
import type { CloudAppsClient, PublishRecord, ShareSnapshot } from "../persistence/cloud.js";
import type { GenerationDependencies } from "../generation/engine.js";
import type { BuildMachineEnv, LifecycleClock } from "../escalation/machine-lifecycle.js";
import type { AppMachineStatus } from "../escalation/manifest-triggers.js";
import type { InClientApproval } from "../remix/inclient.js";
import type { SeedBaseline, SeedDrift } from "../../contract/index.js";
import type { RemixRejection, ReviewQueueEntry } from "../remix/review.js";
import type { SandboxAdapter } from "../escalation/sandbox.js";
import type { ShipDiff } from "../remix/ship-diff.js";
import type { SlotRegistry } from "../persistence/slots.js";

/** 06-apps §1 plus block-plan decisions 3–4. */
export interface AppsConfig {
  store: StoreAdapter;
  /**
   * The deployment's 35-op store surface, when it has one. App data goes
   * through its `appData` family so every row is stamped with the live
   * caller's subject and every read is scoped to it. Absent — a store that
   * offers neither its own ops nor a SQL handle — app data falls back to the
   * raw `store` façade collections, unowned, exactly as it landed before.
   */
  ops?: StoreOps;
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
   * Build contract §9.2–§9.4 — `can()` over whatever store the host wired (the
   * umbrella composes it at the composition seam). OSS and NEVER
   * key-conditional: with no key no grant row can exist, so it degenerates to
   * ownership.
   *
   * Unset ⇒ ownership only, exactly today's behavior.
   */
  appAccess?: AppAccess;
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
  /**
   * The AI reviewer's own seat — the FAST pick, when composition resolved one.
   *
   * The reviewer is the one check that spends a model call, and what it does is
   * read a finished screen against its own rows. That is not the job the
   * flagship is for, so the umbrella fills this with the family fast model
   * (`resolveModels`' `fill` seat) and the reviewer stops riding the writer's
   * seat. Unset — a host composing this block itself — and it rides
   * {@link AppsConfig.model}, exactly as it always did.
   */
  reviewModel?: LanguageModel;
  /** The island smoke-render gate (on unless explicitly `false`): every
   *  generated island renders once headless before it can reach a screen. */
  pipeline?: GenerationDependencies["pipeline"];
  /** The host's own checks over a generated app (`Check` is `@vendoai/core`'s —
   *  a pack is authorable without depending on this block). APPENDED
   *  to the built-in fact checks and the reviewer — a host can add findings,
   *  never remove or replace a built-in one. */
  checks?: readonly Check[];
  /** The composition-normalized catalog (01 §14): derived schemas included.
   *  The provider (function) form of theme/semantics below is resolved lazily
   *  per create/edit (in generationDependencies), never eagerly, so the
   *  umbrella can back it with a first-request cloud read without doing I/O at
   *  compose time. */
  catalog: NormalizedCatalog;
  /** The host's brand, for the SERVED-app handoff alone: a machine-served app
   *  is themed through the `?vendoTheme=` query param the proxy forwards
   *  (runtime-context.ts). What a WRITER is told about the brand rides
   *  {@link briefing} with everything else it must know. */
  theme?: VendoTheme | (() => VendoTheme | undefined);
  secrets?: SecretsProvider;
  /**
   * THE briefing pack — everything a writer is told about the product, in one
   * slot because there is one assembly point (`compose-surfaces.ts`) and both
   * rungs must receive the same bytes. It was three slots across two packages,
   * which is how the box ended up knowing nothing about the brand and the
   * screen agent never saw `.vendo/brief.md`.
   *
   * Per call and ctx-taking, exactly as `toolShapeBrief` is: the design rules
   * re-resolve per generation and the shape card is projected for THIS caller.
   * Unset, a writer is told nothing about the host — which is what an apps
   * runtime composed without the umbrella already was.
   */
  briefing?: (ctx: RunContext) => Promise<BriefingPack>;
  seedBaselines?: SeedBaseline[];
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
   * ADAPTER SLOT — what compiles, type-checks and paints a component screen.
   *
   * The screen gauntlet's three machines (esbuild, the `typescript` package, the
   * QuickJS build) behind one interface, because they are the only part of
   * checking a screen that cannot run in every venue: a deployment whose checks
   * happen where none of the three is reachable fills this and every other stage
   * runs unchanged. Explicitly passed always wins; unset is this process's own,
   * which is exactly what checking did before the slot existed.
   */
  toolchain?: ScreenToolchain;
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
  /** Additive 06 §8 drift report: the host component this app was seeded from
   * fork. Present on every edit result over a drifted app so drift is loud at
   * edit time, not only in sync output or the ship-diff. */
  seedDrift?: SeedDrift;
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

/**
 * What a create build's server lane produced, handed to the caller through
 * `onServerWork` — the create-path counterpart of the fields {@link EditResult}
 * has carried for an escalated edit since Wave 9 (#881: the create door used
 * to drop the envelope on the floor, so a first-ask automation never raised a
 * card and its pending grants were invisible). `failed` carries the sentences
 * the failure-only signal used to carry as `reasons`.
 */
export interface CreateServerWork {
  automation?: EditResult["automation"];
  /** The box wrote real server code for this app (layer 2 or 3). */
  graduated?: boolean;
  /** Caller-facing sentences: refused surface flips, arming issues. */
  issues?: string[];
  /** The plan REQUIRED server work that could not be built. The app still
   *  stands as its tree — this says what it stands without. */
  failed?: string[];
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
 * The ✦ gesture's input. The seed itself is DETERMINISTIC — the engine copies
 * the captured baseline into the seeded seat with no model call — so `component`
 * names the captured host component and `slot` is the placement the gesture came
 * from. An `instruction` then rides the ORDINARY edit path on the new app.
 */
export interface SeedFromInput {
  component: string;
  slot?: string;
  instruction?: string;
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

/** One slot's answer. The CLIENT reads it off the wire too, so the shape itself
 *  lives in core. */
export type { PlacementEntry };

/**
 * What the automation door answers. A failure is a LIST of sentences, not a
 * throw: an app whose automation could not be planned still stands, exactly as
 * it did when this ran as a rung of the escalation ladder.
 */
export type AutomationAuthorResult =
  | { ok: true; document: AppDocument; triggerId: string; armed: boolean }
  | { ok: false; issues: readonly string[] };

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
    /** Called when the build's plan declared server work, with what the lane
     *  produced ({@link CreateServerWork}): the authored automation envelope,
     *  arming/flip issues, or — in `failed` — the sentences for required
     *  server work that could not be built (without which a half-built app
     *  reports a plain success; a live empty app was declared complete that
     *  way). Absent or never called, the create was screen-only. The agent
     *  bridge publishes the automation card and the honest caveat from this,
     *  exactly as it does for {@link onUnsaved} — the create still resolves
     *  with the document itself. */
    onServerWork?: (work: CreateServerWork) => void;
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
   * The same job for a COMPONENT screen (`app.tsx`): the row that makes a written
   * file an app, and the screen itself as that app's stored source.
   *
   * The two halves {@link AppsRuntime.authored} does are two different halves here.
   * A wire document is stored and its queries are resolved by the same call; a
   * screen's queries were run by the gauntlet that rendered it, and the paint
   * carries their answers (`ComponentPaintResult.interactive`), so there is nothing
   * left to resolve and no data to hand back — but the screen is the app's own
   * FILE, so storing it is this call's job rather than
   * {@link AppsRuntime.commitSource}'s. The generic workspace diff cannot tell a
   * passing screen from a refused one, and a screen the floor would not render must
   * never become the app's stored screen.
   *
   * The CALLER differs too. A wire save's app half is the render seam's
   * `authoredApp`; the seam has no such call for `app.tsx`, so the checks floor
   * calls this from the one place that knows the screen really painted — the
   * gauntlet's own `ok`, which is the seam's paint gate. That keeps "a paint is
   * what creates the row" true for both artifacts, which is exactly what `create`
   * reads the row's existence AS (`NOTHING_RENDERABLE`).
   *
   * Every save that paints, not only the first: a re-save lands through the same
   * versioned write `app.vendo` does, so a component app's edits sit on its history
   * under the person's own words like any other artifact's.
   */
  authoredScreen(input: { appId: AppId; name: string; source: string }, ctx: RunContext): Promise<void>;
  /**
   * Why a painted screen's save left no row — {@link AppsRuntime.authoredScreen}'s
   * opposite half, called from the gauntlet's every `ok: false`.
   *
   * A refusal at the paint seam reaches no user-facing channel by design: the seam
   * emits nothing and the last good view stays on screen. When the refused save was
   * an EDIT's, this is that edit's answer — the row still holds the pre-edit
   * document, so the assembler reading it back would report an unchanged app as the
   * change.
   *
   * No ctx: a refusal writes no row. It records why this app's in-flight edit
   * failed, which is app-keyed and in memory (`editRefusals`).
   */
  refusedScreen(input: { appId: AppId; blocking: readonly string[] }): Promise<void>;
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
   *
   * `saves: false` asks for the same five-stage gauntlet with the ROW HALF off —
   * no `authoredScreen`, no `refusedScreen`. `open()` needs it: a component
   * screen's tree is what rendering it produces, so opening one paints it, and a
   * paint that is a READ must never write. It is not a hypothetical — a
   * review-kind app serving an older APPROVED snapshot (`serveDocFor`) paints
   * that snapshot, so a writing floor stored it straight back over the row and
   * the pending version the reviewer was looking at ceased to exist.
   */
  floor(ctx: RunContext, options?: { saves?: boolean }): AppFloor;
  /**
   * What every tool a binding may name really RETURNS, annotated with this
   * host's own field semantics — the `:money.cents`, `:date.iso`, `:enum(a|b)`
   * marks that decide whether a number is dollars or cents on screen.
   *
   * A documented host seam (`.vendo/semantics.json` plus the cloud-owned
   * overrides) that used to reach the model through the fill worker's query
   * brief and nowhere else. The fill worker is gone, so this is how the
   * annotations reach the one thing that writes bindings now. It is the
   * `hostSemantics` half of the briefing pack composition assembles, so both
   * rungs read one rendering of it — this block depends on `core` alone and
   * cannot reach a harness.
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
   * The slot REGISTRY — which slots this caller's surfaces mount, as opposed to
   * which app sits in one (`placements` above).
   *
   * Written by the surfaces themselves: a slot exists because a page renders
   * it, so every render reports it and the read ages out whatever stopped being
   * reported (slots.ts). Nothing else can know the list — a slot is a prop on a
   * host's own component, invisible to the server until it renders.
   */
  slots: SlotRegistry;
  /** Build contract §9.3 — what level the CALLER holds. */
  access: {
    /** The caller's own level, or null when they cannot see the app at all —
     *  what the surface reads to decide between "Edit" and the fork offer. */
    levelFor(appId: AppId, ctx: RunContext): Promise<AccessLevel | null>;
  };
  edit(appId: AppId, instruction: string, ctx: RunContext): Promise<EditResult>;
  /**
   * Automation authoring, its own small door — OFF the escalation ladder.
   *
   * "Run this every morning" is not an escalation: it needs no machine and no
   * sandbox, and it used to travel the rung built for work that does. The
   * planner, the trigger-id rules, the results-board rewire and the arming are
   * unchanged; only the way in is.
   */
  automation: {
    author(
      input: { appId: AppId; instruction: string; mode: "steps" | "agentic" },
      ctx: RunContext,
    ): Promise<AutomationAuthorResult>;
  };
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
   * The capped version log.
   *
   * Build contract §9.3 — this takes the ctx (06 §1's `history(appId)` widened
   * by the wave-3 ruling): `list` needs `viewer`. Without the ctx here the only
   * boundary would be the wire route — and one door is not a boundary.
   */
  history(appId: AppId, ctx: RunContext): { list(): Promise<VersionEntry[]> };
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
    approve(input: { appId: AppId; approvedBy: string }, ctx: RunContext): Promise<InClientApproval>;
  };
  /**
   * Remix final shape (2026-08-02) — additive review-kind lifecycle surface
   * (same additive precedent as `inClient`/`seed`). A review-kind remix (an
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
   * 06-apps §8 — additive remix surface (same additive precedent as `inClient`,
   * not part of the frozen §1 method table).
   *
   * `from` is the ✦ gesture: capture → bundle → an ordinary `create` carrying a
   * `seed`. `drift` reports that the host component this app was seeded from has
   * moved on — a WARNING, nothing more. `reseed` acts on it by swapping in the
   * pristine new component and minting a version.
   *
   * A re-seed REPLACES the seeded component, including whatever the person has
   * changed about it. That is why it is never automatic and why the surface that
   * offers it has to say what it costs.
   */
  seed: {
    drift(appId: AppId, ctx: RunContext): Promise<SeedDrift | null>;
    reseed(input: { appId: AppId }, ctx: RunContext): Promise<AppDocument>;
    from(input: SeedFromInput, ctx: RunContext): Promise<AppDocument>;
  };
  /**
   * execution-v2 — additive machine lifecycle surface (same additive precedent
   * as `inClient`/`seed`). An app with no `machine` on its document
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
    /** Dev-only reporting for the doctor: which apps carry a machine, whether
     *  they are awake, and what their manifests schedule. */
    report(): Promise<AppMachineStatus[]>;
  };
}
