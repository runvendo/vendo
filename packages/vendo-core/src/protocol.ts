import type { UIMessage } from "ai";
import type { UINode } from "./ui.js";
import type { FieldFormat } from "./manifest/tool.js";

export const SCHEMA_VERSION = 1 as const;

/** Message metadata. Run identity is set by the engine's `start` chunk. */
export interface VendoMetadata {
  runId?: string;
  threadId?: string;
  schemaVersion?: number;
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
 * Vendo's typed data-* parts layered on the ai SDK UIMessage.
 *
 * Approval PAUSING is NOT here: human-in-the-loop tool approval is handled by
 * the ai SDK natively (`needsApproval` tools + `addToolApprovalResponse`).
 * `consent` below is TIER METADATA riding beside that native mechanism — the
 * engine writes one persistent `data-consent` part per non-read tool call
 * (ENG-193 §4.1/§4.5), which backs both the approval card's ceremony/unverified
 * rendering (when the call paused) and the receipt line (when it didn't —
 * spec Moment 2, a silently-allowed mutating call still gets a receipt).
 */
export interface ConsentTierPart {
  toolCallId: string;
  tier: "act" | "critical";
  unverified: boolean;
  /** The judge/breaker's plain-language escalation reason (ENG-193 §4.2/§4.7).
   *  Absent for an ordinary (non-escalated) act-tier call. */
  reason?: string;
  /** Per-field display-format hints (field name → format) carried from the
   *  host tool's declared `formats`, so the approval card/receipt renders a
   *  money/date field faithfully ($500.00, not 50000). Absent when the tool
   *  declares none. The closed enum keeps this part inside the typed protocol
   *  (the shell still guards the values defensively before rendering). */
  formats?: Record<string, FieldFormat>;
}

export type VendoDataParts = {
  ui: UINode;
  consent: ConsentTierPart;
};

/** The public message type: an ai SDK UIMessage with Vendo metadata + data parts. */
export type VendoUIMessage = UIMessage<VendoMetadata, VendoDataParts>;
