import {
  VENDO_TREE_FORMAT_V2,
  VendoError,
  validateAppDocument,
  type AppDocument,
  type AppId,
  type ComponentCatalog,
  type Guard,
  type IsoDateTime,
  type Json,
  type RunContext,
  type ApprovalId,
  type RiskLabel,
  type SecretsProvider,
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
  instructionRequiresServer,
  modelEngine,
  type CodeFileEdit,
  type GenerationDependencies,
  type GenerationEngine,
} from "./engine.js";
import { createAppHistory } from "./history.js";
import { createInClientApprovals, type InClientVerdict } from "./inclient.js";
import { createAppInterchange } from "./interchange.js";
import { createMachineSessions } from "./machine.js";
import { createAppOpener, createProgressiveQueryResolver } from "./open.js";
import { appRecordInput, documentFromRecord, enabledAfterDocumentEdit, rowFromRecord } from "./persistence.js";
import { detectPinDrift, hasDefaultExport, pinComponentName, pinForkSource, type InClientApproval, type PinBaseline, type PinDrift } from "./pins.js";
import { createAppsProxy } from "./proxy.js";
import { createRunTokenGate } from "./run-token-gate.js";
import { createSecretExposure, type SecretExposureGrant } from "./secret-exposure.js";
import { computeShipDiff, type ShipDiff } from "./ship-diff.js";
import { appVersionHash } from "./version-hash.js";
import type { SandboxAdapter } from "./sandbox.js";
import type { SandboxMachine } from "./sandbox.js";
import { FETCH_SHIM_BOOT_PRELUDE, FETCH_SHIM_PATH, FETCH_SHIM_SOURCE } from "./scaffold/fetch-shim.js";
import { servedAppScaffold } from "./scaffold/index.js";
import type { IpResolver } from "./ssrf.js";

/** 06-apps §1 plus block-plan decisions 3–4. */
export interface AppsConfig {
  store: StoreAdapter;
  guard: Guard;
  tools: ToolRegistry;
  sandbox?: SandboxAdapter;
  model?: LanguageModel;
  /** v2 spec §4 — tier-0 paint lane knob, passed to the generation engine.
   *  `model` is the no-think switch (a thinking-disabled model instance);
   *  `disabled` forces single-lane generation. */
  paint?: GenerationDependencies["paint"];
  catalog: ComponentCatalog;
  theme?: VendoTheme;
  secrets?: SecretsProvider;
  designRules?: string;
  proxyUrl?: string;
  pinBaselines?: PinBaseline[];
  /**
   * ENG-259 — advanced egress seam for the allowlisted secret-egress proxy (§4.3).
   * Defaults are zero-config on Node: global fetch + node:dns. A non-Node host (edge)
   * or a test injects its own transport/resolver here.
   */
  egressTransport?: { fetch?: typeof globalThis.fetch; resolveIp?: IpResolver };
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
}

