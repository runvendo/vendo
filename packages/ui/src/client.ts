/**
 * createVendoClient — typed fetch/SSE bindings for every wire route (09 §3).
 * Exposed for non-React consumers; every hook rides this.
 *
 * The interface is the coordination artifact between lanes; the
 * implementation lives in client-impl.ts (lane A).
 */
import type {
  AppDocument,
  AppId,
  ApprovalDecision,
  ApprovalId,
  ApprovalRequest,
  AuditEvent,
  GrantId,
  Json,
  PermissionGrant,
  RunId,
  ThreadId,
  ToolOutcome,
} from "@vendoai/core";
import type { UIMessage } from "ai";
import type {
  ApprovalResolution,
  AutomationEntry,
  ConnectableToolkit,
  ConnectionAccount,
  EditResult,
  EnableResult,
  InitiatedConnection,
  OpenSurface,
  PendingSurface,
  PinForkResult,
  PinRebaseResult,
  PlacementEntry,
  RunPlan,
  RunRecord,
  RunStatus,
  ShipDiff,
  SlotEntry,
  Thread,
  ThreadSummary,
  VendoStatus,
  VersionEntry,
} from "./wire-types.js";

export interface VendoClientConfig {
  /** Wire mount point. Default "/api/vendo". */
  baseUrl?: string;
  headers?: Record<string, string>;
}

export interface VendoClient {
  readonly baseUrl: string;
  readonly headers: Record<string, string>;

  threads: {
    /** POST /threads — one conversational turn; the ai-SDK UI message stream (SSE) Response. */
    stream(input: { threadId?: ThreadId; message: UIMessage }): Promise<Response>;
    list(): Promise<ThreadSummary[]>;
    get(id: ThreadId): Promise<Thread>;
    delete(id: ThreadId): Promise<void>;
  };

  approvals: {
    pending(): Promise<ApprovalRequest[]>;
    /** Batch-capable: POST /approvals/decide { ids, decision }. `options.grantSetId`
        (additive) names the grant SET the ids settle so the decided announcement
        can resume a thread parked on the set from ANY surface — it never rides
        the wire. */
    decide(ids: ApprovalId | ApprovalId[], decision: ApprovalDecision, options?: { grantSetId?: string }): Promise<void>;
    /** Existing-agents — GET /approvals/:id, the per-approval state
        `<VendoApprovalEmbed>` polls (pending/executed/declined/expired). */
    get(id: ApprovalId): Promise<ApprovalResolution>;
  };

  grants: {
    list(): Promise<PermissionGrant[]>;
    revoke(id: GrantId): Promise<void>;
  };

  /** 04-actions §3 — per-principal connected accounts (Composio broker). */
  connections: {
    list(): Promise<ConnectionAccount[]>;
    /** POST /connections/initiate — returns the broker's OAuth redirect URL. */
    initiate(input: { toolkit: string; connector?: string; callbackUrl?: string }): Promise<InitiatedConnection>;
    /** GET /connections/:id — poll while the user completes the redirect. */
    status(id: string, connector?: string): Promise<ConnectionAccount>;
    disconnect(id: string, connector?: string): Promise<void>;
    /** GET /connections/catalog — the host-level connectable toolkits; feeds
        the connect dock when no explicit `connectors` prop is passed. */
    catalog(): Promise<ConnectableToolkit[]>;
  };

