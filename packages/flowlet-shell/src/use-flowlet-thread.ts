import { useMemo } from "react";
import type { FlowletUIMessage } from "@flowlet/core";
import type { UINode } from "@flowlet/core";
import { useFlowletChat } from "@flowlet/react";

export type ThreadItem =
  | { kind: "text"; key: string; role: "user" | "assistant"; text: string }
  | { kind: "tool"; key: string; toolName: string; state: string }
  | { kind: "approval"; key: string; approvalId: string; toolName: string; input: unknown }
  | { kind: "ui"; key: string; node: UINode }
  | { kind: "error"; key: string; message: string };

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
        } else {
          items.push({ kind: "tool", key, toolName, state: String(part.state ?? "") });
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
