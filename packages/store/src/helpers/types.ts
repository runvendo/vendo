import type {
  AppDocument,
  AppId,
  ApprovalId,
  ApprovalRequest,
  IsoDateTime,
  Json,
  RunId,
  ThreadId,
  TriggerSource,
} from "@vendoai/core";

/** 02-store §3 */
export interface AppRow {
  id: AppId;
  subject: string;
  enabled: boolean;
  doc: AppDocument;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

/** 02-store §3 */
export interface ThreadRow {
  id: ThreadId;
  subject: string;
  messages: Json[];
  /** Precomputed listing title (03 §5); lets `list` skip loading the messages array. */
  title?: string;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
  /** Opaque write counter backing the routed atomic capability (01 §12); bumped
   *  on every write. Absent only on projections that never carry it (listSelect). */
  revision?: string;
}

/** 02-store §3 */
export interface ApprovalRow {
  id: ApprovalId;
  subject: string;
  request: ApprovalRequest;
  status: "pending" | "approved" | "denied";
  decidedAt?: IsoDateTime;
  sessionId?: string;
  consumedAt?: IsoDateTime;
  createdAt: IsoDateTime;
}

/** 02-store §3 */
export interface RunRow {
  id: RunId;
  appId: AppId;
  trigger: { kind: TriggerSource["kind"]; event?: string };
  status: "running" | "ok" | "error" | "stopped" | "pending-approval";
  record: Json;
  startedAt: IsoDateTime;
  finishedAt?: IsoDateTime;
}

export interface EphemeralStateRow {
  appId: AppId;
  subject: string;
  data: Json;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}
