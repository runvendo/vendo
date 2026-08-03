import { riskLabelSchema, type ApprovalRequest, type RiskLabel, type VendoCitationsPart, type VendoKnowledgeCitation } from "@vendoai/core";
import { isToolUIPart, type UIMessage } from "ai";
import { previewArgs } from "../humanize.js";
import { LONG_TEXT_CAP, truncateHead } from "../truncate.js";

export function partData(part: UIMessage["parts"][number]): unknown {
  return "data" in part ? part.data : part;
}

/** ENG-214 — the marker the agent's `wireErrorMessage` puts on its OWN safe
 * error text (VendoError code + operator-crafted message). Only prefixed
 * strings may be shown in detail to an end user; raw transport/provider
 * strings never carry it. Read by both error surfaces (the banner and the
 * in-thread turn-error part). */
export const VENDO_ERROR_PREFIX = "Vendo: ";

// ENG-216 — a stable placeholder for the in-thread synthesized ApprovalRequest's
// required `createdAt`. The wire approval part carries no timestamp; this value
// is never displayed (the card hides the context byline in-thread) and a fixed
// constant replaces the former per-render `new Date()` that churned on every
// re-render and broke deterministic tests.
export const SYNTHESIZED_CREATED_AT = "1970-01-01T00:00:00.000Z";

export function riskByCall(messages: UIMessage[]): Map<string, RiskLabel> {
  const risks = new Map<string, RiskLabel>();
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type !== "data-vendo-approval") continue;
      const data = partData(part) as { toolCallId?: unknown; risk?: unknown };
      if (typeof data.toolCallId === "string" && riskLabelSchema.safeParse(data.risk).success) {
        risks.set(data.toolCallId, data.risk as RiskLabel);
      }
    }
  }
  return risks;
}

/** Guard approval metadata by tool call — carried in the data-vendo-approval
    part beside the native ai-SDK approval (whose own id is transport-local). */
export function approvalByCall(messages: UIMessage[]): Map<string, {
  approvalId?: string;
  invalidatedGrant?: ApprovalRequest["invalidatedGrant"];
}> {
  const approvals = new Map<string, {
    approvalId?: string;
    invalidatedGrant?: ApprovalRequest["invalidatedGrant"];
  }>();
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type !== "data-vendo-approval") continue;
      const data = partData(part) as {
        toolCallId?: unknown;
        approvalId?: unknown;
        invalidatedGrant?: { id?: unknown; grantedAt?: unknown };
      };
      if (typeof data.toolCallId !== "string") continue;
      approvals.set(data.toolCallId, {
        ...(typeof data.approvalId === "string" ? { approvalId: data.approvalId } : {}),
        ...(typeof data.invalidatedGrant?.id === "string"
          && typeof data.invalidatedGrant.grantedAt === "string"
          ? { invalidatedGrant: data.invalidatedGrant as NonNullable<ApprovalRequest["invalidatedGrant"]> }
          : {}),
      });
    }
  }
  return approvals;
}

/** Grant-set membership by tool call — carried in the data-vendo-grant-set
    part beside the parked native call. The thread uses it to (a) hand the
    parked call to the set card instead of the plain ApprovalCard, and (b)
    resume on a decided announcement that matches the SET (by grantSetId or
    any member approval id), not just the raw native id. */
export function grantSetByCall(messages: UIMessage[]): Map<string, {
  grantSetId: string;
  approvalIds: string[];
}> {
  const sets = new Map<string, { grantSetId: string; approvalIds: string[] }>();
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type !== "data-vendo-grant-set") continue;
      const data = partData(part) as {
        toolCallId?: unknown;
        grantSetId?: unknown;
        permissions?: Array<{ approvalId?: unknown }>;
      };
      if (typeof data.toolCallId !== "string" || typeof data.grantSetId !== "string") continue;
      const approvalIds = Array.isArray(data.permissions)
        ? data.permissions
            .map(permission => permission.approvalId)
            .filter((value): value is string => typeof value === "string")
        : [];
      sets.set(data.toolCallId, { grantSetId: data.grantSetId, approvalIds });
    }
  }
  return sets;
}

/** Knowledge K1 — what a turn's `data-vendo-citations` parts add up to.
    Chips render only ANSWERED citations (a refusal's weak hits stay off the
    chip row — mockup state 2 shows the searched-line alone); the flags carry
    the refusal/outage states. */
export interface TurnKnowledgeSources {
  citations: VendoKnowledgeCitation[];
  refused: boolean;
  unavailable: boolean;
  /** Knowledge K15 — a knowledge call in this turn could not be verified
      (the evidence check was attempted and gave no verdict). */
  unverified: boolean;
}

