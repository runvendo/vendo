import {
  VENDO_TREE_FORMAT_V2,
  VendoError,
  deriveShapeCard,
  validateAppDocument,
  type AppDocument,
  type AppId,
  type Guard,
  type IsoDateTime,
  type Json,
  type NormalizedCatalog,
  type RunContext,
  type ApprovalId,
  type RiskLabel,
  type SecretsProvider,
  type ShapeType,
  type StoreAdapter,
  type ToolCall,
  type ToolDescriptor,
  type ToolOutcome,
  type TreeV2,
  type ToolRegistry,
  type UIPayload,
  type VendoViewPart,
  type VendoTheme,
  type VendoRecord,
} from "@vendoai/core";
import type { LanguageModel } from "ai";
import { createAgentTools } from "./agent-tools.js";
import { createAppData } from "./app-data.js";
import { createAppCaller } from "./call.js";
import {
  publish,
  share,
  type PublishRecord,
  type ShareSnapshot,
} from "./cloud.js";
import {
  instructionRequiresServedApp,
  instructionRequiresServer,
  modelEngine,
  prewarmModels,
  type GenerationDependencies,
  type GenerationEngine,
} from "./engine.js";
import { createAppHistory } from "./history.js";
import { createInClientApprovals, type InClientVerdict } from "./inclient.js";
import { createAppInterchange } from "./interchange.js";
import {
  createMachineLifecycle,
  type BuildMachineEnv,
  type LifecycleClock,
  type MachineSandboxAdapter,
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
import { createAppOpener, createProgressiveQueryResolver, servedAppsDisabledError } from "./open.js";
import { appRecordInput, documentFromRecord, enabledAfterDocumentEdit, rowFromRecord } from "./persistence.js";
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
import type { SandboxMachine } from "./sandbox.js";

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
    sandbox?: MachineSandboxAdapter;
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
   */
  experimentalServedApps?: boolean;
  model?: LanguageModel;
  /** v2 spec §4 — tier-0 paint lane knob, passed to the generation engine.
   *  `model` is the no-think switch (a thinking-disabled model instance);
   *  `disabled` forces single-lane generation. */
  paint?: GenerationDependencies["paint"];
  /** The composition-normalized catalog (01 §14): derived schemas included. */
  catalog: NormalizedCatalog;
  theme?: VendoTheme;
  secrets?: SecretsProvider;
  designRules?: string;
  pinBaselines?: PinBaseline[];
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
  | { kind: "resuming"; cover?: string };

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

const allRecords = async (
  store: StoreAdapter,
  refs: Record<string, string>,
): Promise<VendoRecord[]> => {
  const records: VendoRecord[] = [];
  let cursor: string | undefined;
  do {
    const page = await store.records("vendo_apps").list(
      cursor === undefined ? { refs } : { refs, cursor },
    );
    records.push(...page.records);
    cursor = page.cursor;
  } while (cursor !== undefined);
  return records;
};

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
  ...toolContext,
  ...(config.paint === undefined ? {} : { paint: config.paint }),
  ...(onPartial === undefined ? {} : { onPartial }),
});

/** 06-apps §§8–9 — payload fields only the server may write (the venue verdict
 * and the drift report). A model-written or artifact-imported tree must never
 * smuggle either one in, streamed or at rest. */
const stripServerAuthoritativeFields = (payload: object): void => {
  delete (payload as { inClient?: unknown }).inClient;
  delete (payload as { pinDrift?: unknown }).pinDrift;
};

