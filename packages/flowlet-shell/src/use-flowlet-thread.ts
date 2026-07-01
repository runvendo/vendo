import { useMemo } from "react";
import type { FlowletUIMessage } from "@flowlet/core";
import type { UINode } from "@flowlet/core";
import { useFlowletChat } from "@flowlet/react";

export type ThreadItem =
  | { kind: "text"; key: string; role: "user" | "assistant"; text: string }
  | {
      kind: "tool";
      key: string;
      toolName: string;
      toolCallId?: string;
      state: string;
      input?: unknown;
      output?: unknown;
      errorText?: string;
    }
  | { kind: "approval"; key: string; approvalId: string; toolName: string; input: unknown }
  | { kind: "ui"; key: string; node: UINode }
  | { kind: "skeleton"; key: string }
  | { kind: "error"; key: string; message: string };

/**
 * Built-in render tool name (mirrors `RENDER_TOOL_NAME` in `@flowlet/agent`).
 * Its product is a `data-ui` node, so its tool chip is suppressed to avoid a
 * redundant "render_ui" sliver next to the component it rendered.
 */
const RENDER_UI_TOOL = "render_ui";

/** Pure normalizer: flattens message parts into ordered render items. */
export function toThreadItems(messages: FlowletUIMessage[]): ThreadItem[] {
  const items: ThreadItem[] = [];
  for (const message of messages) {
    const role = message.role === "user" ? "user" : "assistant";
    message.parts.forEach((rawPart, index) => {
      const part = rawPart as { type: string; [k: string]: unknown };
      const key = `${message.id}:${index}`;
      if (part.type === "text") {
        items.push({ kind: "text", key, role, text: String(part.text ?? "") });
      } else if (part.type === "error") {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const p = part as any;
        const message = String(p.errorText ?? p.error ?? "Something went wrong");
        items.push({ kind: "error", key, message });
      } else if (part.type === "data-ui") {
        items.push({ kind: "ui", key, node: part.data as UINode });
      } else if (part.type.startsWith("tool-")) {
        const toolName = part.type.slice("tool-".length);
        if (part.state === "approval-requested") {
          const approval = part.approval as { id: string };
          items.push({ kind: "approval", key, approvalId: approval.id, toolName, input: part.input });
        } else if (toolName === RENDER_UI_TOOL) {
          // render_ui's finished output is the sibling data-ui node (so no chip).
          // But while it's still streaming/pending, show a skeleton in its place
          // so the user sees a view being built — and ONLY then, never for
          // text-only turns.
          const state = String(part.state ?? "");
          if (state === "input-streaming" || state === "input-available") {
            items.push({ kind: "skeleton", key });
          } else if (state === "output-error") {
            items.push({ kind: "error", key, message: String(part.errorText ?? "Failed to render UI") });
          }
          // output-available: skip — the data-ui node carries the result.
        } else {
          // Carry tool detail through so the chip can show meaningful content.
          // Fields stay `undefined` when absent (the SDK only populates `input`
          // at input-available+ and `output`/`errorText` at the terminal state).
          items.push({
            kind: "tool",
            key,
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

/** Hook: F1 chat plus the normalized item list. */
export function useFlowletThread() {
  const chat = useFlowletChat();
  const items = useMemo(() => toThreadItems(chat.messages), [chat.messages]);
  return { ...chat, items };
}
