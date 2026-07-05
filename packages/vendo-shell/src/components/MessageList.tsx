import { useEffect, useMemo, useRef, useState } from "react";
import type { UINode } from "@vendoai/core";
import { groupThreadItems, type ThreadItem } from "../use-vendo-thread";
import { StreamingText } from "./StreamingText";
import { ApprovalCard } from "./ApprovalCard";
import { ApprovalBatchCard } from "./ApprovalBatchCard";
import { AutomationCard, isAutomationApproval } from "./AutomationCard";
import { AutomationCreatedMorph, type AutomationCreatedNotice } from "./AutomationCreatedMorph";
import { UINodeView } from "./UINodeView";
import { Skeleton } from "./Skeleton";
import { ActivityPanel } from "./ActivityPanel";
import { FadeProposalCard } from "./FadeProposalCard";
import { TurnActions, type Feedback } from "./TurnActions";
import { FileAttachment } from "./FileAttachment";
import { FluidReveal } from "./FluidReveal";
import { FluidThinking } from "./FluidThinking";
import { friendlyError } from "./error-copy";

export interface MessageListProps {
  items: ThreadItem[];
  status?: string;
  onApprove: (approvalId: string) => void;
  onDecline?: (approvalId: string) => void;
  /** Batch decisions (ENG-193 §3 Moment 4). Omit to fall back to looping
   *  onApprove/onDecline per item — every existing caller keeps working. */
  onApproveBatch?: (approvalIds: string[], toolCallIds: string[]) => void;
  onApproveSubset?: (
    approvalIds: string[], toolCallIds: string[], allApprovalIds: string[], allToolCallIds: string[],
  ) => void;
  onDeclineBatch?: (approvalIds: string[]) => void;
  /** Regenerate a specific assistant turn (SDK `regenerate`). */
  onRegenerate?: (messageId: string) => void;
  /** Host feedback sink for a turn's thumbs up/down. */
  onFeedback?: (messageId: string, feedback: Feedback) => void;
  /** A pending fade proposal for the turn (ENG-193 §3 Moment 5) — renders
   *  right after that turn's activity panel. Null/absent -> nothing renders.
   *  `count` (review nit) is the tracker's own yes-count at proposal time,
   *  threaded straight to `FadeProposalCard`'s ordinal. */
  fadeProposal?: { messageId: string; toolName: string; count?: number } | null;
  onAcceptFade?: () => void;
  onDeclineFade?: () => void;
  /** Pin a remix candidate onto its VendoRemix anchor. When provided,
   *  generated views tagged with `remixAnchorId` grow an Apply bar. */
  onApplyRemix?: (node: UINode, envelope?: string) => void;
}

