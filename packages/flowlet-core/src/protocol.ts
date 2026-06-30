import type { UIMessage } from "ai";
import type { UINode } from "./ui";

export const SCHEMA_VERSION = 1 as const;

/** Run identity, carried as ai SDK UIMessage metadata (not a custom data part). */
export interface FlowletMetadata {
  runId: string;
  threadId: string;
  schemaVersion: number;
}

/** Sandbox action, carried as a data-action client part (semantic shape; transport is F3). */
export interface ActionRequest {
  requestId: string;
  originNodeId: string;
  action: string;
  payload?: unknown;
  /** Opaque capability token authorizing this action; set by the sandbox when the
   *  origin node was granted one. Absent for unprivileged actions. */
  capability?: unknown;
}

export type ActionResult =
  | { result: unknown }
  | { error: { code: string; message: string } };

/** Semantic shape of the sandbox action chokepoint. Transport is owned by F3. */
export type DispatchAction = (req: ActionRequest) => Promise<ActionResult>;

/**
 * Flowlet's typed data-* parts layered on the ai SDK UIMessage. Approvals are NOT
 * here: human-in-the-loop tool approval is handled by the ai SDK natively
 * (`needsApproval` tools + `addToolApprovalResponse`), not a custom data part.
 */
export type FlowletDataParts = {
  ui: UINode;
};

/** The public message type: an ai SDK UIMessage with Flowlet metadata + data parts. */
export type FlowletUIMessage = UIMessage<FlowletMetadata, FlowletDataParts>;
