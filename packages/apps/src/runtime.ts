import {
  VENDO_APP_BUILD_FAILED_PREFIX,
  VENDO_TREE_FORMAT_V2,
  VendoError,
  checkBindingShapes,
  deriveShapeCard,
  safeErrorMessage,
  validateAppDocument,
  type AppDocument,
  type AppId,
  type DomainManifest,
  type Guard,
  type IsoDateTime,
  type Json,
  type NormalizedCatalog,
  type RunContext,
  type ApprovalId,
  type ApprovalRequest,
  type RiskLabel,
  type SecretsProvider,
  type ShapeType,
  type StoreAdapter,
  type ToolCall,
  type ToolDescriptor,
  type ToolOutcome,
  type ToolSemantics,
  type TreeV2,
  type ToolRegistry,
  type Trigger,
  type UIPayload,
  type VendoViewPart,
  type VendoTheme,
  type VendoRecord,
} from "@vendoai/core";
import type { LanguageModel } from "ai";
import { createAgentTools } from "./agent-tools.js";
import { createAppData } from "./app-data.js";
import { appLifecycleEvent } from "./audit.js";
import { createAppCaller } from "./call.js";
import { createParkedActions } from "./parked-action.js";
import type {
  CloudAppsClient,
  PublishRecord,
  ShareSnapshot,
} from "./cloud.js";
import {
  applyPinFork,
  distinctIssues,
  instructionRequiresServedApp,
  modelEngine,
  prewarmModels,
  serverWorkRung,
  type GenerationDependencies,
  type GenerationEngine,
} from "./engine.js";
import { planAutomation } from "./automation-plan.js";
import { createAppHistory } from "./history.js";
import { createInClientApprovals, type InClientVerdict } from "./inclient.js";
import { createAppInterchange } from "./interchange.js";
import {
  createMachineLifecycle,
  type BuildMachineEnv,
  type LifecycleClock,
} from "./machine-lifecycle.js";
import { createFnCaller } from "./fn.js";
import {
  pushBoxEnv,
  readBoxManifest,
  requestAppWithBootRetry,
  runBoxEdit,
  type BoxEditResult,
} from "./box-agent.js";
import { parseVendoManifest } from "./manifest.js";
import { createAppOpener, createProgressiveQueryResolver, machinesDisabledError, servedAppsDisabledError, stripServerAuthoritativeFields } from "./open.js";
import { appRecordInput, documentFromRecord, enabledAfterDocumentEdit, listAllRecords, nextEnvStaleAt, rowFromRecord, updateAppRow } from "./persistence.js";
import { detectPinDrift, hasDefaultExport, pinComponentName, pinForkSource, type InClientApproval, type PinBaseline, type PinDrift } from "./pins.js";
import { collectSecretValues, redactSecretJson, redactSecretText } from "./redaction.js";
import {
  boxAllowlist,
  createEgressApprovals,
  normalizeEgressDomain,
  unapprovedEgress,
} from "./egress-approval.js";
import {
  createScheduleEngine,
  type AppScheduleState,
  type AppScheduleStatus,
  type ScheduleTickReport,
} from "./schedules.js";
import { createSecretExposure, type SecretExposureGrant } from "./secret-exposure.js";
import { computeShipDiff, type ShipDiff } from "./ship-diff.js";
import { appVersionHash } from "./version-hash.js";
import type { SandboxAdapter, SandboxMachine } from "./sandbox.js";