  apps: {
    list(): Promise<AppDocument[]>;
    create(input: { prompt: string }): Promise<AppDocument>;
    get(id: AppId): Promise<AppDocument>;
    delete(id: AppId): Promise<void>;
    open(id: AppId): Promise<OpenSurface>;
    /** Existing-agents polish — the embed's build-window poll: with
        `pending: true` a not-yet-servable app answers `{ kind: "pending" }`
        over HTTP 200 instead of the contracted 404, so the poll never logs
        browser console errors while the build streams. */
    open(id: AppId, options: { pending: true }): Promise<OpenSurface | PendingSurface>;
    call(id: AppId, ref: string, args: Json): Promise<ToolOutcome>;
    edit(id: AppId, instruction: string): Promise<EditResult>;
    history(id: AppId): Promise<VersionEntry[]>;
    exportApp(id: AppId): Promise<Uint8Array>;
    importApp(bytes: Uint8Array): Promise<AppDocument>;
    fork(id: AppId): Promise<AppDocument>;
    /** GET /apps/:id/ship-diff — the reviewable diff vs the captured host baselines (06 §8–§9). */
    shipDiff(id: AppId): Promise<ShipDiff>;
    /** POST /apps/:id/rebase-pin — re-fork one drifted pin from the new baseline and replay its recorded intents (06 §8). */
    rebasePin(id: AppId, slot: string): Promise<PinRebaseResult>;
    /**
     * POST /apps/fork-pin (no appId) or /apps/:id/fork-pin — the gesture-owned
     * DETERMINISTIC fork of a remixable host slot (06 §8): the engine copies
     * the captured baseline and records the pin with no model call. Without an
     * appId a minimal app is minted around the fork (the `<Remixable>` ✦
     * gesture). `props` — the wrapper's serializable live props at fork time —
     * is stored on the fork as its dashboard seed (2026-08-02 final shape). An
     * optional instruction rides the ordinary edit path afterwards, already
     * scoped to the forked component.
     */
    forkPin(input: { appId?: AppId; slot: string; props?: Record<string, Json>; instruction?: string }): Promise<PinForkResult>;
    /**
     * POST /apps/:id/machine/ping — the embed surface's keepalive:
     * user activity on an embedded served app rides one host-proxied HEAD
     * through the machine, keeping it from idling out under the user. "woke"
     * means the machine had slept — the embed's URL is stale; re-open.
     */
    pingMachine(id: AppId): Promise<{ state: "awake" | "woke" }>;
    /**
     * Placement (2026-08-05) — "show this app in that slot". `POST
     * /apps/:id/place`; one app per slot, so the answer names whatever the
     * write displaced (`evicted`).
     */
    place(id: AppId, slot: string): Promise<{ evicted?: string }>;
    /** `POST /apps/:id/unplace` — clear the slot, if this app still holds it. */
    unplace(id: AppId, slot: string): Promise<void>;
    /** `GET /apps/placements` — what is in the caller's slots. Pass the slots
     *  actually mounted so one request answers the whole page. */
    placements(slots?: readonly string[]): Promise<PlacementEntry[]>;
  };

  automations: {
    list(): Promise<AutomationEntry[]>;
    /** Arm/disarm/preview ONE trigger of an app — an automation is an app with
     *  a LIST of triggers, and each is decided on its own. */
    enable(id: AppId, triggerId: string): Promise<EnableResult>;
    disable(id: AppId, triggerId: string): Promise<void>;
    dryRun(id: AppId, triggerId: string): Promise<RunPlan>;
  };

  runs: {
    list(filter?: {
      appId?: AppId;
      triggerId?: string;
      status?: RunStatus;
      cursor?: string;
    }): Promise<{ runs: RunRecord[]; cursor?: string }>;
    get(id: RunId): Promise<RunRecord>;
    stop(id: RunId): Promise<void>;
    /** POST /runs/:id/rerun — run it again: a FRESH run of the same automation
     *  on the same triggering event. The remedy a failed run leaves behind (07
     *  §1 `runs.rerun`); answers with the new run's id. */
    rerun(id: RunId): Promise<RunId>;
  };

  activity: {
    /** GET /activity — self-scoped audit events; cursor = the id of the last seen event. */
    list(params?: { cursor?: string; limit?: number }): Promise<AuditEvent[]>;
  };

  /** The slot registry — where the "Add to…" picker's destinations come from.
   *  A slot id lives in the host's markup and nowhere else, so a mounted
   *  `VendoSlot` is the only thing that can say one exists. */
  slots: {
    /** GET /slots — every reported destination, newest first. */
    list(): Promise<SlotEntry[]>;
    /** POST /slots — mounted slots saying they exist; batched, idempotent. */
    report(slots: readonly { id: string; label: string }[]): Promise<void>;
  };

  status(): Promise<VendoStatus>;
}

export {
  APPROVALS_DECIDED_EVENT,
  createVendoClient,
  type ApprovalsDecidedDetail,
} from "./client-impl.js";
