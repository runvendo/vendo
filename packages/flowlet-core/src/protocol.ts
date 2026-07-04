import type { UIMessage } from "ai";
import type { UINode } from "./ui";

export const SCHEMA_VERSION = 1 as const;

/** Run identity, carried as ai SDK UIMessage metadata (not a custom data part). */
export interface FlowletMetadata {
  runId: string;
  threadId: string;
  schemaVersion: number;
  /** Anchor context riding a send from a FlowletRemix-scoped surface (2026-07-04 spec). */
  anchors?: AnchorContextBlock;
}

/**
 * Host-page context attached to a chat send. `scoped` is the anchor whose
 * affordance opened the surface (DOM snapshot included, captured only at
 * open). `ambient` is the page's other visible anchors — never snapshots.
 */
export interface AnchorContextBlock {
  scoped?: AnchorRef & { snapshot?: string };
  ambient?: AnchorRef[];
}

export interface AnchorRef {
  anchorId: string;
  label?: string;
  context?: unknown;
}

/**
 * Sandbox action — the semantic chokepoint shape only. How actions actually travel
 * (the transport, e.g. a client part) is owned by F3, not defined here.
 */
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
