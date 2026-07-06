import { useMemo } from "react";
import type { VendoUIMessage } from "@vendoai/core";
import type { UINode } from "@vendoai/core";
import { useVendoChat } from "@vendoai/react";

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
  | {
      kind: "ui";
      key: string;
      messageId: string;
      node: UINode;
      /** Sealed authored-state envelope paired to this node (remix fast-edits);
       *  stored opaquely with the pin so later edits can patch base:"pin". */
      envelope?: string;
    }
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
 * and `REQUEST_CONNECT_TOOL_NAME` in `@vendoai/runtime`.
 */
const RENDER_TOOLS = new Set(["render_view", "edit_view", "request_connect"]);

/** Render tools that stream a view being built (skeleton-worthy). */
const SKELETON_TOOLS = new Set(["render_view", "edit_view"]);

/** Reads the streaming component name out of a render tool part's partial input (if any). */
function renderName(input: unknown): string | undefined {
  if (input && typeof input === "object" && "name" in input) {
    const name = (input as { name?: unknown }).name;
    if (typeof name === "string" && name.length > 0) return name;
  }
  return undefined;
}

/** Pure normalizer: flattens message parts into ordered render items. */
export function toThreadItems(messages: VendoUIMessage[]): ThreadItem[] {
  const items: ThreadItem[] = [];
  for (const message of messages) {
    const role = message.role === "user" ? "user" : "assistant";
    const messageId = message.id;
    // First pass: index this message's data-consent parts by toolCallId
    // (ENG-193 §4.5) — a tool part and its tier metadata can arrive in either
    // order within the same message, so both branches below read this map
    // rather than assuming ordering. The same pass collects remix envelopes
    // by paired node id (remix fast-edits) — envelope parts emit no item of
    // their own and pair regardless of stream order.
    const tierByToolCallId = new Map<string, { tier: "act" | "critical"; unverified: boolean; reason?: string }>();
    const envelopes = new Map<string, string>();
    for (const rawPart of message.parts) {
      const part = rawPart as {
        type: string;
        data?: { toolCallId?: string; tier?: string; unverified?: boolean; reason?: string; envelope?: string; uiNodeId?: string };
      };
      if (part.type === "data-consent" && part.data?.toolCallId) {
        tierByToolCallId.set(part.data.toolCallId, {
          tier: part.data.tier as "act" | "critical",
          unverified: Boolean(part.data.unverified),
          ...(part.data.reason ? { reason: part.data.reason } : {}),
        });
      }
      if (part.type === "data-remix-envelope" && part.data?.uiNodeId && part.data.envelope) {
        envelopes.set(part.data.uiNodeId, part.data.envelope);
      }
    }
    message.parts.forEach((rawPart, index) => {
      const part = rawPart as { type: string; [k: string]: unknown };
      const key = `${message.id}:${index}`;
      if (part.type === "data-remix-envelope") {
        return; // consumed by the pre-pass; pairs onto its ui item below
      }
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
        const node = part.data as UINode;
        const envelope = envelopes.get(node.id);
        items.push({
          kind: "ui",
          key,
          messageId,
          node,
          ...(envelope !== undefined ? { envelope } : {}),
        });
      } else if (part.type === "data-consent") {
        // Consumed via tierByToolCallId above — never its own render item.
      } else if (part.type === "dynamic-tool") {
        // Dynamic tools (MCP servers, and any tool the SDK types at runtime)
        // carry their name in `toolName` instead of the part type. Same
        // approval/chip treatment as static tool parts; RENDER_TOOLS never
        // ingest as dynamic, so no skeleton branch is needed here.
        // toolCallId MUST ride along (MCP consent gap, 2026-07-05): without
        // it the shell's approve()/decline() silently skipped the consent
        // POST, so MCP approvals bypassed the audit/grant channel host tools
        // use. The sibling data-consent tier pairs by the same id.
        const toolName = String(part.toolName ?? "unknown");
        const toolCallId = part.toolCallId as string | undefined;
        const tierInfo = toolCallId ? tierByToolCallId.get(toolCallId) : undefined;
        if (part.state === "approval-requested") {
          const approval = part.approval as { id: string };
          items.push({
            kind: "approval", key, messageId, approvalId: approval.id, toolCallId, toolName, input: part.input,
            tier: tierInfo?.tier, unverified: tierInfo?.unverified,
            ...(tierInfo?.reason ? { reason: tierInfo.reason } : {}),
          });
        } else {
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
          if (SKELETON_TOOLS.has(toolName) && (state === "input-streaming" || state === "input-available")) {
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
 * item so the existing single-card path renders it unchanged. Only tier
 * "act" items are batchable (review follow-up): critical-tier approvals are
 * exempt entirely (spec §3 Moment 6/§4.1, each always renders its own
 * ceremony ApprovalCard) and so — same treatment, not a special case — is an
 * approval whose tier is UNDEFINED. `tier` rides in on the sibling
 * data-consent part (ENG-193 §4.1/§4.5); if that part was lost or never
 * arrived, the item's true tier is simply unknown, and batching it as if it
 * were a confirmed "act" call would be a false assurance — it renders its
 * own individual card instead, same as critical. An item carrying a judge/
 * breaker `reason` (ENG-193 PR #40 review — item C) is EXEMPT too, even at
 * tier "act": a reason means the judge/cautionBreaker/volumeBreaker escalated
 * this SPECIFIC call above its siblings — the "Hold on" ceremony (its own
 * card, the reason legible) must not be swallowed into a bulk "Approve all N".
 * Review follow-up: an `unverified` item is exempt too, consistent with the
 * critical/reason/undefined-tier exemptions above — `ApprovalBatchCard` has
 * no unverified badge/copy, so silently dropping an unverified call into a
 * bulk "Approve all N" would hide exactly the caveat its own individual
 * `ApprovalCard` renders.
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
      // Only tier "act" ever enters batch collapse (review follow-up).
      // Critical-tier approvals NEVER batch (spec §3 Moment 6/§4.1): every
      // money/irreversible action renders its own ceremony card, one
      // deliberate decision each — a batch "Approve all N" would bypass the
      // ceremony register and its untruncated fields. An UNDEFINED tier gets
      // the same treatment: it means the sibling data-consent part carrying
      // the real tier was lost or never arrived, so this item's true
      // dangerousness is simply unknown — batching it as if it were a
      // confirmed "act" call would be a false assurance. A `reason` (ENG-193
      // PR #40 review — item C) is exempt too, however "act" its tier: the
      // judge/breaker specifically escalated THIS call — batching would lose
      // the "Hold on" treatment for exactly the call that most needs it.
      // `unverified` (review follow-up) is exempt for the same reason:
      // ApprovalBatchCard carries no unverified tag, so a batch would hide
      // the caveat the solo ApprovalCard shows.
      if (item.tier !== "act" || item.reason !== undefined || item.unverified) {
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
          // Mirrors the skip above: a critical, undefined-tier, reasoned, OR
          // unverified item that shares a message+tool with act siblings
          // must not be pulled into their batch during promotion either.
          i.kind === "approval" && i.tier === "act" && i.reason === undefined && !i.unverified &&
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
 *  prompt that produced a rendered view. Used when saving a vendo (ENG-183). */
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
export function useVendoThread() {
  const chat = useVendoChat();
  const items = useMemo(() => toThreadItems(chat.messages), [chat.messages]);
  return { ...chat, items };
}
