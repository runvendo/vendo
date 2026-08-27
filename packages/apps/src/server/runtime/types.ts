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
  AppGrantRecord,
  AppId,
  ApprovalId,
  ApprovalRequest,
  AutomationId,
  AutomationRecord,
  AutomationTask,
  CreateAutomation,
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
  UIPayload,
  VendoViewPart,
  WorkspaceFs,
} from "@vendoai/core";
import type {
  AppBuilder,
  AppDocument,
  AppListRow,
  BriefingPack,
  NormalizedCatalog,
  PendingSurface,
  ScreenAssembler,
  VendoRouteMap,
  VendoTheme,
  AppFloor,
} from "../../contract/index.js";
import type { LanguageModel } from "ai";
import type { ScreenToolchain } from "../checking/toolchain.js";
import type { Check, Finding } from "../checking/types.js";
import type { CloudAppsClient, PublishRecord, ShareSnapshot } from "../persistence/cloud.js";
import type { GenerationDependencies } from "../generation/engine.js";
import type { SeedBaseline, SeedDrift } from "../../contract/index.js";
import type { SlotRegistry } from "../persistence/slots.js";

/**
 * What this block may ask of the automations engine — four verbs, no more.
 *
 * An automation is a PRINCIPAL's own record and carries no app reference of any
 * kind; an app may hold a list of automation ids, and that list is maintained
 * here and read nowhere else. Which is why {@link AutomationsSeam.resolve} drops
 * an id nothing answers for instead of failing: the list is a list of names, not
 * a foreign key, so deleting an automation is simply one fewer entry the next
 * time the app is read, and deleting the APP leaves the automation firing — it
 * fails loudly at tool resolution, in the run ledger, which is the designed
 * behavior and not a thing to guard against.
 */
export interface AutomationsSeam {
  /** THE one create operation — the same one `agent.on` and `vendo_automate`
   *  call. An input carrying an `id` that is already stored REPLACES it, which
   *  is what makes a redeploy and a re-synced manifest idempotent. */
  create: CreateAutomation;
  /** `automations.enable` — the 07 §3 grant-capture flow. `missing` is what the
   *  owner still has to allow before an away run can complete unattended. */
  enable(
    id: AutomationId,
    ctx: RunContext,
    options?: { armedBy?: ToolCall },
  ): Promise<{ enabled: boolean; missing: ApprovalRequest[] }>;
  /** The kill switch (`automations.disable`). */
  disable(id: AutomationId, ctx: RunContext): Promise<void>;
  /** The records these ids still name, dead ids dropped. */
  resolve(ids: readonly AutomationId[], ctx: RunContext): Promise<AutomationRecord[]>;
}

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
   * state spread onto the open payload. It takes the RunContext so a per-caller
   * decision stays per-caller, not per-document: a state served only to callers
   * with `can(editor)` is decided here, never baked into the document. Returned
   * keys spread onto the payload; the reserved keys (`inClient`, `data`,
   * `seedDrift`, `seedUnapplied`, `dataUnavailable`) are skipped (open.ts).
   */
  venueState?: (app: AppDocument, ctx: RunContext) => Promise<Record<string, unknown> | undefined>;
  /**
   * The automations seam (the same seam pattern as AutomationsConfig.runner:
   * this block never imports the automations engine, and the engine has no app
   * concepts to import back — the two meet on the types `@vendoai/core` owns).
   *
   * Unset ⇒ no engine is composed: an app is still built and stored, and an ask
   * that wanted a schedule is told so rather than being told one runs.
   */
  automations?: AutomationsSeam;
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
   * (`resolveModels`' `review` seat) and the reviewer stops riding the writer's
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
  /** The pages a generated `<Link to>` may name (`CreateVendoConfig.routes`),
   *  for the FLOOR: a screen naming a route the host never registered is refused
   *  at generation, not left to render as dead text. What a WRITER is told about
   *  them rides {@link briefing}, like everything else it must know. */
  routes?: VendoRouteMap;
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
   * FINAL SPEC v1 — the build engine, for the ask a screen cannot serve. The
   * screen agent's `escalate` is the only thing that reaches it, and only after
   * the person has answered the standing card.
   *
   * An ADAPTER SLOT for the same reason `screen` is: the lane runs a coding
   * agent inside a disposable box, which this block does not hold. Unfilled,
   * an escalation is answered with a failed receipt naming the missing sandbox
   * rather than a promise of a build nothing can run.
   */
  build?: AppBuilder;
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
}

