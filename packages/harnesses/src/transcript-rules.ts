/**
 * The transcript-side rules a turn must apply identically, whoever serves it:
 * what a client may change about stored history, and how a superseded approval
 * resolves.
 *
 * They live beside the runtime rather than inside a door because two doors read
 * them (the harness runtime and, until it is deleted, `createAgent`), and a
 * second copy of "may a client rewrite this message?" is a security answer that
 * could drift.
 */
import { VendoError, type ApprovalId } from "@vendoai/core";
import { isToolUIPart, type UIMessage } from "ai";

// System-role messages are rejected: the system prompt is assembled server-side
// (03 §3); accepting one from the client would be a prompt-injection channel.
export function validateMessage(message: UIMessage | undefined): asserts message is UIMessage {
  if (!message
    || typeof message.id !== "string"
    || message.id.length === 0
    || !["user", "assistant"].includes(message.role)
    || !Array.isArray(message.parts)) {
    throw new VendoError("validation", "stream requires a valid message");
  }
}

export function upsertMessage(messages: UIMessage[], message: UIMessage): void {
  const index = messages.findIndex((candidate) => candidate.id === message.id);
  if (index === -1) messages.push(message);
  else messages[index] = message;
}

/** Structural JSON equality, key-order independent (both sides are
 *  wire-serializable UIMessage parts). */
function jsonEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right)
      && left.length === right.length
      && left.every((item, index) => jsonEqual(item, right[index]));
  }
  if (typeof left !== "object" || typeof right !== "object" || left === null || right === null) {
    return false;
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const keys = Object.keys(leftRecord);
  return keys.length === Object.keys(rightRecord).length
    && keys.every((key) => jsonEqual(leftRecord[key], rightRecord[key]));
}

/** AGENT-12: is `incoming` the one client-writable change to a stored part —
 *  answering a pending approval? The verdict payload is exactly
 *  `{ id (unchanged), approved, reason? }` and EVERY other field of the part
 *  must stay byte-identical — no fabricated output or altered props may ride
 *  along on the flip. */
function isApprovalResponse(stored: unknown, incoming: unknown): boolean {
  const before = stored as Record<string, unknown>;
  const after = incoming as Record<string, unknown>;
  if (before.state !== "approval-requested" || after.state !== "approval-responded") return false;
  const beforeApproval = before.approval as { id?: unknown } | undefined;
  const afterApproval = after.approval as Record<string, unknown> | undefined;
  if (beforeApproval === undefined || afterApproval === undefined) return false;
  if (afterApproval.id !== beforeApproval.id
    || typeof afterApproval.approved !== "boolean"
    || (afterApproval.reason !== undefined && typeof afterApproval.reason !== "string")
    || Object.keys(afterApproval).some((key) => !["id", "approved", "reason"].includes(key))) {
    return false;
  }
  // Reverting the flip must reproduce the stored part exactly.
  return jsonEqual({ ...after, state: before.state, approval: before.approval }, before);
}

/** AGENT-12: clients may add fresh USER messages and answer approvals — they
 *  may not author assistant content or rewrite history by replaying a known
 *  message id with different parts. */
export function validateUpsert(messages: UIMessage[], message: UIMessage): void {
  const existing = messages.find((candidate) => candidate.id === message.id);
  if (existing === undefined) {
    if (message.role !== "user") {
      throw new VendoError("validation", "assistant messages are server-authored; a new message must be role user");
    }
    return;
  }
  if (existing.role !== message.role) {
    throw new VendoError("validation", "a message upsert cannot change the message role");
  }
  // Serialize both sides so explicit-undefined props (which JSON drops on the
  // wire anyway) never make an identical part read as different.
  const stored = JSON.parse(JSON.stringify(existing.parts)) as unknown[];
  const incoming = JSON.parse(JSON.stringify(message.parts)) as unknown[];
  if (message.role === "user") {
    if (!jsonEqual(stored, incoming)) {
      throw new VendoError("validation", "an existing user message cannot be rewritten");
    }
    return;
  }
  if (stored.length !== incoming.length
    || !stored.every((part, index) => jsonEqual(part, incoming[index]) || isApprovalResponse(part, incoming[index]))) {
    throw new VendoError(
      "validation",
      "an assistant message upsert may only answer pending approvals",
    );
  }
}

