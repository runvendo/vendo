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
    }
  | { kind: "approval"; key: string; messageId: string; approvalId: string; toolName: string; input: unknown }
  | { kind: "ui"; key: string; messageId: string; node: UINode }
  | { kind: "skeleton"; key: string; messageId: string; name?: string }
  | { kind: "error"; key: string; messageId: string; message: string };

/** A tool step inside a grouped activity panel. */
export type ToolItem = Extract<ThreadItem, { kind: "tool" }>;

/** A render unit: either a plain item or a group of a turn's tool calls. */
export type RenderItem =
  | ThreadItem
  | { kind: "activity"; key: string; messageId: string; steps: ToolItem[] };

/**
 * Built-in tools whose product is a `data-ui` node (the rendered view, or the
 * host-privileged Connect card). Their raw tool chip is suppressed to avoid a
 * redundant sliver next to the rendered component. Mirrors `RENDER_VIEW_TOOL_NAME`
 * and `REQUEST_CONNECT_TOOL_NAME` in `@flowlet/agent`.
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
      } else if (part.type.startsWith("tool-")) {
        const toolName = part.type.slice("tool-".length);
        if (part.state === "approval-requested") {
          const approval = part.approval as { id: string };
          items.push({ kind: "approval", key, messageId, approvalId: approval.id, toolName, input: part.input });
        } else if (RENDER_TOOLS.has(toolName)) {
          // A render tool's finished output is the sibling data-ui node (so no chip).
          // But while it's still streaming/pending, show a skeleton in its place
          // so the user sees a view being built — and ONLY then, never for
          // text-only turns. The partial input carries the component name, which
          // lets the skeleton match the shape of what's being built.
          const state = String(part.state ?? "");
          if (state === "input-streaming" || state === "input-available") {
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
            toolCallId: part.toolCallId as string | undefined,
            state: String(part.state ?? ""),
            input: part.input,
            output: part.output,
            errorText: part.errorText as string | undefined,
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
 * turn's first tool call.
 */
export function groupThreadItems(items: ThreadItem[]): RenderItem[] {
  const out: RenderItem[] = [];
  const groupIndexByMessage = new Map<string, number>();
  for (const item of items) {
    if (item.kind === "tool") {
      const existing = groupIndexByMessage.get(item.messageId);
      if (existing !== undefined) {
        (out[existing] as { steps: ToolItem[] }).steps.push(item);
      } else {
        groupIndexByMessage.set(item.messageId, out.length);
        out.push({ kind: "activity", key: `activity:${item.messageId}`, messageId: item.messageId, steps: [item] });
      }
    } else {
      out.push(item);
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
