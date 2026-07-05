import { useMemo } from "react";
import type { FlowletUIMessage } from "@flowlet/core";
import type { UINode } from "@flowlet/core";
import { useFlowletChat } from "@flowlet/react";

export type ThreadItem =
  | { kind: "text"; key: string; messageId: string; role: "user" | "assistant"; text: string }
  | {
      kind: "file";
      key: string;
      messageId: string;
      role: "user" | "assistant";
      mediaType: string;
      filename?: string;
      url: string;
    }
  | {
      kind: "tool";
      key: string;
      messageId: string;
      toolName: string;
      toolCallId?: string;
      state: string;
      input?: unknown;
      output?: unknown;
      errorText?: string;
      /** From the sibling data-consent part (ENG-193 §4.1/§4.5). Absent for
       *  read-tier calls and for messages from before this shipped. */
      tier?: "act" | "critical";
      unverified?: boolean;
    }
  | {
      kind: "approval";
      key: string;
      messageId: string;
      approvalId: string;
      toolCallId?: string;
      toolName: string;
      input: unknown;
      tier?: "act" | "critical";
      unverified?: boolean;
      /** The judge/breaker's plain-language reason (ENG-193 §4.2/§4.7), from
       *  the sibling data-consent part. Absent for an ordinary approval. */
      reason?: string;
    }
  | { kind: "ui"; key: string; messageId: string; node: UINode }
  | { kind: "skeleton"; key: string; messageId: string; name?: string }
  | { kind: "error"; key: string; messageId: string; message: string };

/** A tool step inside a grouped activity panel. */
export type ToolItem = Extract<ThreadItem, { kind: "tool" }>;

/** A render unit: either a plain item or a group of a turn's tool calls. */
export type RenderItem =
  | ThreadItem
  | { kind: "activity"; key: string; messageId: string; steps: ToolItem[] }
  | { kind: "approval-batch"; key: string; messageId: string; toolName: string; items: Extract<ThreadItem, { kind: "approval" }>[] };

/**
 * Built-in tools whose product is a `data-ui` node (the rendered view, or the
 * host-privileged Connect card). Their raw tool chip is suppressed to avoid a
 * redundant sliver next to the rendered component. Mirrors `RENDER_VIEW_TOOL_NAME`
 * and `REQUEST_CONNECT_TOOL_NAME` in `@flowlet/runtime`.
 */
const RENDER_TOOLS = new Set(["render_view", "request_connect"]);

/** Reads the streaming component name out of a render tool part's partial input (if any). */
function renderName(input: unknown): string | undefined {
  if (input && typeof input === "object" && "name" in input) {
    const name = (input as { name?: unknown }).name;
    if (typeof name === "string" && name.length > 0) return name;
  }
  return undefined;
}

/** Pure normalizer: flattens message parts into ordered render items. */
export function toThreadItems(messages: FlowletUIMessage[]): ThreadItem[] {
  const items: ThreadItem[] = [];
  for (const message of messages) {
    const role = message.role === "user" ? "user" : "assistant";
    const messageId = message.id;
    // First pass: index this message's data-consent parts by toolCallId
    // (ENG-193 §4.5) — a tool part and its tier metadata can arrive in either
    // order within the same message, so both branches below read this map
    // rather than assuming ordering.
    const tierByToolCallId = new Map<string, { tier: "act" | "critical"; unverified: boolean; reason?: string }>();
    for (const rawPart of message.parts) {
      const part = rawPart as { type: string; data?: { toolCallId?: string; tier?: string; unverified?: boolean; reason?: string } };
      if (part.type === "data-consent" && part.data?.toolCallId) {
        tierByToolCallId.set(part.data.toolCallId, {
          tier: part.data.tier as "act" | "critical",
          unverified: Boolean(part.data.unverified),
          ...(part.data.reason ? { reason: part.data.reason } : {}),
        });
      }
    }
    message.parts.forEach((rawPart, index) => {
      const part = rawPart as { type: string; [k: string]: unknown };
      const key = `${message.id}:${index}`;
      if (part.type === "text") {
        items.push({ kind: "text", key, messageId, role, text: String(part.text ?? "") });
      } else if (part.type === "file") {
        items.push({
          kind: "file",
          key,
          messageId,
          role,
          mediaType: String(part.mediaType ?? "application/octet-stream"),
          filename: part.filename as string | undefined,
          url: String(part.url ?? ""),
        });
      } else if (part.type === "error") {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const p = part as any;
        const text = String(p.errorText ?? p.error ?? "Something went wrong");
        items.push({ kind: "error", key, messageId, message: text });
      } else if (part.type === "data-ui") {
        items.push({ kind: "ui", key, messageId, node: part.data as UINode });
      } else if (part.type === "data-consent") {
        // Consumed via tierByToolCallId above — never its own render item.
      } else if (part.type.startsWith("tool-")) {
        const toolName = part.type.slice("tool-".length);
        const toolCallId = part.toolCallId as string | undefined;
        const tierInfo = toolCallId ? tierByToolCallId.get(toolCallId) : undefined;
        if (part.state === "approval-requested") {
          const approval = part.approval as { id: string };
          items.push({
            kind: "approval", key, messageId, approvalId: approval.id, toolCallId, toolName, input: part.input,
            tier: tierInfo?.tier, unverified: tierInfo?.unverified,
            ...(tierInfo?.reason ? { reason: tierInfo.reason } : {}),
          });
        } else if (RENDER_TOOLS.has(toolName)) {
          // A render tool's finished output is the sibling data-ui node (so no chip).
          // While render_view is still streaming/pending, show a skeleton in its
          // place so the user sees a view being built. request_connect is NOT a
          // built view — it resolves instantly into the host Connect card, so it
          // gets no skeleton (a "building your view" beat there reads absurd).
          const state = String(part.state ?? "");
          if (toolName === "render_view" && (state === "input-streaming" || state === "input-available")) {
            items.push({ kind: "skeleton", key, messageId, name: renderName(part.input) });
          } else if (state === "output-error") {
            items.push({ kind: "error", key, messageId, message: String(part.errorText ?? "Failed to render UI") });
          }
          // output-available: skip — the data-ui node carries the result.
        } else {
          // Carry tool detail through so the chip can show meaningful content.
          // Fields stay `undefined` when absent (the SDK only populates `input`
          // at input-available+ and `output`/`errorText` at the terminal state).
          items.push({
            kind: "tool",
            key,
            messageId,
            toolName,
            toolCallId,
            state: String(part.state ?? ""),
            input: part.input,
            output: part.output,
            errorText: part.errorText as string | undefined,
            tier: tierInfo?.tier, unverified: tierInfo?.unverified,
          });
        }
      }
    });
  }
  return items;
}