export function abandonPendingApprovals(messages: UIMessage[]): string[] {
  const abandonedToolCallIds: string[] = [];
  for (const message of messages) {
    message.parts = message.parts.map((part) => {
      if (!isToolUIPart(part)) return part;
      // Parts flipped on an EARLIER turn re-collect too: guard-side resolution
      // is best-effort per turn, so a failed abandonApprovals call retries on
      // the next fresh turn (the guard method is idempotent — an
      // already-denied id is a no-op there).
      if (part.state === "approval-responded"
        && part.approval?.approved === false
        && (part.approval as { reason?: string }).reason === "abandoned") {
        abandonedToolCallIds.push(part.toolCallId);
        return part;
      }
      if (part.state !== "approval-requested") return part;
      abandonedToolCallIds.push(part.toolCallId);
      return {
        ...part,
        state: "approval-responded",
        approval: {
          id: part.approval.id,
          approved: false,
          reason: "abandoned",
        },
      };
    });
  }
  return abandonedToolCallIds;
}

/** self-serve P — a new turn never inherits the LAST turn's failure notice.
 *  When the thread's final message is an assistant turn, the ai-SDK CONTINUES
 *  it (handleUIMessageStreamFinish reuses its id and seeds the new turn's state
 *  from its parts), so a retry after a failed turn would append the real answer
 *  UNDER the stale "no model key" line and persist both — the flagship keyless
 *  → `vendo login` → Retry flow, permanently wrong on every reload. Anything
 *  the failed turn actually produced (partial text, tool beats) stays.
 *
 *  The emptied message is KEPT rather than dropped: persistence writes one row
 *  per changed message and can only add or replace, never remove. A message
 *  dropped here would simply stay in the store — the retry would look clean live
 *  and still reload with the stale notice above the answer. Left in place, the
 *  continuation reuses its id and the write overwrites the stored copy.
 *
 *  `stored` is the transcript as the STORE holds it, and it is what makes this
 *  work over the wire: the ai-SDK's `regenerate()` slices the assistant message
 *  it is replacing off the history it posts, so the retry arrives ending in the
 *  user message and the record to clear is not in it at all. Carrying the stored
 *  one back on is also what makes the retry a continuation — the SDK reuses that
 *  message's id, so the recovered answer overwrites the failed row instead of
 *  landing under it. Without it the reload showed both, forever. */
export function clearFailedTurnRecord(messages: UIMessage[], stored: readonly UIMessage[] = []): void {
  const last = messages.at(-1);
  if (last === undefined) return;
  const strip = (message: UIMessage): UIMessage["parts"] =>
    message.parts.filter((part) => part.type !== "data-vendo-turn-error");
  if (last.role === "assistant") {
    const kept = strip(last);
    if (kept.length !== last.parts.length) last.parts = kept;
    return;
  }
  // Only the record directly behind this message, and only when it is the end of
  // the stored thread: anything else is history the turn is not replacing.
  const at = stored.findIndex((message) => message.id === last.id);
  if (at === -1 || at !== stored.length - 2) return;
  const failed = stored[at + 1];
  if (failed?.role !== "assistant" || strip(failed).length === failed.parts.length) return;
  const carried = structuredClone(failed) as UIMessage;
  carried.parts = strip(carried);
  messages.push(carried);
}

/** AGENT-6: the guard's approval ids for abandoned tool calls. The native tool
 *  part's `approval.id` is the ai-SDK's own handle; the GUARD's approvalId
 *  rides the data-vendo-approval part beside it, keyed by toolCallId — read it
 *  from either the persisted nested envelope or the flat §16 shape. */
export function guardApprovalIds(messages: UIMessage[], toolCallIds: string[]): ApprovalId[] {
  if (toolCallIds.length === 0) return [];
  const wanted = new Set(toolCallIds);
  const ids: ApprovalId[] = [];
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type !== "data-vendo-approval") continue;
      const payload = ("data" in part ? part.data : part) as { toolCallId?: unknown; approvalId?: unknown };
      if (typeof payload.toolCallId === "string" && wanted.has(payload.toolCallId)
        && typeof payload.approvalId === "string") {
        ids.push(payload.approvalId as ApprovalId);
      }
    }
  }
  return ids;
}