export interface EditFailure {
  code: "edit-rejected";
  retryable: boolean;
  message: string;
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

/** Plan decision 3 — handler mounted by the umbrella at the configured proxy URL. */
export interface AppsProxy {
  handler(request: Request): Promise<Response>;
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
  proxy: AppsProxy;
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

/** True (exit 0) when something answers HTTP on $PORT. fetch resolves on any
    HTTP response, so a 404 still proves a listener. */
const PROBE_SNIPPET =
  "node -e 'fetch(\"http://127.0.0.1:\"+(process.env.PORT||\"8080\")+\"/\").then(()=>process.exit(0),()=>process.exit(1))'";

/** Stop the server THIS runtime started in an earlier edit (recorded in
    /tmp/vendo-app.pid), then wait for $PORT to free. Provider-started
    processes (Modal's create command) carry no pid file and are left alone. */
const STOP_OWNED_SERVER_SNIPPET = [
  "if [ -f /tmp/vendo-app.pid ]; then",
  "  kill -- \"-$(cat /tmp/vendo-app.pid)\" 2>/dev/null || true",
  "  kill \"$(cat /tmp/vendo-app.pid)\" 2>/dev/null || true",
  "  rm -f /tmp/vendo-app.pid",
  `  i=0; while [ $i -lt 20 ] && ${PROBE_SNIPPET}; do i=$((i+1)); sleep 0.1; done`,
  "fi",
].join("\n");

/**
 * 06-apps §4.1 — the machine IS the server: a rung ≥2 snapshot must capture a
 * machine that answers on $PORT, because `fn:` calls resume that snapshot and
 * POST to it. E2B resumes a MEMORY image, so only a process serving at
 * snapshot time serves after resume; Modal instead re-runs its create command
 * (which waits for /app/start.sh or /app/server.js) on every disk-image
 * resume. This snippet makes both true from the provider-neutral seam:
 * restart the runtime-owned server so the just-written files take effect,
 * leave a provider-started listener alone, and boot the conventional entry
 * (/app/start.sh, else /app/server.js) when nothing serves. `setsid` puts the
 * server in its own process group so a later edit can stop it cleanly.
 */
const ENSURE_SERVING_COMMAND = [
  STOP_OWNED_SERVER_SNIPPET,
  `if ${PROBE_SNIPPET}; then exit 0; fi`,
  // ENG-290 M4 — the rung-2/3 boot convention loads the egress fetch shim into
  // every node process the entry spawns (NODE_OPTIONS propagates to children).
  FETCH_SHIM_BOOT_PRELUDE,
  "if [ -f /app/start.sh ]; then",
  "  nohup setsid sh /app/start.sh >/tmp/vendo-app.log 2>&1 & echo $! >/tmp/vendo-app.pid",
  "elif [ -f /app/server.js ]; then",
  "  nohup setsid node /app/server.js >/tmp/vendo-app.log 2>&1 & echo $! >/tmp/vendo-app.pid",
  "else",
  "  echo 'no /app/start.sh or /app/server.js to serve $PORT' >&2; exit 1",
  "fi",
  `i=0; while [ $i -lt 50 ]; do ${PROBE_SNIPPET} && exit 0; i=$((i+1)); sleep 0.1; done`,
  "cat /tmp/vendo-app.log >&2",
  "exit 1",
].join("\n");

const rungFor = (
  app: AppDocument,
  declared?: VersionEntry["rung"],
): VersionEntry["rung"] => {
  if (app.ui === "http") return 4;
  if (app.server !== undefined) return declared === 3 ? 3 : 2;
  return 1;
};

const generationDependencies = (
  config: AppsConfig,
  model: LanguageModel,
  onPartial?: GenerationDependencies["onPartial"],
): GenerationDependencies => ({
  model,
  catalog: config.catalog,
  theme: config.theme,
  designRules: config.designRules,
  pinBaselines: config.pinBaselines,
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
  const tokenSecret = globalThis.crypto.getRandomValues(new Uint8Array(32));
  // ENG-251 — one anti-replay gate shared by the machine cache (which burns a
  // run's jti on teardown) and the proxy (which rejects a burned jti).
  const consumedRunTokens = createRunTokenGate();
  // ENG-345 — per-secret × per-app in-sandbox exposure grants. A dedicated store
  // collection, NEVER part of the app document, so no copy path can carry it.
  const exposure = createSecretExposure(config.store);

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

  const machines = createMachineSessions({
    sandbox: config.sandbox,
    proxyUrl: config.proxyUrl,
    tokenSecret,
    consumedRunTokens,
    // ENG-345 — the machine cache injects a REAL value only for a secret with an
    // active grant, and audits one exposed-run event per run. Same SecretsProvider
    // seam the egress proxy uses; without it every secret stays a handle.
    ...(config.secrets === undefined ? {} : { secrets: config.secrets }),
    resolveExposedSecrets: (app) => exposure.activeNames(app.id),
    reportExposedRun: (app, ctx, secrets) =>
      reportGuard("app-lifecycle", ctx.principal.subject, app.id, ctx, {
        operation: "secret-exposed-run",
        secrets,
      }),
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
    sandbox: config.sandbox,
    machines,
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
    // Re-boot the machine so the next run's env reflects the new grant state.
    await machines.evict(grant.appId);
    await reportGuard("app-lifecycle", grant.owner, grant.appId, { venue: "app", presence: "present" }, {
      operation: "secret-exposure-set",
      secretName: grant.secretName,
      expose: true,
    });
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
  };
  config.guard.onApprovalDecision((id, approved) => onApprovalDecision(id, approved));

  const inClientApprovals = createInClientApprovals(config.store);
  const caller = createAppCaller(machines, config.tools);
  const opener = createAppOpener(
    machines,
    caller,
    config.store,
    config.pinBaselines,
    (doc) => inClientApprovals.venueStateFor(doc),
  );
  const proxy = createAppsProxy({
    tokenSecret,
    tools: config.tools,
    data,
    owns: async (appId, subject) => await owned(appId, subject) !== null,
    loadApp: owned,
    ...(config.secrets === undefined ? {} : { secrets: config.secrets }),
    ...(config.egressTransport?.fetch === undefined ? {} : { fetch: config.egressTransport.fetch }),
    ...(config.egressTransport?.resolveIp === undefined ? {} : { resolveIp: config.egressTransport.resolveIp }),
    consumedRunTokens,
  });

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

  const syntaxCheck = async (
    machine: SandboxMachine,
    file: CodeFileEdit,
  ): Promise<string | undefined> => {
    if (!/\.[cm]?[jt]s$/i.test(file.path)) return undefined;
    const result = await machine.exec(`node --check '${file.path}'`, { cwd: "/app", timeoutMs: 10_000 });
    if (result.code === 0) return undefined;
    const detail = result.stderr.trim() || result.stdout.trim() || `node --check exited ${result.code}`;
    return `${file.path}: ${detail}`;
  };

  const applyCodeFiles = async (
    app: AppDocument,
    files: CodeFileEdit[],
    rung: VersionEntry["rung"],
    ctx: RunContext,
  ): Promise<{ server?: string; cover?: Uint8Array; issues: string[] }> => {
    const graduatesToHttp = rung === 4 && app.ui !== "http";
    try {
      return await machines.withFork(
        app,
        ctx,
        async ({ machine }) => {
          try {
            if (rung === 4 && machine.url === undefined) {
              return { issues: ["sandbox-unavailable: adapter cannot serve http apps"] };
            }
            if (graduatesToHttp) {
              const scaffold = servedAppScaffold(app);
              const scaffoldPaths = new Set(scaffold.map((file) => file.path));
              const collision = files.find((file) => scaffoldPaths.has(file.path));
              if (collision !== undefined) {
                return {
                  issues: [`initial rung-4 graduation cannot replace scaffold file "${collision.path}"; edit it after graduation`],
                };
              }
              for (const file of scaffold) {
                await machine.files.write(file.path, file.content);
              }
            }
            for (const file of files) await machine.files.write(file.path, file.content);
            // ENG-290 M4 — make sure the egress fetch shim exists on this fork:
            // a fresh machine carries it from create, but a fork resumed from a
            // pre-shim snapshot needs it written before the boot prelude can
            // require it. Written AFTER the model's files so the runtime-owned
            // shim always wins (it is part of the boot convention, not app code).
            await machine.files.write(FETCH_SHIM_PATH, FETCH_SHIM_SOURCE);
            const issues: string[] = [];
            for (const file of files) {
              const issue = await syntaxCheck(machine, file);
              if (issue !== undefined) issues.push(issue);
            }
            if (issues.length > 0) {
              return { issues };
            }
            if (graduatesToHttp) {
              // A graduation fork resumed from a serving rung-2/3 snapshot still
              // carries that old server (E2B memory resume); stop it first or the
              // scaffold loses the $PORT race and the "ready" probe would bless
              // the OLD process into the rung-4 snapshot.
              const started = await machine.exec(
                `${STOP_OWNED_SERVER_SNIPPET}\n${FETCH_SHIM_BOOT_PRELUDE}\n`
                + "nohup setsid sh /app/start.sh >/tmp/vendo-app.log 2>&1 & echo $! >/tmp/vendo-app.pid",
                // The stop-owned prelude probes $PORT with short node spawns
                // (~0.5s each on a cold machine); 10s aborted mid-loop live.
                { cwd: "/app", timeoutMs: 30_000 },
              );
              if (started.code !== 0) {
                const detail = started.stderr.trim() || started.stdout.trim() || `start command exited ${started.code}`;
                return { issues: [`served-app scaffold failed to start: ${detail}`] };
              }
              // The backgrounded start always exits 0; only a served response
              // proves the scaffold is actually listening (Devin, PR #243) —
              // otherwise the snapshot and cover would capture a dead machine.
              const ready = await machine.exec(
                "i=0; while [ $i -lt 50 ]; do"
                + " node -e \"fetch('http://127.0.0.1:'+(process.env.PORT||'8080')+'/').then(()=>process.exit(0),()=>process.exit(1))\""
                + " && exit 0; i=$((i+1)); sleep 0.1; done; cat /tmp/vendo-app.log >&2; exit 1",
                // 50 probes are ~30s of real node spawns on a live machine, so
                // the exec budget must outlive the loop, not race it.
                { cwd: "/app", timeoutMs: 45_000 },
              );
              if (ready.code !== 0) {
                const detail = ready.stderr.trim() || ready.stdout.trim() || "no response on $PORT";
                return { issues: [`served-app scaffold did not become ready: ${detail}`] };
              }
            } else {
              // Rungs 2–3 (and re-edits of an already-served app): the snapshot
              // must capture a machine that serves $PORT, or every later fn:
              // call resumes a dead machine. See ENSURE_SERVING_COMMAND.
              const serving = await machine.exec(ENSURE_SERVING_COMMAND, { cwd: "/app", timeoutMs: 60_000 });
              if (serving.code !== 0) {
                const detail = serving.stderr.trim() || serving.stdout.trim() || "no listener on $PORT";
                return { issues: [`app server is not serving on $PORT after this edit: ${detail}`] };
              }
            }
            const cover = rung === 4 && machine.screenshot !== undefined
              ? await machine.screenshot()
              : undefined;
            const server = await machine.snapshot();
            return cover === undefined ? { server, issues: [] } : { server, cover, issues: [] };
          } catch (error) {
            return { issues: [error instanceof Error ? error.message : "machine edit failed"] };
          } finally {
            await machine.stop().catch(() => undefined);
          }
        },
      );
    } catch (error) {
      return {
        issues: [error instanceof Error ? error.message : "sandbox machine unavailable"],
      };
    }
  };

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
    await history.append(app.id, previous, version, pinSlots ?? touchedPinSlots(previous, app));
    const wasEnabled = await assertCurrent();
    // A changed trigger must be re-armed — enable() re-captures and re-mints trigger state.
    const enabled = enabledAfterDocumentEdit(previous, app, wasEnabled);
    const appRow = appRecordInput(app, subject, enabled);
    await apps.put(appRow);
    return structuredClone(appRow.data.doc);
  };

  const reportLifecycle = async (
    operation: "create" | "delete" | "fork" | "in-client-approve" | "pin-rebase",
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

  const runtime: AppsRuntime = {
    async create(input, ctx) {
      if (config.model === undefined) {
        throw new VendoError("not-implemented", "generation requires a model");
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
        : createProgressiveQueryResolver(machines, caller, queryApp, ctx, (data) => {
          if (latestTree === undefined) return;
          emit({ ...structuredClone(latestTree), data, streaming: true } as TreeV2);
        });
      const generated = await engine.create(
        { prompt: input.prompt },
        generationDependencies(config, config.model, input.onView === undefined ? undefined : (partial) => {
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
      await machines.stop(appId);
      await data.clear(app, ctx.principal.subject, await history.documents(appId));
      await history.clear(appId);
      await inClientApprovals.clear(appId);
      await exposure.clearForApp(appId);
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
      if (source.server !== undefined && config.sandbox !== undefined) {
        const machine = await config.sandbox.resume(source.server);
        try {
          fork.server = await machine.snapshot();
        } finally {
          await machine.stop().catch(() => undefined);
        }
      } else {
        delete fork.server;
      }
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
      const requiresServer = instructionRequiresServer(previous, instruction);
      if (requiresServer && !machines.available()) {
        return failedEdit(previous, instruction, [
          "sandbox-unavailable: this edit requires server execution",
        ], false);
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
          generationDependencies(config, config.model),
        );
        if (generated.kind === "failure") {
          collectedIssues = appendIssues(collectedIssues, generated.issues);
          repairIssues = collectedIssues;
          continue;
        }

        if (generated.kind === "document") {
          const app: AppDocument = { ...generated.document, id: appId };
          // Same strip-before-persist rule as create(): open() strips at serve
          // time, but a model-forged venue or drift field must not be
          // persisted either.
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

        // The contextual guard decision ran before generation. If the engine
        // ever violates the tree dialect and emits code for a call classified
        // read-class, stop before touching a machine or persisting anything.
        if (!requiresServer) {
          return failedEdit(previous, instruction, [
            "approval-required: a tree-classified edit unexpectedly produced server code",
          ]);
        }

        const applied = await applyCodeFiles(previous, generated.files, generated.rung, ctx);
        if (applied.server === undefined) {
          collectedIssues = appendIssues(collectedIssues, applied.issues);
          repairIssues = collectedIssues;
          continue;
        }
        const app: AppDocument = {
          ...structuredClone(previous),
          server: applied.server,
          ...(generated.rung === 4 ? { ui: "http" } : {}),
        };
        const validation = validateAppDocument(app);
        if (!validation.ok) {
          return failedEdit(previous, instruction, [validation.error.message]);
        }
        const version: VersionEntry = {
          at: new Date().toISOString(),
          intent: instruction,
          rung: rungFor(app, generated.rung),
        };
        const persisted = await persistEdit(previous, app, version, ctx.principal.subject);
        if (applied.cover !== undefined) {
          await config.store.blobs(`app:${app.id}`).put("cover.png", applied.cover, {
            contentType: "image/png",
          });
        }
        await machines.evict(appId);
        return withPinDrift({ app: persisted, version: { ...version } });
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
        undo: async () => {
          const restored = await surface.undo();
          await machines.evict(appId);
          return restored;
        },
      });
    },

    async open(appId, ctx) {
      return opener(await requireOwned(appId, ctx.principal.subject), ctx);
    },

    async call(appId, ref, args, ctx) {
      const app = await requireOwned(appId, ctx.principal.subject);
      // Only fn: refs reach the machine and need a run token; a host-tool ref goes
      // straight to the guard-bound registry, so don't pay for HMAC signing there.
      // The fn: path mints its own token via machines.withMachine when none is passed.
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
      return share(appId, app, ctx);
    },

    async publish(appId, ctx) {
      const app = await requireOwned(appId, ctx.principal.subject);
      return publish(appId, app, ctx);
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
            generationDependencies(config, config.model),
          );
          const remaining = replayIntents.slice(index + 1);
          if (generated.kind !== "document") {
            return failedRebase(intent, generated.kind === "failure"
              ? [...generated.issues]
              : ["replayed intent produced a server code edit; pin intents replay through the tree edit path only"], remaining);
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
          await machines.evict(input.appId);
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
          await machines.evict(input.appId);
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

    proxy,
  };

  return runtime;
};
