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
  PinDrift,
  PinRebaseResult,
  RunPlan,
  RunRecord,
  RunStatus,
  ShipDiff,
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
    /** Batch-capable: POST /approvals/decide { ids, decision }. */
    decide(ids: ApprovalId | ApprovalId[], decision: ApprovalDecision): Promise<void>;
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
    call(id: AppId, ref: string, args: Json): Promise<ToolOutcome>;
    edit(id: AppId, instruction: string): Promise<EditResult>;
    history(id: AppId): Promise<VersionEntry[]>;
    undo(id: AppId): Promise<AppDocument>;
    exportApp(id: AppId): Promise<Uint8Array>;
    importApp(bytes: Uint8Array): Promise<AppDocument>;
    fork(id: AppId): Promise<AppDocument>;
    /** GET /apps/:id/ship-diff — the reviewable diff vs the captured host baselines (06 §8–§9). */
    shipDiff(id: AppId): Promise<ShipDiff>;
    /** GET /apps/:id/pin-drift — the pins whose captured host baseline changed under the fork (06 §8). */
    pinDrift(id: AppId): Promise<PinDrift[]>;
    /** POST /apps/:id/rebase-pin — re-fork one drifted pin from the new baseline and replay its recorded intents (06 §8). */
    rebasePin(id: AppId, slot: string): Promise<PinRebaseResult>;
  };

  automations: {
    list(): Promise<AutomationEntry[]>;
    enable(id: AppId): Promise<EnableResult>;
    disable(id: AppId): Promise<void>;
    dryRun(id: AppId): Promise<RunPlan>;
  };

  runs: {
    list(filter?: { appId?: AppId; status?: RunStatus; cursor?: string }): Promise<{ runs: RunRecord[]; cursor?: string }>;
    get(id: RunId): Promise<RunRecord>;
    stop(id: RunId): Promise<void>;
  };

  activity: {
    /** GET /activity — self-scoped audit events; cursor = the id of the last seen event. */
    list(params?: { cursor?: string; limit?: number }): Promise<AuditEvent[]>;
  };

  status(): Promise<VendoStatus>;
}

export { createVendoClient } from "./client-impl.js";
