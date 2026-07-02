/**
 * Client-side executor logic for host-API tools (ENG-202, topology B).
 *
 * The agent registers host-API tools with no server execute; the browser is
 * the executor, on the user's existing session. Two pure helpers drive the
 * React glue in the provider:
 *
 * - `pendingHostToolCalls` — which tool parts are ready to execute NOW. Two
 *   ready states exist, both settled (never mid-stream, because the SDK emits
 *   the tool call BEFORE its approval request — executing on `onToolCall`
 *   would bypass the gate):
 *     1. `input-available` after the stream finished → the policy allowed the
 *        call without approval.
 *     2. `approval-responded` with `approved: true` → the user approved via
 *        the existing approval card; the client must now execute and attach
 *        the output before the turn resubmits.
 *
 * - `hostAwareSendAutomaticallyWhen` — the auto-resubmit predicate. The SDK's
 *   stock approval predicate fires as soon as every approval has a response,
 *   but an approved HOST tool without an output would resubmit a broken turn
 *   (no server execute produces the result). This predicate holds resubmission
 *   until approved host tools carry outputs, and otherwise preserves the stock
 *   behaviour for server-executed tools.
 */

import type { FlowletUIMessage } from "@flowlet/core";

/** A host tool call that the browser should execute now. */
export interface PendingHostToolCall {
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
}

interface ToolPartView {
  type: string;
  toolCallId?: string;
  state?: string;
  input?: unknown;
  providerExecuted?: boolean;
  approval?: { id: string; approved?: boolean };
}

function toolName(part: ToolPartView): string {
  return part.type.slice("tool-".length);
}

function isToolPart(part: { type: string }): part is ToolPartView {
  return part.type.startsWith("tool-");
}

/** Ready-to-execute host tool calls on the (settled) last assistant message. */
export function pendingHostToolCalls(
  message: FlowletUIMessage | undefined,
  hostToolNames: ReadonlySet<string>,
): PendingHostToolCall[] {
  if (!message || message.role !== "assistant") return [];
  const pending: PendingHostToolCall[] = [];
  for (const part of message.parts as Array<{ type: string }>) {
    if (!isToolPart(part) || !hostToolNames.has(toolName(part))) continue;
    const ready =
      part.state === "input-available" ||
      (part.state === "approval-responded" && part.approval?.approved === true);
    if (ready && typeof part.toolCallId === "string") {
      pending.push({
        toolCallId: part.toolCallId,
        toolName: toolName(part),
        input: (part.input ?? {}) as Record<string, unknown>,
      });
    }
  }
  return pending;
}

/**
 * Host-aware replacement for the SDK's
 * `lastAssistantMessageIsCompleteWithApprovalResponses`. Considers only the
 * last step's non-provider-executed tool parts, like the SDK's predicates.
 */
export function hostAwareSendAutomaticallyWhen(
  hostToolNames: ReadonlySet<string>,
): (options: { messages: FlowletUIMessage[] }) => boolean {
  return ({ messages }) => {
    const message = messages[messages.length - 1];
    if (!message || message.role !== "assistant") return false;

    const parts = message.parts as Array<{ type: string }>;
    const lastStepStart = parts.reduce(
      (last, part, index) => (part.type === "step-start" ? index : last),
      -1,
    );
    const invocations = parts
      .slice(lastStepStart + 1)
      .filter(isToolPart)
      .filter((part) => part.providerExecuted !== true);
    if (invocations.length === 0) return false;

    // An approved (or un-gated) host tool without an output means the client
    // executor still owes the result — never resubmit yet.
    const hostOwesOutput = invocations.some(
      (part) =>
        hostToolNames.has(toolName(part)) &&
        (part.state === "input-available" ||
          (part.state === "approval-responded" && part.approval?.approved === true)),
    );
    if (hostOwesOutput) return false;

    const terminal = (part: ToolPartView) =>
      part.state === "output-available" ||
      part.state === "output-error" ||
      part.state === "output-denied";

    // Stock approval behaviour: every part settled or responded, and at least
    // one approval response present (covers server-tool approvals + declines).
    const responded = invocations.filter((part) => part.state === "approval-responded");
    if (
      responded.length > 0 &&
      invocations.every((part) => terminal(part) || part.state === "approval-responded")
    ) {
      return true;
    }

    // Client-output behaviour: a host tool produced its output in the browser
    // and every invocation is terminal — continue the turn.
    const hostDelivered = invocations.some(
      (part) => hostToolNames.has(toolName(part)) && terminal(part),
    );
    return hostDelivered && invocations.every(terminal);
  };
}
