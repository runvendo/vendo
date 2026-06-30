import { Fragment, useEffect, useRef } from "react";
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

export function MessageList({ items, status, onApprove, onDecline }: MessageListProps) {
  const lastTextKey = [...items].reverse().find((i) => i.kind === "text")?.key;
  const listRef = useRef<HTMLDivElement>(null);

  // Keep the latest content in view as messages, streaming text, skeletons, and
  // rendered views arrive.
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [items, status]);

  return (
    <div className="fl-msglist" role="log" aria-live="polite" ref={listRef}>
      {items.map((item) => {
        switch (item.kind) {
          case "text":
            return (
              <div key={item.key} className={item.role === "user" ? "fl-turn-user" : "fl-turn-assistant"}>
                <StreamingText text={item.text} streaming={status === "streaming" && item.key === lastTextKey} />
              </div>
            );
          case "tool":
            return null; // tool chips are hidden — the result (or skeleton) carries the turn
          case "skeleton":
            // Shown only while render_ui is in flight; never for text-only turns.
            return (
              <Fragment key={item.key}>
                <div className="fl-generating"><span className="fl-pulse" />Building your view…</div>
                <Skeleton />
              </Fragment>
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
      {status === "submitted" && (
        <div className="fl-typing" aria-label="Working">
          <span /><span /><span />
        </div>
      )}
    </div>
  );
}
