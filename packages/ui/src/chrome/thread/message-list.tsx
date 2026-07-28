import type { RiskLabel } from "@vendoai/core";
import type { ComponentProps } from "react";
import { FluidThinking } from "../fluid-thinking.js";
import { ThreadMessage } from "./message.js";
import { ThreadApprovals } from "./parts.js";
import type { useMessageWindow, useStickToBottom } from "./scrolling.js";

/** The transcript pane: the windowed message list (ENG-218), parked approval
    and connect cards, and the ENG-217 streaming indicators. The jump-to-latest
    affordance (ENG-213) lives with the composer, docked onto the bar.
    Pure presentation over the thread-level state. */
export function MessageList({
  scroll, messageWindow, busy, risks, isRestored,
  activeAssistantId, lastUserId, lastAssistantId, onEditLast, onRegenerateLast,
  approvals, guardApprovals, cardRefs, respond, onMorph,
  sendMessage, working,
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
  /** The thread's send — connect cards use it for the post-connect continuation. */
  sendMessage: (message: { text: string }) => unknown;
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
            sendMessage={sendMessage}
            respond={respond}
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
        {working ? <FluidThinking label="Working" /> : null}
      </div>
      {/* Lane picks 3A + 6B — the jump affordance ("N new replies · …") now
          renders inside the composer's .fl-dock-anchor (see VendoThread), so
          it docks flush onto the bar and the two read as one piece. */}
    </div>
  );
}
