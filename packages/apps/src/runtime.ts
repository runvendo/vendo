import {
  auditContext,
  VENDO_APP_BUILD_FAILED_PREFIX,
  VENDO_TREE_FORMAT,
  VendoError,
  checkBindingShapes,
  compilePlan,
  compileWire,
  deriveShapeCard,
  describeShapeWithSemantics,
  effectiveAppBuildUiDeadlineMs,
  effectiveBuildWatchdogMs,
  encodeGrantPrincipal,
  safeErrorMessage,
  type AccessLevel,
  type AppAccess,
  type AppDocument,
  type AppId,
  type AppPlan,
  type Principal,
  type Json,
  type PlanDisplay,
  type RunContext,
  type ScreenAssembler,
  type ApprovalId,
  type ShapeType,
  type StoreAdapter,
  type ToolCall,
  type ToolDescriptor,
  type Tree,
  type UIPayload,
  type VendoRecord,
  type WireCompileResult,
} from "@vendoai/core";
import type { LanguageModel } from "ai";
import { createAccessSurface } from "./access-surface.js";
import { createAgentTools } from "./agent-tools.js";
import { createAppData } from "./app-data.js";
import { createInClientSurface } from "./inclient-surface.js";
import { createPinsSurface } from "./pins-surface.js";
import { createReviewSurface } from "./review-surface.js";
import type { AppsRuntimeContext } from "./runtime-context.js";
import { commitApp } from "./app-source.js";
import { appLifecycleEvent } from "./audit.js";
import { createAppCaller } from "./call.js";
import { createParkedActions } from "./parked-action.js";
import { placementStore, type PlacementRow } from "./placements.js";
import { createAppFloor, floorChecks } from "./checking/floor.js";
import {
  asPayload,
  asTree,
  prewarmModels,
  snapshotDesignRules,
  type GenerationDependencies,
} from "./engine.js";
import {
  escalatedServer,
  runServerLane,
  type BoxSeam,
  type ServerFunction,
} from "./generation/lanes.js";
import { skeletonFromPlan } from "./generation/skeleton.js";
import type { Finding } from "./checking/types.js";
// The `validate` verb IS the shipped floor plus the shipped create validation,
// called rather than re-derived — so the verb and generation can never disagree
// about whether a document is sound.
import { createCheckingLayer, judgmentRules } from "./checking/layer.js";
import { queryEvidence } from "./checking/evidence.js";
import { reviewerCheck } from "./checking/reviewer.js";
import { UNSTORED_APP_ID, validateCompiledCreate } from "./generation/validation/validate.js";
import { wireCompileOptionsFor } from "./wire-options.js";
import { createAppHistory, type PinIntentKind } from "./history.js";
import { createInClientApprovals } from "./inclient.js";
import { createAppInterchange } from "./interchange.js";
import { createMachineLifecycle } from "./machine-lifecycle.js";
import { createFnCaller } from "./fn.js";
import {
  pushBoxEnv,
  readBoxManifest,
  requestAppWithBootRetry,
  runBoxEdit,
  type BoxEditResult,
} from "./box-agent.js";
import { appMemoryBrief, rememberedMemory } from "./app-memory.js";
import { parseVendoManifest } from "./manifest.js";
import { createAppOpener, createProgressiveQueryResolver, stripServerAuthoritativeFields } from "./open.js";
import { appRecordInput, documentFromRecord, enabledAfterDocumentEdit, listAllRecords, nextEnvStaleAt, rowFromRecord, updateAppRow, withoutSession, type AppRecordWrite } from "./persistence.js";
import { classifyLegacyPlacements, detectPinDrift, pinComponentName } from "./pins.js";
import { createReviewLifecycle } from "./review.js";
import { collectSecretValues, redactSecretJson, redactSecretText } from "./redaction.js";
import {
  boxAllowlist,
  createEgressApprovals,
  normalizeEgressDomain,
  unapprovedEgress,
} from "./egress-approval.js";
import { createManifestTriggers } from "./manifest-triggers.js";
import { createSecretExposure, type SecretExposureGrant } from "./secret-exposure.js";

// 06-apps §1 — the block's type surface moved to types.ts (the contract and its
// implementation used to sit ~2,000 lines apart in this file). Re-exported here
// because `./runtime.js` is where the package's existing importers name them.
export type {
  AppsConfig,
  AppsRuntime,
  AuthoredAppResult,
  BoxRequest,
  BoxResponse,
  EditFailure,
  EditResult,
  MachineEditResult,
  OpenSurface,
  PinForkInput,
  PinForkResult,
  PinRebaseResult,
  PlacementEntry,
  SecretExposureState,
  SetExposureResult,
  VersionEntry,
} from "./types.js";
import type {
  AppsConfig,
  AppsRuntime,
  BoxRequest,
  BoxResponse,
  EditResult,
  PlacementEntry,
  VersionEntry,
} from "./types.js";

/** The non-empty name a failed build record ships under (open() ignores it —
 *  the embed's title rides the app-ref — but validateAppDocument requires one).
 *  Collapsed and capped like the pack's fast-return title. */
const fallbackAppName = (prompt: string): string => {
  const collapsed = prompt.replace(/\s+/g, " ").trim();
  if (collapsed.length === 0) return "Vendo app";
  return collapsed.length > 60 ? collapsed.slice(0, 60) : collapsed;
};

/** The two ways assembly comes back with nothing, said the same way wherever the
 *  seam is entered — `vendo_make`'s front door and the public create/edit API are
 *  the same engine now, so they must not grow two vocabularies for one failure. */
export const NO_ASSEMBLER = "nothing in this deployment builds screens.";
export const NOTHING_RENDERABLE = "what came back wasn't something I could show.";
/** The one capability gap a person can act on, in their terms — no flag name and
 *  no adapter name. An escalation is a request for the box, and a deployment with
 *  no sandbox has no box to give it. */
export const NO_MACHINE = "That one needs a real build — code running on a server — and I can't do that here.";

/** 0.4.5 E2E cert (defect D) — the terminal record the build watchdog writes
 *  when a create neither persisted an app nor a failure inside its window:
 *  the one class the in-band catch cannot cover (a build task that hangs or
 *  dies without ever settling). */
/** One finding as an operator log line. `where` is optional — a check judging the
 *  whole app may have no locus to name — so it is only printed when there is one,
 *  never as the string "undefined". */
const findingLine = (finding: Finding): string =>
  `[vendo] gen ${finding.severity}${finding.where === undefined ? "" : ` ${finding.where}`}: ${finding.message}`;

/**
 * The commit gate moved. `blockedBy` / `notShipped` and their two lead
 * paragraphs lived here because the pipeline ran the checking layer INSIDE
 * create and edit and then refused at this commit path. Both doors are the
 * screen assembler now, and the assembler's saves land through `authored`
 * behind the paint seam's own floor (`AppsRuntime.floor`) — which runs for every
 * author rather than only for apps this package built. Deleted 2026-08-06 with
 * zero callers; what the person reads on a refusal is the engine's own reason,
 * verbatim, rather than a lead paragraph wrapped around it.
 */
const BUILD_WATCHDOG_REASON =
  "the build never finished — the server-side build task stalled or died without reporting a "
  + "failure. Retry the request; if this repeats, check the host server log.";

/** Test seam and operator escape hatch, mirroring turn-liveness: the window a
 *  create has to persist SOMETHING (app or failure) before the watchdog writes
 *  the terminal failed record. Shared with the UI polling cutoff through
 *  @vendoai/core's build-deadlines module (speed-core lane), so the client
 *  always outlasts the watchdog and renders its record instead of the generic
 *  deadline beat. */
const buildWatchdogMs = effectiveBuildWatchdogMs;

/**
 * Provider quota/billing language, and ONLY that. A quota claim is a statement
 * about the host's ACCOUNT and it is non-retryable, so a false positive tells
 * the person two lies at once — that they owe money, and that waiting helps.
 * The pattern used to include the bare words "insufficient" and "payment",
 * which are ordinary app and tool vocabulary: demo-bank's inventory carries
 * `host_listScheduledPayments`, so every finding that quoted the host tools
 * (checking/facts.ts) classified as a quota exhaustion (observed live
 * 2026-08-03, wave E2E). Word boundaries keep tool and field names out —
 * `host_getBilling` and `billing_id` have no boundary at the match edge —
 * and `insufficient_quota` (OpenAI's own code, where `_` is a word character)
 * is named explicitly for the same reason.
 *
 * Deliberately NOT here: "rate limit exceeded". A 429 rate limit clears in
 * seconds, so calling it a non-retryable quota exhaustion would just be a
 * different lie; it stays a retryable generic failure. OpenAI's quota refusal
 * also arrives as a 429 but carries `insufficient_quota`, which is matched.
 */
const QUOTA_SIGNAL = /\bquota\b|insufficient_quota|\bbilling\b|\b402\b/i;
const TIMEOUT_SIGNAL = /time?d?\s*out|timeout|abort/i;
/** The engine's stream-catch marker (generation/engine.ts askModel). It is the
 *  ONLY thing that distinguishes a provider's own error line from a validation
 *  finding once both are strings in the terminal throw's `issues`. */
const MODEL_ERROR_PREFIX = /^model generation failed: /;
/** The dev-model's own no-usable-credential lines (missing provider package,
 *  no key at all, or a key the provider REFUSED). These are written by Vendo,
 *  not a provider — the ONE failure class whose full message IS the honest
 *  reason, so it surfaces verbatim instead of collapsing to "generation failed"
 *  (0.4.x E2E: the surface said {code:"validation"} while the actionable
 *  `npm install @ai-sdk/...` line landed only in the operator terminal; the
 *  same swallowing was measured again 2026-08-03 for the 401 lines, where the
 *  generic reason was ALSO wrongly retryable — a revoked key fails identically
 *  on every retry). Anchored to the exact shapes in vendo/dev-creds
 *  (`rejectedKey`, `noModelKey`) so a provider error that merely mentions a key
 *  can never leak through. */
const MODEL_UNAVAILABLE_SIGNAL = /^(?:[A-Z][A-Z0-9_]* is set but @ai-sdk\/[\w-]+ is not installed in this app|Vendo found no model key|your [A-Za-z]+ API key was rejected \(401\)|VENDO_API_KEY was rejected by the Vendo Cloud model gateway \(401\))/;

/**
 * Map a generation-turn throw to the short, honest, NON-LEAKY reason persisted
 * on the failed app record. Only the CANNED reason is ever emitted — the raw
 * provider message is used solely to classify, never surfaced.
 *
 * The engine's stream helper catches provider errors and folds their message
 * into the `issues` of the terminal `VendoError("validation", "model could not
 * produce a valid app")`, so the raw 402/AbortError rarely propagates intact:
 * classify from a raw error when it does (quota/timeout/cloud-required), and
 * otherwise from the PREFIXED provider lines among the validation issues —
 * never from the findings beside them — defaulting to a generic generation
 * failure the user can retry.
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
  // What the PROVIDER (or the dev-model ladder) actually said, and nothing
  // else. A terminal validation throw's `issues` mix two unrelated kinds of
  // string: the engine's prefixed stream-catch lines, and the honesty gate's
  // findings — which quote the app's own content and the whole host tool
  // inventory. Classifying from the findings is how `host_listScheduledPayments`
  // became "quota exhausted". Such a throw's `message` is its own first issue
  // (runtime create, `conducted.issues[0]`), so it adds nothing but that same
  // leak and is read only when there are no issues to read.
  const detail = error instanceof VendoError && Array.isArray(error.detail)
    ? error.detail.filter((item): item is string => typeof item === "string")
    : undefined;
  const providerErrors = (detail === undefined
    ? [error instanceof Error ? error.message : String(error)]
    : detail.filter((issue) => MODEL_ERROR_PREFIX.test(issue))
  ).map((line) => line.replace(MODEL_ERROR_PREFIX, ""));
  // Vendo's own dev-model unavailable lines pass through verbatim (they are
  // the actionable fix), stripped of the engine's stream-catch prefix.
  const unavailable = providerErrors.find((line) => MODEL_UNAVAILABLE_SIGNAL.test(line));
  if (unavailable !== undefined) return { reason: unavailable, retryable: false };
  const text = providerErrors.join(" ");
  if (QUOTA_SIGNAL.test(text)) return { reason: "quota exhausted", retryable: false };
  if (TIMEOUT_SIGNAL.test(text)) return { reason: "timed out", retryable: true };
  return { reason: "generation failed", retryable: true };
};

const allRecords = (store: StoreAdapter, refs: Record<string, string>): Promise<VendoRecord[]> =>
  listAllRecords(store.records("vendo_apps"), { refs });

const rungFor = (
  app: AppDocument,
  declared?: VersionEntry["rung"],
): VersionEntry["rung"] => {
  // execution-v2 Wave 4 — a machine-served surface is layer 3 (the layer ladder);
  // rung 4 remains only for the retired v1 `server`-backed http shape.
  if (app.ui === "http") return app.machine !== undefined ? 3 : 4;
  // execution-v2 — a machine (Wave 1 Lane B) is layer 2, exactly like the
  // retired v1 `server`; presence, never a stored rung, is the source of truth.
  if (app.machine !== undefined || app.server !== undefined) return declared === 3 ? 3 : 2;
  return 1;
};

/** Resolve a value-or-provider config slot. The provider (function) form is
 *  called ONCE here — generationDependencies runs once per create/edit — so
 *  theme/semantics match designRules' "re-read per generation" contract
 *  and a first-request cloud-backed provider never does I/O at compose time. */
