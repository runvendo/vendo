/**
 * Structural declarations of wire-response shapes owned by sibling block
 * contracts (06-apps, 07-automations, 03-agent, 09-vendo §3).
 *
 * ui depends on core only (00-overview dependency rule), so shapes that the
 * wire returns but core does not export are declared here, verbatim from the
 * frozen contract text. The wire is the contract: both sides derive from the
 * same frozen documents, so these cannot drift within the version train.
 */
import type {
  AppDocument,
  AppId,
  ApprovalRequest,
  AuditEvent,
  IsoDateTime,
  RunId,
  ThreadId,
  TriggerSource,
  ToolOutcome,
  UIPayload,
} from "@vendoai/core";
import type { UIMessage } from "ai";

/** 06-apps §1 — what `GET /apps/:id/open` returns. */
export type OpenSurface =
  | { kind: "tree"; payload: UIPayload; components?: Record<string, string> }
  | { kind: "http"; url: string }
  | { kind: "resuming"; cover?: string };

/** 06-apps §1 — what `POST /apps/:id/edit` returns. */
export interface EditResult {
  app: AppDocument;
  version: VersionEntry;
  issues?: string[];
}

/** 06-apps §1 — one entry of `GET /apps/:id/history`. */
export interface VersionEntry {
  at: IsoDateTime;
  intent: string;
  rung: 1 | 2 | 3 | 4;
}

/** 07-automations §5 */
export type RunStatus = "running" | "ok" | "error" | "stopped" | "pending-approval";

/** 07-automations §5 — what `/runs` routes return. */
export interface RunRecord {
  id: RunId;
  appId: AppId;
  trigger: { kind: TriggerSource["kind"]; event?: string };
  status: RunStatus;
  startedAt: IsoDateTime;
  finishedAt?: IsoDateTime;
  steps: Array<{ id: string; tool: string; outcome: ToolOutcome["status"]; at: IsoDateTime; detail?: string }>;
  summary?: string;
  error?: { code: string; message: string };
}

/** 07-automations §1 — what `POST /automations/:id/dry-run` returns. */
export interface RunPlan {
  steps: Array<{ id: string; tool: string; wouldAsk: boolean }>;
  grantsMissing: string[];
}

/** 07-automations §1 — one entry of `GET /automations`. */
export interface AutomationEntry {
  app: AppDocument;
  enabled: boolean;
}

/** 07-automations §1 — what `POST /automations/:id/enable` returns. */
export interface EnableResult {
  enabled: boolean;
  missing: ApprovalRequest[];
}

/** 03-agent §5 — what `GET /threads/:id` returns. */
export interface Thread {
  id: ThreadId;
  subject: string;
  messages: UIMessage[];
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

/** 03-agent §5 — one entry of `GET /threads`. */
export interface ThreadSummary {
  id: ThreadId;
  title: string;
  updatedAt: IsoDateTime;
}

/** 05-guard §1 `status()` / 09-vendo §3 — what `GET /status` returns. */
export type GuardPosture = "unconfigured" | "rules" | "judge" | "rules+judge";

export interface VendoStatus {
  posture: GuardPosture;
  version: string;
  blocks: Record<string, unknown>;
}