/** Knowledge K1 (pattern: approvalByCall) — fold a turn's citations parts
    into the one summary TurnCitations renders, deduped by doc+chunk across
    multiple knowledge calls in the same turn. */
export function sourcesFor(message: UIMessage): TurnKnowledgeSources {
  const citations: VendoKnowledgeCitation[] = [];
  const seen = new Set<string>();
  let refused = false;
  let unavailable = false;
  let unverified = false;
  for (const part of message.parts) {
    if (part.type !== "data-vendo-citations") continue;
    const data = partData(part) as Partial<VendoCitationsPart>;
    if (data.outcome === "unavailable") unavailable = true;
    if (data.outcome === "insufficient-evidence") refused = true;
    if (data.unverified === true) unverified = true;
    if (data.outcome !== "answered" || !Array.isArray(data.citations)) continue;
    for (const citation of data.citations) {
      if (typeof citation?.docId !== "string" || typeof citation.title !== "string") continue;
      if (typeof citation.snippet !== "string" || typeof citation.kind !== "string") continue;
      if (citation.visibility !== "public" && citation.visibility !== "internal") continue;
      const key = `${citation.docId}::${citation.chunkId ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      citations.push(citation);
    }
  }
  return { citations, refused, unavailable, unverified };
}

export function toolName(part: Extract<UIMessage["parts"][number], { toolCallId: string }>): string {
  return part.type === "dynamic-tool" && "toolName" in part ? part.toolName : part.type.replace(/^tool-/, "");
}

/** The app-boundary title: the payload's `name`, else its first heading Text node. */
export function appTitle(payload: unknown): string | undefined {
  const named = (payload as { name?: unknown }).name;
  if (typeof named === "string" && named.trim()) return named;
  const nodes = (payload as { nodes?: Array<{ component?: string; props?: Record<string, unknown> }> }).nodes;
  if (!Array.isArray(nodes)) return undefined;
  for (const node of nodes) {
    if (node.component === "Text" && node.props?.variant === "heading" && typeof node.props.text === "string") {
      return node.props.text;
    }
  }
  return undefined;
}

/** A stable signature for a tool part — same tool + same input = the same call. */
function toolSignature(part: Extract<UIMessage["parts"][number], { toolCallId: string }>): string {
  const input = "input" in part ? part.input : undefined;
  let serialized: string;
  try {
    serialized = JSON.stringify(input);
  } catch {
    serialized = String(input);
  }
  return `${toolName(part)}::${serialized}`;
}

/** ENG-216 — collapse runs of consecutive identical tool chips (e.g. eight
    `host_listClientDocuments` calls) into one entry carrying a count. The
    latest part in the run is kept so the chip icon reflects the final state. */
export function collapseToolRuns(
  parts: UIMessage["parts"],
): { part: UIMessage["parts"][number]; index: number; count: number }[] {
  const items: { part: UIMessage["parts"][number]; index: number; count: number }[] = [];
  parts.forEach((part, index) => {
    const previous = items.at(-1);
    if (
      isToolUIPart(part)
      && previous !== undefined
      && isToolUIPart(previous.part)
      && toolSignature(previous.part) === toolSignature(part)
    ) {
      previous.count += 1;
      previous.part = part;
      return;
    }
    items.push({ part, index, count: 1 });
  });
  return items;
}

/** The plain text a user turn carried, joined across its text parts — the seed
    for "edit last message" (ENG-215). */
export function userText(message: UIMessage): string {
  return message.parts
    .filter((part): part is Extract<UIMessage["parts"][number], { type: "text" }> => part.type === "text")
    .map(part => part.text)
    .join("");
}

/** What "copy this turn" yields for an assistant message: its text parts (the
    markdown source), blank-line separated — tool beats and views don't copy. */
export function assistantText(message: UIMessage): string {
  return message.parts
    .filter((part): part is Extract<UIMessage["parts"][number], { type: "text" }> => part.type === "text")
    .map(part => part.text)
    .join("\n\n");
}

/** ENG-216 — the in-thread approval preview is built client-side (the wire part
    carries no descriptor), so format args as readable `Label: value` lines
    instead of the raw JSON with literal \n escapes end users were reading. */
export function preview(input: unknown): string {
  // ENG-216 — readable `Label: value` lines instead of raw JSON. ENG-218 — then
  // bound the result before it reaches the DOM: a huge argument blob (dumped
  // rows, base64) otherwise renders unbounded inside the approval card's <pre>,
  // blowing up layout and the node count.
  const formatted = previewArgs(input);
  return formatted.length > LONG_TEXT_CAP
    ? `${truncateHead(formatted)}\n… (${(formatted.length / 1000).toFixed(0)}k chars, truncated)`
    : formatted;
}
