/** Build the in-thread `ApprovalRequest` from the `data-vendo-approval` wire part.
 *
 *  The descriptor must travel with the approval: without the declared
 *  `inputSchema`, `declaredMoneyUnit` has nothing to read and a $47.50 transfer
 *  renders as "4750 (unit not specified)" in the thread while the same ask
 *  formats correctly in the queue.
 */
import type { ApprovalRequest, Json, JsonSchema, RiskLabel } from "@vendoai/core";
import { preview, SYNTHESIZED_CREATED_AT } from "./message-data.js";

/** Only the field this builder reads off the host's `tools` map (a `ToolMetaMap`
    at every call site). Structural, because the thread directory ships as an
    eject template and may only import the PUBLIC package surface. */
type ToolDescriptions = Record<string, { description?: string } | undefined>;

export interface ApprovalWirePart {
  /** `part.approval.id` — the guard record this card decides. */
  approvalId: string;
  /** `part.toolCallId`. */
  toolCallId: string;
  /** The raw wire tool id (the card humanizes it). */
  tool: string;
  /** The REAL inputs the model passed. */
  args?: unknown;
  /** Absent means `ungraded` — never read-only; see the default in the builder. */
  risk?: RiskLabel;
  invalidatedGrant?: ApprovalRequest["invalidatedGrant"];
  /** Descriptor fields the wire part carries when the server has them. */
  descriptor?: {
    title?: string;
    description?: string;
    inputSchema?: JsonSchema;
  };
}

/** The in-thread ApprovalRequest — real descriptor first, host metadata second,
 *  never a fabricated sentence. */
export function buildApprovalRequest(part: ApprovalWirePart, tools: ToolDescriptions): ApprovalRequest {
  const authored = part.descriptor;
  const title = authored?.title?.trim();
  return {
    id: part.approvalId,
    call: { id: part.toolCallId, tool: part.tool, args: part.args as Json },
    descriptor: {
      name: part.tool,
      description: authored?.description ?? tools[part.tool]?.description ?? "",
      inputSchema: authored?.inputSchema ?? {},
      // An absent risk is UNGRADED, a first-class grade — never "read", which
      // would make an unreviewed call claim "Read-only" on its chip.
      risk: part.risk ?? "ungraded",
      ...(title === undefined || title.length === 0 ? {} : { title }),
    },
    // Client-side humanized, never the server's `tool slug + canonical JSON`.
    inputPreview: preview(part.args),
    ...(part.invalidatedGrant === undefined ? {} : { invalidatedGrant: part.invalidatedGrant }),
    // The wire carries no ctx: only structurally-true, stable values ride here.
    // Never shown — the card sets showContext={false} in-thread.
    ctx: { principal: { kind: "user", subject: "" }, venue: "chat", presence: "present" },
    createdAt: SYNTHESIZED_CREATED_AT,
  };
}