export function MessageList({
  items, status, onApprove, onDecline, onApproveBatch, onApproveSubset, onDeclineBatch, onRegenerate, onFeedback,
  fadeProposal, onAcceptFade, onDeclineFade, onApplyRemix,
}: MessageListProps) {
  const rendered = useMemo(() => groupThreadItems(items), [items]);
  // Render-slot keys (ENG-205): a skeleton and the ui view that replaces it
  // carry different item keys (different part indices), but must share one
  // React identity for the reveal to morph instead of remount. Slots pair by
  // per-message order, which is stable because message parts append in order.
  const slotKeys = useMemo(() => {
    const keys = new Map<string, string>();
    const counters = new Map<string, number>();
    for (const item of rendered) {
      // Only GENERATED views pair with skeletons — host-component nodes (the
      // Connect card) are their own thread items with no skeleton phase, so
      // counting them here would misalign the skeleton↔view pairing.
      if (item.kind !== "skeleton" && (item.kind !== "ui" || item.node.kind !== "generated")) continue;
      const n = counters.get(item.messageId) ?? 0;
      counters.set(item.messageId, n + 1);
      keys.set(item.key, `reveal:${item.messageId}:${n}`);
    }
    return keys;
  }, [rendered]);
  const lastTextKey = [...items].reverse().find((i) => i.kind === "text")?.key;
  const listRef = useRef<HTMLDivElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const automationApprovalRefs = useRef(new Map<string, HTMLDivElement>());
  const [automationNotices, setAutomationNotices] = useState<AutomationCreatedNotice[]>([]);
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

  const queueAutomationNotice = (item: Extract<ThreadItem, { kind: "approval" }>) => {
    const host = wrapRef.current;
    const source = automationApprovalRefs.current.get(item.approvalId);
    const sourceRect = host && source
      ? (() => {
          const hostRect = host.getBoundingClientRect();
          const card = source.querySelector<HTMLElement>(".fl-automation-approval") ?? source;
          const rect = card.getBoundingClientRect();
          return {
            top: rect.top - hostRect.top,
            left: rect.left - hostRect.left,
            width: rect.width,
            height: rect.height,
          };
        })()
      : undefined;

    setAutomationNotices((current) => [
      ...current.filter((notice) => notice.id !== item.approvalId),
      { id: item.approvalId, toolName: item.toolName, input: item.input, sourceRect },
    ]);
  };

  return (
    <div className="fl-msglist-wrap" ref={wrapRef}>
      <div className="fl-msglist" ref={listRef} onScroll={onScroll}>
        {rendered.map((item) => {
          switch (item.kind) {
            case "activity":
              // A turn is still working if this is the last render unit and the
              // thread hasn't settled — the panel then shows its live header.
              return (
                <div key={item.key} className="fl-activity-slot">
                  <ActivityPanel
                    steps={item.steps}
                    working={status !== "ready" && status !== "error" && item === rendered[rendered.length - 1]}
                  />
                  {fadeProposal && fadeProposal.messageId === item.messageId && (
                    <FadeProposalCard
                      toolName={fadeProposal.toolName}
                      count={fadeProposal.count}
                      onAccept={() => onAcceptFade?.()}
                      onDecline={() => onDeclineFade?.()}
                    />
                  )}
                </div>
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
                <FluidReveal key={slotKeys.get(item.key)} phase="skeleton">
                  <div className="fl-generating"><span className="fl-pulse" />Building your view…</div>
                  <Skeleton name={item.name} />
                </FluidReveal>
              );
            case "approval":
              // Automation authoring approvals get the inspectable card; every
              // other gated call keeps the generic JSON approval.
              return isAutomationApproval(item.toolName) ? (
                <div
                  key={item.key}
                  className="fl-automation-approval-slot"
                  ref={(node) => {
                    if (node) automationApprovalRefs.current.set(item.approvalId, node);
                    else automationApprovalRefs.current.delete(item.approvalId);
                  }}
                >
                  <AutomationCard
                    toolName={item.toolName}
                    input={item.input}
                    onApprove={() => {
                      queueAutomationNotice(item);
                      onApprove(item.approvalId);
                    }}
                    onDecline={() => onDecline?.(item.approvalId)}
                  />
                </div>
              ) : (
                <ApprovalCard
                  key={item.key}
                  toolName={item.toolName}
                  input={item.input}
                  tier={item.tier}
                  unverified={item.unverified}
                  reason={item.reason}
                  onApprove={() => onApprove(item.approvalId)}
                  onDecline={() => onDecline?.(item.approvalId)}
                />
              );
            case "approval-batch":
              return (
                <ApprovalBatchCard
                  key={item.key}
                  toolName={item.toolName}
                  items={item.items}
                  onApproveAll={(approvalIds, toolCallIds) =>
                    onApproveBatch ? onApproveBatch(approvalIds, toolCallIds) : approvalIds.forEach(onApprove)
                  }
                  onApproveSubset={(approvalIds, toolCallIds, allApprovalIds, allToolCallIds) => {
                    if (onApproveSubset) {
                      onApproveSubset(approvalIds, toolCallIds, allApprovalIds, allToolCallIds);
                      return;
                    }
                    // Fallback mirrors the seam: approve the selection, decline
                    // the rest of the batch by approvalId.
                    approvalIds.forEach(onApprove);
                    allApprovalIds
                      .filter((id) => !approvalIds.includes(id))
                      .forEach((id) => onDecline?.(id));
                  }}
                  onDeclineAll={(approvalIds) =>
                    onDeclineBatch ? onDeclineBatch(approvalIds) : approvalIds.forEach((id) => onDecline?.(id))
                  }
                />
              );
            case "ui":
              // Host-component nodes (the Connect card) are utility affordances,
              // not built views: they mount directly like any other thread item
              // (the shared entrance animation covers them) instead of going
              // through the skeleton→view reveal morph.
              if (item.node.kind !== "generated") {
                return (
                  <div key={item.key} className="fl-uihost">
                    <UINodeView node={item.node} />
                  </div>
                );
              }
              return (
                <FluidReveal key={slotKeys.get(item.key)} phase="view">
                  <UINodeView node={item.node} />
                  {onApplyRemix && item.node.remixAnchorId !== undefined && (
                    <div className="fl-applybar">
                      <button
                        type="button"
                        className="fl-apply-btn"
                        onClick={() => onApplyRemix(item.node, item.envelope)}
                      >
                        ✦ Apply to page
                      </button>
                      <span className="fl-applybar-hint">replaces the wrapped element for you</span>
                    </div>
                  )}
                </FluidReveal>
              );
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
        {working && <FluidThinking label="Working" />}
      </div>
      {automationNotices.map((notice) => (
        <AutomationCreatedMorph
          key={notice.id}
          notice={notice}
          onDone={(id) => setAutomationNotices((current) => current.filter((notice) => notice.id !== id))}
        />
      ))}
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