const resolveProvider = <T>(slot: T | (() => T | undefined) | undefined): T | undefined =>
  typeof slot === "function" ? (slot as () => T | undefined)() : slot;

const generationDependencies = (
  config: AppsConfig,
  model: LanguageModel,
  toolContext: Pick<GenerationDependencies, "tools" | "toolShapes">,
): GenerationDependencies => {
  const theme = resolveProvider(config.theme);
  const semantics = resolveProvider(config.semantics);
  return snapshotDesignRules({
    model,
    catalog: config.catalog,
    ...(theme === undefined ? {} : { theme }),
    designRules: config.designRules,
    pinBaselines: config.pinBaselines,
    ...(semantics === undefined ? {} : { semantics }),
    ...toolContext,
    ...(config.pipeline === undefined ? {} : { pipeline: config.pipeline }),
  });
};

/** v2 spec §1 — assemble the emitted payload: the tree plus document islands
 *  at payload level (the renderer lifts them into the shared walk). Exported for
 *  the harness runtime's hot-path render seam, which must produce the IDENTICAL
 *  payload shape this emitter does. */
export const assembleTree = (source: {
  tree: UIPayload | Tree;
  components?: Record<string, string>;
  /** W4b — the stamped per-island tool manifests ride beside the sources. */
  componentTools?: Record<string, string[]>;
  /** The plan's arrival posture (redesign spec §5): inline card or opened stage.
   *  It is assembled HERE rather than at either emitter so the in-process
   *  generation and the harness render seam cannot disagree about the field.
   *  Absent stays absent — the client reads that as inline. */
  display?: PlanDisplay;
}): Tree => ({
  ...structuredClone(source.tree),
  ...(source.components === undefined ? {} : { components: structuredClone(source.components) }),
  ...(source.componentTools === undefined ? {} : { componentTools: structuredClone(source.componentTools) }),
  ...(source.display === undefined ? {} : { display: source.display }),
} as Tree);

/**
 * §1.6 files-first — the app a harness wrote as `app.vendo`, as a document.
 *
 * The tree, the name and the islands are the model's; on an app that ALREADY
 * exists, everything else — trigger, storage, machine, pins, description, the
 * egress grant — is the app's own history and survives untouched. That is
 * exactly `documentFromEdit`'s rule (generation/validation/validate.ts), applied
 * without a model, because saving a file is not a generation.
 *
 * `componentTools` is deliberately NOT stamped: stamping is island admission's
 * job (`prepareIslands`, behind the checking floor), and a manifest invented here
 * would either lie about the sources or carry the PREVIOUS version's islands. Left
 * absent, the renderer derives each island's tool surface from the source it was
 * handed — the pre-stamped rule, and the same posture the mid-turn paint already
 * has (the seam emits raw compiled islands too).
 */
const authoredDocument = (
  appId: AppId,
  compiled: WireCompileResult,
  previous: AppDocument | undefined,
): AppDocument => {
  const name = compiled.name?.trim();
  const document: AppDocument = {
    ...(previous === undefined ? { format: "vendo/app@1" as const } : structuredClone(previous)),
    id: appId,
    // A save mid-build often has no name yet, and the stored name is the app's
    // title in the person's list — so an unnamed document keeps whatever title
    // the app already had rather than losing it.
    name: name === undefined || name === "" ? previous?.name ?? "Untitled app" : name,
    ui: "tree",
    tree: asPayload(structuredClone(compiled.tree)),
  };
  // documentFromEdit's pinned/model split: a PINNED component's source is host
  // source captured on the furnishing trust path, backing a `pins` row that is the
  // app's own history — not a file save's to drop. The compile still wins for a
  // name it does carry (a pinned island IS editable through the wire); a save whose
  // text omits it keeps the stored source, because `pins` carries on naming it and
  // a pin whose source is gone is not a pin (pins.ts demotes it).
  const pinned = new Set((previous?.pins ?? []).map((pin) => pinComponentName(pin.slot)));
  const carried = Object.entries(previous?.components ?? {})
    .filter(([name]) => pinned.has(name) && compiled.components[name] === undefined);
  const components = { ...Object.fromEntries(carried), ...compiled.components };
  if (Object.keys(components).length === 0) {
    delete document.components;
  } else {
    document.components = structuredClone(components);
  }
  delete document.componentTools;
  // The same rule at rest as at serve time (create's own line): a model-forged
  // venue verdict or drift report is never persisted, and a file save can never
  // resurrect a terminal build failure.
  if (document.tree !== undefined) stripServerAuthoritativeFields(document.tree);
  delete document.buildFailed;
  return document;
};