/** 06-apps §1 */
export interface EditResult {
  app: AppDocument;
  version: VersionEntry;
  /** What the assembling agent SAID when it finished this edit — its own closing
   *  words, verbatim (`ScreenOutcome.say`), which `vendo_make` puts in the
   *  receipt's `say`. Absent when the run said nothing; the door falls back. */
  say?: string;
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
   * Set when this edit authored an automation: the RECORD the create operation
   * minted (owned by the caller, carrying no reference back to this app), with
   * its id appended to the app's own `automations` list. No machine is involved.
   * `resultsCollection` names the app records collection the automation writes
   * displayable results into (the rows the tree queries). `pendingGrants` carries
   * the standing-grant approvals the enable flow parked — approving them lets
   * away runs complete unattended.
   */
  automation?: {
    record: AutomationRecord;
    /** What ARMING actually produced — false when the seam left it disarmed or
     * arming threw (the issues entry says why). The thread's automation card
     * needs the true state, not an inference. */
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
  /** A SEALED bundle. `entry` is the content hash of the file the frame boots,
   *  so it is both the address to fetch and the frame's remount key. */
  | { kind: "bundle"; entry: string }
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
 * The ✦ gesture's input. There are no bare forks: `component` names the captured
 * host component and `instruction` is what the person asked for, which the
 * gesture collects BEFORE it fires. `slot` is the placement the gesture came
 * from.
 */
export interface SeedFromInput {
  component: string;
  slot?: string;
  instruction: string;
}

/**
 * What a files-first save answers with: the resolved query data for the tree it
 * stored, and — when a query FAILED to resolve — the honest marker that says so.
 * Without the second half the seam could only tell the truth about a whole app
 * half that THREW, and a query that answered "error", "blocked" or
 * "connect-required" would render "—" everywhere and read as "you have no data"
 * (see `dataUnavailable` below).
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
  | { ok: true; document: AppDocument; record: AutomationRecord; armed: boolean }
  | { ok: false; issues: readonly string[] };

/** 06-apps §1 */
export interface AppsRuntime {
  create(input: {
    prompt: string;
    /**
     * The id this build must use, when the caller already minted one.
     *
     * The front door mints before it routes to the screen agent (§4.5): the
     * screen agent's files live at `/user/apps/<appId>/` and its paints ride
     * `vendoViewStreamId(appId)`, so a conductor that minted its own id would
     * paint the finished app onto a SECOND stream. Absent — every caller but the
     * front door — one is minted here.
     */
    appId?: AppId;
    /**
     * §4.5 — the escalating screen agent already ran, and this is its one line
     * about why assembly could not serve the ask.
     *
     * Its presence is also what says "do not assemble again": the front door
     * routes through the screen agent before it calls this, so a `create` that
     * re-routed would run a second full agent — two model bills for one ask.
     * Absent, this door starts where every other caller does: in the screen agent.
     */
    why?: string;
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
   * versioned write every screen does, so a component app's edits sit on its history
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
   * the one place that sees every write to `app.tsx`, whoever made it. Handing it
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
   * paint that is a READ must never write — otherwise a reopen would store its
   * paint straight back over the row.
   */
  floor(ctx: RunContext, options?: { saves?: boolean }): AppFloor;
  /**
   * The source a RE-SEED's replay must start from, or nothing — and it is gone
   * once read.
   *
   * Public for the same reason `authoredScreen` and `commitSource` are: the hand
   * that has to act on it is not in this package. A re-seed replays the recorded
   * wish onto the host's NEW port, and only the assembler holds a workspace to
   * put that port in front of the model. This block never paints it into the row
   * — the replay's own save is the single landing, so a replay that does not land
   * leaves the person's screen untouched.
   *
   * Empty except during a re-seed's own replay, and emptied by the read. An
   * ordinary edit never publishes one, so it can never take one.
   */
  takeReplaySource(appId: AppId): string | undefined;
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
  list(ctx: RunContext): Promise<AppListRow[]>;
  delete(appId: AppId, ctx: RunContext): Promise<void>;
  fork(appId: AppId, ctx: RunContext): Promise<AppDocument>;
  /**
   * Arrival (2026-08-17) — mark this app seen BY THIS CALLER, so the launcher's
   * quiet dot stops pointing at it. Idempotent, and viewer-scoped: being able to
   * see the app is the whole act being recorded.
   *
   * Called by the one route a PERSON's render comes through (`GET /apps/:id/open`,
   * wire/apps.ts). Deliberately not called by `open` itself: an agent reading a
   * tree over MCP and an automation resolving a surface both go through that
   * door, and neither is anybody looking at a screen.
   */
  seen(appId: AppId, ctx: RunContext): Promise<void>;
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
   * Two sources, merged on read (slots.ts). A REPORTED slot is written by the
   * surface itself: it exists because a page renders it, so every render
   * reports it again and the read ages out whatever stopped being reported. A
   * DECLARED slot comes from the host's `slots` config — it never decays and
   * needs no render, which is the only thing an agent-only product, where no
   * page of ours renders a <VendoSlot>, has to pin to. Declared wins: a
   * reported slot of the same id is dropped.
   */
  slots: SlotRegistry;
  /** Build contract §9.2–§9.3 — what level the CALLER holds, and the grant
   *  writes the ✦ share toggle needs. `list` is viewer-scoped (reading who
   *  else can reach an app you can see); grant/revoke are owner-scoped. Every
   *  write answers with the resulting list, so a surface never makes a second
   *  round trip to learn what it just did. */
  access: {
    /** The caller's own level, or null when they cannot see the app at all —
     *  what the surface reads to decide between "Edit" and the fork offer. */
    levelFor(appId: AppId, ctx: RunContext): Promise<AccessLevel | null>;
    list(appId: AppId, ctx: RunContext): Promise<AppGrantRecord[]>;
    grant(appId: AppId, principal: string, level: AccessLevel, ctx: RunContext): Promise<AppGrantRecord[]>;
    revoke(appId: AppId, principal: string, ctx: RunContext): Promise<AppGrantRecord[]>;
  };
  edit(appId: AppId, instruction: string, ctx: RunContext): Promise<EditResult>;
  /**
   * Automation authoring, its own small door — OFF the escalation ladder.
   *
   * "Run this every morning" is not an escalation: it needs no machine and no
   * sandbox, and it used to travel the rung built for work that does.
   */
  automation: {
    author(
      input: { appId: AppId; instruction: string; mode: AutomationTask["kind"] },
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
   * `landed` is the other half of an `ask` on a REMIX, and only there: the wish
   * list replays on every Update, so only a change that reached the screen
   * belongs on it. The ask itself is recorded either way.
   *
   * There is deliberately no second row-write door for this. Every caller —
   * `vendo_make`'s create arms, its edit arm, the screen assembler's decisions —
   * comes through here, which is also the one place the `editor` level is
   * checked. A caller treats a rejection as a non-event: memory is never worth
   * failing a make over.
   */
  remember(
    input: { appId: AppId; ask?: string; decisions?: string; landed?: boolean },
    ctx: RunContext,
  ): Promise<void>;
  /**
   * The capped version log.
   *
   * Build contract §9.3 — this takes the ctx (06 §1's `history(appId)` widened
   * by the wave-3 ruling): `list` needs `viewer`. Without the ctx here the only
   * boundary would be the wire route — and one door is not a boundary.
   */
  history(appId: AppId, ctx: RunContext): { list(): Promise<VersionEntry[]> };
  /**
   * `pending` opts into the build window's additive half: an app whose build is
   * still in flight answers `{kind:"pending"}` — carrying the forming tree's
   * GEOMETRY when it has one (see `createAppOpener`) — instead of the not-found
   * every other caller gets. The pending kind is reachable only through it.
   */
  open(appId: AppId, ctx: RunContext, options?: { pending?: boolean }): Promise<OpenSurface | PendingSurface>;
  /**
   * FINAL SPEC v1 — the other half of a `{kind:"bundle"}` open: the sealed file
   * named by `hash`, wrapped in the document the frame renders it as. Served
   * behind {@link BUNDLE_CSP} (doors/build-door.ts), and viewer-scoped like
   * every other read of an app.
   */
  bundleDocument(appId: AppId, hash: string, ctx: RunContext): Promise<Uint8Array>;
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
   * and findings read as "your screen is wrong". Only the second one gets fixed.
   * `appId` names what is stored — a screen has already passed its paint gate to
   * BE stored, so there is nothing else to check.
   *
   * `request` is the person's ask, verbatim, when the caller has it. The reviewer
   * judges two of its five things against it — a section nobody asked for, work
   * quietly dropped — and without it those rules read against nothing and can
   * never fire. Absent is the caller saying it has no ask to hand over, which is
   * what a bare verb call is: the checks that read it treat that as "no
   * carve-out", the conservative direction.
   *
   * `viewport` is the surface the screen renders into, in CSS pixels, when the
   * caller knows it — the same fact the writer was told. Given, the reviewer is
   * shown the screen's FIRST PAINT in order, framed by those pixels, so a table
   * below the fold and a step behind a click stop reading like content on screen.
   * Absent, the reviewer's prompt is byte for byte the one it always was: a paint
   * with no surface to measure it against is a frame the reader would have to
   * guess.
   */
  validate(
    input: { appId?: AppId; request?: string; viewport?: { width: number; height: number } },
    ctx: RunContext,
  ): Promise<{ ok: boolean; findings: Finding[] }>;
  /**
   * Design §4's `schedule` verb: set or change WHEN an app's automation runs.
   *
   * Only a cron change, and only on an app whose list already names a scheduled
   * automation — authoring one from nothing is `edit`'s job, because it needs a
   * task. The change goes through the SAME create operation under the record's
   * own id, so there is no second write path, and enable re-runs the 07 §3
   * grant-capture flow: missing standing grants come back on `missing` rather
   * than failing silently at the first firing.
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
   * 06-apps §8 — additive remix surface (not part of the frozen §1 method
   * table).
   *
   * `from` is the ✦ gesture: fork and first edit as ONE operation, producing an
   * ordinary screen app that carries a `seed`. `drift` reports that the host
   * component this app was seeded from has moved on — a WARNING, nothing more.
   * `reseed` acts on it by replaying the recorded instruction against the host's
   * new baseline.
   *
   * A re-seed REBUILDS the remix, so whatever the person has changed since is
   * gone. That is why it is never automatic and why the surface that offers it
   * has to say what it costs.
   */
  seed: {
    drift(appId: AppId, ctx: RunContext): Promise<SeedDrift | null>;
    reseed(input: { appId: AppId }, ctx: RunContext): Promise<AppDocument>;
    from(input: SeedFromInput, ctx: RunContext): Promise<AppDocument>;
    /**
     * The COURIER: the live props of the host instance this remix stands in for,
     * shipped by the `<Remixable>` wrapper on mount and on every change.
     *
     * A ported screen renders from its props, and no prop is in any source it
     * could read — so without this the floor paints it on the baseline's frozen
     * `sampleProps` and the remix shows the sync-time number forever. It writes
     * `AppSeed.props` and NOTHING else: this is provenance about the call site,
     * never a content edit, so it mints no version and replays no wish.
     *
     * Filtered here to the captured baseline's own declared prop names — a prop
     * the host component never declared is dropped before it is stored.
     */
    props(input: { appId: AppId; props: Record<string, Json> }, ctx: RunContext): Promise<AppDocument>;
  };
  /**
   * FINAL SPEC v1 — the built-app door.
   *
   * `propose` is the only route to a build box, and it never opens one: it
   * raises the standing approval card and returns, so the turn that asked ends
   * having spent nothing. The person's yes — whenever it lands, possibly long
   * after that turn is gone — is what starts the build, through the
   * `onApprovalDecision` seam (persistence/approval-flow.ts).
   */
  build: {
    /** Can this deployment build at all — i.e. is a sandbox adapter composed?
     *  The ONE gate, so the front door can answer an escalation honestly before
     *  it asks for consent it could not act on. */
    available(): boolean;
    propose(
      input: { appId: AppId; name: string; prompt: string; why: string },
      ctx: RunContext,
    ): Promise<{ approvalId: ApprovalId } | { declined: string }>;
  };
}
