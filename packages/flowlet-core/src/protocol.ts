import type { UIMessage } from "ai";
import type { UINode } from "./ui";

export const SCHEMA_VERSION = 1 as const;

/** Run identity, carried as a (transient) data-run part at stream start. */
export interface RunInfo {
  runId: string;
  threadId: string;
  schemaVersion: number;
}

/** Approval request, carried as a data-approval part. */
export interface ApprovalRequest {
  approvalId: string;
  toolCallId: string;
  prompt: string;
  input: unknown;
  expiresAt?: number;
}

/** Approval response, carried as a data-approval-response client part. */
export interface ApprovalResponse {
  approvalId: string;
  approved: boolean;
  editedInput?: unknown;
}

/** Sandbox action, carried as a data-action client part (semantic shape; transport is F3). */
export interface ActionRequest {
  requestId: string;
  originNodeId: string;
  action: string;
  payload?: unknown;
}

/** Flowlet's typed data-* parts layered on the ai SDK UIMessage. */
export interface FlowletDataParts {
  run: RunInfo;
  ui: UINode;
  approval: ApprovalRequest;
}

/** The public message type: an ai SDK UIMessage with Flowlet data parts. */
export type FlowletUIMessage = UIMessage<never, FlowletDataParts>;

/** Client -> server parts (the return channel). */
export type ClientPart =
  | { type: "data-approval-response"; data: ApprovalResponse }
  | { type: "data-action"; data: ActionRequest };
