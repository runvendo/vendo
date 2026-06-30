import type { ThreadItem } from "../use-flowlet-thread";
import { StreamingText } from "./StreamingText";
import { ApprovalCard } from "./ApprovalCard";
import { UINodeView } from "./UINodeView";
import { Skeleton } from "./Skeleton";

export interface MessageListProps {
  items: ThreadItem[];
  status?: string;
  onApprove: (approvalId: string) => void;
  onDecline?: (approvalId: string) => void;
}

/** True once the current turn has produced something visible to the user. */
function hasVisibleOutput(items: ThreadItem[]): boolean {
  let lastUser = -1;
  items.forEach((it, i) => {
    if (it.kind === "text" && it.role === "user") lastUser = i;
  });
  return items
    .slice(lastUser + 1)
    .some((it) => it.kind === "ui" || it.kind === "approval" || (it.kind === "text" && it.role !== "user"));
}

export function MessageList({ items, status, onApprove, onDecline }: MessageListProps) {
  const lastTextKey = [...items].reverse().find((i) => i.kind === "text")?.key;
  // Tool calls are intentionally NOT shown in the thread. While the agent works
  // on a turn and hasn't produced visible output yet, a skeleton holds the space.
  const working = status === "submitted" || status === "streaming";
  const showSkeleton = working && !hasVisibleOutput(items);

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
            return null; // hidden — the skeleton + the rendered result carry the turn
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
      {showSkeleton && (
        <>
          <div className="fl-generating"><span className="fl-pulse" />Building your view…</div>
          <Skeleton />
        </>
      )}
    </div>
  );
}
