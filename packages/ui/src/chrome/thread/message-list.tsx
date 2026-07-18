import type { RiskLabel } from "@vendoai/core";
import type { UIMessage } from "ai";
import type { ComponentProps } from "react";
import { FluidThinking } from "../fluid-thinking.js";
import { ThreadMessage } from "./message.js";
import { ThreadApprovals, ThreadConnectRequests } from "./parts.js";
import type { useMessageWindow, useStickToBottom } from "./scrolling.js";

/** The transcript pane: the windowed message list (ENG-218), parked approval
    and connect cards, the ENG-217 streaming indicators, and the jump-to-latest
    affordance (ENG-213). Pure presentation over the thread-level state. */
export function MessageList({
  scroll, messageWindow, busy, risks, isRestored,
  activeAssistantId, lastUserId, lastAssistantId, onEditLast, onRegenerateLast,
  approvals, guardApprovals, cardRefs, respond, onMorph,
  messages, sendMessage, awaitingFirstChunk, working,
}: {
  scroll: ReturnType<typeof useStickToBottom>;
  messageWindow: ReturnType<typeof useMessageWindow>;
  busy: boolean;
  risks: Map<string, RiskLabel>;
  isRestored: (id: string) => boolean;
  activeAssistantId?: string | undefined;
  lastUserId?: string | undefined;
  lastAssistantId?: string | undefined;
  onEditLast: () => void;
  onRegenerateLast: () => void;
  approvals: ComponentProps<typeof ThreadApprovals>["approvals"];
  guardApprovals: ComponentProps<typeof ThreadApprovals>["guardApprovals"];
  cardRefs: ComponentProps<typeof ThreadApprovals>["cardRefs"];
  respond: ComponentProps<typeof ThreadApprovals>["respond"];
  onMorph: ComponentProps<typeof ThreadApprovals>["onMorph"];
  messages: UIMessage[];
  sendMessage: ComponentProps<typeof ThreadConnectRequests>["sendMessage"];
  awaitingFirstChunk: boolean;
  working: boolean;
}) {
  return (
    <div className="fl-msglist-wrap">
      {/* role="log" — aria-label is prohibited on a roleless div (WCAG 4.1.2), and a
          streaming message list is exactly what "log" names. */}
      <div
        className="fl-msglist"
        role="log"
        aria-label="Conversation messages"
        aria-live="polite"
        aria-busy={busy}
        ref={scroll.listRef}
        onScroll={() => { scroll.onScroll(); messageWindow.onNearTop(); }}
      >
        {messageWindow.hasOlder ? (
          <button
            type="button"
            className="fl-load-older"
            onClick={messageWindow.loadOlder}
          >
            Show {messageWindow.olderCount} earlier message{messageWindow.olderCount === 1 ? "" : "s"}
          </button>
        ) : null}
        {messageWindow.windowed.map(message => (
          <ThreadMessage
            key={message.id}
            message={message}
            restored={isRestored(message.id)}
            risks={risks}
            busy={busy}
            activeAssistantId={activeAssistantId}
            lastUserId={lastUserId}
            lastAssistantId={lastAssistantId}
            onEditLast={onEditLast}
            onRegenerateLast={onRegenerateLast}
          />
        ))}
        <ThreadApprovals
          approvals={approvals}
          risks={risks}
          guardApprovals={guardApprovals}
          cardRefs={cardRefs}
          respond={respond}
          onMorph={onMorph}
        />
        <ThreadConnectRequests messages={messages} sendMessage={sendMessage} />
        {awaitingFirstChunk ? (
          <>
            <div className="fl-generating">
              <span className="fl-pulse" aria-hidden="true" />
              Generating&hellip;
            </div>
            <div className="fl-skeleton" aria-hidden="true">
              <div className="fl-skeleton-bar" />
              <div className="fl-skeleton-bar" />
              <div className="fl-skeleton-bar" />
            </div>
          </>
        ) : null}
        {working ? <FluidThinking label="Working" /> : null}
      </div>
      {scroll.showJump ? (
        <button type="button" className="fl-jump" aria-label="Jump to latest" onClick={scroll.jumpToLatest}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M12 5v14" /><path d="m19 12-7 7-7-7" />
          </svg>
        </button>
      ) : null}
    </div>
  );
}
