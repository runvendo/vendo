import type { ThreadItem } from "../use-flowlet-thread";
import { StreamingText } from "./StreamingText";
import { ToolCall } from "./ToolCall";
import { ApprovalCard } from "./ApprovalCard";
import { UINodeView } from "./UINodeView";

export interface MessageListProps {
  items: ThreadItem[];
  status?: string;
  onApprove: (approvalId: string) => void;
  onDecline?: (approvalId: string) => void;
}

export function MessageList({ items, status, onApprove, onDecline }: MessageListProps) {
  const lastTextKey = [...items].reverse().find((i) => i.kind === "text")?.key;
  return (
    <div className="fl-msglist" role="log" aria-live="polite">
      {items.map((item) => {
        switch (item.kind) {
          case "text":
            return (
              <div key={item.key} className={item.role === "user" ? "fl-turn-user" : "fl-turn-assistant"}>
                <StreamingText text={item.text} streaming={status === "streaming" && item.key === lastTextKey} />
              </div>
            );
          case "tool":
            return (
              <ToolCall
                key={item.key}
                toolName={item.toolName}
                state={item.state}
                errorText={item.errorText}
              />
            );
          case "approval":
            return (
              <ApprovalCard
                key={item.key}
                toolName={item.toolName}
                input={item.input}
                onApprove={() => onApprove(item.approvalId)}
                onDecline={() => onDecline?.(item.approvalId)}
              />
            );
          case "ui":
            return <UINodeView key={item.key} node={item.node} />;
          case "error":
            return <div key={item.key} className="fl-error" role="alert">{item.message}</div>;
        }
      })}
    </div>
  );
}