/**
 * Collapses each turn's consecutive tool calls into a single `activity` group so
 * the message list can render one activity panel per turn instead of a chip per
 * tool. Non-tool items pass through in place; the group takes the position of the
 * turn's first tool call. Sibling approval-requested items of the SAME tool in
 * the SAME message also collapse into one `approval-batch` (ENG-193 §3 Moment
 * 4 — "ten at once → one decision"); a lone approval stays a plain `approval`
 * item so the existing single-card path renders it unchanged. Critical-tier
 * approvals are exempt from batching entirely (spec §3 Moment 6/§4.1): each
 * always renders its own ceremony ApprovalCard.
 */
export function groupThreadItems(items: ThreadItem[]): RenderItem[] {
  const out: RenderItem[] = [];
  const groupIndexByMessage = new Map<string, number>();
  // key = `${messageId}::${toolName}` -> index into `out` of its approval-batch
  const approvalGroupIndex = new Map<string, number>();

  for (const item of items) {
    if (item.kind === "tool") {
      const existing = groupIndexByMessage.get(item.messageId);
      if (existing !== undefined) {
        (out[existing] as { steps: ToolItem[] }).steps.push(item);
      } else {
        groupIndexByMessage.set(item.messageId, out.length);
        out.push({ kind: "activity", key: `activity:${item.messageId}`, messageId: item.messageId, steps: [item] });
      }
    } else if (item.kind === "approval") {
      // Critical-tier approvals NEVER enter batch collapse (spec §3 Moment
      // 6/§4.1): every money/irreversible action renders its own ceremony
      // card, one deliberate decision each — a batch "Approve all N" would
      // bypass the ceremony register and its untruncated fields.
      if (item.tier === "critical") {
        out.push(item);
        continue;
      }
      const groupKey = `${item.messageId}::${item.toolName}`;
      if (approvalGroupIndex.has(groupKey)) {
        // A sibling of an already-seen tool in this message: never pushed as
        // its own render item. The second pass below collects every sibling
        // straight from `items` (not `out`) and promotes the FIRST sighting's
        // placeholder into the batch, so this one doesn't need its own slot.
        // (During this pass the placeholder is always still a plain
        // "approval" — promotion only happens in the second pass.)
        continue;
      }
      // First sighting: hold a place. It gets promoted to a real
      // "approval-batch" only if a SECOND sibling of the same tool shows up
      // (below) — a lone approval stays a plain "approval" render item so
      // ApprovalCard (not ApprovalBatchCard) renders it, unchanged from today.
      approvalGroupIndex.set(groupKey, out.length);
      out.push(item);
    } else {
      out.push(item);
    }
  }

  // Second pass: promote any placeholder that gained siblings into a real
  // "approval-batch" — done as a pass rather than inline above so a batch's
  // FIRST item (already pushed as a plain "approval") converts cleanly once
  // its second sibling is seen, without special-casing index 0 vs index 1+.
  for (const [groupKey, index] of approvalGroupIndex) {
    const entry = out[index];
    if (entry && entry.kind === "approval") {
      const toolName = groupKey.slice(groupKey.indexOf("::") + 2);
      const siblings = items.filter(
        (i): i is Extract<ThreadItem, { kind: "approval" }> =>
          // tier !== "critical" mirrors the skip above: a critical item that
          // shares a message+tool with act siblings must not be pulled into
          // their batch during promotion either.
          i.kind === "approval" && i.tier !== "critical" &&
          i.messageId === entry.messageId && i.toolName === toolName,
      );
      if (siblings.length > 1) {
        out[index] = {
          kind: "approval-batch", key: `approval-batch:${entry.messageId}:${toolName}`,
          messageId: entry.messageId, toolName, items: siblings,
        };
      }
    }
  }
  return out;
}

/** The nearest user text item preceding the item with key `uiKey` — i.e. the
 *  prompt that produced a rendered view. Used when saving a flowlet (ENG-183). */
export function originatingPrompt(items: ThreadItem[], uiKey: string): string | undefined {
  const at = items.findIndex((item) => item.key === uiKey);
  if (at < 0) return undefined;
  for (let i = at - 1; i >= 0; i--) {
    const item = items[i];
    if (item?.kind === "text" && item.role === "user" && item.text.trim()) return item.text;
  }
  return undefined;
}

/** Hook: F1 chat plus the normalized item list. */
export function useFlowletThread() {
  const chat = useFlowletChat();
  const items = useMemo(() => toThreadItems(chat.messages), [chat.messages]);
  return { ...chat, items };
}
