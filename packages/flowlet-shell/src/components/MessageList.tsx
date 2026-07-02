import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { groupThreadItems, type ThreadItem } from "../use-flowlet-thread";
import { StreamingText } from "./StreamingText";
import { ApprovalCard } from "./ApprovalCard";
import { UINodeView } from "./UINodeView";
import { Skeleton } from "./Skeleton";
import { ActivityPanel } from "./ActivityPanel";
import { TurnActions, type Feedback } from "./TurnActions";
import { FileAttachment } from "./FileAttachment";
import { friendlyError } from "./error-copy";

export interface MessageListProps {
  items: ThreadItem[];
  status?: string;
  onApprove: (approvalId: string) => void;
  onDecline?: (approvalId: string) => void;
  /** Regenerate a specific assistant turn (SDK `regenerate`). */
  onRegenerate?: (messageId: string) => void;
  /** Host feedback sink for a turn's thumbs up/down. */
  onFeedback?: (messageId: string, feedback: Feedback) => void;
}

export function MessageList({ items, status, onApprove, onDecline, onRegenerate, onFeedback }: MessageListProps) {
  const rendered = useMemo(() => groupThreadItems(items), [items]);
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
  // First-seen wall-clock per assistant message, for the hover timestamp. A ref
  // so re-renders don't reset it and the pure item list stays timestamp-free.
  const seenAt = useRef(new Map<string, number>());

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
  // sending (last item is the user's own turn). Once a tool part exists, the
  // activity panel carries the working state, so the dots stand down.
  const last = items[items.length - 1];
  const lastIsUser = last?.kind === "text" && last.role === "user";
  const working = status === "submitted" || (status === "streaming" && (!last || lastIsUser || last.kind === "file"));

  const timestampFor = (messageId: string): number => {
    const map = seenAt.current;
    let t = map.get(messageId);
    if (t === undefined) {
      t = Date.now();
      map.set(messageId, t);
    }
    return t;
  };

  return (
    <div className="fl-msglist-wrap">
      <div className="fl-msglist" ref={listRef} onScroll={onScroll}>
        {rendered.map((item) => {
          switch (item.kind) {
            case "activity":
              // A turn is still working if this is the last render unit and the
              // thread hasn't settled — the panel then shows its live header.
              return (
                <ActivityPanel
                  key={item.key}
                  steps={item.steps}
                  working={status !== "ready" && status !== "error" && item === rendered[rendered.length - 1]}
                />
              );
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
                  {status !== "streaming" || item.key !== lastTextKey ? (
                    <TurnActions
                      text={item.text}
                      timestamp={timestampFor(item.messageId)}
                      onRegenerate={onRegenerate ? () => onRegenerate(item.messageId) : undefined}
                      onFeedback={onFeedback ? (fb) => onFeedback(item.messageId, fb) : undefined}
                    />
                  ) : null}
                </div>
              );
            case "file":
              return (
                <div key={item.key} className={item.role === "user" ? "fl-turn-user-att" : "fl-turn-assistant"}>
                  <FileAttachment mediaType={item.mediaType} filename={item.filename} url={item.url} />
                </div>
              );
            case "skeleton":
              // Shown only while render_view is in flight; never for text-only turns.
              return (
                <Fragment key={item.key}>
                  <div className="fl-generating"><span className="fl-pulse" />Building your view…</div>
                  <Skeleton name={item.name} />
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
            case "error": {
              // Friendly copy only — no title attribute, which would leak the
              // raw provider text to hover and the accessibility tree.
              const friendly = friendlyError(item.message);
              return (
                <div key={item.key} className="fl-error" role="alert">
                  <span>{friendly.message}</span>
                  {friendly.retryable && onRegenerate && (
                    <button
                      type="button"
                      className="fl-error-retry"
                      onClick={() => onRegenerate(item.messageId)}
                    >
                      Retry
                    </button>
                  )}
                </div>
              );
            }
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
