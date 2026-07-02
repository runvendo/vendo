import { Fragment, useEffect, useRef, useState } from "react";
import type { ThreadItem } from "../use-flowlet-thread";
import { StreamingText } from "./StreamingText";
import { ApprovalCard } from "./ApprovalCard";
import { UINodeView } from "./UINodeView";
import { Skeleton } from "./Skeleton";
import { ToolCall } from "./ToolCall";

export interface MessageListProps {
  items: ThreadItem[];
  status?: string;
  onApprove: (approvalId: string) => void;
  onDecline?: (approvalId: string) => void;
}

export function MessageList({ items, status, onApprove, onDecline }: MessageListProps) {
  const lastTextKey = [...items].reverse().find((i) => i.kind === "text")?.key;
  const listRef = useRef<HTMLDivElement>(null);
  // Whether the user is pinned to the bottom. A ref drives the auto-scroll
  // (read inside effects without re-subscribing); the state mirrors it so the
  // "jump to latest" affordance can show/hide.
  const stick = useRef(true);
  const [atBottom, setAtBottom] = useState(true);
  // True while WE are running a smooth scroll-to-bottom. onScroll can't tell our
  // own animation's intermediate ticks from a user scroll, so without this the
  // "jump to latest" click would unpin itself mid-animation (every tick is still
  // >80px from bottom). We ignore those ticks until the animation lands.
  const programmatic = useRef(false);

  const onScroll = () => {
    const el = listRef.current;
    if (!el) return;
    const pinned = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (programmatic.current) {
      if (!pinned) return; // mid-animation tick — keep the pin until we arrive
      programmatic.current = false; // landed at the bottom
    }
    stick.current = pinned;
    setAtBottom(pinned);
  };

  const scrollToBottom = (smooth: boolean) => {
    const el = listRef.current;
    if (!el) return;
    if (smooth) programmatic.current = true;
    if (typeof el.scrollTo === "function") el.scrollTo({ top: el.scrollHeight, behavior: smooth ? "smooth" : "auto" });
    else el.scrollTop = el.scrollHeight; // jsdom / no smooth-scroll support
  };

  // Keep the latest content in view — but only when the user is already pinned
  // to the bottom, so scrolling up to read history isn't yanked back down on
  // every throttled streaming tick.
  useEffect(() => {
    if (!stick.current) return;
    const reduce =
      typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;
    scrollToBottom(!(status === "streaming" || reduce));
  }, [items, status]);

  // Async-growing content (ui cards, markdown images) can land after the items
  // effect runs; re-pin to bottom while the user is following along.
  useEffect(() => {
    const el = listRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      if (stick.current) el.scrollTop = el.scrollHeight;
    });
    ro.observe(el);
    for (const child of Array.from(el.children)) ro.observe(child);
    return () => ro.disconnect();
  }, [items]);

  // Screen readers: announce only the final assistant turn once it settles,
  // not the whole message re-emitted on every streaming tick.
  const lastAssistantText = [...items]
    .reverse()
    .find((i): i is Extract<ThreadItem, { kind: "text" }> => i.kind === "text" && i.role === "assistant");
  const announce = status === "ready" ? lastAssistantText?.text ?? "" : "";

  // Dead-air guard: show the working dots while the request is in flight, and
  // while streaming has begun but nothing readable has arrived yet — right after
  // sending (last item is the user's own turn) or during a tool round-trip.
  const last = items[items.length - 1];
  const lastIsUser = last?.kind === "text" && last.role === "user";
  const working =
    status === "submitted" ||
    (status === "streaming" && (!last || lastIsUser || last.kind === "tool"));

  return (
    <div className="fl-msglist-wrap">
      <div className="fl-msglist" ref={listRef} onScroll={onScroll}>
        {items.map((item) => {
          switch (item.kind) {
            case "text":
              if (item.role === "user")
                return (
                  <div key={item.key} className="fl-turn-user">
                    <div className="fl-usertext">{item.text}</div>
                  </div>
                );
              return (
                <div key={item.key} className="fl-turn-assistant">
                  <StreamingText text={item.text} streaming={status === "streaming" && item.key === lastTextKey} />
                </div>
              );
            case "tool":
              // Quiet, stateful chip ("Searching Gmail…" → ✓). render_view never
              // reaches here — its turn is carried by the skeleton + data-ui node.
              return <ToolCall key={item.key} toolName={item.toolName} state={item.state} errorText={item.errorText} />;
            case "skeleton":
              // Shown only while render_view is in flight; never for text-only turns.
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
        {working && (
          <div className="fl-typing" aria-label="Working">
            <span /><span /><span />
          </div>
        )}
      </div>
      {!atBottom && (
        <button
          type="button"
          className="fl-jump"
          aria-label="Jump to latest"
          onClick={() => { stick.current = true; setAtBottom(true); scrollToBottom(true); }}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M12 5v14" /><path d="m19 12-7 7-7-7" />
          </svg>
        </button>
      )}
      <div className="fl-sr-only" role="log" aria-live="polite" aria-atomic="true">{announce}</div>
    </div>
  );
}