const pinnedSubtree = (app: AppDocument, componentName: string): unknown[] => {
  if (app.tree?.formatVersion !== VENDO_TREE_FORMAT_V2) return [];
  const tree = app.tree as unknown as TreeV2;
  const included = new Set(tree.nodes.filter((node) => node.component === componentName).map((node) => node.id));
  const pending = [...included];
  while (pending.length > 0) {
    const node = tree.nodes.find(({ id }) => id === pending.pop());
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

  const reportGuard = async (
    kind: "app-lifecycle",
    principalSubject: string,
    appId: AppId,
    ctx: Pick<RunContext, "venue" | "presence"> & { trigger?: RunContext["trigger"] },
    detail: Record<string, Json>,
  ): Promise<void> => {
    await config.guard.report({
      id: `aud_${globalThis.crypto.randomUUID()}`,
      at: new Date().toISOString(),
      kind,
      principal: { kind: "user", subject: principalSubject },
      venue: ctx.venue,
      presence: ctx.presence,
      appId,
      ...(ctx.trigger === undefined ? {} : { trigger: { ...ctx.trigger } }),
      outcome: "ok",
      detail,
    });
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

  const commitExposure = async (grant: SecretExposureGrant): Promise<void> => {
    await exposure.activate(grant.appId, grant.secretName);
    // Known v2 limit: a machine PROVISIONED before this grant keeps its
    // provision-time env — a memory snapshot resumes already-started
    // processes, so env can only change at a fresh provision (and Wave 3's
    // in-box edit loop, which restarts the server, is where re-injection
    // lands).
    await reportGuard("app-lifecycle", grant.owner, grant.appId, { venue: "app", presence: "present" }, {
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
  const updateAppDocument = async (
    appId: AppId,
    mutate: (doc: AppDocument) => AppDocument,
  ): Promise<AppDocument> => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const record = await apps.get(appId);
      if (record === null) throw new VendoError("not-found", `app not found: ${appId}`);
      const row = rowFromRecord(record);
      const next = mutate(structuredClone(row.doc));
      const input = appRecordInput(next, row.subject, row.enabled);
      if (apps.atomic === undefined || record.revision === undefined) {
        await apps.put(input);
        return next;
      }
      if (await apps.atomic.compareAndSwap(input, record.revision) !== null) return next;
    }
    throw new VendoError("conflict", `app ${appId} was concurrently modified`, { appId });
  };

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
    await reportGuard("app-lifecycle", owner, appId, { venue: "app", presence: "present" }, {
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
          await reportGuard("app-lifecycle", entry.owner, appId, { venue: "app", presence: "present" }, {
            operation: "egress-denied",
            domains: entry.domains,
          });
        }
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
  const caller = fnCaller.wrap(createAppCaller(config.tools));
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

  const appendIssues = (current: string[], next: string[]): string[] => [
    ...new Set([...current, ...next]),
  ];

  const persistEdit = async (
    previous: AppDocument,
    app: AppDocument,
    version: VersionEntry,
    subject: string,
    pinSlots?: readonly string[],
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
    const enabled = enabledAfterDocumentEdit(previous, app, wasEnabled);
    const appRow = appRecordInput(app, subject, enabled);
    await apps.put(appRow);
    return structuredClone(appRow.data.doc);
  };

  const reportLifecycle = async (
    operation: "create" | "delete" | "fork" | "in-client-approve" | "pin-rebase" | "machine-provision" | "machine-destroy",
    appId: AppId,
    ctx: RunContext,
    extra: Record<string, Json> = {},
  ): Promise<void> => {
    await config.guard.report({
      id: `aud_${globalThis.crypto.randomUUID()}`,
      at: new Date().toISOString(),
      kind: "app-lifecycle",
      principal: { ...ctx.principal },
      venue: ctx.venue,
      presence: ctx.presence,
      appId,
      trigger: ctx.trigger === undefined ? undefined : { ...ctx.trigger },
      outcome: "ok",
      detail: { operation, ...extra },
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
      tools: descriptors.map(({ name, description, risk }) => ({ name, description, risk })),
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
      servedOk = root !== undefined
        && root.status >= 200 && root.status < 300
        && (root.headers["content-type"] ?? "").includes("text/html")
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
      } else if (box.result.servesUi === true && box.servedOk) {
        const flipped = structuredClone(base);
        delete flipped.tree;
        delete flipped.components;
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
    const treeInstruction = `The app just graduated to a machine that serves these functions: ${fns.map((fn) => `fn:${fn}`).join(", ") || "(none reported)"}. Rewire the tree to use them:\n- Repoint the query that feeds the main board/list/digest so its tool is the matching data function (e.g. change its tool to "fn:getDigest"); if no such query exists, add one with <Query id="data" tool="fn:..."/> and bind a node to it. Do not leave a stale placeholder or host-tool query where the server now provides the data.\n- Wire any submit/refresh/run control's action to the matching fn:.\nChange ONLY the data source and actions; keep the layout. Emit no id attributes on nodes (ids are compiler-owned); a <Query> id is its name.`;
    let treeIssues: string[] = [];
    let bound: AppDocument | undefined;
    for (let attempt = 0; attempt < 3 && bound === undefined; attempt += 1) {
      const generated = await engine.edit(
        {
          app: structuredClone(base),
          instruction: treeInstruction,
          ...(treeIssues.length === 0 ? {} : { repairIssues: treeIssues }),
        },
        generationDependencies(config, config.model, await generationToolContext(ctx)),
      );
      if (generated.kind === "document") {
        bound = { ...generated.document, id: base.id };
      } else {
        treeIssues = appendIssues(treeIssues, generated.issues);
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
      const generated = await engine.create(
        { prompt: input.prompt },
        generationDependencies(config, config.model, await generationToolContext(ctx), input.onView === undefined ? undefined : (partial) => {
          // v2 spec §1 — the payload carries islands at payload level (the
          // renderer lifts them); a mid-stream payload is marked streaming.
          latestTree = {
            ...structuredClone(partial.tree),
            ...(partial.components === undefined ? {} : { components: structuredClone(partial.components) }),
          } as TreeV2;
          emit({ ...structuredClone(latestTree), streaming: true } as TreeV2);
          queryResolver?.update(latestTree);
        }),
      );
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
      let finalTree: TreeV2 | undefined;
      if (input.onView !== undefined && app.tree?.formatVersion === VENDO_TREE_FORMAT_V2) {
        finalTree = {
          ...structuredClone(app.tree),
          ...(app.components === undefined ? {} : { components: structuredClone(app.components) }),
        } as TreeV2;
        latestTree = structuredClone(finalTree);
        queryResolver?.update(finalTree);
        finalTree.data = await queryResolver?.complete() ?? structuredClone(finalTree.data ?? {});
      }
      await apps.put(appRecordInput(app, ctx.principal.subject));
      await reportLifecycle("create", app.id, ctx);
      if (finalTree !== undefined) emit(finalTree);
      // execution-v2 Wave 3 — graduate on create when the prompt needs server
      // capability (schedule / egress / heavy logic / app state). The tree is
      // already on screen; the machine, the box-written server code, and the
      // tree's fn: bindings land additively (the user never picks a tier).
      // Best-effort: a graduation failure leaves the working tree app to retry
      // via edit, so create never regresses to a white box.
      if (lifecycle.available() && instructionRequiresServer(app, input.prompt)) {
        try {
          const graduated = await graduate(structuredClone(app), input.prompt, ctx, {
            served: instructionRequiresServedApp(app, input.prompt),
          });
          if (graduated.failure === undefined) {
            if (input.onView !== undefined && graduated.app.tree?.formatVersion === VENDO_TREE_FORMAT_V2) {
              const tree = {
                ...structuredClone(graduated.app.tree),
                ...(graduated.app.components === undefined ? {} : { components: structuredClone(graduated.app.components) }),
              } as TreeV2;
              stripServerAuthoritativeFields(tree);
              emit(tree);
            }
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
          documents.push(documentFromRecord(record));
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
      await apps.delete(appId);
      await reportLifecycle("delete", appId, ctx);
    },

    async fork(appId, ctx) {
      const source = await requireOwned(appId, ctx.principal.subject);
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
      return instructionRequiresServer(app, args.instruction) ? "write" : "read";
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
      // execution-v2 Wave 3 — an instruction that needs server capability
      // graduates the app (provision a machine, delegate to the in-box agent,
      // land fn: bindings). A pure-UI instruction stays on the cheap tree path.
      if (instructionRequiresServer(previous, instruction)) {
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
          collectedIssues = appendIssues(collectedIssues, generated.issues);
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
          rung: rungFor(app, generated.rung),
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
      // Lane E grant hygiene — a share copy never carries the owner's egress
      // approval; whoever runs the copy approves its declaration themselves.
      const { egressApproved: _egressApproved, ...shared } = app;
      return share(appId, shared, ctx);
    },

    async publish(appId, ctx) {
      const app = await requireOwned(appId, ctx.principal.subject);
      // Lane E grant hygiene — same rule as share: approval never travels.
      const { egressApproved: _published, ...published } = app;
      return publish(appId, published, ctx);
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
          await reportGuard("app-lifecycle", ctx.principal.subject, input.appId, ctx, {
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
          await reportGuard("app-lifecycle", ctx.principal.subject, input.appId, ctx, {
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