/** 06-apps §1 plus block-plan decisions 3–4. */
export interface AppsConfig {
  store: StoreAdapter;
  guard: Guard;
  tools: ToolRegistry;
  /**
   * execution-v2 — machine lifecycle seams. `sandbox` is the v2 adapter
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
   * execution-v2 Wave 4 — the layer-3 (machine serves the app surface)
   * experimental opt-in. OFF by default: layer-3 generation, the 2→3 surface
   * flip, and open() on a served app all refuse with a typed VendoError naming
   * this flag. The host enables it per project
   * (`createVendo({ apps: { experimentalServedApps: true } })`).
   * Layer 3 is a machine surface, so this flag REQUIRES
   * {@link AppsConfig.experimentalMachines}; createApps refuses the
   * combination `experimentalServedApps` without `experimentalMachines`.
   */
  experimentalServedApps?: boolean;
  /**
   * execution-v2 Wave 9 — the layer-2 (machine-backed execution) experimental
   * opt-in, gating ALL of the box machinery for NEW graduation: machine
   * provisioning, box-agent delegation, and fn: generation targeting a new
   * machine. OFF by default: when the escalation ladder concludes only a box
   * can express a request (rung c), the create/edit refuses with a typed
   * VendoError naming this flag — NEVER a silent degrade to a broken
   * automation. Rungs (a) steps and (b) agentic automations need no machine
   * and work regardless of this flag. Apps that ALREADY carry a machine are
   * never stranded: every runtime path over an existing machine (wake, sleep,
   * fn: calls, schedules, box edits, open) keeps working with the flag off —
   * only NEW graduation/provisioning is gated.
   */
  experimentalMachines?: boolean;
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
  armAutomation?: (appId: AppId, ctx: RunContext) => Promise<{ enabled: boolean; missing: ApprovalRequest[] }>;
  model?: LanguageModel;
  /** v2 spec §4 — tier-0 paint lane knob, passed to the generation engine.
   *  `model` is the no-think switch (a thinking-disabled model instance);
   *  `disabled` forces single-lane generation. */
  paint?: GenerationDependencies["paint"];
  /** W4 pipeline knobs, passed to the generation engine: structured repair
   *  (default on), outline+region-parallel tier-2 and the end pass (opt-in). */
  pipeline?: GenerationDependencies["pipeline"];
  /** The composition-normalized catalog (01 §14): derived schemas included. */
  catalog: NormalizedCatalog;
  theme?: VendoTheme;
  secrets?: SecretsProvider;
  /** Host design rules for generation prompts; the function form is re-read
   *  per create/edit (engine.ts GenerationDependencies). */
  designRules?: string | (() => string | undefined);
  pinBaselines?: PinBaseline[];
  /** ADAPTER RULE — the share/publish seam (see cloud.ts): the umbrella wires
   * the Cloud console client when VENDO_API_KEY fills the unset slot; this
   * block never reads the environment. Unset → share/publish fail with
   * VendoError("cloud-required"). */
  cloud?: CloudAppsClient;
  /** W3 — per-tool field semantics from `.vendo/semantics.json`, passed to
   *  the generation engine (annotated shape cards, law checks, Kit format
   *  defaults). */
  semantics?: Readonly<Record<string, ToolSemantics>>;
  /** W3 — the host's domain manifest (has / has-NOT), generation fact. */
  domains?: DomainManifest;
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
   * resolution the approval embed gets from denied/expired.
   */
  | { kind: "failed"; reason: string; retryable?: boolean };

/** The non-empty name a failed build record ships under (open() ignores it —
 *  the embed's title rides the app-ref — but validateAppDocument requires one).
 *  Collapsed and capped like the pack's fast-return title. */
const fallbackAppName = (prompt: string): string => {
  const collapsed = prompt.replace(/\s+/g, " ").trim();
  if (collapsed.length === 0) return "Vendo app";
  return collapsed.length > 60 ? collapsed.slice(0, 60) : collapsed;
};

const QUOTA_SIGNAL = /quota|insufficient|payment|billing|\b402\b/i;
const TIMEOUT_SIGNAL = /time?d?\s*out|timeout|abort/i;
/** The dev-model's own no-usable-credential lines (missing provider package /
 *  no key at all). These are written by Vendo, not a provider — the ONE
 *  failure class whose full message IS the honest reason, so it surfaces
 *  verbatim instead of collapsing to "generation failed" (0.4.x E2E: the
 *  surface said {code:"validation"} while the actionable `npm install
 *  @ai-sdk/...` line landed only in the operator terminal). Anchored to the
 *  exact shapes in vendo/dev-creds so a provider error that merely mentions a
 *  key can never leak through. */
const MODEL_UNAVAILABLE_SIGNAL = /^(?:[A-Z][A-Z0-9_]* is set but @ai-sdk\/[\w-]+ is not installed in this app|Vendo found no model key)/;

/**
 * Map a generation-turn throw to the short, honest, NON-LEAKY reason persisted
 * on the failed app record. Only the CANNED reason is ever emitted — the raw
 * provider message is used solely to classify, never surfaced.
 *
 * The engine's stream helper catches provider errors and folds their message
 * into the `issues` of the terminal `VendoError("validation", "model could not
 * produce a valid app")`, so the raw 402/AbortError rarely propagates intact:
 * classify from a raw error when it does (quota/timeout/cloud-required), and
 * otherwise scan the validation issues for the same signals, defaulting to a
 * generic generation failure the user can retry.
 */
export const buildFailureReason = (
  error: unknown,
): { reason: string; retryable: boolean } => {
  if (error instanceof Error && error.name === "AbortError") {
    return { reason: "timed out", retryable: true };
  }
  const statusCode = (error as { statusCode?: unknown } | null)?.statusCode;
  if (statusCode === 402 || (error instanceof VendoError && error.code === "cloud-required")) {
    return { reason: "quota exhausted", retryable: false };
  }
  const candidates = [
    error instanceof Error ? error.message : String(error),
    ...(error instanceof VendoError && Array.isArray(error.detail)
      ? error.detail.filter((item): item is string => typeof item === "string")
      : []),
  ];
  // Vendo's own dev-model unavailable lines pass through verbatim (they are
  // the actionable fix), stripped of the engine's stream-catch prefix.
  const unavailable = candidates
    .map((candidate) => candidate.replace(/^model generation failed: /, ""))
    .find((candidate) => MODEL_UNAVAILABLE_SIGNAL.test(candidate));
  if (unavailable !== undefined) return { reason: unavailable, retryable: false };
  const text = candidates.join(" ");
  if (QUOTA_SIGNAL.test(text)) return { reason: "quota exhausted", retryable: false };
  if (TIMEOUT_SIGNAL.test(text)) return { reason: "timed out", retryable: true };
  return { reason: "generation failed", retryable: true };
};

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

/** 06-apps §1 */
export interface AppsRuntime {
  create(input: {
    prompt: string;
    /** Additive per-call stream hook used by the agent bridge. */
    onView?: (part: VendoViewPart) => void;
  }, ctx: RunContext): Promise<AppDocument>;
  /** Speed lane — best-effort page-open warm-up of the generation model(s)
   *  (full + paint), so the first create reuses a live connection. Safe to
   *  call on surface mount; never throws. */
  prewarm(): Promise<void>;
  get(appId: AppId, ctx: RunContext): Promise<AppDocument | null>;
  list(ctx: RunContext): Promise<AppDocument[]>;
  delete(appId: AppId, ctx: RunContext): Promise<void>;
  fork(appId: AppId, ctx: RunContext): Promise<AppDocument>;
  edit(appId: AppId, instruction: string, ctx: RunContext): Promise<EditResult>;
  history(appId: AppId): { list(): Promise<VersionEntry[]>; undo(): Promise<AppDocument> };
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
   * execution-v2 skin contract (Lane C) — the box door the wire's fn proxy
   * route rides: wake the app's machine on demand and proxy ONE HTTP request
   * to its $PORT (the box serves `POST /fn/<name>` per the contract; the
   * caller shapes the path). Owner-scoped like every app surface. Additive
   * like `proxy`/`inClient` — not part of the frozen §1 method table. Lane B's
   * machine lifecycle owns the wake internals behind this door.
   */
  box: {
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
     * awake. Owner-scoped like every machine surface.
     */
    ping(appId: AppId, ctx: RunContext): Promise<{ state: "awake" | "woke" }>;
  };
  /**
   * execution-v2 Wave 2 Lane D — additive BYO schedule-execution surface (same
   * additive precedent as `machine`/`box`). `tick` is what the host's
   * authenticated scheduler endpoint calls on every external-cron hit: it
   * fires due `vendo.json` schedules exactly once per cron window (see
   * schedules.ts for the store-claimed idempotency rule). `sync` is the
   * owner-scoped manifest re-read (the Wave-3 in-box agent's edit-complete
   * hook); `report` feeds the doctor's machine/schedule reporting.
   */
  schedules: {
    tick(at?: Date): Promise<ScheduleTickReport>;
    sync(appId: AppId, ctx: RunContext): Promise<AppScheduleState>;
    report(): Promise<AppScheduleStatus[]>;
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

const allRecords = (store: StoreAdapter, refs: Record<string, string>): Promise<VendoRecord[]> =>
  listAllRecords(store.records("vendo_apps"), { refs });

const rungFor = (
  app: AppDocument,
  declared?: VersionEntry["rung"],
): VersionEntry["rung"] => {
  // execution-v2 Wave 4 — a machine-served surface is layer 3 (the v2 ladder);
  // rung 4 remains only for the retired v1 `server`-backed http shape.
  if (app.ui === "http") return app.machine !== undefined ? 3 : 4;
  // execution-v2 — a machine (Wave 1 Lane B) is layer 2, exactly like the
  // retired v1 `server`; presence, never a stored rung, is the source of truth.
  if (app.machine !== undefined || app.server !== undefined) return declared === 3 ? 3 : 2;
  return 1;
};

const generationDependencies = (
  config: AppsConfig,
  model: LanguageModel,
  toolContext: Pick<GenerationDependencies, "tools" | "toolShapes">,
  onPartial?: GenerationDependencies["onPartial"],
): GenerationDependencies => ({
  model,
  catalog: config.catalog,
  theme: config.theme,
  designRules: config.designRules,
  pinBaselines: config.pinBaselines,
  ...(config.semantics === undefined ? {} : { semantics: config.semantics }),
  ...(config.domains === undefined ? {} : { domains: config.domains }),
  ...toolContext,
  ...(config.paint === undefined ? {} : { paint: config.paint }),
  ...(config.pipeline === undefined ? {} : { pipeline: config.pipeline }),
  ...(onPartial === undefined ? {} : { onPartial }),
});

/** v2 spec §1 — assemble the emitted payload: the tree plus document islands
 *  at payload level (the v2 renderer lifts them into the shared walk). */
const assembleTree = (source: {
  tree: UIPayload | TreeV2;
  components?: Record<string, string>;
  /** W4b — the stamped per-island tool manifests ride beside the sources. */
  componentTools?: Record<string, string[]>;
}): TreeV2 => ({
  ...structuredClone(source.tree),
  ...(source.components === undefined ? {} : { components: structuredClone(source.components) }),
  ...(source.componentTools === undefined ? {} : { componentTools: structuredClone(source.componentTools) }),
} as TreeV2);

const pinnedSubtree = (app: AppDocument, componentName: string): unknown[] => {
  if (app.tree?.formatVersion !== VENDO_TREE_FORMAT_V2) return [];
  const tree = app.tree as unknown as TreeV2;
  const included = new Set(tree.nodes.filter((node) => node.component === componentName).map((node) => node.id));
  const pending = [...included];
  while (pending.length > 0) {
    const id = pending.pop();
    const node = tree.nodes.find((candidate) => candidate.id === id);
    for (const child of node?.children ?? []) {
      if (included.has(child)) continue;
      included.add(child);
      pending.push(child);
    }
  }
  return tree.nodes.filter(({ id }) => included.has(id));
};

const touchedPinSlots = (previous: AppDocument, next: AppDocument): string[] => {
  const previousPins = new Map((previous.pins ?? []).map((pin) => [pin.slot, pin]));
  return (next.pins ?? []).flatMap((pin) => {
    const prior = previousPins.get(pin.slot);
    if (prior?.base !== pin.base) return [pin.slot];
    const componentName = pinComponentName(pin.slot);
    if (previous.components?.[componentName] !== next.components?.[componentName]) return [pin.slot];
    // Subtree serialization intentionally over-reports reordered nodes as touched.
    return JSON.stringify(pinnedSubtree(previous, componentName)) === JSON.stringify(pinnedSubtree(next, componentName))
      ? []
      : [pin.slot];
  });
};

/** 06-apps §1 — construct the app lifecycle, generation, execution, and interchange surface. */
export const createApps = (config: AppsConfig): AppsRuntime => {
  // Wave 9 — the experimental-flag relationship: a served (layer-3) surface
  // lives in a machine, so layer 3 cannot be enabled without layer 2. Refuse
  // the combination at composition time, loudly, instead of at first use.
  if (config.experimentalServedApps === true && config.experimentalMachines !== true) {
    throw new VendoError(
      "validation",
      "experimentalServedApps requires experimentalMachines: a served (layer-3) app surface is served BY a machine, so enable both — createVendo({ apps: { experimentalServedApps: true, experimentalMachines: true } })",
    );
  }
  const engine: GenerationEngine = modelEngine;
  const apps = config.store.records("vendo_apps");
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

  const reportGuard = async (
    principalSubject: string,
    appId: AppId,
    ctx: Pick<RunContext, "venue" | "presence"> & { trigger?: RunContext["trigger"] },
    detail: Record<string, Json>,
  ): Promise<void> => {
    await config.guard.report(
      appLifecycleEvent({ kind: "user", subject: principalSubject }, ctx, appId, detail),
    );
  };

  // execution-v2 — the v2 machine lifecycle (provision/wake/sleep/destroy);
  // the v1 MachineSessions cache is deleted.
  const {
    implicitDomains,
    buildEnv: hostBuildEnv,
    boxEditPollMs,
    boxEditTimeoutMs,
    ...machineConfig
  } = config.machine ?? {};
  const implicitEgress = (implicitDomains ?? [])
    .map(normalizeEgressDomain)
    .filter((domain) => domain !== "");
  const lifecycle = createMachineLifecycle({
    store: config.store,
    ...machineConfig,
    // Lane E — the runtime resolves the app's active secret grants at every
    // env assembly, so the host's buildEnv injects ONLY declared ∩ granted
    // secrets (per-app grants decide which keys enter the box).
    ...(hostBuildEnv === undefined ? {} : {
      buildEnv: async (doc: AppDocument) =>
        hostBuildEnv(doc, { grantedSecrets: await exposure.activeNames(doc.id) }),
      // Wave 7 — the wake-time env rebuild for grant changes (machine.envStaleAt)
      // rides the same box control-port door the pre-edit re-injection uses;
      // the in-box harness restarts the app with the new boundary set.
      injectEnv: pushBoxEnv,
    }),
    // Lane E — the egress policy EVERY provision and wake consults (including
    // ctx-less paths like an idle resume or a schedule fire): approved
    // declaration + implicit skin domains, or a loud refusal naming the
    // unapproved domains. See boxAllowlist for the assembly rules.
    allowedDomains: (doc) => boxAllowlist(doc, implicitEgress),
  });

  const owned = async (appId: AppId, subject: string): Promise<AppDocument | null> => {
    const record = await apps.get(appId);
    if (record === null || record.refs?.subject !== subject) return null;
    return documentFromRecord(record);
  };

  const requireOwned = async (appId: AppId, subject: string): Promise<AppDocument> => {
    const app = await owned(appId, subject);
    if (app === null) throw new VendoError("not-found", `app not found: ${appId}`);
    return app;
  };

  const interchange = createAppInterchange({
    store: config.store,
    guard: config.guard,
    pinBaselines: config.pinBaselines,
    requireOwned,
  });

  // ENG-345 — turning a secret ON is a HIGH-RISK approval reusing the guard's
  // existing critical-approval flow: check() with a critical descriptor parks an
  // approval, and this subscription commits the parked exposure grant only when
  // that approval is decided approved. Denial (or any non-approval) reverts it.
  // This is the SAME onApprovalDecision seam automations use to resume a parked
  // run — no parallel approval mechanism is introduced.
  const EXPOSURE_TOOL = "vendo_secret_expose";
  const exposureDescriptor = (): ToolDescriptor => ({
    name: EXPOSURE_TOOL,
    description: "Expose a declared secret's real value inside this app's sandbox (high-risk, owner-only).",
    inputSchema: {
      type: "object",
      properties: { appId: { type: "string" }, secretName: { type: "string" } },
      required: ["appId", "secretName"],
    },
    risk: "destructive",
    critical: true,
  });
  // Stable across the park/approve phases so the real guard's approved-replay
  // match (subject + call id + args + descriptor + venue/presence/app) lines up.
  const exposureCall = (appId: AppId, secretName: string): ToolCall => ({
    id: `call_expose_${appId}_${secretName}`,
    tool: EXPOSURE_TOOL,
    args: { appId, secretName },
  });

  /**
   * Wave 7 — a grant change while a machine exists: resumes restore the
   * SNAPSHOT's env on every provider, so mark the machine env-stale (the next
   * wake rebuilds the boundary env through the box control port and the
   * harness restarts the app) and put a RUNNING box to sleep so its next
   * request takes that wake path. No machine → nothing to mark; an app
   * deleted between park and decision is a no-op.
   */
  const markMachineEnvStale = async (appId: AppId): Promise<void> => {
    let marked: AppDocument;
    try {
      marked = await updateAppDocument(appId, (doc) => doc.machine === undefined
        ? doc
        // Strictly-increasing marker (nextEnvStaleAt): same-millisecond flips
        // must not mint equal values, or a concurrent wake's guarded clear
        // would erase the newer flip after injecting the older env.
        : { ...doc, machine: { ...doc.machine, envStaleAt: nextEnvStaleAt(doc.machine.envStaleAt) } });
    } catch (error) {
      if (error instanceof VendoError && error.code === "not-found") return;
      throw error;
    }
    if (marked.machine === undefined) return;
    await lifecycle.sleep(marked).catch(() => undefined);
  };

  const commitExposure = async (grant: SecretExposureGrant): Promise<void> => {
    await exposure.activate(grant.appId, grant.secretName);
    // A machine PROVISIONED before this grant keeps its provision-time env —
    // mark it stale so the next wake's control-port rebuild (and the pre-edit
    // re-injection) lands the new value.
    await markMachineEnvStale(grant.appId);
    await reportGuard(grant.owner, grant.appId, { venue: "app", presence: "present" }, {
      operation: "secret-exposure-set",
      secretName: grant.secretName,
      expose: true,
    });
  };

  // Lane E — approving an app's declared egress reuses the SAME high-risk
  // critical-approval flow (approval card in-client, no new ceremony types):
  // check() with this descriptor parks an approval, and the shared
  // onApprovalDecision subscription below commits the parked domains onto the
  // app document's egressApproved field only when the owner approves.
  const EGRESS_TOOL = "vendo_egress_allow";
  const egressDescriptor = (): ToolDescriptor => ({
    name: EGRESS_TOOL,
    description: "Allow this app's machine outbound network access to its declared egress domains (high-risk, owner-only).",
    inputSchema: {
      type: "object",
      properties: {
        appId: { type: "string" },
        domains: { type: "array", items: { type: "string" } },
      },
      required: ["appId", "domains"],
    },
    risk: "destructive",
    critical: true,
  });
  // Stable across the park/approve phases so the real guard's approved-replay
  // match (subject + call id + args + descriptor + venue/presence/app) lines up.
  const egressCall = (appId: AppId, domains: string[]): ToolCall => ({
    id: `call_egress_${appId}_${domains.join("_")}`,
    tool: EGRESS_TOOL,
    args: { appId, domains },
  });

  /** Bounded read-mutate-CAS on the app row (the lifecycle uses the same recipe). */
  const updateAppDocument = (
    appId: AppId,
    mutate: (doc: AppDocument) => AppDocument,
  ): Promise<AppDocument> => updateAppRow(apps, appId, mutate);

  const commitEgressApproval = async (
    appId: AppId,
    domains: string[],
    owner: string,
  ): Promise<void> => {
    const updated = await updateAppDocument(appId, (doc) => ({
      ...doc,
      egressApproved: [...new Set([
        ...(doc.egressApproved ?? []).map(normalizeEgressDomain),
        ...domains,
      ])],
    }));
    for (const domain of domains) await egressApprovals.remove(appId, domain);
    // A sleeping snapshot carries the pre-grant allowlist and the wake-time
    // policy override fixes that — but a LIVE machine still runs the old
    // network policy, so put it to sleep; its next wake applies the grant.
    await lifecycle.sleep(updated).catch(() => undefined);
    await reportGuard(owner, appId, { venue: "app", presence: "present" }, {
      operation: "egress-approved",
      domains,
    });
  };

  /**
   * Lane E — request approval for an app's declared-but-unapproved egress. On
   * "block" it throws; a pre-approved replay commits immediately; otherwise it
   * PARKS the approval card and returns its id and domains WITHOUT throwing, so
   * a caller (graduation) can surface a pending approval as an edit outcome
   * rather than a failure. This is the one seam that can ASK — it has the
   * acting principal; the lifecycle's ctx-less policy callback only refuses.
   */
  const requestEgressApproval = async (
    app: AppDocument,
    ctx: RunContext,
  ): Promise<{ status: "none" } | { status: "approved"; domains: string[] } | { status: "pending"; approvalId: ApprovalId; domains: string[] }> => {
    const unapproved = unapprovedEgress(app);
    if (unapproved.length === 0) return { status: "none" };
    const guardCtx: RunContext = { ...ctx, appId: app.id };
    const decision = await config.guard.check(egressCall(app.id, unapproved), egressDescriptor(), guardCtx);
    if (decision.action === "block") {
      throw new VendoError("blocked", decision.reason);
    }
    if (decision.action === "run") {
      // A pre-approved replay already cleared the high-risk gate — commit now.
      await commitEgressApproval(app.id, unapproved, ctx.principal.subject);
      return { status: "approved", domains: unapproved };
    }
    const requestedAt = new Date().toISOString();
    for (const domain of unapproved) {
      await egressApprovals.putPending({
        appId: app.id,
        domain,
        owner: ctx.principal.subject,
        approvalId: decision.approval.id,
        requestedAt,
      });
    }
    return { status: "pending", approvalId: decision.approval.id, domains: unapproved };
  };

  /**
   * Lane E — the ctx-carrying pre-flight run by provision/wake/box surfaces:
   * declared domains without a grant park the approval card and the operation
   * refuses loudly until the owner decides. Graduation uses the non-throwing
   * {@link requestEgressApproval} directly.
   */
  const ensureEgressApproved = async (app: AppDocument, ctx: RunContext): Promise<void> => {
    const outcome = await requestEgressApproval(app, ctx);
    if (outcome.status === "pending") {
      throw new VendoError(
        "blocked",
        `machine egress requires approval for: ${outcome.domains.join(", ")}`,
        { status: "pending-approval", approvalId: outcome.approvalId, unapprovedDomains: outcome.domains },
      );
    }
  };

  const onApprovalDecision = async (id: ApprovalId, approved: boolean): Promise<void> => {
    const parked = await exposure.byApproval(id);
    for (const grant of parked) {
      if (grant.status !== "pending") continue;
      if (approved) {
        await commitExposure(grant);
      } else {
        // Denied high-risk approval leaves the secret a handle (fail closed).
        await exposure.revoke(grant.appId, grant.secretName);
      }
    }
    // Lane E — parked egress domains riding this approval commit or clear as
    // one batch per app (a card's call pins a single appId, but group anyway).
    const parkedEgress = await egressApprovals.byApproval(id);
    if (parkedEgress.length > 0) {
      const byApp = new Map<AppId, { owner: string; domains: string[] }>();
      for (const request of parkedEgress) {
        const entry = byApp.get(request.appId) ?? { owner: request.owner, domains: [] };
        entry.domains.push(request.domain);
        byApp.set(request.appId, entry);
      }
      for (const [appId, entry] of byApp) {
        if (approved) {
          try {
            await commitEgressApproval(appId, entry.domains, entry.owner);
          } catch (error) {
            // The app vanished between park and decision (delete raced the
            // card): there is nothing to grant — clear the orphaned records.
            for (const domain of entry.domains) await egressApprovals.remove(appId, domain);
            if (!(error instanceof VendoError && error.code === "not-found")) throw error;
          }
        } else {
          // Denial leaves the declaration unapproved (fail closed) and clears the card.
          for (const domain of entry.domains) await egressApprovals.remove(appId, domain);
          await reportGuard(entry.owner, appId, { venue: "app", presence: "present" }, {
            operation: "egress-denied",
            domains: entry.domains,
          });
        }
      }
    }

    // W0 — resume a parked in-app action. Approval makes the exact parked call
    // eligible for the guard's one-shot approved replay, so re-dispatching it
    // through the guard-bound registry runs it and lands the host effect. The
    // record clears either way (approve = ran; deny = fail closed, never runs).
    const parkedAction = await parkedActions.byApproval(id);
    if (parkedAction !== null) {
      try {
        // Contained: a failed resume must never roll back the approval (the
        // guard already swallows subscriber throws, but be explicit here so
        // the record is always cleared).
        if (approved) await config.tools.execute(parkedAction.call, parkedAction.ctx);
      } finally {
        await parkedActions.remove(id);
      }
    }
  };
  config.guard.onApprovalDecision((id, approved) => onApprovalDecision(id, approved));

  const inClientApprovals = createInClientApprovals(config.store);
  // execution-v2 Lane D — fn: refs on a machine-bearing app resolve over the
  // v2 box door (the same wake Lane C's wire proxy rides); the wrap leaves
  // every other ref on the existing caller. Queries hit this at open(),
  // actions at call().
  const fnCaller = createFnCaller({ wake: (app) => lifecycle.wake(app) });
  const scheduleEngine = createScheduleEngine({
    store: config.store,
    lifecycle,
    callFn: fnCaller.callFn,
    audit: (event) => config.guard.report(event),
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
    (doc) => inClientApprovals.venueStateFor(doc),
    // Wave 4 (layer 3) — the served surface: wake-on-open over the machine
    // lifecycle, the provider's public ingress URL for $PORT, and the theming
    // handoff (host theme tokens as a query param the served app MAY consume).
    {
      enabled: config.experimentalServedApps === true,
      urlFor: async (app) => {
        const machine = await lifecycle.wake(app);
        // Absorb the fresh-boot 502 race server-side so the iframe's first
        // paint is the app, not a provider error (the wake latency is the
        // accepted loading state — no v1 cover machinery).
        await requestAppWithBootRetry(machine, { method: "GET", path: "/" }).catch(() => undefined);
        const url = new URL(await machine.url());
        if (config.theme !== undefined) {
          url.searchParams.set("vendoTheme", JSON.stringify(config.theme));
        }
        return url.toString();
      },
    },
  );

  // 06-apps §8 — every edit result over a drifted app carries the drift report,
  // so an agent or host editing a stale fork hears about it at edit time.
  const withPinDrift = (result: EditResult): EditResult => {
    const driftedPins = detectPinDrift(result.app, config.pinBaselines ?? []);
    return driftedPins.length === 0 ? result : { ...result, driftedPins };
  };

  const failedEdit = (
    app: AppDocument,
    instruction: string,
    issues: string[],
    retryable = true,
  ): EditResult => withPinDrift({
    app: structuredClone(app),
    version: {
      at: new Date().toISOString(),
      intent: instruction,
      rung: rungFor(app),
    },
    issues: [...issues],
    failure: {
      code: "edit-rejected",
      retryable,
      message: retryable
        ? "Edit was not applied. Retry vendo_apps_edit on the same app with a narrower instruction; do not rebuild the app."
        : "Edit was not applied and cannot be retried until the reported blocker is resolved.",
    },
  });

  const persistEdit = async (
    previous: AppDocument,
    app: AppDocument,
    version: VersionEntry,
    subject: string,
    pinSlots?: readonly string[],
    options: {
      /** Wave 9 — an edit that AUTHORED the trigger arms it in the same write
       *  (the ladder's automation path); every other edit keeps the disarm-on-
       *  trigger-change rule below. */
      armTrigger?: boolean;
    } = {},
  ): Promise<AppDocument> => {
    // Best-effort optimistic concurrency. The core StoreAdapter seam (01-core §12) has
    // no compare-and-swap or transactions, so a narrow TOCTOU window between the final
    // check and the put remains — closing it fully needs a store-level revision column
    // (a store-block follow-up). This catches the common edit-vs-undo / double-edit races.
    const assertCurrent = async (): Promise<boolean> => {
      const current = await apps.get(previous.id);
      const row = current === null ? null : rowFromRecord(current);
      if (row === null
        || row.subject !== subject
        || JSON.stringify(row.doc) !== JSON.stringify(previous)) {
        throw new VendoError("conflict", `app changed during edit: ${previous.id}`);
      }
      return row.enabled;
    };
    await assertCurrent();
    // Lane E — egressApproved is grant state, written ONLY by the egress
    // approval flow: an engine- or model-authored edit must never mint or
    // widen it (same rule as model-forged venue/drift fields above). Pin it
    // to the stored document's value.
    if (previous.egressApproved === undefined) {
      delete app.egressApproved;
    } else {
      app.egressApproved = [...previous.egressApproved];
    }
    await history.append(app.id, previous, version, pinSlots ?? touchedPinSlots(previous, app));
    const wasEnabled = await assertCurrent();
    // A changed trigger must be re-armed — enable() re-captures and re-mints trigger state.
    const enabled = options.armTrigger === true && app.trigger !== undefined
      ? true
      : enabledAfterDocumentEdit(previous, app, wasEnabled);
    const appRow = appRecordInput(app, subject, enabled);
    await apps.put(appRow);
    return structuredClone(appRow.data.doc);
  };

  const reportLifecycle = async (
    operation: "create" | "delete" | "fork" | "in-client-approve" | "pin-fork" | "pin-rebase" | "machine-provision" | "machine-destroy",
    appId: AppId,
    ctx: RunContext,
    extra: Record<string, Json> = {},
  ): Promise<void> => {
    await config.guard.report(appLifecycleEvent(ctx.principal, ctx, appId, { operation, ...extra }));
  };

  // verify-v2 fixes / v2 spec §3 — shape cards from live samples: each read
  // tool is sampled once per runtime (empty input, the calling user's
  // authority — the same call the app's queries make); the derived shape
  // feeds the generation prompt and the compiler's binding type-check, and
  // the descriptor list gates query tool names. A failed sample leaves that
  // tool's shape unknown (defensive `json` per the spec).
  const sampledShapes = new Map<string, ShapeType>();
  const settledSamples = new Set<string>();
  const requiresInput = (descriptor: ToolDescriptor): boolean => {
    const required = (descriptor.inputSchema as { required?: unknown }).required;
    return Array.isArray(required) && required.length > 0;
  };
  const generationToolContext = async (
    ctx: RunContext,
  ): Promise<Pick<GenerationDependencies, "tools" | "toolShapes">> => {
    const descriptors = await config.tools.descriptors().catch(() => []);
    await Promise.all(descriptors
      .filter((descriptor) =>
        descriptor.risk === "read" && !requiresInput(descriptor) && !settledSamples.has(descriptor.name))
      .map(async (descriptor) => {
        try {
          const outcome = await config.tools.execute(
            { id: `call_${globalThis.crypto.randomUUID()}`, tool: descriptor.name, args: {} },
            ctx,
          );
          if (outcome.status === "ok") {
            settledSamples.add(descriptor.name);
            sampledShapes.set(descriptor.name, deriveShapeCard(descriptor.name, [outcome.output]).output);
          } else if (outcome.status === "pending-approval" || outcome.status === "blocked") {
            // The policy gates this read: never re-ask on later creates (one
            // parked approval per boot at most), and leave the shape unknown.
            settledSamples.add(descriptor.name);
          }
          // Transient errors (e.g. an unauthenticated caller) retry on the
          // next create with that caller's own authority.
        } catch {
          // Unknown shape stays defensive; the tool is still listed by name.
        }
      }));
    return {
      tools: descriptors.map(({ name, description, risk, inputSchema }) => ({
        name,
        description,
        risk,
        // W4 pipeline — the structured-repair payload skeleton derives from
        // the tool's input schema (mutation-without-payload fixes).
        ...(typeof inputSchema === "object" && inputSchema !== null && !Array.isArray(inputSchema)
          ? { inputSchema: inputSchema as Record<string, unknown> }
          : {}),
      })),
      ...(sampledShapes.size === 0 ? {} : { toolShapes: Object.fromEntries(sampledShapes) }),
    };
  };

  // ─── execution-v2 Wave 3: the agent in the box + graduation ────────────────

  /** The skin-contract summary carried to the in-box agent as task context.
   *  Values never cross — only the env-var NAMES the box will find, the /fn
   *  convention, the vendo.json schema, and curl shapes for the store/tools
   *  callback surfaces. */
  const skinContractPrompt = (app: AppDocument): string => {
    const secretNames = (app.secrets ?? []).join(", ") || "(none declared)";
    return [
      "SKIN CONTRACT (the box boundary you build against):",
      "- Listen on the PORT env var. Serve POST /fn/<name> answering {\"result\": ...} (or {\"error\":{\"code\",\"message\"}}), and GET /vendo.json returning the manifest file.",
      "- Manifest vendo.json: {\"schedules\":[{\"cron\":\"0 8 * * *\",\"fn\":\"<name>\"}], \"egress\":[\"host.example.com\"]}. Declare EVERY third-party domain you fetch; undeclared egress is blocked at the network layer.",
      "- .vendo/run holds ONE shell line that starts the app (e.g. \"node server.js\"). Write it; a supervisor runs it.",
      "- Durable rows go through the Vendo store, NOT disk: PUT \"$VENDO_STORE_URL/rows/<collection>/<id>\" with header \"authorization: Bearer $VENDO_APP_TOKEN\" and body {\"data\":{...}}; list with GET \"$VENDO_STORE_URL/rows/<collection>\".",
      "- Host tools ride POST \"$VENDO_HOST_URL/tools/<name>\" with the same bearer; approvals/audit happen host-side.",
      `- Env vars available in the box: PORT, VENDO_STORE_URL, VENDO_APP_TOKEN, VENDO_HOST_URL, VENDO_INFERENCE_URL, VENDO_INFERENCE_KEY, and these declared secrets by name: ${secretNames}.`,
    ].join("\n");
  };

  /** Wave 4 (layer 3) — the extra contract lines for a served-app build: the
   *  box now OWNS the app surface. Same data-only floor as everything else the
   *  box reads; the host still verifies the served root itself before any
   *  surface flip. */
  const servedAppContractPrompt = (): string => [
    "THIS TASK BUILDS THE APP SURFACE ITSELF (layer 3):",
    "- START WARM: a served-app scaffold is pre-baked at /opt/vendo-box/scaffold (zero-dep Node server with the /fn envelopes, vendo.json serving, a themed entry page, and the .vendo/run entry already wired and tested). Your FIRST action: run exactly `cp -a /opt/vendo-box/scaffold/. /app/` (one command; it copies .vendo/run too — no ls, no second cp), then go straight to editing fns.js + index.html (touch server.js only for extra routes). Only if that cp fails (older box) build from scratch.",
    "- Serve a REAL web app on the non-/fn paths of $PORT. GET / is the entry page and must answer 200 with text/html. Any framework or plain HTML+JS; keep it self-contained (no CDN dependencies unless their domains are declared egress).",
    "- Keep every POST /fn/<name> endpoint working beside the pages; the page's own JavaScript may call relative /fn/<name> endpoints for data and actions.",
    "- The page may read the OPTIONAL `vendoTheme` query param (JSON host theme tokens: colors/typography/radius/density) to match the host brand. Ignore it if absent.",
    "- Verify by curling your own pages (GET / and every route you serve) until they answer 200 with the real content, then report servesUi: true.",
  ].join("\n");

  /**
   * The box server-edit primitive: wake the (already-provisioned) machine,
   * re-inject the current boundary env (grant-flip restart loop), send the
   * instruction to the in-box agent, and on success sync schedules + the
   * egress declaration and snapshot the new state. On failure the box is
   * DISCARDED — the app rolls back to its pre-edit snapshot. Returns the box's
   * (data-only) result and the synced document.
   */
  const editServerViaBox = async (
    app: AppDocument,
    instruction: string,
    _ctx: RunContext,
    options: { served?: boolean } = {},
  ): Promise<{ ok: true; result: BoxEditResult; doc: AppDocument; servedOk: boolean } | { ok: false; result: BoxEditResult }> => {
    const machine = await lifecycle.wake(app);
    await pushBoxEnv(machine, await lifecycle.buildAppEnv(app)).catch(() => undefined);
    const result = await runBoxEdit(machine, {
      prompt: instruction,
      context: options.served === true
        ? `${skinContractPrompt(app)}\n${servedAppContractPrompt()}`
        : skinContractPrompt(app),
      ...(boxEditPollMs === undefined ? {} : { pollIntervalMs: boxEditPollMs }),
      ...(boxEditTimeoutMs === undefined ? {} : { timeoutMs: boxEditTimeoutMs }),
    });
    if (!result.ok) {
      // Rollback: drop the live machine without snapshotting — the doc keeps
      // its pre-edit ref (no new fork machinery, just "don't keep this").
      await lifecycle.discard(app).catch(() => undefined);
      return { ok: false, result };
    }
    // Wave 4 (layer 3) — the box's servesUi is DATA; the HOST verifies the
    // served root while the machine is still awake. A surface flip downstream
    // requires this check, never the claim alone.
    let servedOk = false;
    if (result.servesUi === true) {
      const root = await requestAppWithBootRetry(machine, { method: "GET", path: "/" }).catch(() => undefined);
      // Header keys are matched case-insensitively: fetch normalizes to
      // lowercase, but a provider adapter is not obliged to.
      const contentType = root === undefined
        ? ""
        : Object.entries(root.headers).find(([key]) => key.toLowerCase() === "content-type")?.[1] ?? "";
      servedOk = root !== undefined
        && root.status >= 200 && root.status < 300
        && contentType.includes("text/html")
        && root.body.length > 0;
    }
    // Sync schedule state while the box is awake and its egress declaration is
    // not yet on the doc (so this wake's allowlist still passes).
    await scheduleEngine.syncManifest(app).catch(() => undefined);
    // Sync the egress DECLARATION (mirrors vendo.json) onto the doc; the
    // owner-approval grant is a separate, guard-gated step (Lane E).
    let egressDecl: string[] = [];
    const manifestSource = await readBoxManifest(machine).catch(() => undefined);
    if (manifestSource !== undefined) {
      try {
        egressDecl = (parseVendoManifest(manifestSource).egress ?? []).map(normalizeEgressDomain).filter((d) => d !== "");
      } catch {
        // An invalid manifest declares nothing; the box just cannot egress.
      }
    }
    const synced = await updateAppDocument(app.id, (doc) => {
      const next = { ...doc };
      if (egressDecl.length === 0) delete next.egress;
      else next.egress = [...new Set(egressDecl)];
      return next;
    });
    // Snapshot the new code + state (sleep does not consult the allowlist).
    // Sleep advances machine.snapshotRef via CAS, so the post-sleep document —
    // not the pre-sleep `synced` — is the current stored row a later persist
    // must build on.
    const slept = await lifecycle.sleep(synced);
    return { ok: true, result, doc: slept, servedOk };
  };

  /**
   * Graduation 1→2 (invisible, additive): provision a machine if the app has
   * none, delegate the server work to the in-box agent, then land the tree's
   * fn: bindings through the NORMAL v2 tree-edit dialect. The tree keeps
   * working throughout; the user never picks a tier. A graduating edit whose
   * server declares unapproved egress SURFACES the parked approval (the code is
   * written and snapshotted; the fn does real egress only once approved).
   */
  const graduate = async (
    previous: AppDocument,
    instruction: string,
    ctx: RunContext,
    options: { served?: boolean } = {},
  ): Promise<EditResult> => {
    if (config.model === undefined) {
      throw new VendoError("not-implemented", "generation requires a model");
    }
    if (!lifecycle.available()) {
      return failedEdit(previous, instruction, [
        "this instruction needs server capability (schedule / egress / heavy logic / app state), but no sandbox adapter is configured — set machine.sandbox to graduate",
      ], false);
    }
    // Provision on first graduation. A fresh app declares no egress, so this
    // does not park anything; a re-graduation of an app with pending egress
    // surfaces that card here (ensureEgressApproved throws).
    let provisioned = previous;
    if (previous.machine === undefined) {
      await ensureEgressApproved(previous, ctx);
      provisioned = await lifecycle.provision(previous);
      await reportLifecycle("machine-provision", previous.id, ctx);
    }
    const box = await editServerViaBox(provisioned, instruction, ctx, { served: options.served === true });
    if (!box.ok) {
      return failedEdit(provisioned, instruction, [
        `the in-box agent could not complete the server work: ${box.result.summary}`,
      ], true);
    }
    // Park the approval card for the domains the server code declared. On the
    // pre-approved-replay path this COMMITS the grant (writing egressApproved
    // and sleeping the box), which mutates the stored row — so re-read the
    // current document AFTER it as the base the fn-binding persist builds on,
    // rather than the now-possibly-stale box.doc.
    const pending = await requestEgressApproval(box.doc, ctx);
    const base = await requireOwned(previous.id, ctx.principal.subject);
    const pendingEgress = pending.status === "pending"
      ? { pendingEgress: { approvalId: pending.approvalId, domains: pending.domains } }
      : {};
    const boxReport = {
      box: {
        ok: box.result.ok,
        summary: box.result.summary,
        ...(box.result.fns === undefined ? {} : { fns: box.result.fns }),
        filesChanged: box.result.filesChanged,
      },
    };
    // ── Wave 4 (layer 3): the 2→3 surface flip ─────────────────────────────
    // The tree kept serving through the whole box build; only NOW — box ok,
    // servesUi declared, and the host's own served-root check green — does the
    // document flip to the served surface (ui: http, the tree is gone). The
    // experimental flag guards the FLIP itself, not just generation: a box
    // that self-declares a served app while the flag is off is refused here,
    // loudly (de-graduation guard).
    const extraIssues: string[] = [];
    if (options.served === true || box.result.servesUi === true) {
      if (config.experimentalServedApps !== true) {
        extraIssues.push(
          "the box declared a served web app, but experimentalServedApps is disabled — the surface flip was refused and the tree keeps serving (enable createVendo({ apps: { experimentalServedApps: true } }))",
        );
      } else if (options.served === true && box.result.servesUi === true && box.servedOk) {
        // The flip needs BOTH the escalation decision and the verified served
        // surface: a box that spontaneously serves UI on a layer-2 instruction
        // must never replace a tree the user did not ask to lose.
        const flipped = structuredClone(base);
        delete flipped.tree;
        delete flipped.components;
        delete flipped.componentTools;
        delete flipped.pins;
        flipped.ui = "http";
        const flipVersion: VersionEntry = {
          at: new Date().toISOString(),
          intent: instruction,
          rung: rungFor(flipped),
        };
        const persisted = await persistEdit(base, flipped, flipVersion, ctx.principal.subject);
        return withPinDrift({
          app: persisted,
          version: { ...flipVersion },
          graduated: true,
          ...boxReport,
          ...pendingEgress,
        });
      } else if (options.served === true) {
        // The box work landed (machine + code snapshotted), but no verified
        // served surface exists — the current surface stays live; retry edits.
        return withPinDrift({
          app: structuredClone(base),
          version: { at: new Date().toISOString(), intent: instruction, rung: rungFor(base) },
          issues: [
            "the box did not produce a verified served web app (GET / must answer 200 text/html) — the surface was not flipped; retry the edit",
          ],
          graduated: true,
          ...boxReport,
          ...pendingEgress,
        });
      }
    }
    // Land fn: bindings via the normal tree-edit dialect. The app now carries a
    // machine, so fn: refs validate (core machine-presence rule).
    const fns = box.result.fns ?? [];
    // A FOCUSED rebind directive — not the full server spec (which is noise to
    // the tree-edit model). The only job here is repointing the tree's data
    // queries and actions at the new fn: functions.
    const treeInstruction = `The app just graduated to a machine that serves these functions: ${fns.map((fn) => `fn:${fn}`).join(", ") || "(none reported)"}. Rewire the tree to use them:\n- Repoint the query that feeds the main board/list/digest so its tool is the matching data function (e.g. change its tool to "fn:getDigest"); if no such query exists, add one with <Query id="data" tool="fn:..."/> and bind a node to it. Do not leave a stale placeholder or host-tool query where the server now provides the data.\n- Wire any submit/refresh/run control's action to the matching fn:.\n- An fn response unwraps its {"result": ...} envelope: bind paths directly against the function's result value, and NEVER carry a host tool's response envelope (e.g. a "data" segment) into an fn: binding — when you repoint a query, rewrite every binding path that read the old tool's shape.\nChange ONLY the data source and actions; keep the layout. Emit no id attributes on nodes (ids are compiler-owned); a <Query> id is its name.`;
    let treeIssues: string[] = [];
    let bound: AppDocument | undefined;
    // Wave 7 H2 (the em-dash class, PR #418) — fn-result shape cards, sampled
    // lazily for the fn: queries the rebind actually lands (never for unbound
    // action fns), keyed like tool shapes ("fn:<name>") so the edit compiler
    // and the TOOL RESPONSE SHAPES prompt pick them up on retries.
    const fnShapes: Record<string, ShapeType> = {};
    const sampledFns = new Set<string>();
    for (let attempt = 0; attempt < 3 && bound === undefined; attempt += 1) {
      const toolContext = await generationToolContext(ctx);
      const generated = await engine.edit(
        {
          app: structuredClone(base),
          instruction: treeInstruction,
          ...(treeIssues.length === 0 ? {} : { repairIssues: treeIssues }),
        },
        generationDependencies(config, config.model, {
          ...toolContext,
          ...(Object.keys(fnShapes).length === 0 && toolContext.toolShapes === undefined
            ? {}
            : { toolShapes: { ...toolContext.toolShapes, ...fnShapes } }),
        }),
      );
      if (generated.kind !== "document") {
        treeIssues = distinctIssues(treeIssues, generated.issues);
        continue;
      }
      const candidate: AppDocument = { ...generated.document, id: base.id };
      // Post-pass: check the landed fn: bindings against SAMPLED result
      // shapes. The sample is the exact call the bound query makes at open()
      // (fn.ts unwraps the {result} envelope), so it does nothing a rendered
      // board would not do itself; a failed sample leaves that fn's shape
      // unknown — defensive, like an unsampled host tool.
      const tree = candidate.tree as unknown as TreeV2 | undefined;
      const queries = tree?.queries ?? [];
      // Sampling adds no new authority and (at most) one extra invocation:
      // a query-bound fn fires WITHOUT user action the moment the graduated
      // tree is opened or emitted (the progressive resolver calls it with
      // exactly this input), so an fn too dangerous to sample was already
      // too dangerous for the model to wire as a query — that is a box-side
      // design concern, not a host gate this pass could add.
      for (const query of queries) {
        if (!query.tool.startsWith("fn:") || sampledFns.has(query.tool)) continue;
        sampledFns.add(query.tool);
        const outcome = await fnCaller.callFn(base, query.tool.slice(3), query.input ?? {}, ctx).catch(() => undefined);
        if (outcome !== undefined && outcome.status === "ok") {
          fnShapes[query.tool] = deriveShapeCard(query.tool, [outcome.output]).output;
        }
      }
      const bindingErrors = tree === undefined ? [] : checkBindingShapes(tree.nodes, queries, fnShapes);
      if (bindingErrors.length === 0) {
        bound = candidate;
      } else {
        treeIssues = distinctIssues(treeIssues, bindingErrors.map((error) =>
          `binding ${error.path} on node "${error.nodeId}" prop "${error.prop}": ${error.message}${error.available === undefined ? "" : ` (available: ${error.available.join(", ")})`}`));
      }
    }
    const version: VersionEntry = { at: new Date().toISOString(), intent: instruction, rung: rungFor(base) };
    if (bound === undefined) {
      // Server graduated + snapshotted, but the model couldn't validate the
      // fn: bindings. The machine sticks (already persisted by editServerViaBox);
      // report the miss instead of silently dropping the graduation.
      return withPinDrift({
        app: structuredClone(base),
        version,
        issues: ["graduated: machine provisioned and server code written, but the tree fn: bindings did not validate — retry the edit to wire them", ...treeIssues, ...extraIssues],
        graduated: true,
        ...boxReport,
        ...pendingEgress,
      });
    }
    if (bound.tree !== undefined) stripServerAuthoritativeFields(bound.tree);
    const persisted = await persistEdit(base, bound, version, ctx.principal.subject);
    return withPinDrift({
      app: persisted,
      version: { ...version },
      ...(extraIssues.length === 0 ? {} : { issues: [...extraIssues] }),
      graduated: true,
      ...boxReport,
      ...pendingEgress,
    });
  };

  /**
   * Wave 9 — the escalation ladder's rungs (a) and (b): author a STEPS or
   * AGENTIC automation for a server-shaped instruction instead of graduating
   * to a box. One structured model call plans the trigger (seconds, no
   * machine); the trigger and its results-collection declaration land on the
   * document through the normal edit persist, ARMED so the existing
   * automations engine fires it; then the tree gains a query over the results
   * rows through the same tree-edit dialect graduation uses for fn: bindings.
   * Grant capture stays lazy: an away run's first ungranted mutating step
   * parks the standard approval card (park/resume already handles it).
   */
  const automate = async (
    previous: AppDocument,
    instruction: string,
    ctx: RunContext,
    mode: "steps" | "agentic",
  ): Promise<EditResult> => {
    if (config.model === undefined) {
      throw new VendoError("not-implemented", "generation requires a model");
    }
    const toolContext = await generationToolContext(ctx);
    const planned = await planAutomation({
      appId: previous.id,
      appName: previous.name,
      instruction,
      mode,
      tools: toolContext.tools ?? [],
      ...(toolContext.toolShapes === undefined ? {} : { toolShapes: toolContext.toolShapes }),
    }, config.model);
    if (planned.kind === "failure") {
      return failedEdit(previous, instruction, [
        `this instruction needs ${mode === "steps" ? "a scheduled/triggered steps" : "an agentic"} automation, but no valid plan validated`,
        ...planned.issues,
      ]);
    }
    const { plan } = planned;
    const automated = structuredClone(previous);
    automated.trigger = structuredClone(plan.trigger);
    if (plan.resultsCollection !== undefined && automated.storage?.[plan.resultsCollection] === undefined) {
      automated.storage = {
        ...automated.storage,
        [plan.resultsCollection]: {
          about: `Latest results written by the "${plan.name ?? "automation"}" automation for the app board.`,
          kind: "records",
        },
      };
    }
    // Bind the tree to the results rows BEFORE the single persist, so one
    // version entry carries the whole edit. A failed rebind never blocks the
    // automation (same rule as graduation's fn: bindings): the trigger still
    // lands and the miss is reported for a retry edit.
    let bound = automated;
    const issues: string[] = [];
    if (plan.resultsCollection !== undefined && automated.tree?.formatVersion === VENDO_TREE_FORMAT_V2) {
      const rebindInstruction = `The app now has a ${mode} automation${plan.name === undefined ? "" : ` ("${plan.name}")`} that runs while the user is away and writes its latest displayable result into the app data collection "${plan.resultsCollection}" (record id "latest"). Rewire the tree to show those results:
- Add (or repoint) a query over the results rows: <Query id="results" tool="vendo_apps_data_list" input={{appId:"${previous.id}", collection:"${plan.resultsCollection}"}}/> — the input is LITERAL JSON exactly as written. The tool's result shape is {records: [{id, data: <what the automation stored>}]}, so bind node props against /results/records/... paths (e.g. {results.records.0.data.summary}).
- Keep the layout; change only what is needed to surface the automation's results (add a small section if none fits).
- Emit no id attributes on nodes (ids are compiler-owned); a <Query> id is its name.`;
      let treeIssues: string[] = [];
      let rebound: AppDocument | undefined;
      for (let attempt = 0; attempt < 2 && rebound === undefined; attempt += 1) {
        const generated = await engine.edit(
          {
            app: structuredClone(automated),
            instruction: rebindInstruction,
            ...(treeIssues.length === 0 ? {} : { repairIssues: treeIssues }),
          },
          generationDependencies(config, config.model, toolContext),
        );
        if (generated.kind === "document") {
          rebound = { ...generated.document, id: previous.id };
        } else {
          treeIssues = distinctIssues(treeIssues, generated.issues);
        }
      }
      if (rebound === undefined) {
        issues.push(
          "automation armed, but the tree binding to its results collection did not validate — retry the edit to wire the board",
          ...treeIssues,
        );
      } else {
        // The rebind must never drop the just-authored automation fields.
        rebound.trigger = structuredClone(plan.trigger);
        rebound.storage = structuredClone(automated.storage);
        bound = rebound;
      }
    }
    if (bound.tree !== undefined) stripServerAuthoritativeFields(bound.tree);
    const version: VersionEntry = { at: new Date().toISOString(), intent: instruction, rung: rungFor(bound) };
    // Arming: through the seam when the host wired one (the umbrella wires
    // automations.enable — the 07 §3 grant-capture flow), directly otherwise.
    const persisted = await persistEdit(previous, bound, version, ctx.principal.subject, undefined, {
      armTrigger: config.armAutomation === undefined,
    });
    let pendingGrants: ApprovalRequest[] | undefined;
    if (config.armAutomation !== undefined) {
      try {
        const armed = await config.armAutomation(previous.id, ctx);
        if (armed.missing.length > 0) pendingGrants = structuredClone(armed.missing);
        // A seam that answers without arming is the same miss as a thrown one:
        // the trigger must never sit silently disarmed.
        if (!armed.enabled) {
          issues.push("the automation was authored but the arming seam left it disabled — enable it explicitly via the automations engine (automations.enable / POST /automations/:appId/enable)");
        }
      } catch (error) {
        // Never a silently dead automation: the trigger is on the document but
        // disarmed — say so, with the arming surface to use.
        issues.push(`the automation was authored but arming it failed (${error instanceof Error ? error.message : "unknown error"}) — enable it explicitly via the automations engine (automations.enable / POST /automations/:appId/enable)`);
      }
    }
    await reportGuard(ctx.principal.subject, previous.id, ctx, {
      operation: "automation-created",
      mode,
      triggerKind: plan.trigger.on.kind,
    });
    return withPinDrift({
      app: persisted,
      version: { ...version },
      ...(issues.length === 0 ? {} : { issues }),
      automation: {
        mode,
        trigger: structuredClone(plan.trigger),
        ...(plan.resultsCollection === undefined ? {} : { resultsCollection: plan.resultsCollection }),
        ...(pendingGrants === undefined ? {} : { pendingGrants }),
      },
    });
  };

  const runtime: AppsRuntime = {
    async prewarm() {
      const models = [config.model, config.paint?.model].filter(
        (model): model is LanguageModel => model !== undefined,
      );
      if (models.length > 0) await prewarmModels(models);
    },
    async create(input, ctx) {
      if (config.model === undefined) {
        throw new VendoError("not-implemented", "generation requires a model");
      }
      // execution-v2 Wave 4 — a prompt that needs a served web app (layer 3)
      // refuses cleanly while the experimental flag is off: no tree is built
      // that could only disappoint, and the error names the flag.
      if (config.experimentalServedApps !== true && instructionRequiresServedApp({}, input.prompt)) {
        throw servedAppsDisabledError();
      }
      // execution-v2 Wave 9 — same rule for a prompt whose server work only a
      // box can express (the ladder's rung c) while machines are off: a typed
      // refusal naming the flag, never a silent degrade. Automation-shaped
      // prompts (rungs a/b) proceed — they never need a machine.
      if (config.experimentalMachines !== true && serverWorkRung({ ui: "tree" }, input.prompt) === "box") {
        throw machinesDisabledError();
      }
      // Mint before generation so every partial already carries its permanent id.
      const appId = `app_${globalThis.crypto.randomUUID()}`;
      const emit = (payload: TreeV2): void => {
        // 06-apps §§8–9 — the venue verdict and drift report are
        // server-authoritative and a model-written tree must never smuggle
        // either into the live stream: a freshly generated app has no approval
        // and no drifted pins by definition.
        stripServerAuthoritativeFields(payload);
        input.onView?.({
          type: "data-vendo-view",
          appId,
          payload: payload as unknown as UIPayload,
        });
      };
      let latestTree: TreeV2 | undefined;
      const queryApp: AppDocument = {
        format: "vendo/app@1",
        id: appId,
        name: "Generating app",
        ui: "tree",
      };
      const queryResolver = input.onView === undefined
        ? undefined
        : createProgressiveQueryResolver(caller, queryApp, ctx, (data) => {
          if (latestTree === undefined) return;
          emit({ ...structuredClone(latestTree), data, streaming: true } as TreeV2);
        });
      let generated: Awaited<ReturnType<GenerationEngine["create"]>>;
      try {
        generated = await engine.create(
          { prompt: input.prompt },
          generationDependencies(config, config.model, await generationToolContext(ctx), input.onView === undefined ? undefined : (partial) => {
            // v2 spec §1 — the payload carries islands at payload level (the
            // renderer lifts them); a mid-stream payload is marked streaming.
            latestTree = assembleTree(partial);
            emit({ ...structuredClone(latestTree), streaming: true } as TreeV2);
            queryResolver?.update(latestTree);
          }),
        );
      } catch (error) {
        // The build turn threw (model error, quota, timeout). `vendo_create_app`
        // already returned an app-ref the instant the FIRST partial streamed, so
        // the embed is mounted polling open() — with no persisted record it would
        // spin to APP_BUILD_DEADLINE_MS and then show the generic failed beat.
        // Persist a TERMINAL failed record so open() answers {kind:"failed"} with
        // the reason on the very next poll — the prompt resolution approvals get.
        const { reason, retryable } = buildFailureReason(error);
        await apps.put(appRecordInput({
          format: "vendo/app@1",
          id: appId,
          name: fallbackAppName(input.prompt),
          buildFailed: { reason, retryable, at: new Date().toISOString() },
        }, ctx.principal.subject)).catch(() => undefined);
        // The operator's terminal gets the un-canned detail (the engine folds
        // provider errors into the VendoError's issue list) — a silent failed
        // build was the 0.4.x E2E's hardest defect to self-diagnose.
        const detail = error instanceof VendoError && Array.isArray(error.detail)
          ? error.detail.filter((item): item is string => typeof item === "string")
          : [];
        const detailLines = detail.length > 0 ? detail : [safeErrorMessage(error)];
        console.error(`[vendo] app build failed (${appId}): ${reason}${detailLines
          .map((line) => `\n  - ${line}`).join("")}`);
        // Re-throw CARRYING the classified reason: the tool outcome the calling
        // agent reads is built from this message, and "model could not produce
        // a valid app" told it (and the user) nothing actionable. detail keeps
        // the raw issue list for in-process callers (the wire serializes only
        // code + message, so nothing un-canned crosses to clients).
        throw new VendoError(
          error instanceof VendoError ? error.code : "validation",
          `${VENDO_APP_BUILD_FAILED_PREFIX}: ${reason}`,
          { appId, reason, retryable, issues: detailLines },
        );
      }
      const app: AppDocument = {
        ...generated,
        id: appId,
      };
      // Same rule at rest: open() strips before serving, but a model-forged
      // venue or drift field has no business being persisted in the first place.
      if (app.tree !== undefined) stripServerAuthoritativeFields(app.tree);
      // Lane E — same rule for egress grant state: a freshly generated app
      // has approved nothing, whatever the model emitted.
      delete app.egressApproved;
      // buildFailed is server-written only (the create catch above): a
      // successfully generated document never carries it, whatever the model
      // emitted into the tree markup.
      delete app.buildFailed;
      let finalTree: TreeV2 | undefined;
      if (input.onView !== undefined && app.tree?.formatVersion === VENDO_TREE_FORMAT_V2) {
        finalTree = assembleTree({ tree: app.tree, components: app.components, componentTools: app.componentTools });
        latestTree = structuredClone(finalTree);
        queryResolver?.update(finalTree);
        finalTree.data = await queryResolver?.complete() ?? structuredClone(finalTree.data ?? {});
      }
      await apps.put(appRecordInput(app, ctx.principal.subject));
      await reportLifecycle("create", app.id, ctx);
      if (finalTree !== undefined) emit(finalTree);
      // execution-v2 Wave 9 — escalate on create when the prompt needs server
      // capability, walking the ladder: a steps/agentic automation (seconds,
      // no machine) before box graduation. The tree is already on screen; the
      // trigger (or the machine + fn: bindings) lands additively — the user
      // never picks a tier. Best-effort: an escalation failure leaves the
      // working tree app to retry via edit, so create never regresses to a
      // white box.
      const servedCreate = instructionRequiresServedApp(app, input.prompt);
      const rung = servedCreate ? "box" : serverWorkRung(app, input.prompt);
      // The streamed view parts are last-write-wins, and the pre-escalation
      // emit above already painted resolved query data — so this emit must
      // resolve the escalated tree's queries too (fn: refs are resolvable —
      // the machine exists; a results query reads the app's own rows). On a
      // resolver failure, emit nothing rather than a data-less tree that
      // would blank the screen.
      const emitEscalated = async (escalated: AppDocument): Promise<void> => {
        if (input.onView === undefined || escalated.tree?.formatVersion !== VENDO_TREE_FORMAT_V2) return;
        try {
          const tree = assembleTree({ tree: escalated.tree, components: escalated.components, componentTools: escalated.componentTools });
          stripServerAuthoritativeFields(tree);
          const escalatedResolver = createProgressiveQueryResolver(caller, escalated, ctx);
          escalatedResolver.update(tree);
          tree.data = await escalatedResolver.complete();
          emit(tree);
        } catch {
          // Best-effort: the pre-escalation view stands until open().
        }
      };
      if (rung === "steps" || rung === "agentic") {
        try {
          const automated = await automate(structuredClone(app), input.prompt, ctx, rung);
          if (automated.failure === undefined) {
            await emitEscalated(automated.app);
            return structuredClone(automated.app);
          }
        } catch {
          // Automation is best-effort on create; the working tree app stands.
        }
      } else if (rung === "box" && lifecycle.available()) {
        // Rung (c) reaches here only with experimentalMachines on — the
        // flag-off case refused before generation above.
        try {
          const graduated = await graduate(structuredClone(app), input.prompt, ctx, {
            served: servedCreate,
          });
          if (graduated.failure === undefined) {
            await emitEscalated(graduated.app);
            return structuredClone(graduated.app);
          }
        } catch {
          // Graduation is best-effort on create; the working tree app stands.
        }
      }
      return structuredClone(app);
    },

    async get(appId, ctx) {
      return owned(appId, ctx.principal.subject);
    },

    async list(ctx) {
      const records = await allRecords(config.store, { subject: ctx.principal.subject });
      const documents: AppDocument[] = [];
      for (const record of records
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id))) {
        try {
          const document = documentFromRecord(record);
          // A terminally failed build is a tombstone open() reads to resolve
          // the embed — not a real app; it never joins the listable surface.
          if (document.buildFailed !== undefined) continue;
          documents.push(document);
        } catch {
          // Corrupt rows cannot be surfaced, but must not hide valid owned apps.
        }
      }
      return documents;
    },

    async delete(appId, ctx) {
      const app = await requireOwned(appId, ctx.principal.subject);
      // execution-v2 — deleting the app reaps its machine (live sandbox +
      // stored snapshot) directly, without rewriting the doomed document: a
      // graduated tree's fn: refs would fail a machine-cleared re-validation
      // and otherwise strand the provider snapshot.
      await lifecycle.destroyResources(app);
      await scheduleEngine.clearForApp(appId);
      await data.clear(app, ctx.principal.subject, await history.documents(appId));
      await history.clear(appId);
      await inClientApprovals.clear(appId);
      await exposure.clearForApp(appId);
      await egressApprovals.clearForApp(appId);
      await parkedActions.clearForApp(appId);
      await apps.delete(appId);
      await reportLifecycle("delete", appId, ctx);
    },

    async fork(appId, ctx) {
      const source = await requireOwned(appId, ctx.principal.subject);
      // Wave 4 — a served (layer-3) app's ENTIRE surface lives in its machine,
      // and machines never travel with a copy: the fork would be an app that
      // can never open (ui: http, no tree, no machine). Refuse loudly instead
      // of minting a broken document. Scoped to machine-backed docs — a
      // retired v1 `server`-ref doc keeps its established fork semantics (the
      // copy drops the dead ref; see the 09 §3 wire test).
      if (source.ui === "http" && source.machine !== undefined) {
        throw new VendoError(
          "conflict",
          "a served (layer-3) app cannot be forked: its surface lives in its machine, which never travels with a copy — create a new app instead",
        );
      }
      const fork: AppDocument = {
        ...structuredClone(source),
        id: `app_${globalThis.crypto.randomUUID()}`,
        forkedFrom: source.id,
      };
      // execution-v2 — a fork never carries the machine (or the retired v1
      // server snapshot); the copy re-graduates on its own.
      delete fork.machine;
      // Lane E grant hygiene — egress approval never travels with a copy; the
      // fork re-approves its declaration.
      delete fork.egressApproved;
      delete fork.server;
      await apps.put(appRecordInput(fork, ctx.principal.subject));
      await reportLifecycle("fork", fork.id, ctx, { sourceAppId: source.id });
      return structuredClone(fork);
    },

    async agentToolRisk(call, ctx) {
      if (call.tool !== "vendo_apps_edit") return undefined;
      if (typeof call.args !== "object" || call.args === null || Array.isArray(call.args)) {
        return "write";
      }
      const args = call.args as Record<string, Json>;
      if (typeof args.appId !== "string" || typeof args.instruction !== "string") {
        return "write";
      }
      const app = await owned(args.appId, ctx.principal.subject);
      if (app === null) return "write";
      // Wave 9 — any ladder rung (steps/agentic automation or box work) is a
      // write-class edit; only pure-tree instructions stay read-class.
      return serverWorkRung(app, args.instruction) !== null ? "write" : "read";
    },

    async edit(appId, instruction, ctx) {
      if (config.model === undefined) {
        throw new VendoError("not-implemented", "generation requires a model");
      }
      const previous = await requireOwned(appId, ctx.principal.subject);
      // execution-v2 Wave 4 — an instruction whose UI needs exceed the tree
      // escalates 2→3 (the box builds a real served web app). Experimental:
      // the flag refuses this path CLEANLY before any box work happens.
      const served = instructionRequiresServedApp(previous, instruction);
      if (served && config.experimentalServedApps !== true) {
        throw servedAppsDisabledError();
      }
      // execution-v2 Wave 9 — server-shaped instructions walk the escalation
      // ladder: (a) a steps automation, (b) an agentic automation (both ride
      // the existing automations engine — seconds, no machine), (c) box
      // graduation only when custom code is required (experimental). A served
      // ask is a fortiori a box ask (Wave 4), and an app that ALREADY has a
      // machine keeps its box workflow — existing apps are never rerouted.
      // A pure-UI instruction stays on the cheap tree path.
      const rung = served ? "box" : serverWorkRung(previous, instruction);
      if (rung !== null) {
        if (previous.machine === undefined && (rung === "steps" || rung === "agentic")) {
          return automate(previous, instruction, ctx, rung);
        }
        // Rung (c): NEW graduation (no machine yet) is gated by the
        // experimental flag — a typed refusal, never a silent degrade.
        if (previous.machine === undefined && config.experimentalMachines !== true) {
          throw machinesDisabledError();
        }
        return graduate(previous, instruction, ctx, { served });
      }
      let repairIssues: string[] | undefined;
      let collectedIssues: string[] = [];
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const generated = await engine.edit(
          {
            app: structuredClone(previous),
            instruction,
            ...(repairIssues === undefined ? {} : { repairIssues }),
          },
          generationDependencies(config, config.model, await generationToolContext(ctx)),
        );
        if (generated.kind === "failure") {
          collectedIssues = distinctIssues(collectedIssues, generated.issues);
          repairIssues = collectedIssues;
          continue;
        }
        const app: AppDocument = { ...generated.document, id: appId };
        // Same strip-before-persist rule as create(): open() strips at serve
        // time, but a model-forged venue or drift field must not be persisted.
        if (app.tree !== undefined) stripServerAuthoritativeFields(app.tree);
        const version: VersionEntry = {
          at: new Date().toISOString(),
          intent: instruction,
          rung: rungFor(app),
        };
        return withPinDrift({
          app: await persistEdit(previous, app, version, ctx.principal.subject),
          version: { ...version },
        });
      }
      return failedEdit(
        previous,
        instruction,
        collectedIssues.length === 0 ? ["edit failed validation"] : collectedIssues,
      );
    },

    /**
     * ⚠️ OWNERSHIP IS THE CALLER'S RESPONSIBILITY. The frozen 06 §1 signature
     * `history(appId)` takes no RunContext, so — unlike create/get/edit/delete/fork/
     * open/call, which all scope by `ctx.principal.subject` — this handle cannot check
     * ownership itself. The umbrella wire route (`/apps/:id/history`, 09 §3) MUST resolve
     * the principal and confirm ownership before exposing `list`/`undo`; that route is the
     * system's cross-user auth boundary ("the unauthenticated surface is exactly nothing").
     * Flagged by Codex + Greptile review; closing it inside this block needs a contract
     * major to add `ctx` here — see the PR's escalation note.
     */
    history(appId) {
      const surface = history.surface(appId);
      return Object.freeze({
        list: () => surface.list(),
        undo: () => surface.undo(),
      });
    },

    async open(appId, ctx) {
      return opener(await requireOwned(appId, ctx.principal.subject), ctx);
    },

    async call(appId, ref, args, ctx) {
      const app = await requireOwned(appId, ctx.principal.subject);
      // A host-tool ref goes straight to the guard-bound registry; an fn: ref
      // settles as a contained not-implemented outcome until the v2 in-runtime
      // fn path lands (see call.ts).
      return caller.call(app, ref, args, ctx);
    },

    async exportApp(appId, ctx) {
      return interchange.exportApp(appId, ctx);
    },

    async importApp(source, ctx) {
      return interchange.importApp(source, ctx);
    },

    async share(appId, ctx) {
      const app = await requireOwned(appId, ctx.principal.subject);
      if (config.cloud === undefined) {
        throw new VendoError("cloud-required", "Vendo Cloud requires VENDO_API_KEY");
      }
      // Lane E grant hygiene — a share copy never carries the owner's egress
      // approval; whoever runs the copy approves its declaration themselves.
      const { egressApproved: _egressApproved, ...shared } = app;
      return config.cloud.share(appId, shared);
    },

    async publish(appId, ctx) {
      const app = await requireOwned(appId, ctx.principal.subject);
      if (config.cloud === undefined) {
        throw new VendoError("cloud-required", "Vendo Cloud requires VENDO_API_KEY");
      }
      // Lane E grant hygiene — same rule as share: approval never travels.
      const { egressApproved: _published, ...published } = app;
      return config.cloud.publish(appId, published);
    },

    agentTools() {
      return createAgentTools(runtime, { data, requireOwned });
    },

    inClient: {
      async shipDiff(appId, ctx) {
        const app = await requireOwned(appId, ctx.principal.subject);
        return computeShipDiff(app, config.pinBaselines ?? []);
      },
      async approvals(appId, ctx) {
        await requireOwned(appId, ctx.principal.subject);
        return inClientApprovals.list(appId);
      },
      async verdict(appId, ctx) {
        const app = await requireOwned(appId, ctx.principal.subject);
        return inClientApprovals.verdictFor(app);
      },
      async approve(input, ctx) {
        const app = await requireOwned(input.appId, ctx.principal.subject);
        const approval = await inClientApprovals.record({
          appId: app.id,
          versionHash: appVersionHash(app),
          approvedBy: input.approvedBy,
          at: new Date().toISOString(),
        });
        await reportLifecycle("in-client-approve", app.id, ctx, {
          versionHash: approval.versionHash,
          approvedBy: approval.approvedBy,
        });
        return approval;
      },
    },

    pins: {
      async drift(appId, ctx) {
        const app = await requireOwned(appId, ctx.principal.subject);
        return detectPinDrift(app, config.pinBaselines ?? []);
      },

      // Gesture-owned forking (2026-07-21) — deterministic: the captured
      // baseline is copied by the engine and the pin recorded WITHOUT a model
      // call. The recorded fork version is intents[0] of the pin's replay
      // trail, so rebase() replays exactly the user's later modifications.
      async fork(input, ctx) {
        const baseline = (config.pinBaselines ?? []).find(({ slot }) => slot === input.slot);
        if (baseline === undefined) {
          throw new VendoError("not-found", `remixable slot "${input.slot}" has no captured baseline; register the component as remixable and run vendo sync`);
        }
        const forkOnto = (base: AppDocument): AppDocument => {
          const forked = structuredClone(base);
          // applyPinFork prefixes issues with "<ForkPin> failed:" for the
          // stored-app op compiler; a user gesture never saw that op, so the
          // prefix is stripped from the surfaced error.
          const issues = applyPinFork(forked, { slot: input.slot }, config.pinBaselines)
            .map((issue) => issue.replace(/^<ForkPin> failed: /, ""));
          if (issues.length > 0) throw new VendoError("conflict", issues.join("; "));
          const validation = validateAppDocument(forked);
          if (!validation.ok) throw new VendoError("validation", validation.error.message);
          return forked;
        };
        let previous: AppDocument;
        if (input.appId !== undefined) {
          previous = await requireOwned(input.appId, ctx.principal.subject);
          if (previous.tree?.formatVersion !== VENDO_TREE_FORMAT_V2) {
            throw new VendoError("conflict", "a pin fork requires a vendo-genui/v2 tree app");
          }
        } else {
          // The empty-slot Remix gesture: mint the minimal base document the
          // fork lands in, so the fork itself is an ordinary recorded edit
          // (undo returns to the empty base; rebase finds a full trail).
          const minted: AppDocument = {
            format: "vendo/app@1",
            id: `app_${globalThis.crypto.randomUUID()}`,
            name: `${baseline.slot} remix`,
            ui: "tree",
            tree: {
              formatVersion: VENDO_TREE_FORMAT_V2,
              root: "root",
              nodes: [{ id: "root", component: "Stack", source: "prewired" }],
            },
          };
          // Dry-run the fork BEFORE persisting the base, so a bad baseline
          // never strands an empty app.
          forkOnto(minted);
          await apps.put(appRecordInput(minted, ctx.principal.subject));
          await reportLifecycle("create", minted.id, ctx);
          // Re-read the stored row: persistEdit's concurrency check compares
          // against the store's own JSON round-trip of the document (a jsonb
          // store may normalize key order), never the in-memory original.
          previous = await requireOwned(minted.id, ctx.principal.subject);
        }
        const working = forkOnto(previous);
        const version: VersionEntry = {
          at: new Date().toISOString(),
          intent: `Remix the host component "${input.slot}"`,
          rung: rungFor(working),
        };
        const persisted = await persistEdit(previous, working, version, ctx.principal.subject, [input.slot]);
        await reportLifecycle("pin-fork", persisted.id, ctx, {
          slot: input.slot,
          baseHash: baseline.hash,
        });
        const componentName = pinComponentName(input.slot);
        const result: PinForkResult = {
          app: persisted,
          version: { ...version },
          slot: input.slot,
          componentName,
        };
        const instruction = input.instruction?.trim();
        if (instruction === undefined || instruction.length === 0) return result;
        // The instruction reaches the model ALREADY SCOPED: the fork exists,
        // so this is an ordinary island edit on the pinned component. A failed
        // edit never rolls the fork back — the user keeps the faithful copy
        // and the failure is loud on the result. That holds for THROWN edits
        // too (no model configured, a gated escalation, a provider error):
        // the fork is already persisted, so the gesture returns it with a
        // failure-shaped edit instead of surfacing as an error.
        try {
          const edit = await runtime.edit(
            persisted.id,
            `The remixable host slot "${input.slot}" is already forked into the generated component "${componentName}" (its island source is in CURRENT_APP). Apply this change to that component: ${instruction}`,
            ctx,
          );
          return { ...result, app: edit.app, edit };
        } catch (error) {
          return {
            ...result,
            edit: failedEdit(persisted, instruction, [error instanceof Error ? error.message : String(error)]),
          };
        }
      },

      async rebase(input, ctx) {
        if (config.model === undefined) {
          throw new VendoError("not-implemented", "generation requires a model");
        }
        const app = await requireOwned(input.appId, ctx.principal.subject);
        const pin = (app.pins ?? []).find(({ slot }) => slot === input.slot);
        if (pin === undefined) {
          throw new VendoError("not-found", `pin not found: ${input.slot}`);
        }
        const baseline = (config.pinBaselines ?? []).find(({ slot }) => slot === input.slot);
        if (baseline === undefined) {
          throw new VendoError("conflict", `pin ${input.slot} has no captured baseline to rebase onto; re-run vendo sync`);
        }
        if (baseline.hash === pin.base) {
          throw new VendoError("conflict", `pin ${input.slot} is not drifted`);
        }
        // Replay rides the tree edit dialect; a graduated http app routes every
        // instruction to the code path, so its trail can no longer replay.
        if (app.ui === "http") {
          throw new VendoError("conflict", `pin ${input.slot} cannot rebase on a served (http) app`);
        }
        const intents = (await history.pinIntents(app.id, input.slot)).map(({ intent }) => intent);
        // No recorded fork intent means the trail cannot vouch for the fork's
        // content (e.g. the pin arrived via an app fork or import, which start
        // an empty history). A mechanical re-fork would silently discard the
        // user's remix, so fail closed instead.
        if (intents.length === 0) {
          throw new VendoError("conflict", `pin ${input.slot} has no recorded edit trail to replay; remix the updated component manually`);
        }
        // intents[0] is the forking edit by construction: the first edit that
        // can touch a slot is the fork-pin that creates it, and undo removes a
        // reverted fork's intent. Re-forking is mechanical (the captured
        // baseline source is copied through `pinForkSource`, exactly like
        // fork-pin), so replay starts after it.
        const replayIntents = intents.slice(1);
        const componentName = pinComponentName(input.slot);
        // ENG-348 — same bar as fork-pin: a baseline the jail could never
        // render must not persist as a "successful" rebase.
        const forkSource = pinForkSource(baseline.source);
        if (!hasDefaultExport(forkSource)) {
          throw new VendoError("conflict", `pin ${input.slot} baseline has no default export and no detectable named component export; export the component from its module and re-run vendo sync`);
        }
        let working: AppDocument = structuredClone(app);
        working.components = { ...(working.components ?? {}), [componentName]: forkSource };
        working.pins = (working.pins ?? []).map((candidate) => candidate.slot === input.slot
          ? { ...candidate, base: baseline.hash }
          : candidate);
        const replayed: string[] = [];
        const failedRebase = (intent: string, issues: string[], remaining: string[]): PinRebaseResult => ({
          status: "failed",
          slot: input.slot,
          baseHash: baseline.hash,
          replayed: [...replayed],
          failed: { intent, issues },
          remaining,
        });
        for (const [index, intent] of replayIntents.entries()) {
          const generated = await engine.edit(
            { app: structuredClone(working), instruction: intent },
            generationDependencies(config, config.model, await generationToolContext(ctx)),
          );
          const remaining = replayIntents.slice(index + 1);
          if (generated.kind === "failure") {
            return failedRebase(intent, [...generated.issues], remaining);
          }
          const next: AppDocument = { ...structuredClone(generated.document), id: app.id };
          if (next.tree !== undefined) stripServerAuthoritativeFields(next.tree);
          const survived = (next.pins ?? []).some((candidate) =>
            candidate.slot === input.slot && candidate.base === baseline.hash)
            && next.components?.[componentName] !== undefined;
          if (!survived) {
            return failedRebase(intent, ["replayed intent removed the rebased pin or its component source"], remaining);
          }
          working = next;
          replayed.push(intent);
        }
        const validation = validateAppDocument(working);
        if (!validation.ok) {
          throw new VendoError("validation", validation.error.message);
        }
        const version: VersionEntry = {
          at: new Date().toISOString(),
          intent: `Rebase remixed ${input.slot} onto the updated host component`,
          rung: rungFor(working),
        };
        // The rebase version appends NO pin intent of its own: its content is
        // exactly the replayed trail on the new baseline, and replaying a
        // "rebase" instruction through the model on a future rebase would be
        // meaningless. Undo of this version therefore removes no intents.
        const persisted = await persistEdit(app, working, version, ctx.principal.subject, []);
        await reportLifecycle("pin-rebase", app.id, ctx, {
          slot: input.slot,
          fromBaseHash: pin.base,
          toBaseHash: baseline.hash,
          replayedIntents: replayed.length,
        });
        return {
          status: "rebased",
          app: persisted,
          version: { ...version },
          slot: input.slot,
          baseHash: baseline.hash,
          replayed,
        };
      },
    },

    machine: {
      async provision(appId, ctx) {
        const app = await requireOwned(appId, ctx.principal.subject);
        const alreadyProvisioned = app.machine !== undefined;
        // Wave 9 — provisioning a NEW machine is experimental (typed refusal
        // while the flag is off); an already-provisioned app stays idempotent
        // here so existing apps are never stranded.
        if (!alreadyProvisioned && config.experimentalMachines !== true) {
          throw machinesDisabledError();
        }
        // Lane E — first provision is the "approve once" moment: unapproved
        // declared egress parks the approval card and refuses loudly here.
        await ensureEgressApproved(app, ctx);
        const provisioned = await lifecycle.provision(app);
        if (!alreadyProvisioned) await reportLifecycle("machine-provision", appId, ctx);
        return provisioned;
      },
      async wake(appId, ctx) {
        const app = await requireOwned(appId, ctx.principal.subject);
        // Lane E — a manifest change adding domains re-prompts at the next
        // wake: the new declaration parks a fresh card for the delta only.
        await ensureEgressApproved(app, ctx);
        return lifecycle.wake(app);
      },
      async sleep(appId, ctx) {
        const app = await requireOwned(appId, ctx.principal.subject);
        return lifecycle.sleep(app);
      },
      async editApp(appId, instruction, ctx) {
        const app = await requireOwned(appId, ctx.principal.subject);
        if (app.machine === undefined) {
          throw new VendoError("validation", `app ${appId} has not graduated; use edit to graduate it first`);
        }
        // A pre-declared unapproved egress must clear (or park) before we wake
        // the box — the wake would refuse it anyway (Lane E boxAllowlist).
        await ensureEgressApproved(app, ctx);
        const outcome = await editServerViaBox(app, instruction, ctx);
        if (!outcome.ok) {
          return { ok: false, summary: outcome.result.summary, filesChanged: outcome.result.filesChanged };
        }
        const pending = await requestEgressApproval(outcome.doc, ctx);
        return {
          ok: true,
          summary: outcome.result.summary,
          ...(outcome.result.fns === undefined ? {} : { fns: outcome.result.fns }),
          filesChanged: outcome.result.filesChanged,
          app: outcome.doc,
          ...(pending.status === "pending" ? { pendingEgress: { approvalId: pending.approvalId, domains: pending.domains } } : {}),
        };
      },
      async ping(appId, ctx) {
        const app = await requireOwned(appId, ctx.principal.subject);
        if (app.machine === undefined) {
          throw new VendoError("validation", `app ${appId} has no machine to ping`);
        }
        const wasAwake = lifecycle.peek(appId) !== undefined;
        // A ping that has to WAKE rides the same egress gate as machine.wake:
        // an unapproved declared domain must never reach the provider.
        if (!wasAwake) await ensureEgressApproved(app, ctx);
        const machine = await lifecycle.wake(app);
        // The activity signal itself: one cheap HEAD through the idle-tracked
        // wrapper. Best-effort — a failed HEAD must not fail the keepalive
        // (the wake above already proved the machine is reachable).
        await machine.request({ method: "HEAD", path: "/" }).catch(() => undefined);
        return { state: wasAwake ? "awake" as const : "woke" as const };
      },
      async destroy(appId, ctx) {
        const app = await requireOwned(appId, ctx.principal.subject);
        const cleared = await lifecycle.destroyMachine(app);
        // De-graduation retires the cached schedule state with the machine.
        await scheduleEngine.clearForApp(appId);
        if (app.machine !== undefined) await reportLifecycle("machine-destroy", appId, ctx);
        return cleared;
      },
    },

    schedules: {
      tick: (at) => scheduleEngine.tick(at),
      async sync(appId, ctx) {
        const app = await requireOwned(appId, ctx.principal.subject);
        return scheduleEngine.syncManifest(app);
      },
      report: () => scheduleEngine.report(),
    },

    secrets: {
      async exposure(appId, ctx) {
        const app = await requireOwned(appId, ctx.principal.subject); // owner-only read
        const grants = new Map((await exposure.list(appId)).map((grant) => [grant.secretName, grant]));
        return (app.secrets ?? []).map((secretName) => {
          const grant = grants.get(secretName);
          if (grant === undefined) return { secretName, status: "handle" as const };
          return grant.status === "active"
            ? { secretName, status: "exposed" as const }
            : { secretName, status: "pending" as const, approvalId: grant.approvalId };
        });
      },

      async setExposure(input, ctx) {
        // Owner-only: requireOwned throws not-found for any non-owner principal.
        const app = await requireOwned(input.appId, ctx.principal.subject);
        if (!(app.secrets ?? []).includes(input.secretName)) {
          throw new VendoError("validation", `secret not declared by app: ${input.secretName}`);
        }

        if (input.expose === false) {
          // Turning OFF is safe — revert to the Option B handle default at once.
          await exposure.revoke(input.appId, input.secretName);
          // Wave 7 — the revoked value is still baked into the box snapshot;
          // the stale marker makes the next wake rebuild env without it.
          await markMachineEnvStale(input.appId);
          await reportGuard(ctx.principal.subject, input.appId, ctx, {
            operation: "secret-exposure-set",
            secretName: input.secretName,
            expose: false,
          });
          return { status: "handles" };
        }

        // Turning ON is HIGH-RISK: route through the guard's existing critical
        // approval flow. appId is pinned in the guard ctx so the parked approval
        // is app-scoped (and, for the real guard, so an approved replay matches).
        const guardCtx: RunContext = { ...ctx, appId: input.appId };
        const decision = await config.guard.check(
          exposureCall(input.appId, input.secretName),
          exposureDescriptor(),
          guardCtx,
        );
        if (decision.action === "block") {
          throw new VendoError("blocked", decision.reason);
        }
        if (decision.action === "run") {
          // A pre-approved replay already cleared the high-risk gate — commit now.
          const approvalId: ApprovalId = decision.grantId === undefined
            ? `apr_replayed_${globalThis.crypto.randomUUID()}`
            : `apr_${decision.grantId}`;
          await exposure.putPending({
            appId: input.appId,
            secretName: input.secretName,
            owner: ctx.principal.subject,
            approvalId,
            requestedAt: new Date().toISOString(),
          });
          await exposure.activate(input.appId, input.secretName);
          // Wave 7 — same stale marker as the approval-decided commit path.
          await markMachineEnvStale(input.appId);
          await reportGuard(ctx.principal.subject, input.appId, ctx, {
            operation: "secret-exposure-set",
            secretName: input.secretName,
            expose: true,
          });
          return { status: "exposed" };
        }
        // Parked: record the pending grant against this approval; it flips to
        // active only when onApprovalDecision fires with approved=true.
        await exposure.putPending({
          appId: input.appId,
          secretName: input.secretName,
          owner: ctx.principal.subject,
          approvalId: decision.approval.id,
          requestedAt: new Date().toISOString(),
        });
        return { status: "pending-approval", approvalId: decision.approval.id };
      },
    },

    box: {
      // v2 only: the fn door rides the machine lifecycle's wake — an
      // un-provisioned app fails loudly here (graduation provisions first);
      // the dying v1 session cache never serves a box request.
      async request(appId, request, ctx) {
        const app = await requireOwned(appId, ctx.principal.subject);
        // Lane E — the fn door wakes the machine, so it carries the same
        // egress pre-flight (and re-prompt on a grown declaration) as wake.
        await ensureEgressApproved(app, ctx);
        const machine = await lifecycle.wake(app);
        // Lane E redaction guard — a box may echo its own env (fn responses
        // are host-side artifacts that reach clients and logs): scrub every
        // known secret value out of the response, and out of any error
        // message crossing this seam.
        const secretValues = await collectSecretValues(app.secrets, config.secrets);
        try {
          const answer = await machine.request(request);
          if (secretValues.size === 0) return answer;
          const text = new TextDecoder().decode(answer.body);
          const scrubbed = redactSecretText(text, secretValues);
          return {
            status: answer.status,
            headers: Object.fromEntries(Object.entries(answer.headers)
              .map(([header, value]) => [header, redactSecretText(value, secretValues)])),
            // Untouched bodies pass through byte-identical (binary safety).
            body: scrubbed === text ? answer.body : new TextEncoder().encode(scrubbed),
          };
        } catch (error) {
          if (error instanceof Error) {
            // Mutate in place so the error keeps its type, stack, and code.
            error.message = redactSecretText(error.message, secretValues);
          }
          if (error instanceof VendoError && error.detail !== undefined) {
            error.detail = redactSecretJson(error.detail, secretValues);
          }
          throw error;
        }
      },

      async redact(appId, value) {
        const record = await apps.get(appId);
        if (record === null) return value;
        const secretValues = await collectSecretValues(
          documentFromRecord(record).secrets,
          config.secrets,
        );
        return redactSecretJson(value, secretValues);
      },
    },
  };

  return runtime;
};