const pinnedSubtree = (app: AppDocument, componentName: string): unknown[] => {
  if (app.tree?.formatVersion !== VENDO_TREE_FORMAT) return [];
  const tree = app.tree as unknown as Tree;
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

  const reportGuard = async (
    principalSubject: string,
    appId: AppId,
    // Every field the ROW depends on is named here. It used to stop at
    // venue/presence/trigger, and `turnId` survived only because every caller
    // happens to hand over a whole ctx — so the first caller to pass a literal
    // would have dropped it silently. Naming it makes that a typecheck failure.
    ctx: Pick<RunContext, "venue" | "presence" | "trigger" | "turnId">,
    detail: Record<string, Json>,
  ): Promise<void> => {
    await config.guard.report(
      appLifecycleEvent({ kind: "user", subject: principalSubject }, ctx, appId, detail),
    );
  };

  // execution-v2 — the machine lifecycle (provision/wake/sleep/destroy);
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

  /**
   * Build contract §9.3 — the ONE permission check, widened rather than
   * duplicated: the wire and the MCP door reach it through this runtime.
   *
   * Level rules: reads need `viewer`, edits `editor`, delete/share `owner`.
   * With no `appAccess` wired (the OSS single-player default) it degenerates to
   * exactly what it always was — row ownership, at every level.
   */
  const holds = async (
    appId: AppId,
    ctx: RunContext,
    level: AccessLevel,
    /** The row, when the caller already read it — `open()` and `get()` are on
        every render, so the single-player path must stay ONE read. */
    known?: VendoRecord | null,
  ): Promise<boolean> => {
    const record = known === undefined ? await apps.get(appId) : known;
    // The owner fast path. Ownership is the TOP level, so the row the caller
    // already read answers every level for its own subject — no grants query,
    // no second read. This is what keeps get()/open() at ONE store read on the
    // single-player path even with `can()` wired (which is always, under the
    // umbrella).
    if (record?.refs?.subject === ctx.principal.subject) return true;
    if (config.appAccess === undefined) return false;
    return await config.appAccess.can(ctx, level, { app: appId });
  };

  // Pins/placements split (2026-08-02) — every runtime read classifies legacy
  // rows (classifyLegacyPlacements), so drift, ship-diff, export, and the wire
  // all see fork provenance in `pins` and slot placement in `placements`; the
  // next persistEdit writes the classified document, normalizing the row.
  const owned = async (
    appId: AppId,
    ctx: RunContext,
    level: AccessLevel = "editor",
  ): Promise<AppDocument | null> => {
    const record = await apps.get(appId);
    if (record === null || !(await holds(appId, ctx, level, record))) return null;
    return classifyLegacyPlacements(documentFromRecord(record), config.pinBaselines);
  };

  /** Build contract §9.6 — the ONE Cloud gate on this block. Sharing is
      multi-party coordination, so the writes that create it need a key; the
      enforcement half (`can()`) is OSS and never key-conditional, which is why
      only these three verbs consult this. */
  const requireMultiParty = (what: string): void => {
    if (config.multiParty !== true) {
      throw new VendoError(
        "cloud-required",
        `${what} needs Vendo Cloud: set VENDO_API_KEY (or pass a hosted store) — apps you own alone keep working without it`,
      );
    }
  };

  /** Only the WRITE verbs reach this: an unwired seam is an absence, and the
      reads (`levelFor`, `list`) report it as ownership + an empty list rather
      than as something to go buy. */
  const requireAccess = (): AppAccess => {
    if (config.appAccess === undefined) {
      throw new VendoError("cloud-required", "this deployment has no app-access store wired");
    }
    return config.appAccess;
  };

  /** Build contract §9.2 — the grant-principal encodings THIS ctx satisfies.
      Derived from the asserted memberships alone, so a team the host did not
      assert this request simply is not in the list. Through core's ONE encoder,
      so a query here can never miss a shape a surface wrote. */
  const grantPrincipalsOf = (ctx: RunContext): string[] => {
    const encodings = [encodeGrantPrincipal({ kind: "user", subject: ctx.principal.subject })];
    for (const membership of ctx.memberships ?? []) {
      encodings.push(encodeGrantPrincipal({ kind: "org", org: membership.org }));
      for (const team of membership.teams ?? []) {
        encodings.push(encodeGrantPrincipal({ kind: "team", org: membership.org, team }));
      }
    }
    return encodings;
  };

  /** The app rows this caller reaches WITHOUT owning them: their grant rows,
      plus every app held by an org they administer (implicit owner, §9.3).
      `can()` re-decides each one — this only narrows what to ask about. */
  const grantedRecords = async (ctx: RunContext, already: Set<string>): Promise<VendoRecord[]> => {
    if (config.appAccess === undefined) return [];
    const ids = new Set<string>();
    const found: VendoRecord[] = [];
    for (const principal of grantPrincipalsOf(ctx)) {
      for (const row of await listAllRecords(config.store.records("vendo_app_grants"), { refs: { principal } })) {
        const appId = (row.data as { appId?: string }).appId;
        if (appId !== undefined && !already.has(appId)) ids.add(appId);
      }
    }
    for (const membership of ctx.memberships ?? []) {
      if (membership.admin !== true) continue;
      for (const row of await allRecords(config.store, { subject: membership.org })) {
        if (!already.has(row.id)) found.push(row);
      }
    }
    for (const record of await listAllRecords(apps, { ids: [...ids] })) {
      if (!found.some((row) => row.id === record.id)) found.push(record);
    }
    // The grant/admin sets can overlap the caller's own rows only through a
    // doctored row; `can()` below is still the authority on every one of them.
    const visible: VendoRecord[] = [];
    for (const record of found) {
      if (await holds(record.id, ctx, "viewer")) visible.push(record);
    }
    return visible;
  };

  /** §9.4's posture in one place: what the caller cannot even VIEW stays
      `not-found` (existence-masking, as ever); a proven viewer denied a
      stronger action gets `forbidden`, which is what the fork offer renders. */
  const requireOwned = async (
    appId: AppId,
    ctx: RunContext,
    level: AccessLevel = "editor",
  ): Promise<AppDocument> => {
    const app = await owned(appId, ctx, level);
    if (app !== null) return app;
    if (level !== "viewer" && await holds(appId, ctx, "viewer")) {
      throw new VendoError("forbidden", `${level} access is required for ${appId}`);
    }
    throw new VendoError("not-found", `app not found: ${appId}`);
  };

  const interchange = createAppInterchange({
    store: config.store,
    guard: config.guard,
    pinBaselines: config.pinBaselines,
    requireOwned,
  });

  // ENG-345 — turning a secret ON is a HIGH-RISK approval reusing the guard's
  // existing confirmEach-approval flow: check() with a confirmEach descriptor parks an
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
    confirmEach: true,
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
  // confirmEach-approval flow (approval card in-client, no new ceremony types):
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
    confirmEach: true,
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
    // An egress approval is self-subject like every approval, but its EFFECT is
    // not: the decision writes `egressApproved` onto the SHARED app document and
    // binds everyone who uses the app from then on. So the ask belongs to a
    // caller who can CHANGE the app — which is what this module has always said
    // it records (`EgressApprovalRequest.owner`: "the only principal who may
    // approve"). Two doors reach here at viewer level (§9.8's `serve` and
    // `machine.ping`), and they parked a card in the viewer's name. They now
    // refuse in the same words a ctx-less wake does, and wait for an editor.
    const undecided = unapprovedEgress(app);
    if (undecided.length > 0 && !(await holds(app.id, ctx, "editor"))) {
      throw new VendoError(
        "blocked",
        `machine egress is not approved for: ${undecided.join(", ")}`
        + " — only someone who can change this app can approve it",
        { unapprovedDomains: undecided },
      );
    }
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
        ? "Edit was not applied. Retry vendo_make with the same `app` and a narrower request; do not rebuild the app."
        : "Edit was not applied and cannot be retried until the reported blocker is resolved.",
    },
  });

  /**
   * Build contract §9.9 — the ONE announcement every change to what an app IS
   * passes through, so lane H's sponsorship invalidation hears about a
   * third-party change without a second write path to police. Called by
   * `persistEdit` and by `undo` (which writes the row itself, in the history
   * module, and so cannot go through persistEdit). The change has ALREADY
   * landed: a listener that throws must never unwind it.
   */
  const reportDocumentEdit = async (
    previous: AppDocument,
    next: AppDocument,
    subject: string,
  ): Promise<void> => {
    if (config.onDocumentEdit === undefined) return;
    try {
      await config.onDocumentEdit(previous, next, subject);
    } catch (error) {
      console.warn(`[vendo] onDocumentEdit hook failed for ${next.id}: ${safeErrorMessage(error)}`);
    }
  };

  /**
   * The undo point an append already spent, deleted because the write it was
   * appended FOR never landed. `undo()` restores the latest snapshot
   * unconditionally, so an orphan version is a loaded gun: its snapshot predates
   * the concurrent change a refusal just preserved. Cleanup failure is logged,
   * never thrown — the refusal is what the caller must hear about.
   */
  const discardVersion = async (appId: AppId, versionId: string): Promise<void> => {
    try {
      await history.discard(appId, versionId);
    } catch (error) {
      console.error(`[vendo] a refused write left an undo point behind (${appId}): ${safeErrorMessage(error)}`);
    }
  };

  /** The 50-version cap, applied once the write its newest version records has
   *  LANDED — see `AppHistoryAccess.prune` (history.ts) for why it cannot live
   *  inside the append. Failure is logged, never thrown: the save is real, and one
   *  entry over the cap is not worth turning it into an error. */
  const pruneHistory = async (appId: AppId): Promise<void> => {
    try {
      await history.prune(appId);
    } catch (error) {
      console.error(`[vendo] history for ${appId} could not be trimmed to its cap: ${safeErrorMessage(error)}`);
    }
  };

  const persistEdit = async (
    previous: AppDocument,
    app: AppDocument,
    version: VersionEntry,
    subject: string,
    pinSlots?: readonly string[],
    options: {
      /** An edit that AUTHORED the trigger arms it in the same write (the
       *  server lane's automation path); every other edit keeps the
       *  disarm-on-trigger-change rule below. */
      armTrigger?: boolean;
      /** `"fork"` on the fork gesture's own version — the ONE pin intent that
       *  vouches for the pinned source having started as the captured baseline,
       *  which is what `pins.rebase` replays the rest of the trail onto. Every
       *  other write records a replayable `"edit"`. */
      pinIntentKind?: PinIntentKind;
    } = {},
  ): Promise<AppDocument> => {
    // Build contract §9.5 — the ROW's subject, which for a promoted app is the
    // org id, not the editor. The routing door pins `WHERE id AND subject`, so
    // writing the editor here would silently lose every org edit; `can(editor)`
    // upstream is what authorized this write, and the row keeps its owner.
    const rowSubject = (await apps.get(previous.id))?.refs?.subject ?? subject;
    // Best-effort optimistic concurrency. The core StoreAdapter seam (01-core §12) has
    // no compare-and-swap or transactions, so a narrow TOCTOU window between the final
    // check and the put remains — closing it fully needs a store-level revision column
    // (a store-block follow-up). This catches the common edit-vs-undo / double-edit races.
    const assertCurrent = async (): Promise<boolean> => {
      const current = await apps.get(previous.id);
      const row = current === null ? null : rowFromRecord(current);
      // `previous` came through a classifying read (owned), so the stored row
      // classifies the same way before comparing — otherwise every edit of a
      // not-yet-normalized legacy row would read as a concurrent change.
      if (row === null
        || row.subject !== rowSubject
        || JSON.stringify(classifyLegacyPlacements(row.doc, config.pinBaselines)) !== JSON.stringify(previous)) {
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
    // Same rule, same reason: the memory is written by the memory door alone, so
    // an edit carries the STORED one across rather than whatever the generated
    // document happens to hold (which, on a rebuild, is nothing).
    if (previous.memory === undefined) {
      delete app.memory;
    } else {
      app.memory = structuredClone(previous.memory);
    }
    const versionId = await history.append(
      app.id,
      previous,
      version,
      pinSlots ?? touchedPinSlots(previous, app),
      options.pinIntentKind,
    );
    let appRow: AppRecordWrite;
    try {
      const wasEnabled = await assertCurrent();
      // A changed trigger must be re-armed — enable() re-captures and re-mints trigger state.
      const enabled = options.armTrigger === true && (app.triggers ?? []).length > 0
        ? true
        : enabledAfterDocumentEdit(previous, app, wasEnabled);
      appRow = appRecordInput(app, rowSubject, enabled);
      await apps.put(appRow);
    } catch (error) {
      // The version above is an undo point to a state that never became the
      // past — see discardVersion. The refusal is re-thrown unchanged.
      await discardVersion(app.id, versionId);
      throw error;
    }
    // The write landed, so that version is real history now and the cap applies
    // to it — see pruneHistory for why this cannot happen inside the append.
    await pruneHistory(app.id);
    await reportDocumentEdit(previous, appRow.data.doc, subject);
    // A legacy row's transcript never rides a document out of the runtime. One
    // rule, every path (get/list/fork/undo strip it too), so what an edit
    // returns is exactly what a list returns.
    return withoutSession(structuredClone(appRow.data.doc));
  };

  /** A document without its id, the shape every generation module speaks. */
  const withoutId = (app: AppDocument): Omit<AppDocument, "id"> => {
    const { id: _id, ...document } = structuredClone(app);
    return document;
  };

  /**
   * The person's own words for a save THIS runtime asked the assembler for.
   *
   * `authored` is the one write path now — a runtime edit is a screen agent
   * opening the app's document, rewriting it and saving it, which is the same
   * commit any other author makes. Without this the undo point for every edit
   * would read "Saved app.vendo" and `pins.rebase` would find a trail of
   * unreplayable `touch` rows where the user's instructions used to be.
   *
   * Set for exactly the duration of one `assembleEdit`, keyed by app so two
   * concurrent edits of different apps cannot read each other's intent.
   */
  const editIntents = new Map<AppId, string>();

  /**
   * The version row an edit's own save APPENDED, keyed by app — the return leg
   * of `editIntents`.
   *
   * The row is written where the save happens (`authored`, the one write path),
   * and `edit` reports it verbatim rather than stamping a second `new Date()`:
   * two clock reads agree only inside one millisecond, so the version handed to
   * the caller otherwise differs from the one history holds whenever the two
   * straddle a tick.
   *
   * Keyed by app, like `editIntents` — so two OVERLAPPING edits of one app share
   * a slot, and the WORDS decide whose row it is (`takeEditVersion`): an edit
   * takes the entry only when its intent is the instruction that edit was given,
   * and otherwise leaves the sibling's row where it is and stamps its own
   * version exactly as this door did before any row was captured. Both misses
   * degrade to that stamp — the millisecond skew this fix removes in the
   * ordinary case — and neither can hand a caller someone else's version.
   */
  const editVersions = new Map<AppId, VersionEntry>();

  /**
   * Why an edit's own save did NOT land, keyed by app — the other return leg of
   * `editIntents`, and the only one that can say the edit failed.
   *
   * A refused save degrades rather than throws (the file is on screen, it just
   * is not in the store), and the assembler sits between that save and this
   * runtime, so `authored`'s return value cannot carry the refusal back to
   * `edit`. Without this, `assembleEdit` re-reads the row, finds the PRE-edit
   * document, and reports it as the edit — a success receipt for a change that
   * never happened.
   *
   * Keyed by app and matched on the WORDS, exactly like `editVersions`, so two
   * overlapping edits of one app cannot take each other's refusal.
   */
  const editRefusals = new Map<AppId, { intent: string; reason: string }>();

  /** THIS edit's refusal, or nothing. See {@link editRefusals}. */
  const takeEditRefusal = (appId: AppId, instruction: string): string | undefined => {
    const recorded = editRefusals.get(appId);
    if (recorded?.intent !== instruction) return undefined;
    editRefusals.delete(appId);
    return recorded.reason;
  };

  /**
   * THIS edit's captured row, or nothing.
   *
   * The intent match is the correlation: `edit` reports a version, and the only
   * version it may report is one recorded under the words it was asked to carry
   * out. A row belonging to an overlapping edit of the same app is left in the
   * map for that edit to take.
   */
  const takeEditVersion = (appId: AppId, instruction: string): VersionEntry | undefined => {
    const recorded = editVersions.get(appId);
    if (recorded?.intent !== instruction) return undefined;
    editVersions.delete(appId);
    return recorded;
  };

  /**
   * ONE instruction through the ONE builder.
   *
   * There is no second engine: the assembler opens the app's own `app.vendo`,
   * rewrites it and saves it, and the save lands through `authored` — the real
   * store write, the real floor, the real paint. So this returns nothing but the
   * row as it stands afterwards, because the row IS the answer.
   *
   * `unavailable`, a throw, and an unfilled slot are the same honest failure
   * `vendo_make` gives a create: a deployment that composed no assembler cannot
   * change an app, and pretending otherwise is how a composition bug ships.
   */
  const assembleEdit = async (
    appId: AppId,
    instruction: string,
    ctx: RunContext,
  ): Promise<
    | { kind: "assembled"; app: AppDocument }
    /** The CHANGE needs the builder — the escalation ladder, from an app that
     *  already exists. The document is untouched and still serving. */
    | { kind: "escalate" }
    | { kind: "failed"; issues: string[] }
  > => {
    if (config.screen === undefined) {
      return { kind: "failed", issues: [NO_ASSEMBLER] };
    }
    // The app's MEMORY leads the brief, for the same reason it leads the
    // in-box builder's (`editServerViaBox`): the document on screen cannot say
    // which of its shapes were asked for and which are incidental, so an editor
    // that never read it "fixes" the filter the person asked for. Composed here
    // rather than duplicated — `appMemoryBrief` is the one writer of this block.
    const before = await apps.get(appId).catch(() => null);
    const memory = appMemoryBrief(before === null ? undefined : rowFromRecord(before).doc.memory);
    editIntents.set(appId, instruction);
    // Kept even though `takeEditVersion` matches on the words: an entry no edit
    // ever took (an assembler that saved and then reported unavailable, a
    // `rebind` inside the ladder) would otherwise sit here until some later edit
    // of this app said exactly the same thing and reported that OLD row as its
    // own. Clearing can only cost a concurrent edit its captured row, and losing
    // a row means stamping the version the way this door always did.
    editVersions.delete(appId);
    editRefusals.delete(appId);
    let outcome: Awaited<ReturnType<ScreenAssembler["assemble"]>>;
    try {
      outcome = await config.screen.assemble({
        appId,
        request: memory === undefined ? instruction : `${memory}\n\n${instruction}`,
      }, ctx);
    } catch (error) {
      return { kind: "failed", issues: [safeErrorMessage(error)] };
    } finally {
      editIntents.delete(appId);
    }
    if (outcome.kind === "escalate") return { kind: "escalate" };
    if (outcome.kind === "unavailable") return { kind: "failed", issues: [outcome.why] };
    // The assembler says it saved, and the STORE may have refused that save (see
    // `editRefusals`). The row below would then read back the pre-edit document
    // and this door would report it as the edit.
    const refused = takeEditRefusal(appId, instruction);
    if (refused !== undefined) return { kind: "failed", issues: [refused] };
    // Through `requireOwned`, so what comes back is the same classified,
    // access-checked document every other door hands out — the row is the answer
    // and it must read identically wherever it is read.
    const stored = await requireOwned(appId, ctx).catch(() => undefined);
    if (stored === undefined) return { kind: "failed", issues: [NOTHING_RENDERABLE] };
    return { kind: "assembled", app: stored };
  };

  const reportLifecycle = async (
    operation: "create" | "delete" | "fork" | "promote" | "in-client-approve" | "pin-fork" | "pin-rebase" | "machine-provision" | "machine-destroy" | "place" | "unplace",
    appId: AppId,
    ctx: RunContext,
    extra: Record<string, Json> = {},
  ): Promise<void> => {
    await config.guard.report(appLifecycleEvent(ctx.principal, ctx, appId, { operation, ...extra }));
  };

  /** A slot name is host-authored and arrives from a wire body or a tool call,
   *  so it is checked here — the one place every caller passes through. */
  const requireSlot = (slot: string): string => {
    const trimmed = slot.trim();
    if (trimmed.length === 0) throw new VendoError("validation", "slot must be a non-empty string");
    return trimmed;
  };

  /**
   * B1 — the slot is claimed the moment the id EXISTS, so it shows the build
   * forming (and, if it never lands, its failure) instead of sitting empty
   * until the app record does. `place()` cannot be used: it gates on an app
   * record, and by construction there is none yet.
   *
   * Two callers, one write: `create` for a build that mints its own id, and the
   * `vendo_make` front door for the id it minted before it routed. Whichever
   * engine the ask reaches, the row is already down.
   */
  const claimSlot = async (appId: AppId, slot: string, ctx: RunContext): Promise<void> => {
    const named = requireSlot(slot);
    await placementRows.put(ctx.principal.subject, {
      slot: named,
      appId,
      placedBy: ctx.principal.subject,
      placedAt: new Date().toISOString(),
    });
    await reportLifecycle("place", appId, ctx, { slot: named });
  };

  /**
   * The terminal record for an id no engine will ever land — the front door's
   * own, for an ask that died in assembly.
   *
   * The SAME tombstone a failed build leaves (`failBuild`, inside `create`), and
   * that is the whole point: `entryFor` below reads one thing, so a claimed slot
   * turns into the honest failure card the instant either engine gives up rather
   * than holding a skeleton until the build window ages out.
   */
  const markUnbuilt = async (
    appId: AppId,
    name: string,
    reason: string,
    ctx: RunContext,
  ): Promise<void> => {
    await apps.put(appRecordInput({
      format: "vendo/app@1",
      id: appId,
      name,
      buildFailed: { reason, at: new Date().toISOString() },
    }, ctx.principal.subject));
  };

  /** Where a placed app's build stands, read off its record every time.
   *
   *  NO RECORD is the build still running — the slot is claimed at mint and the
   *  app record only lands at completion. Past the UI build window
   *  that stops being true: either the watchdog would have landed a terminal
   *  record by now, or the app was deleted out from under the row. Either way
   *  it is not forming, and a slot that says "building" forever is the exact
   *  failure the build watchdog exists to prevent. */
  const entryFor = async (row: PlacementRow, ctx: RunContext): Promise<PlacementEntry | undefined> => {
    const record = await apps.get(row.appId);
    if (record === null) {
      const forming = Date.now() - Date.parse(row.placedAt) < effectiveAppBuildUiDeadlineMs();
      return { slot: row.slot, app: row.appId, title: "", status: forming ? "building" : "failed" };
    }
    // §9.4, on the placement read too: a placement names a DOCUMENT, so its
    // title and its live build status are that document's to mask. A viewer
    // whose grant was taken back reads the slot as empty, exactly as
    // open()/get()/list() have already gone back to not-found for them.
    if (!(await holds(row.appId, ctx, "viewer", record))) return undefined;
    // Two fields off the raw row, deliberately without document validation:
    // one unparseable app must not take down every other slot's answer (the
    // same read the wire's ?pending=1 probe does).
    const doc = (record.data as { doc?: { name?: unknown; buildFailed?: unknown } } | null)?.doc;
    return {
      slot: row.slot,
      app: row.appId,
      title: typeof doc?.name === "string" ? doc.name : "",
      status: doc?.buildFailed === undefined || doc.buildFailed === null ? "ready" : "failed",
    };
  };

  /** The one mint for the `share` kind. It has existed in core since 01 §7 and
   *  had ZERO producers until sharing shipped; the activity feed's semantics
   *  already render it. Separate from `appLifecycleEvent` because that mint
   *  stamps `kind: "app-lifecycle"` and an `outcome`, and a share event carries
   *  neither. */
  const reportShare = async (
    appId: AppId,
    ctx: RunContext,
    detail: Record<string, Json>,
  ): Promise<void> => {
    await config.guard.report({
      id: `aud_${globalThis.crypto.randomUUID()}`,
      at: new Date().toISOString(),
      kind: "share",
      ...auditContext(ctx),
      appId,
      detail,
    });
  };

  // verify-v2 fixes / v2 spec §3 — shape cards from live samples: each read
  // tool is sampled once per runtime (empty input, the calling user's
  // authority — the same call the app's queries make); the derived shape
  // feeds the generation prompt and the compiler's binding type-check, and
  // the descriptor list gates query tool names. A failed sample leaves that
  // tool's shape unknown (defensive `json` per the spec).
  const sampledShapes = new Map<string, ShapeType>();
  const settledSamples = new Set<string>();
  // connect-required settles PER SUBJECT and PER TTL (review 2026-07-26): a
  // shape is host-level, but a missing account connection is one principal's
  // state — settling it globally would stop ever sampling the tool for a
  // DIFFERENT subject whose account is fine, and settling it forever would
  // never recover the shape after the SAME subject reconnects mid-boot (the
  // broker lists the toolkit as active both before and after, so the
  // connected set cannot signal the repair). Within the TTL the dead probe
  // stays quiet; after it, one probe per tool retries. Bounded like the
  // umbrella's toolkit cache.
  const CONNECT_SETTLE_TTL_MS = 10 * 60_000;
  const connectRequiredSettled = new Map<string, number>();
  const connectSettleKey = (subject: string, tool: string): string => `${subject} ${tool}`;
  const connectSettled = (subject: string, tool: string): boolean => {
    const at = connectRequiredSettled.get(connectSettleKey(subject, tool));
    return at !== undefined && Date.now() - at < CONNECT_SETTLE_TTL_MS;
  };
  const requiresInput = (descriptor: ToolDescriptor): boolean => {
    const required = (descriptor.inputSchema as { required?: unknown }).required;
    return Array.isArray(required) && required.length > 0;
  };
  const generationToolContext = async (
    ctx: RunContext,
  ): Promise<Pick<GenerationDependencies, "tools" | "toolShapes">> => {
    const descriptors = await config.tools.descriptors(ctx).catch(() => []);
    const candidates = descriptors.filter((descriptor) =>
      descriptor.risk === "read" && !requiresInput(descriptor) && !settledSamples.has(descriptor.name)
      && !connectSettled(ctx.principal.subject, descriptor.name));
    // Re-gate 2026-07-26 finding 2: a connector tool (descriptor.toolkit,
    // 01-core §4) is probed ONLY when its toolkit is connected for this
    // caller — an unconnected toolkit's probe can never yield a shape (the
    // account is missing), and on the gate hosts the ~50-tool probe burst
    // per create parked at the approval gate and tripped the call-rate
    // breaker under the create's own host reads. The connected set is
    // resolved lazily (only when a connector candidate exists) and degrades
    // to empty on failure or when the seam is not composed: probes skip,
    // the tools stay listed below.
    const connectorCandidates = candidates.filter((descriptor) => typeof descriptor.toolkit === "string");
    let connected: ReadonlySet<string> = new Set();
    if (connectorCandidates.length > 0 && config.connectedToolkits !== undefined) {
      connected = new Set(await config.connectedToolkits(ctx).catch(() => []));
    }
    await Promise.all(candidates
      .filter((descriptor) => typeof descriptor.toolkit !== "string" || connected.has(descriptor.toolkit))
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
          } else if (outcome.status === "connect-required") {
            // The broker listed the toolkit as connected but the provider has
            // no account (expired/foreign): settle for THIS subject only (and
            // only for the TTL), so the dead probe stays quiet on their next
            // creates while a different, properly connected subject still gets
            // sampled and a mid-boot reconnect recovers after the TTL.
            if (connectRequiredSettled.size > 10_000) connectRequiredSettled.clear();
            connectRequiredSettled.set(connectSettleKey(ctx.principal.subject, descriptor.name), Date.now());
          }
          // Transient errors (e.g. an unauthenticated caller) retry on the
          // next create with that caller's own authority.
        } catch {
          // Unknown shape stays defensive; the tool is still listed by name.
        }
      }));
    return {
      tools: descriptors.map(({ name, description, risk, inputSchema, outputSchema }) => ({
        name,
        description,
        risk,
        // W4 pipeline — the structured-repair payload skeleton derives from
        // the tool's input schema (mutation-without-payload fixes).
        ...(typeof inputSchema === "object" && inputSchema !== null && !Array.isArray(inputSchema)
          ? { inputSchema: inputSchema as Record<string, unknown> }
          : {}),
        // The host's own declared response shape — what the screen type check
        // reads before it falls back to a sample (checking/deps.ts).
        ...(outputSchema === undefined ? {} : { outputSchema }),
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
    "- START WARM: the universal app template is pre-baked at /opt/vendo-box/template — Vite + React 19 with @vendoai/ui (the whole Kit, at @vendoai/ui/kit) already installed, the /fn envelopes and vendo.json serving already wired, and the .vendo/run entry already written. Your FIRST action: run exactly `cp -a /opt/vendo-box/template/. /app/` (one command; it copies .vendo/run and the node_modules link too — no ls, no second cp), then go straight to editing src/App.tsx and fns.js. Only if that cp fails (older box) build from scratch.",
    "- Write real TypeScript and React — the full language, no restricted subset. `npm run typecheck` (tsc), `npm run build` (vite) and the dev server's own errors are your code validators, and all three run here in the box. Import components from \"@vendoai/ui/kit\", never from a CDN.",
    "- src/App.tsx is the app. src/main.tsx is the wiring (brand, provider, frame protocol) and you should not need to touch it. fns.js holds your POST /fn/<name> handlers; the page reaches them with `callFn` from src/fn.ts.",
    "- Serve a REAL web app on the non-/fn paths of $PORT. GET / is the entry page and must answer 200 with text/html; `node server.js` already does that from the Vite build. Keep it self-contained — the box's egress is deny-by-default, so a CDN reference is a guaranteed failed fetch.",
    "- The host's brand is applied for you (the `vendoTheme` query param and the provisioned .vendo/host/theme.json both flow through src/provision.ts onto the --vendo-* CSS variables the Kit reads). Style with those variables, never with hardcoded brand colors.",
    "- Before you report done: run `npm run validate`. Exit 0 means shippable; any other exit prints its findings on stdout and you fix them first. Then curl GET / until it answers 200 with the real content and report servesUi: true.",
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
    ctx: RunContext,
    options: { served?: boolean } = {},
  ): Promise<{ ok: true; result: BoxEditResult; doc: AppDocument; servedOk: boolean } | { ok: false; result: BoxEditResult }> => {
    const machine = await lifecycle.wake(app);
    await pushBoxEnv(machine, await lifecycle.buildAppEnv(app)).catch(() => undefined);
    // The builder in the box reads the app's memory before its own contract, for
    // the same reason the brain does: the code on that disk cannot say which of
    // its shapes were asked for and which are incidental.
    const contract = options.served === true
      ? `${skinContractPrompt(app)}\n${servedAppContractPrompt()}`
      : skinContractPrompt(app);
    const memory = appMemoryBrief(app.memory);
    const result = await runBoxEdit(machine, {
      prompt: instruction,
      context: memory === undefined ? contract : `${memory}\n\n${contract}`,
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
    // Fold the manifest's schedules into doc triggers while the box is awake and
    // its egress declaration is not yet on the doc (so this wake's allowlist
    // still passes). Best-effort — a manifest the converter cannot honor must
    // not roll back an edit that already succeeded inside the box — but never
    // SILENT: the reason is the only thing that says why nothing is scheduled.
    await manifestTriggers.sync(app, ctx).catch((error: unknown) => {
      console.warn(`[vendo] vendo.json schedules for ${app.id} were not folded into triggers: ${safeErrorMessage(error)}`);
    });
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
   * The box, as the server lane needs it. `available()` is checked BEFORE
   * anything is provisioned; `instruct()` wakes the machine, hands the in-box
   * agent the plan's reason, and — on failure — discards the live machine
   * WITHOUT snapshotting, so a failed box leaves nothing to inherit.
   *
   * Every function the box reports is SAMPLED here by actually calling it: the
   * sample is the only real shape in existence for it, because nothing declared
   * these functions up front. That is the same call the graduation path made,
   * and the same call a query-bound fn makes the moment the app opens.
   */
  const boxSeamFor = (appId: AppId, ctx: RunContext, wantsServed: boolean): BoxSeam => ({
    available: () => lifecycle.available(),
    provision: async () => {
      const app = await requireOwned(appId, ctx);
      if (app.machine !== undefined) return;
      await ensureEgressApproved(app, ctx);
      await lifecycle.provision(app);
      await reportLifecycle("machine-provision", appId, ctx);
    },
    instruct: async (instruction) => {
      const app = await requireOwned(appId, ctx);
      const box = await editServerViaBox(app, instruction, ctx, { served: wantsServed });
      if (!box.ok) return { ok: false, summary: box.result.summary };
      const current = await requireOwned(appId, ctx);
      const functions: ServerFunction[] = [];
      // A served app's PAGES are its interface: there is no tree left to bind a
      // function into, and sampling would wake the box straight back up after
      // the snapshot. Graduation ends asleep.
      for (const name of wantsServed ? [] : box.result.fns ?? []) {
        const outcome = await fnCaller.callFn(current, name, {}, ctx).catch(() => undefined);
        functions.push({
          name,
          ...(outcome !== undefined && outcome.status === "ok"
            ? { sampleOutput: outcome.output as Json }
            : {}),
        });
      }
      return {
        ok: true,
        summary: box.result.summary,
        functions,
        ...(box.result.servesUi === undefined ? {} : { servesUi: box.result.servesUi }),
        servedOk: box.servedOk,
      };
    },
  });

  /**
   * Run the server work a plan declared, on an app that is already STORED — the
   * lane lands through the ordinary edit persist, and arming a trigger whose row
   * does not exist yet would enable an automation nobody has. steps/agentic
   * author an automation on the existing engine in seconds; box provisions a
   * machine and lets the in-box agent write real code against the plan itself.
   */
  const runServerWork = async (
    input: {
      plan: AppPlan;
      /** The escalated `plan.vendo` verbatim — the box's brief (lanes.ts). */
      planText?: string;
      document: AppDocument;
      request: string;
    },
    ctx: RunContext,
    deps: GenerationDependencies,
  ): Promise<{
    document: AppDocument;
    findings: Finding[];
    automation?: EditResult["automation"];
    /** The box wrote real server code for this app (layer 2 or 3). */
    graduated?: boolean;
    /** Sentences for the caller's `issues` — a refused flip is never silent. */
    issues?: string[];
    /** The server work the plan REQUIRED could not be built, so the edit did not
     *  happen at all: a served app that never got its surface has nothing to
     *  stand on, unlike a layer-2 box whose tree still works. */
    failed?: string[];
  }> => {
    const appId = input.document.id;
    const wantsServed = input.plan.server?.served === true;
    const landVersion = (document: AppDocument): VersionEntry => ({
      at: new Date().toISOString(),
      intent: input.request,
      rung: rungFor(document),
    });
    const lane = await runServerLane(input.plan, withoutId(input.document), {
      ...deps,
      appId,
      ctx,
      // The words that started this. The automation planner decides whether the
      // ask is one MORE automation or a new version of one the app already has,
      // and the plan's `why` alone cannot tell those apart.
      request: input.request,
      ...(input.planText === undefined ? {} : { planText: input.planText }),
      box: boxSeamFor(appId, ctx, wantsServed),
      ...(config.armAutomation === undefined ? {} : { armAutomation: config.armAutomation }),
      land: async (document, options) => {
        const previous = await requireOwned(appId, ctx);
        const next: AppDocument = { ...document, id: appId };
        if (next.tree !== undefined) stripServerAuthoritativeFields(next.tree);
        await persistEdit(previous, next, landVersion(next), ctx.principal.subject, undefined, options);
      },
      // The board that shows an automation's results is a SCREEN, so the thing
      // that writes every other screen writes this one: one assembler turn over
      // the app as it stands. The row it saves is what the lane re-stamps the
      // trigger onto, so the automation can never be lost to its own rewire.
      rebind: async (instruction) => {
        const rebound = await assembleEdit(appId, instruction, ctx);
        if (rebound.kind === "assembled") return { document: withoutId(rebound.app), issues: [] };
        return {
          issues: rebound.kind === "escalate"
            ? ["the assembler asked for a build rather than rewiring the board"]
            : rebound.issues,
        };
      },
    });
    let document: AppDocument = { ...lane.document, id: appId };
    const findings = [...lane.findings];
    if (lane.automation !== undefined) {
      // The automation lane landed its own write; re-read so the caller holds
      // the stored row rather than the pre-persist copy.
      document = await requireOwned(appId, ctx);
    } else if (lane.server !== undefined) {
      // Provisioning the box wrote `machine` to the row, so the caller must hold
      // the row as it stands NOW — the pre-box copy would report an app with no
      // machine on it.
      document = await requireOwned(appId, ctx);
    }
    // ── The 2→3 surface flip ────────────────────────────────────────────────
    // The tree kept serving through the whole box build. Only NOW, with the box
    // green, does the surface change — and only on TWO independent signals: the
    // PLAN asked to be served, and the host itself fetched `GET /` and got a real
    // page. A box that self-declares a served surface on a layer-2 plan is
    // refused loudly: it must never replace a tree the person did not ask to lose.
    const issues: string[] = [];
    if (wantsServed && lane.server === undefined) {
      return { document, findings, failed: findings.map(({ message }) => message) };
    }
    if (lane.server !== undefined && (wantsServed || lane.server.servesUi === true)) {
      if (!wantsServed) {
        issues.push("the box declared a served web app, but this app's plan never asked for one — the surface flip was refused and the tree keeps serving");
      } else if (lane.server.servesUi === true && lane.server.servedOk === true) {
        const base = await requireOwned(appId, ctx);
        const flipped = structuredClone(base);
        delete flipped.tree;
        delete flipped.components;
        delete flipped.componentTools;
        delete flipped.pins;
        flipped.ui = "http";
        document = await persistEdit(base, flipped, landVersion(flipped), ctx.principal.subject, undefined, {});
      } else {
        issues.push("the box did not produce a verified served web app (GET / must answer 200 text/html) — the surface was not flipped; retry the edit");
      }
    }
    // Wave 9 — an edit that rode the ladder to an automation is an audit event
    // in its own right (the row main has carried since the ladder shipped): the
    // trigger now fires unattended, so the trail must say when it was authored.
    if (lane.automation !== undefined) {
      await reportGuard(ctx.principal.subject, appId, ctx, {
        operation: "automation-created",
        mode: lane.automation.mode,
        triggerKind: lane.automation.trigger.on.kind,
      });
    }
    // Arming's own sentences are the CALLER's, not just the log's: a trigger
    // left disarmed is the person's to fix, and the sentence names the surface
    // that fixes it. The rest of the lane's findings stay operator-side.
    const armingIssues = lane.armingIssues ?? [];
    return {
      document,
      findings,
      ...(lane.automation === undefined ? {} : { automation: lane.automation }),
      ...(lane.server === undefined ? {} : { graduated: true }),
      ...(issues.length === 0 && armingIssues.length === 0
        ? {}
        : { issues: [...issues, ...armingIssues] }),
    };
  };


  /**
   * Forward ONE already-authorized request into the app's machine. Extracted
   * because §9.8's served door and the fn door differ ONLY in the level they
   * require (`viewer` vs `editor`) — the wake, the egress pre-flight and the
   * redaction guard are identical, and a second copy of them is exactly how the
   * two would drift apart.
   */
  const forwardToBox = async (
    app: AppDocument,
    request: BoxRequest,
    ctx: RunContext,
  ): Promise<BoxResponse> => {
    // Lane E — the fn door wakes the machine, so it carries the same
    // egress pre-flight (and re-prompt on a grown declaration) as wake.
    await ensureEgressApproved(app, ctx);
    const machine = await lifecycle.wake(app);
    // Lane E redaction guard — a box may echo its own env (fn responses
    // are host-side artifacts that reach clients and logs): scrub every
    // known secret value out of the response, and out of any error
    // message crossing this seam. issue #566 — prefer the values already
    // injected into THIS box (the lifecycle's per-box cache) so a value
    // that entered the box is always redactable without a refetch that
    // could fail; only names NOT injected fall back to a best-effort read.
    const secretValues = await collectSecretValues(
      app.secrets,
      config.secrets,
      lifecycle.injectedSecretValues(app.id),
    );
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
  };

  /** What the namespace surfaces below are built from — the closure, named
   *  once. `runtime` is a thunk because `pins.fork` re-enters the public doors
   *  while this object literal is still forming. */
  const surfaceContext: AppsRuntimeContext = {
    config,
    apps,
    placementRows,
    history,
    inClientApprovals,
    review,
    holds,
    requireOwned,
    requireMultiParty,
    requireAccess,
    reviewerAsserted,
    rungFor,
    persistEdit,
    failedEdit,
    assembleEdit,
    reportGuard,
    reportShare,
    reportLifecycle,
    runtime: () => runtime,
  };

  const runtime: AppsRuntime = {
    async prewarm() {
      if (config.model !== undefined) await prewarmModels([config.model]);
    },
    async create(input, ctx) {
      if (config.model === undefined) {
        throw new VendoError("not-implemented", "generation requires a model");
      }
      // Mint before generation so every partial already carries its permanent id
      // — unless the front door already did, in which case an escalated plan's
      // skeleton and this build's paints share one stream.
      const appId = input.appId ?? `app_${globalThis.crypto.randomUUID()}`;
      const createStartedAt = Date.now();
      // B1, for a caller that minted its id HERE. The front door claims before
      // it routes (it minted earlier), so it passes no slot down.
      if (input.slot !== undefined) await claimSlot(appId, input.slot, ctx);
      // The build's dead-man switch. The catch below persists a terminal failure
      // when the build turn THROWS, but a build task that hangs (a provider
      // stream that never settles) or dies with its promise chain severed
      // settles nothing: the embed polls {kind:"pending"} forever. A timer is
      // independent of the promise chain, so it fires either way; if by then
      // NOTHING was persisted for this id, it writes the terminal failed record
      // itself so open() resolves the embed with a reason. Any persist clears
      // it; a late success after a fired watchdog overwrites the failed record —
      // self-healing, never the reverse.
      const watchdog = setTimeout(() => {
        void (async () => {
          if (await apps.get(appId) !== null) return;
          await apps.put(appRecordInput({
            format: "vendo/app@1",
            id: appId,
            name: fallbackAppName(input.prompt),
            buildFailed: { reason: BUILD_WATCHDOG_REASON, retryable: true, at: new Date().toISOString(), prompt: input.prompt },
          }, ctx.principal.subject));
          console.error(`[vendo] app build watchdog (${appId}): no app record and no failure landed within ${buildWatchdogMs()}ms — persisted a terminal failed record so the embed resolves instead of polling forever.`);
        })().catch(() => undefined);
      }, buildWatchdogMs());
      (watchdog as { unref?: () => void }).unref?.();
      const emit = (payload: Tree): void => {
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
      const generationDeps = generationDependencies(config, config.model, await generationToolContext(ctx));

      /** The terminal failed record + the classified throw, shared by a thrown
       *  build turn and an honest refusal. */
      const failBuild = async (
        reason: string,
        retryable: boolean,
        detail: readonly string[],
        code: VendoError["code"] = "validation",
      ): Promise<never> => {
        await apps.put(appRecordInput({
          format: "vendo/app@1",
          id: appId,
          name: fallbackAppName(input.prompt),
          buildFailed: { reason, retryable, at: new Date().toISOString(), prompt: input.prompt },
        }, ctx.principal.subject)).catch(() => undefined);
        clearTimeout(watchdog);
        console.error(`[vendo] app build failed (${appId}): ${reason}${detail.map((line) => `\n  - ${line}`).join("")}`);
        throw new VendoError(
          code,
          `${VENDO_APP_BUILD_FAILED_PREFIX}: ${reason}`,
          { appId, reason, retryable, issues: [...detail] },
        );
      };

      /**
       * The BRIEF this build runs on: the escalated plan, or the assembler's
       * answer to the ask.
       *
       * `input.plan` is the §4.5 hand-off — `vendo_make` already ran the
       * assembler, it escalated, and the plan it wrote is the brief. Every OTHER
       * caller of this door (the HTTP route, a seed script, a host calling
       * `apps.create` directly) starts where `vendo_make` starts, because there
       * is one engine and the seam routes, not the caller: assembly first, and a
       * build only if assembly asks for one by name.
       */
      let planText = input.plan;
      if (planText === undefined) {
        if (config.screen === undefined) {
          return failBuild(NO_ASSEMBLER, false, [NO_ASSEMBLER], "not-implemented");
        }
        let routed: Awaited<ReturnType<ScreenAssembler["assemble"]>>;
        try {
          routed = await config.screen.assemble({
            appId,
            request: input.prompt,
            ...(input.onView === undefined ? {} : { onView: (part) => input.onView?.(part) }),
          }, ctx);
        } catch (error) {
          const { reason, retryable } = buildFailureReason(error);
          const detail = error instanceof VendoError && Array.isArray(error.detail)
            ? error.detail.filter((item): item is string => typeof item === "string")
            : [];
          return failBuild(
            reason,
            retryable,
            detail.length > 0 ? detail : [safeErrorMessage(error)],
            error instanceof VendoError ? error.code : "validation",
          );
        }
        if (routed.kind === "assembled") {
          // The row is the check that "assembled" is true rather than merely
          // intended: `authored` upserts it iff the seam really compiled and
          // painted the document, so a save nobody can render leaves no row.
          const stored = await apps.get(appId).catch(() => null);
          if (stored === null) return failBuild(NOTHING_RENDERABLE, true, [NOTHING_RENDERABLE]);
          clearTimeout(watchdog);
          console.info(`[vendo] assembled app=${appId} total=${((Date.now() - createStartedAt) / 1000).toFixed(1)}s`);
          return withoutSession(documentFromRecord(stored));
        }
        if (routed.kind === "unavailable") {
          return failBuild(routed.why, true, [routed.why]);
        }
        // `escalate` — the assembler asking for the builder by name. The plan it
        // wrote is read back through the same slot `vendo_make` reads it with.
        planText = await config.escalatedPlan?.(appId, ctx).catch(() => undefined);
      }
      // Sandbox-gated, exactly where §4.5 put the gate: the build IS the box, so
      // a deployment with no machine says so instead of spending a build's
      // latency to arrive at nothing.
      if (!lifecycle.available()) {
        return failBuild(NO_MACHINE, false, [NO_MACHINE], "not-implemented");
      }

      // ── The plan is the brief ───────────────────────────────────────────────
      // No brain re-plans it: `<Server kind>` is the escalating agent's own
      // declaration (see `escalatedServer`), the skeleton is the outline already
      // on the person's screen, and the plan text travels to the box verbatim.
      const compiled = planText === undefined ? undefined : compilePlan(planText, {
        tools: (generationDeps.tools ?? []).map(({ name }) => name),
        components: config.catalog.map(({ name }) => name),
      });
      // No plan file, or one the compiler could not read: the ask is the whole
      // brief and the box is the lane, which is exactly what an escalation with
      // no `<Server>` gets. Never a lost build.
      const plan: AppPlan = compiled?.plan
        ?? { name: fallbackAppName(input.prompt), groups: [], queries: [], cannot: [] };
      const planned = { ...plan, server: escalatedServer(plan, input.prompt) };
      const skeleton = skeletonFromPlan(planned);
      let app: AppDocument = {
        format: "vendo/app@1",
        id: appId,
        name: planned.name,
        ui: "tree",
        tree: asPayload(skeleton.tree),
      };
      if (app.tree !== undefined) stripServerAuthoritativeFields(app.tree);

      // The outline reaches the screen as the app's own first paint. It is
      // already there as the plan's skeleton — this is the same tree on the same
      // stream, which is what makes the outline BECOME the app rather than being
      // replaced by a second card.
      let unsavedReason: string | undefined;
      try {
        await apps.put(appRecordInput(app, ctx.principal.subject));
      } catch (error) {
        // A persist failure degrades the app to view-only — it renders, it just
        // is not in the user's list and cannot be reopened. Far better than
        // discarding a working view, but never silent.
        unsavedReason = safeErrorMessage(error);
        console.error(`[vendo] app not saved (${appId}): the view rendered but the store rejected it — ${unsavedReason}`);
      }
      clearTimeout(watchdog);
      if (unsavedReason !== undefined) {
        // The server lane writes through the same store the persist just failed
        // on, and it assumes a stored app — so an unsaved create ends here.
        input.onUnsaved?.(unsavedReason);
        return structuredClone(app);
      }
      await reportLifecycle("create", app.id, ctx);
      try {
        const served = await runServerWork({
          plan: planned,
          ...(planText === undefined ? {} : { planText }),
          document: app,
          request: input.prompt,
        }, ctx, generationDeps);
        app = served.document;
        for (const finding of served.findings) {
          console.info(findingLine(finding));
        }
      } catch (error) {
        console.warn(`[vendo] server work skipped for ${appId} (the app stands without it): ${safeErrorMessage(error)}`);
      }
      // The streamed view parts are last-write-wins and the plan's own skeleton
      // is still the last thing painted, so the built app settles the stream. On
      // a resolver failure emit nothing rather than a data-less tree that would
      // blank the screen.
      if (input.onView !== undefined && app.tree?.formatVersion === VENDO_TREE_FORMAT) {
        const tree = assembleTree({ tree: app.tree, components: app.components, componentTools: app.componentTools });
        stripServerAuthoritativeFields(tree);
        const resolver = createProgressiveQueryResolver(caller, app, ctx);
        resolver.update(tree);
        tree.data = await resolver.complete().catch(() => tree.data ?? {});
        emit(tree);
      }
      console.info(`[vendo] gen create complete app=${appId} total=${((Date.now() - createStartedAt) / 1000).toFixed(1)}s`);
      return structuredClone(app);
    },

    async toolShapeBrief(ctx) {
      // Re-resolved on every call, which is the whole contract: the provider form
      // of `semantics` re-merges the local `tools.json` with the cloud-owned
      // overrides, and memoizing it would lock a host's annotations for the
      // lifetime of the process.
      const semantics = resolveProvider(config.semantics) ?? {};
      const { toolShapes } = await generationToolContext(ctx);
      const cards = Object.entries(toolShapes ?? {})
        .map(([tool, shape]) => `- ${tool} — shape: ${describeShapeWithSemantics(shape, semantics[tool] ?? {})}`);
      if (cards.length === 0) return undefined;
      return "TOOL RESPONSE SHAPES (what each tool really returns, with this host's own field semantics)."
        + " Bind only to fields these name, and read the annotations: :money.cents is integer CENTS,"
        + " :money.dollars whole dollars, :date.iso and :date.epoch machine dates, :enum(a|b) a closed"
        + " vocabulary, :id an opaque host identifier, :percent.ratio 0..1.\n"
        + cards.join("\n");
    },

    floor(ctx) {
      return createAppFloor({
        // Exactly the four fields the floor reads, built directly rather than
        // through `generationDependencies`: none of the pipeline's other knobs
        // (theme, design rules, fill tiers, the partial-tree seam) is a fact about
        // an app, so none of them belongs in a check's inputs. `model` rides along
        // when the deployment has one and is absent when it does not — the seam
        // never spends it either way, and the AI reviewer is `validate`'s.
        deps: async () => ({
          catalog: config.catalog,
          ...(config.model === undefined ? {} : { model: config.model }),
          ...await generationToolContext(ctx),
        }),
        ...(config.checks === undefined ? {} : { checks: config.checks }),
      });
    },

    async authored(input, ctx) {
      const record = await apps.get(input.appId);
      const row = record === null ? null : rowFromRecord(record);
      // A row that already exists belongs to whoever holds it. `/user/**` is its
      // subject's at EVERY level (core `accessForPath`), so a harness can write
      // `/user/apps/<someone-else's-id>/app.vendo` in its own mount and the
      // workspace lands the file — this is the only place that can refuse to let
      // that rewrite the other person's app. A row that does NOT exist can only
      // have come from this caller's own `/user` mount: a fresh
      // `/orgs/<org>/apps/<id>/` path has no app row to grant on, so `canCommit`
      // refuses it and the file never lands at all.
      const mayWrite = row === null || await holds(input.appId, ctx, "editor", record);
      // And refusing the WRITE is not the whole refusal: `previous` is what these
      // queries resolve against, and `fn:` routes on `app.machine` ALONE (fn.ts)
      // with no ctx — so an inherited machine ref would send this file's `fn:`
      // queries onto SOMEONE ELSE'S sandbox and hand back the answer. A file the
      // caller may not write is painted from the compile alone.
      const previous = row === null || !mayWrite
        ? undefined
        : classifyLegacyPlacements(row.doc, config.pinBaselines);
      const document = authoredDocument(input.appId, input.compiled, previous);
      if (mayWrite) {
        /** The version this save appended, while its write has not landed yet. */
        let appended: string | undefined;
        try {
          /** Whether this save is a change at all — the history entry and the §9.9
           *  announcement below are both owed only by a save that changes the app. */
          let changed = false;
          let enabled = false;
          if (previous !== undefined) {
            // `persistEdit`'s `assertCurrent` bracket, in the shape a files-first
            // save can take it. `document` carries the baseline's own history
            // forward (trigger, pins, storage, machine, description), so a put
            // computed over a row that changed in the window would silently REVERT
            // an `edit()` that landed there rather than merely ordering after it.
            // Best-effort for persistEdit's reason (no revision on the store seam),
            // and it cannot conflict with a run of same-turn saves: every save
            // re-reads its own baseline. Only ever re-reads a row this caller was
            // already authorized to read.
            const assertCurrent = async (): Promise<boolean> => {
              const current = await apps.get(input.appId);
              const stored = current === null ? null : rowFromRecord(current);
              if (stored === null
                // The subject too, for persistEdit's reason: a promote that landed
                // in the window moved the row to an org, and re-writing the stale
                // owner would lose the app out of it.
                || stored.subject !== row?.subject
                || JSON.stringify(classifyLegacyPlacements(stored.doc, config.pinBaselines)) !== JSON.stringify(previous)) {
                throw new VendoError("conflict", `app changed under this save: ${input.appId}`);
              }
              return stored.enabled;
            };
            await assertCurrent();
            // The undo point this path had none of: the state the save replaces,
            // appended before the write lands, exactly as persistEdit does it. A
            // re-save that changed nothing is not a version — it would spend one of
            // the 50 capped slots to undo to the state it is already in.
            changed = JSON.stringify(previous) !== JSON.stringify(document);
            if (changed) {
              // The person's own words when THIS runtime asked for the save
              // (`edit`, and the trail `pins.rebase` replays); "Saved app.vendo"
              // for every other author, which is all a bare file save can say.
              const intent = editIntents.get(input.appId);
              const entry: VersionEntry = {
                at: new Date().toISOString(),
                intent: intent ?? "Saved app.vendo",
                rung: rungFor(document),
              };
              // ONE clock read for this save: when the save is an `edit`'s, that
              // door reports this very row (see `editVersions`).
              if (intent !== undefined) editVersions.set(input.appId, entry);
              appended = await history.append(input.appId, previous, entry, touchedPinSlots(previous, document),
              // A "touch" for an authored save, never an "edit": that receipt
              // records THAT the save changed a pinned component and nothing
              // about what it changed. Handing "Saved app.vendo" to a rebase as a
              // replay instruction is how a file-authored remix gets overwritten
              // by the pristine host component under a "rebased" verdict (see
              // pins.rebase) — which is exactly why an edit whose intent IS the
              // person's words records the replayable kind instead.
              intent === undefined ? "touch" : "edit");
            }
            // Asserted a SECOND time, because the append is itself a store round
            // trip and the first check alone leaves it inside the TOCTOU window.
            // Its answer is also the arm bit this write must keep — read after the
            // window, never from the stale baseline row.
            enabled = enabledAfterDocumentEdit(previous, document, await assertCurrent());
          }
          const appRow = appRecordInput(
            document,
            // §9.5 — a promoted app's row subject is the ORG id; the editor check
            // above is what authorized this write, and the row keeps its owner.
            row?.subject ?? ctx.principal.subject,
            enabled,
          );
          await apps.put(appRow);
          // The write landed, so the version above is real history now: whatever
          // the announcements below do, it must not be cleaned up — and the cap
          // applies to it (pruneHistory).
          appended = undefined;
          await pruneHistory(input.appId);
          if (previous === undefined) {
            await reportLifecycle("create", document.id, ctx);
          } else if (changed) {
            // §9.9 — the ONE announcement every change to what an app IS passes
            // through (see reportDocumentEdit). A files-first rewrite changes the
            // app while leaving `trigger` verbatim, so the intent hash a sponsorship
            // was minted over is unchanged: without this, a third party's rewrite
            // leaves sponsorship ACTIVE and the automation keeps firing on the
            // sponsor's authority against code the sponsor never saw, and a
            // sponsor's own rename changes the hash with no re-bind. Partial saves
            // included — what the store holds is what fires. An identical re-save is
            // announced on neither half: invalidation is terminal, so announcing it
            // would kill a live sponsorship for nothing.
            await reportDocumentEdit(previous, appRow.data.doc, ctx.principal.subject);
          }
        } catch (error) {
          // The same degradation create takes on a refused write: the app is on
          // screen, it just is not in the list. Never silent — and never a reason
          // to withhold the data the person can already see.
          const reason = safeErrorMessage(error);
          console.error(`[vendo] app not saved (${input.appId}): the harness wrote it as a file but it did not land — ${reason}`);
          // …and when the save was an EDIT's, the refusal is that edit's answer:
          // the row still holds the pre-edit document, so `assembleEdit` reading
          // it back would report an unchanged app as the change (`editRefusals`).
          const refusedIntent = editIntents.get(input.appId);
          if (refusedIntent !== undefined) editRefusals.set(input.appId, { intent: refusedIntent, reason });
          // …and a refused save spends no undo point: the appended version's
          // snapshot predates the concurrent edit the refusal just preserved, and
          // `undo()` would write it straight over that edit (see discardVersion).
          if (appended !== undefined) await discardVersion(input.appId, appended);
          // …and a discarded version is not history, so it is not this edit's
          // answer either.
          editVersions.delete(input.appId);
        }
      }
      // The queries, through the SAME guard-bound caller `open()` resolves with:
      // one guard decision per query, this person's authority, `venue: "app"`. When
      // one FAILED, the seam is told, so the painted view says "Data didn't load"
      // instead of an empty app that looks like real, empty data.
      const queries = createProgressiveQueryResolver(caller, document, ctx);
      queries.update(asTree(document.tree));
      const data = await queries.complete();
      return { data, ...(queries.dataUnavailable() ? { dataUnavailable: true as const } : {}) };
    },

    async commitSource(input, ctx) {
      await commitApp(input.appId, input.changed, input.workspace, ctx, {
        requireOwned,
        update: (appId, mutate) => updateAppDocument(appId, mutate),
        // §9.7 — the app's ADDRESS comes from its OWNER, and the row's subject is
        // the authoritative answer (§9.5: a promoted app's row subject IS the org
        // id, verbatim). Read here, never remembered: permission cannot choose an
        // address, because an org app's editor can usually write their own `/user`
        // mount too.
        ownerOf: async (appId) => {
          const subject = (await apps.get(appId))?.refs?.subject;
          if (subject === undefined) {
            throw new VendoError("not-found", `${appId} has no row to hold its source`);
          }
          return subject;
        },
        ...(config.files === undefined ? {} : { blobs: config.files }),
      });
    },

    async get(appId, ctx) {
      const app = await owned(appId, ctx, "viewer");
      return app === null ? null : withoutSession(app);
    },

    async list(ctx) {
      const records = await allRecords(config.store, { subject: ctx.principal.subject });
      // Build contract §9.3 — owned ∪ granted. The grant rows already name the
      // apps this caller reaches, so the union is one extra id fetch rather
      // than a scan; `can()` still decides each one (a grant to a team the
      // caller is not in this request does not match).
      const granted = await grantedRecords(ctx, new Set(records.map((record) => record.id)));
      records.push(...granted);
      const documents: AppDocument[] = [];
      for (const record of records
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id))) {
        try {
          const document = classifyLegacyPlacements(documentFromRecord(record), config.pinBaselines);
          // A terminally failed build is a tombstone open() reads to resolve
          // the embed — not a real app; it never joins the listable surface.
          if (document.buildFailed !== undefined) continue;
          documents.push(withoutSession(document));
        } catch {
          // Corrupt rows cannot be surfaced, but must not hide valid owned apps.
        }
      }
      return documents;
    },

    async delete(appId, ctx) {
      const app = await requireOwned(appId, ctx, "owner");
      // execution-v2 — deleting the app reaps its machine (live sandbox +
      // stored snapshot) directly, without rewriting the doomed document: a
      // graduated tree's fn: refs would fail a machine-cleared re-validation
      // and otherwise strand the provider snapshot.
      await lifecycle.destroyResources(app);
      await manifestTriggers.clearLegacyState(appId);
      await data.clear(app, ctx.principal.subject, await history.documents(appId));
      await history.clear(appId);
      await inClientApprovals.clear(appId);
      await review.clear(appId);
      await exposure.clearForApp(appId);
      await egressApprovals.clearForApp(appId);
      await parkedActions.clearForApp(appId);
      await apps.delete(appId);
      // A deleted app can never mount again, so its placement rows are dead
      // weight — and a row with no app record reads as a build in flight, which
      // would park a skeleton in the slot until the build window elapsed and
      // then a failure card over the host's own markup. Swept by APP, not by
      // the deleter's subject: a shared app sits in slots belonging to people
      // the deleter cannot enumerate, and those pages are the ones that would
      // be left holding it.
      await placementRows.clearForApp(appId);
      await reportLifecycle("delete", appId, ctx);
    },

    async fork(appId, ctx) {
      const source = await requireOwned(appId, ctx, "viewer");
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
      // The conversation belongs to the owner who had it, not to the copy: the
      // persist already drops it (appRecordInput takes no session here), and the
      // RETURNED document must not hand it back either.
      await apps.put(appRecordInput(fork, ctx.principal.subject));
      await reportLifecycle("fork", fork.id, ctx, { sourceAppId: source.id });
      return withoutSession(structuredClone(fork));
    },

    async place(input, ctx) {
      const slot = requireSlot(input.slot);
      // Viewer: seeing the app is enough to put it in your own slot. This also
      // masks an app the caller cannot see (§9.4) before any row is written.
      await requireOwned(input.app, ctx, "viewer");
      const subject = ctx.principal.subject;
      const previous = await placementRows.place(subject, {
        slot,
        appId: input.app,
        placedBy: subject,
        placedAt: new Date().toISOString(),
      });
      const evicted = previous !== undefined && previous.appId !== input.app ? previous.appId : undefined;
      await reportLifecycle("place", input.app, ctx, {
        slot,
        ...(evicted === undefined ? {} : { evicted }),
      });
      return evicted === undefined ? {} : { evicted };
    },

    async unplace(input, ctx) {
      const slot = requireSlot(input.slot);
      const subject = ctx.principal.subject;
      const row = await placementRows.get(subject, slot);
      // Not this app's slot (any more): nothing to clear, and clearing what
      // replaced it would be a silent eviction nobody asked for. The store's
      // delete is scoped to the same app, so a place that lands between this
      // read and that write keeps the slot.
      if (row === undefined || row.appId !== input.app) return;
      await placementRows.delete(subject, slot, input.app);
      await reportLifecycle("unplace", input.app, ctx, { slot });
    },

    async placements(input, ctx) {
      // The SAME normalization every write goes through. Trimming on one side
      // only means `placements({ slots: [" hero "] })` cannot see what
      // `place(" hero ")` wrote.
      const rows = await placementRows.list(ctx.principal.subject, input.slots?.map(requireSlot));
      const entries = await Promise.all(rows.map((row) => entryFor(row, ctx)));
      return entries.filter((entry): entry is PlacementEntry => entry !== undefined);
    },

    async promote(appId, orgId, ctx) {
      requireMultiParty("promote");
      const app = await requireOwned(appId, ctx, "owner");
      // The host asserted this request's orgs; promoting into one you are not
      // in is the same refusal shape as any other over-reach on a visible app.
      if (!(ctx.memberships ?? []).some((membership) => membership.org === orgId)) {
        throw new VendoError(
          "forbidden",
          `you are not a member of ${orgId}, so this app cannot be promoted into it`,
        );
      }
      const from = (await apps.get(appId))?.refs?.subject;
      if (from === undefined) throw new VendoError("not-found", `app not found: ${appId}`);
      if (from === orgId) return withoutSession(structuredClone(app));
      if (config.promoteApp === undefined) {
        // Build contract §9.5, ruled 2026-08-01: promote is BYO-store-only for
        // now. A promote crosses subjects AND moves workspace rows, which needs
        // a local engine handle the Cloud-hosted store does not have — a
        // hosted-store promote door is Cloud-console work. The refusal stays
        // LOUD and never half-moves an app; it names the limit and the fix so
        // nobody has to read this comment to get unstuck.
        throw new VendoError(
          "cloud-required",
          "moving an app into a team workspace isn't available on the hosted store yet — "
          + "wire your own Postgres with createVendo({ store: createStore({ url }) }) to move it, "
          + "or share a copy with fork instead",
        );
      }
      // "Share implies promote", so the promoter must not lock themselves out
      // of the app they just handed over. Minted BEFORE the flip, because
      // afterwards the row belongs to the org and the owner gate on `grant`
      // would have nothing to admit them by — the promoter is not necessarily
      // an org admin.
      const promoter = encodeGrantPrincipal({ kind: "user", subject: ctx.principal.subject });
      // Mint-then-KNOW: what the promoter held BEFORE this call, so a failure
      // takes back exactly what this call added and nothing else. Inferring it
      // afterwards cannot tell "I minted this" from "someone else did".
      const heldBefore = (await config.appAccess?.list(ctx, appId))
        ?.find((row) => row.principal === promoter)?.level;
      await config.appAccess?.grant(ctx, appId, promoter, "owner");
      // The row's subject becomes the org id VERBATIM — the same convention the
      // workspace `owner` column uses (contract §3.3), so one id names the app's
      // rows and its documents alike, and the documents move with it.
      try {
        await config.promoteApp(appId, from, orgId);
      } catch (failure) {
        // All-or-nothing means undoing what THIS call did — and only that. If
        // the row no longer names `from`, a concurrent promote won: the grant
        // now admits the promoter to the app that just moved, and revoking it
        // would lock her out of her own app.
        if ((await apps.get(appId))?.refs?.subject === from && config.appAccess !== undefined) {
          const undo = heldBefore === undefined
            ? config.appAccess.revoke(ctx, appId, promoter)
            : config.appAccess.grant(ctx, appId, promoter, heldBefore);
          await undo.catch(() => undefined);
        }
        throw failure;
      }
      // Re-stamped now that the row names the org, so the grant's `org_id`
      // records the org that actually holds the app (one row per (app,
      // principal), so this updates in place rather than accreting).
      await config.appAccess?.grant(ctx, appId, promoter, "owner");
      // An automation runs with a PERSON's access — their connections, their
      // secrets, their name in the audit log — and there is no org principal to
      // run as (inventing one would run it as a synthetic user named after the
      // org). The person who armed it may not even be in the team. So the move
      // DISARMS it, the same law an edited trigger already follows; re-enabling
      // mints a fresh sponsorship under whoever turns it back on.
      const moved = await apps.get(appId);
      const movedRow = moved === null ? null : rowFromRecord(moved);
      const disarmed = movedRow?.enabled === true;
      if (disarmed) {
        await apps.put(appRecordInput(movedRow.doc, orgId, false));
      }
      await reportLifecycle("promote", appId, ctx, { orgId, from, ...(disarmed ? { disarmed } : {}) });
      return withoutSession(structuredClone(app));
    },

    access: createAccessSurface(surfaceContext),

    /**
     * No contextual projection for app self-mutation.
     *
     * Yousef's ruling (2026-07-28): an app edit does not need approval. Changing
     * your own view is not an act on the world — the static descriptors say
     * `read` for create and edit, and there is nothing per-call that should
     * raise them. What an app DOES still carries full ceremony: every host tool
     * an app calls goes through the guard on its own risk, an away run's first
     * ungranted mutating step parks the normal card, and egress needs the
     * owner's approval before a machine is provisioned.
     *
     * `undefined` means the static descriptor stands.
     */
    async agentToolRisk() {
      return undefined;
    },

    async validate(input, ctx) {
      if (config.model === undefined) {
        // The floor's fact checks read the generation dependencies, which are
        // built around a model. Nothing to hide behind: say so.
        throw new VendoError("not-implemented", "validate requires a model");
      }
      const deps = generationDependencies(config, config.model, await generationToolContext(ctx));

      if (typeof input.document === "string") {
        // Wire text, not a stored app: compile it in the PRODUCTION dialect (the
        // one every other compile of model wire uses — a compile that lacked
        // these options once failed every app built on inline tool references),
        // then run the shipped create validation. Its issues are already the
        // sentences a model can act on.
        const compiled = compileWire(
          input.document,
          wireCompileOptionsFor(deps),
        );
        const { document, issues } = await validateCompiledCreate(compiled, deps);
        if (document === undefined) {
          // Wire that did not compile, or islands that did not pass admission:
          // the screen text the floor would read does not exist yet, so those
          // sentences are the whole answer.
          return { ok: false, findings: issues.map((message) => ({ severity: "block" as const, message })) };
        }
        // …and then the SAME floor every other door runs, on the document the
        // wire assembled to.
        const findings = await createCheckingLayer({ deps, checks: floorChecks(deps) })
          .run({ document: { ...document, id: UNSTORED_APP_ID } as AppDocument, request: "" });
        return { ok: !findings.some(({ severity }) => severity === "block"), findings };
      }

      if (input.appId === undefined) {
        throw new VendoError("validation", "validate needs an appId or a document to check");
      }
      // Editor-scoped, like edit itself: checking the shape of an app you may
      // change is part of changing it, and a mere viewer is masked as ever.
      const document = await requireOwned(input.appId, ctx);
      // The SAME floor create and edit run — the seven fact checks, the host's and
      // every plugged check, AND the AI reviewer. The reviewer was the
      // piece this door was missing: without it `validate` could not see invented
      // data, dishonest tool use, dead controls or dropped work, and could not
      // apply a single one of the host's own judgment RULES, which are not code and
      // which the reviewer is the only thing that can read. The skill teaches
      // "validate after every edit — faster and surer than re-reading your own
      // work", so half a checker answering "ok" was the worst lie available here.
      //
      // Composed exactly as `conductor.ts`'s `checkingFor` composes it, including
      // deriving the rubric with the same function the layer exposes it with, so the
      // rubric the reviewer reads and `layer.rubric` cannot diverge. Fail-open is
      // unchanged: silence, a refusal and a failed request all mean no findings.
      //
      // `samples` are the app's OWN queries, run (`queryEvidence`). This door used
      // to pass none, on the reasoning that a verb call has run no queries — true,
      // and it left the reviewer judging markup with nothing behind it, which is
      // half its rubric switched off. A double-counted headline ($11,216 shown,
      // ~$6,276 true, demo-bank 2026-08-06) is invisible in the markup and obvious
      // beside the rows.
      //
      // `request` is empty because a verb call carries no user text — the checks
      // that read it treat that as "no carve-out", which is the conservative
      // direction.
      const plugged = config.checks ?? [];
      const samples = await queryEvidence(document, config.tools, ctx);
      const findings = await createCheckingLayer({
        deps,
        // The thorough door: the shared floor AND the reviewer. Off the
        // scripted-create hot path, so the tsc pass is affordable here (§7.1).
        checks: [...floorChecks(deps), reviewerCheck(deps, samples, judgmentRules(plugged)), ...plugged],
      }).run({ document, request: "" });
      return { ok: !findings.some(({ severity }) => severity === "block"), findings };
    },

    async schedule(appId, cron, ctx) {
      const previous = await requireOwned(appId, ctx);
      const trigger = (previous.triggers ?? []).find((candidate) => candidate.on.kind === "schedule");
      if (trigger === undefined) {
        throw new VendoError(
          "validation",
          `app ${appId} has no schedule to change. Ask for the automation itself first — a schedule needs `
          + "something to run, and that is an edit, not a cron.",
          { appId },
        );
      }
      // Exactly one of cron/every/at may be set (core `triggerSchema`), so
      // choosing a cron REPLACES whichever the app carried. The cron string
      // itself is validated by the arming leg below, which is the one place that
      // knows the parser.
      await updateAppDocument(appId, (document) => ({
        ...document,
        triggers: (document.triggers ?? []).map((candidate) =>
          candidate.id === trigger.id ? { ...candidate, on: { kind: "schedule" as const, cron } } : candidate),
      }));
      if (config.armAutomation === undefined) {
        // No automations engine composed: the cron is stored, and saying it is
        // armed would be a lie.
        return { appId, cron, enabled: false, missing: 0 };
      }
      const armed = await config.armAutomation(appId, trigger.id, ctx);
      return { appId, cron, enabled: armed.enabled, missing: armed.missing.length };
    },

    async edit(appId, instruction, ctx) {
      // Permission before capability (§9.4): a viewer must hear "you can't
      // change the team's copy" — the sentence the fork offer renders from —
      // whether or not this deployment happens to have a model wired.
      const previous = await requireOwned(appId, ctx);
      if (config.model === undefined) {
        throw new VendoError("not-implemented", "generation requires a model");
      }
      // A SERVED app has no tree — its whole surface is the code in its machine —
      // so there is nothing for the brain to edit as text. Every instruction goes
      // to the in-box agent instead, through the same conversation the person is
      // already having with the app.
      if (previous.ui === "http" && previous.machine !== undefined) {
        const box = await editServerViaBox(previous, instruction, ctx, { served: true });
        if (!box.ok) {
          return failedEdit(previous, instruction, [
            `the in-box agent could not change the served app: ${box.result.summary}`,
          ]);
        }
        const landed = await requireOwned(appId, ctx);
        const boxVersion: VersionEntry = {
          at: new Date().toISOString(),
          intent: instruction,
          rung: rungFor(landed),
        };
        // The box already landed its own write, so this version is real history
        // the moment it is appended — and the cap applies to it right here.
        await history.append(landed.id, previous, boxVersion, []);
        await pruneHistory(landed.id);
        return withPinDrift({
          app: landed,
          version: { ...boxVersion },
          graduated: true,
          box: {
            ok: box.result.ok,
            summary: box.result.summary,
            ...(box.result.fns === undefined ? {} : { fns: box.result.fns }),
            filesChanged: box.result.filesChanged,
          },
        });
      }
      // A `.vendo` screen edit goes to the ONE builder: the assembler opens this
      // app's own document, rewrites it and saves it. The save lands through
      // `authored` — the real store write, the real checks floor, the real paint
      // — so the row it leaves behind IS the edit, and this door's only remaining
      // job is to report it.
      const edited = await assembleEdit(appId, instruction, ctx);
      if (edited.kind === "failed") {
        // Nothing was written: the previous app keeps serving out of its own row,
        // which is why this needs no flagged version and no pointer.
        return failedEdit(
          previous,
          instruction,
          edited.issues.length === 0 ? ["edit failed validation"] : edited.issues,
        );
      }
      let app = edited.kind === "assembled" ? edited.app : previous;
      let automation: EditResult["automation"] | undefined;
      let graduated: boolean | undefined;
      const issues: string[] = [];
      // ── The escalation ladder, from an app that already exists ──────────────
      // The assembler could not make this change out of components, so it wrote a
      // plan and asked for the builder — the same §4.5 hand-off a create takes,
      // landing ADDITIVELY on the stored app: an automation on the existing
      // engine, or a box that writes real code and may flip the surface.
      if (edited.kind === "escalate") {
        const planText = await config.escalatedPlan?.(appId, ctx).catch(() => undefined);
        const deps = generationDependencies(config, config.model, await generationToolContext(ctx));
        const compiled = planText === undefined ? undefined : compilePlan(planText, {
          tools: (deps.tools ?? []).map(({ name }) => name),
          components: config.catalog.map(({ name }) => name),
        });
        const base: AppPlan = compiled?.plan
          ?? { name: previous.name, groups: [], queries: [], cannot: [] };
        const planned = { ...base, server: escalatedServer(base, instruction) };
        if (planned.server.kind === "box" && !lifecycle.available()) {
          return failedEdit(previous, instruction, [NO_MACHINE], false);
        }
        try {
          const served = await runServerWork({
            plan: planned,
            ...(planText === undefined ? {} : { planText }),
            document: previous,
            request: instruction,
          }, ctx, deps);
          if (served.failed !== undefined) {
            // The plan REQUIRED this server work and it could not be built, so
            // no edit happened: the stored app is untouched and says why.
            return failedEdit(previous, instruction, served.failed);
          }
          app = served.document;
          automation = served.automation;
          graduated = served.graduated;
          issues.push(...(served.issues ?? []));
          for (const finding of served.findings) {
            console.info(findingLine(finding));
          }
        } catch (error) {
          const reason = safeErrorMessage(error);
          console.warn(`[vendo] the build this edit asked for did not run for ${appId}: ${reason}`);
          return failedEdit(previous, instruction, [reason]);
        }
      }
      // `authored` appended this edit's own undo point under the person's words
      // (see `editIntents`), so the version reported here IS that row — read
      // back rather than re-stamped, because a second clock read tells the
      // caller a millisecond history does not hold. Nothing else is written.
      const version: VersionEntry = takeEditVersion(appId, instruction) ?? {
        at: new Date().toISOString(),
        intent: instruction,
        rung: rungFor(app),
      };
      return withPinDrift({
        app,
        version,
        ...(issues.length === 0 ? {} : { issues }),
        ...(automation === undefined ? {} : { automation }),
        ...(graduated === undefined ? {} : { graduated }),
      });
    },

    async remember(input, ctx) {
      // The same `editor` gate every other write to this row passes: appending
      // to an app's memory is changing the app.
      await requireOwned(input.appId, ctx);
      await updateAppDocument(input.appId, (doc) => ({
        ...doc,
        memory: rememberedMemory(doc.memory, input),
      }));
    },

    /**
     * Build contract §9.3 — the level lives HERE, not only at the wire route
     * that used to be the sole boundary: reading the log needs `viewer`,
     * rolling the app back needs `EDITOR`. A caller who cannot even see the app
     * stays masked (`not-found`) at both verbs, exactly like every other door.
     * The 06 §1 signature gained the ctx for this reason (wave-3 ruling).
     */
    history(appId, ctx) {
      const surface = history.surface(appId);
      return Object.freeze({
        list: async () => {
          await requireOwned(appId, ctx, "viewer");
          return await surface.list();
        },
        undo: async () => {
          const previous = await requireOwned(appId, ctx, "editor");
          const restored = await surface.undo();
          // §9.9 — a rollback CHANGES WHAT THE APP IS, so it is an edit for every
          // purpose the choke point serves: a third party rewinding the team's
          // app has to invalidate the sponsorship exactly as their edit would.
          // The history module writes the row itself, so the announcement is made
          // here, at the one door every undo comes through.
          await reportDocumentEdit(previous, restored, ctx.principal.subject);
          return withoutSession(restored);
        },
      });
    },

    async open(appId, ctx) {
      const app = await requireOwned(appId, ctx, "viewer");
      // Review-kind (2026-08-02): an unapproved current version is invisible —
      // open() serves the newest APPROVED version from the existing history
      // instead (or the pending state when none was ever approved). Instant
      // kind passes through untouched.
      return opener(await review.serveDocFor(app), ctx);
    },

    async call(appId, ref, args, ctx) {
      const app = await requireOwned(appId, ctx, "viewer");
      // A host-tool ref goes straight to the guard-bound registry; an fn: ref
      // settles as a contained not-implemented outcome until the in-runtime
      // fn path lands (see call.ts).
      //
      // A READ takes the QUERY arm. This is the only door a code-land app has
      // (@vendoai/ui/kit's useToolQuery), so sending every call through the action
      // arm gave a read a random uuid per invocation — and the guard's approved
      // replay PINS the call id (05 §2), so an ungraded read that parked could
      // never be satisfied: approve, refetch, new id, park again, forever.
      // `callQuery` derives the id from (app, tool, args), which is exactly a
      // query's identity. The discriminator is the tool's own authored risk
      // grade, the server's existing classification of what a call does;
      // everything else keeps the action arm, because two identical mutations
      // are two separate acts and each has to earn its own approval.
      const descriptor = (await config.tools.descriptors(ctx).catch(() => []))
        .find((candidate) => candidate.name === ref);
      return descriptor?.risk === "read"
        ? caller.callQuery(app, ref, args, ctx)
        : caller.call(app, ref, args, ctx);
    },

    async exportApp(appId, ctx) {
      return interchange.exportApp(appId, ctx);
    },

    async importApp(source, ctx) {
      return interchange.importApp(source, ctx);
    },

    async share(appId, ctx) {
      const app = await requireOwned(appId, ctx, "owner");
      if (config.cloud === undefined) {
        throw new VendoError("cloud-required", "Vendo Cloud requires VENDO_API_KEY");
      }
      // Lane E grant hygiene — a share copy never carries the owner's egress
      // approval; whoever runs the copy approves its declaration themselves.
      // …and the brain's conversation never travels either: it is the owner's
      // transcript, not part of the app.
      const { egressApproved: _egressApproved, ...shared } = app;
      return config.cloud.share(appId, withoutSession(shared));
    },

    async publish(appId, ctx) {
      const app = await requireOwned(appId, ctx, "owner");
      if (config.cloud === undefined) {
        throw new VendoError("cloud-required", "Vendo Cloud requires VENDO_API_KEY");
      }
      // Lane E grant hygiene — same rule as share: approval never travels.
      const { egressApproved: _published, ...published } = app;
      return config.cloud.publish(appId, withoutSession(published));
    },

    agentTools() {
      return createAgentTools(runtime, {
        data,
        requireOwned,
        claimSlot,
        markUnbuilt,
        ...(config.screen === undefined ? {} : { screen: config.screen }),
        ...(config.escalatedPlan === undefined ? {} : { escalatedPlan: config.escalatedPlan }),
      });
    },

    inClient: createInClientSurface(surfaceContext),

    review: createReviewSurface(surfaceContext),

    pins: createPinsSurface(surfaceContext),

    machine: {
      available: () => lifecycle.available(),
      async provision(appId, ctx) {
        const app = await requireOwned(appId, ctx);
        const alreadyProvisioned = app.machine !== undefined;
        // `experimentalMachines` used to gate NEW provisioning here with a second
        // error explaining the flag. The flag is gone, and so is that error: with
        // the sandbox adapter as the whole gate, "there is nothing to provision
        // in" is exactly what the lifecycle's own `sandbox-unavailable` already
        // says, and the escalation ladder never reaches this line — `laneGates`
        // states the missing lane to the brain BEFORE it plans. An
        // already-provisioned app stays idempotent, so it is never stranded.
        // Lane E — first provision is the "approve once" moment: unapproved
        // declared egress parks the approval card and refuses loudly here.
        await ensureEgressApproved(app, ctx);
        const provisioned = await lifecycle.provision(app);
        if (!alreadyProvisioned) await reportLifecycle("machine-provision", appId, ctx);
        return provisioned;
      },
      async wake(appId, ctx) {
        const app = await requireOwned(appId, ctx);
        // Lane E — a manifest change adding domains re-prompts at the next
        // wake: the new declaration parks a fresh card for the delta only.
        await ensureEgressApproved(app, ctx);
        return lifecycle.wake(app);
      },
      async sleep(appId, ctx) {
        const app = await requireOwned(appId, ctx);
        return lifecycle.sleep(app);
      },
      async editApp(appId, instruction, ctx) {
        const app = await requireOwned(appId, ctx);
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
        const app = await requireOwned(appId, ctx, "viewer");
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
        const app = await requireOwned(appId, ctx, "owner");
        const cleared = await lifecycle.destroyMachine(app);
        // De-graduation retires the old scheduler's leftover row with the machine.
        await manifestTriggers.clearLegacyState(appId);
        if (app.machine !== undefined) await reportLifecycle("machine-destroy", appId, ctx);
        return cleared;
      },
      async syncManifest(appId, ctx) {
        const app = await requireOwned(appId, ctx);
        return manifestTriggers.sync(app, ctx);
      },
      report: () => manifestTriggers.report(),
    },

    secrets: {
      async exposure(appId, ctx) {
        const app = await requireOwned(appId, ctx, "owner"); // which secrets are live is owner-only
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
        // Owner-only: exposing a real secret value is the highest-risk
        // write an app has; a shared editor never reaches it (§9.3).
        const app = await requireOwned(input.appId, ctx, "owner");
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

        // Turning ON is HIGH-RISK: route through the guard's existing confirmEach
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

    async serve(appId, request, ctx) {
      // §9.8 — LIVE rows, every request. `viewer` is the level because a
      // viewer may see and USE a shared app; a caller who cannot see it stays
      // masked, exactly as every other app door answers them.
      //
      // The BoxRequest is forwarded as given. Keeping the browser's cookies,
      // authorization and host headers off the skin is the WIRE route's job:
      // `servedProxyRoutes` assembles the request from method, path,
      // content-type and body alone. A direct caller of this door — the host's
      // own code — chooses its own headers.
      return await forwardToBox(await requireOwned(appId, ctx, "viewer"), request, ctx);
    },
    box: {
      // v2 only: the fn door rides the machine lifecycle's wake — an
      // un-provisioned app fails loudly here (graduation provisions first);
      // the dying v1 session cache never serves a box request.
      async request(appId, request, ctx) {
        return await forwardToBox(await requireOwned(appId, ctx), request, ctx);
      },

      async redact(appId, value) {
        const record = await apps.get(appId);
        if (record === null) return value;
        // issue #566 — same per-box cache preference as box.request: an
        // injected value redacts without a refetch that could fail.
        const secretValues = await collectSecretValues(
          documentFromRecord(record).secrets,
          config.secrets,
          lifecycle.injectedSecretValues(appId),
        );
        return redactSecretJson(value, secretValues);
      },
    },
  };

  return runtime;
};
