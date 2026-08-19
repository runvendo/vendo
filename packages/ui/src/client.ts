/**
 * createVendoClient — typed fetch/SSE bindings for every wire route (09 §3).
 * Exposed for non-React consumers; every hook rides this.
 *
 * The interface is the coordination artifact between lanes; the
 * implementation lives in client-impl.ts (lane A).
 */
import {
  type AccessLevel,
  type AppDocument,
  type AppGrantRecord,
  type AppId,
  type ApprovalDecision,
  type ApprovalId,
  type ApprovalRequest,
  type AuditEvent,
  type AutomationId,
  type GrantId,
  type Json,
  type PermissionGrant,
  type RunId,
  type ThreadId,
  type ToolOutcome,
} from "@vendoai/core";
import type { UIMessage } from "ai";
import type {
  AppListRow,
  ApprovalResolution,
  AutomationEntry,
  ConnectableToolkit,
  ConnectionAccount,
  EditResult,
  EnableResult,
  InitiatedConnection,
  OpenSurface,
  PendingSurface,
  PlacementEntry,
  RunPlan,
  RunRecord,
  RunStatus,
  ShipDiff,
  SlotEntry,
  Thread,
  ThreadSummary,
  UploadedFile,
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
    /** POST /threads/warm — prime the provider's prompt cache so the first
     *  real message reads a warm prefix. Best-effort; fire when the chat
     *  surface opens and ignore failures. */
    warm(): Promise<void>;
  };

  /** The signed-in user's own files. A file put here outlives the conversation
   *  it was shared in, so the message that follows carries only the reference. */
  files: {
    /** POST /files — the file's raw bytes under its own media type, never
     *  multipart. Fetch-only, and deliberately without a progress callback: the
     *  door caps an upload at 5 MiB, which is not long enough to be news. */
    upload(file: File): Promise<UploadedFile>;
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
    list(): Promise<AppListRow[]>;
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
    /**
     * Build contract §9.2 — the ✦ share toggle's transport. `grants` reads the
     * app's grant list, the caller's own level, AND the caller's memberships
     * (projected off the ctx), so ONE round trip tells the menu which tenant to
     * name and whether the share is already on.
     */
    grants(id: AppId): Promise<{
      level: AccessLevel | null;
      grants: AppGrantRecord[];
      orgs: { org: string; display?: string }[];
    }>;
    share(id: AppId, principal: string, level: AccessLevel): Promise<{ grants: AppGrantRecord[] }>;
    unshare(id: AppId, principal: string): Promise<{ grants: AppGrantRecord[] }>;
    /** GET /apps/:id/ship-diff — the reviewable diff vs the captured host baselines (06 §8–§9). */
    shipDiff(id: AppId): Promise<ShipDiff>;
    /** POST /apps/:id/reseed — rebuild the remix against the host's current
     *  version of the component (06 §8) by replaying EVERY wish the seed
     *  recorded, oldest first. A wish the new version cannot take is kept and
     *  reported (`seed.unapplied`), never dropped. */
    reseed(id: AppId): Promise<AppDocument>;
    /**
     * POST /apps/seed — the ✦ gesture (06 §8). There are no bare forks: the
     * gesture collects the `instruction` first, and the fork plus that first edit
     * are ONE operation whose answer is an ordinary screen app carrying the
     * remix's provenance.
     */
    seedFrom(input: { component: string; slot?: string; instruction: string }): Promise<AppDocument>;
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
    /** Arm/disarm/preview ONE record — an automation is decided on its own. */
    enable(id: AutomationId): Promise<EnableResult>;
    disable(id: AutomationId): Promise<void>;
    dryRun(id: AutomationId): Promise<RunPlan>;
  };

  runs: {
    list(filter?: {
      automationId?: AutomationId;
      owner?: string;
      agent?: string;
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
    report(slots: readonly { id: string; label: string; description?: string }[]): Promise<void>;
  };

  status(): Promise<VendoStatus>;
}

export {
  APPROVALS_DECIDED_EVENT,
  createVendoClient,
  type ApprovalsDecidedDetail,
} from "./client-impl.js";
