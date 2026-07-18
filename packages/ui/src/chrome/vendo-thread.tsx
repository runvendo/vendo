import { isToolUIPart, type UIMessage } from "ai";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { useVendoThread } from "../hooks/use-vendo-thread.js";
import { ChromeRoot } from "./chrome-root.js";
import { useCopyFeedback } from "./clipboard.js";
import { MorphToast, type MorphToastProps } from "./morph-toast.js";
import { FluidThinking } from "./fluid-thinking.js";
import { SentAttachment, type FilePart } from "./thread/attachments.js";
import { Composer, useComposer } from "./thread/composer.js";
import { ThreadApprovals, ThreadConnectRequests, ThreadPart } from "./thread/parts.js";
import { useMessageWindow, useStickToBottom } from "./thread/scrolling.js";
import {
  approvalByCall,
  assistantText,
  collapseToolRuns,
  riskByCall,
  userText,
} from "./thread/message-data.js";

/** ENG-225 — the copy turn action (.fl-turn-actions design). */
function CopyTurnButton({ text }: { text: string }) {
  const [copied, copy] = useCopyFeedback();
  return (
    <button type="button" className="fl-turn-btn" aria-label="Copy message" onClick={() => copy(text)}>
      {copied ? (
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M20 6 9 17l-5-5" />
        </svg>
      ) : (
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <rect width="13" height="13" x="9" y="9" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
        </svg>
      )}
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

export interface VendoThreadProps {
  threadId?: string;
  /** Landing headline shown above the composer while the thread is empty. */
  greeting?: string;
  /** Starter prompts shown as chips on the empty landing; clicking sends one. */
  suggestions?: string[];
  /** Show a mic affordance in the composer that launches the host's voice surface. */
  onVoice?: () => void;
  /** ENG-222 — fires with the effective thread id once it is known, including
   * the fresh `thr_` the server mints for a new conversation. Lets a host
   * surface (e.g. VendoPage's sidebar) pull the new conversation into its list. */
  onThreadId?: (threadId: string) => void;
}

/** 08-ui §4 — conversation chrome over the headless thread transport. */
export function VendoThread({
  threadId,
  greeting = "What can I help you build?",
  suggestions = [],
  onVoice,
  onThreadId,
}: VendoThreadProps) {
  const thread = useVendoThread(threadId);
  // ENG-222 — surface the effective (possibly server-minted) thread id upward.
  const reportedThreadId = thread.threadId;
  useEffect(() => {
    if (reportedThreadId !== undefined) onThreadId?.(reportedThreadId);
  }, [reportedThreadId, onThreadId]);
  const busy = thread.status === "submitted" || thread.status === "streaming";
  // busy is a content-revision signal for the scroll hook: turn-actions mount
  // below the last turn when a stream settles, which changes the list height.
  const scroll = useStickToBottom(thread.messages, threadId, busy);
  const approvalCardRefs = useRef(new Map<string, HTMLDivElement | null>());
  const [morph, setMorph] = useState<Omit<MorphToastProps, "onDone"> | null>(null);

  // A build's approval lands below a tall generated view — off-screen — so it
  // would sit unnoticed until the reader scrolls. When a NEW approval appears,
  // bring it into view (and re-stick), so consent is never something you have
  // to go hunting for.
  const seenApprovalsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const pending = thread.messages
      .flatMap(message => message.parts)
      .filter(part => isToolUIPart(part) && part.state === "approval-requested")
      .map(part => (part as { approval?: { id?: string } }).approval?.id)
      .filter((id): id is string => typeof id === "string");
    const fresh = pending.find(id => !seenApprovalsRef.current.has(id));
    seenApprovalsRef.current = new Set(pending);
    if (fresh === undefined) return;
    const timer = setTimeout(() => {
      const card = approvalCardRefs.current.get(fresh)?.querySelector<HTMLElement>(".fl-approval");
      // block: "end", not "center": a sibling surface sharing this pane's
      // flex column (VendoStage docked below the thread, Maple's /vendo tab)
      // can leave the list shorter than the card itself at a short viewport
      // height — centering then crops evenly off BOTH edges, hiding the
      // card's own Approve/Decline row behind whatever renders next in flow
      // with no way to reach it. Bottom-aligning always leaves the action
      // row — the part the reader actually needs — as the last thing in
      // view, consistent with the list's own stick-to-bottom behavior.
      if (card) card.scrollIntoView({ behavior: "smooth", block: "end" });
      else scroll.jumpToLatest();
    }, 80);
    return () => clearTimeout(timer);
  }, [thread.messages, scroll]);

  const messageWindow = useMessageWindow(thread.messages, scroll.listRef, threadId);
  // ENG-218 — entrance-animation gating on restore. The .fl-item-in rise runs
  // when an article first mounts; a reopened long thread mounts them all at once
  // → a stampede on first paint. We record every message id present when the
  // thread is first shown (and after each switch) as "restored" and suppress
  // the entrance on those; only turns that arrive AFTER restore (streamed
  // replies, sends) animate. A ref, not state — read during render, no re-render.
  const restoredIdsRef = useRef<{ key: string | undefined; ids: Set<string> }>({ key: undefined, ids: new Set() });
  if (restoredIdsRef.current.key !== threadId) {
    restoredIdsRef.current = { key: threadId, ids: new Set(thread.messages.map(message => message.id)) };
  } else if (restoredIdsRef.current.ids.size === 0 && thread.messages.length > 0) {
    // First non-empty render after an async history load (mount → list/get):
    // that whole batch is a restore, not new arrivals.
    restoredIdsRef.current.ids = new Set(thread.messages.map(message => message.id));
  }
  const isRestored = (id: string) => restoredIdsRef.current.ids.has(id);
  const composerApi = useComposer({ busy, sendMessage: message => thread.sendMessage(message) });
  const { setDraft, setQueued, textareaRef, send } = composerApi;
  const risks = useMemo(() => riskByCall(thread.messages), [thread.messages]);
  const guardApprovals = useMemo(() => approvalByCall(thread.messages), [thread.messages]);
  const landing = thread.messages.length === 0;
  const activeAssistant = thread.messages.at(-1)?.role === "assistant" ? thread.messages.at(-1) : undefined;
  const assistantHasVisibleText = activeAssistant?.parts.some(
    part => part.type === "text" && part.text.trim().length > 0,
  ) ?? false;
  // ENG-217 — the three streaming moments each get exactly ONE affordance:
  // before the first chunk the generating skeleton holds the floor; a streamed
  // turn whose text is still empty shows the lone caret (renderPart); once
  // text flows the trailing caret rides .fl-md--streaming. FluidThinking
  // covers the remaining gap (tool phases with no text yet).
  const awaitingFirstChunk = busy && (activeAssistant === undefined || activeAssistant.parts.length === 0);
  const lastPart = activeAssistant?.parts.at(-1);
  const caretShowing = busy && lastPart?.type === "text" && lastPart.state === "streaming"
    && lastPart.text.trim().length === 0;
  // Once ANY build beat exists in the active turn, the checklist is the
  // progress voice — the thinking indicator between beats reads as two
  // indicators fighting.
  const hasBeats = activeAssistant?.parts.some(part => isToolUIPart(part)) ?? false;
  const working = busy && !assistantHasVisibleText && !awaitingFirstChunk && !caretShowing && !hasBeats;

  // ENG-215 — edit the last user turn: drop it (and anything after) from the
  // transcript and refill the composer, so re-sending amends rather than
  // duplicates. Only meaningful when idle.
  const lastUserIndex = (() => {
    for (let index = thread.messages.length - 1; index >= 0; index -= 1) {
      if (thread.messages[index]?.role === "user") return index;
    }
    return -1;
  })();
  // Turn actions attach by id, not list index: the map below renders a windowed
  // slice (ENG-218), so positional indices no longer line up with thread.messages.
  const lastUserId = lastUserIndex >= 0 ? thread.messages[lastUserIndex]?.id : undefined;
  const editLast = () => {
    if (busy || lastUserIndex < 0) return;
    const message = thread.messages[lastUserIndex];
    if (!message) return;
    thread.setMessages(thread.messages.slice(0, lastUserIndex));
    setQueued(null);
    setDraft(userText(message));
    requestAnimationFrame(() => textareaRef.current?.focus());
  };

  // ENG-215 — regenerate the last assistant turn (re-issues from the preserved
  // user message; no duplication). Only when idle and an assistant turn exists.
  const lastAssistantIndex = (() => {
    for (let index = thread.messages.length - 1; index >= 0; index -= 1) {
      if (thread.messages[index]?.role === "assistant") return index;
    }
    return -1;
  })();
  const lastAssistantId = lastAssistantIndex >= 0 ? thread.messages[lastAssistantIndex]?.id : undefined;
  const regenerateLast = () => {
    if (busy || lastAssistantIndex < 0) return;
    void thread.regenerate();
  };

  // ENG-214 — a broken turn (failed send, mid-stream drop, any thread.error)
  // surfaces VISIBLY in the thread, not only through the hidden status span.
  // The copy stays friendly — raw transport errors are announced to assistive
  // tech below but never printed to end users. Retry regenerates the failed
  // turn from the preserved user message (no duplication).
  const errorBanner = thread.error ? (
    <div className="fl-error">
      <span>Something went wrong and the response didn&rsquo;t finish.</span>
      <button
        type="button"
        className="fl-error-retry"
        onClick={() => {
          // Nothing to re-issue (sends append the user turn before any request
          // fires, so this is a defensive rail): degrade to dismissing the
          // error instead of letting regenerate() throw on an empty thread.
          if (thread.messages.length === 0) {
            thread.clearError();
            return;
          }
          void thread.regenerate();
        }}
      >
        Retry
      </button>
    </div>
  ) : null;

  const composer = (
    <Composer
      composer={composerApi}
      busy={busy}
      status={thread.status}
      errorMessage={thread.status === "error" && thread.error ? thread.error.message : undefined}
      onStop={() => void thread.stop()}
      onVoice={onVoice}
    />
  );

  const approvals = thread.messages.flatMap(message => message.parts).filter(isToolUIPart).filter(part => part.state === "approval-requested");

  if (landing) {
    return (
      <ChromeRoot>
        <div className="fl-thread" role="region" aria-label="Vendo conversation">
          <div className="fl-landing">
            <h1 className="fl-greet">{greeting}</h1>
            {errorBanner}
            <div className="fl-landing-composer">{composer}</div>
            {suggestions.length > 0 ? (
              <div className="fl-chips">
                {suggestions.map((text, i) => (
                  <button type="button" className="fl-chip" key={`${i}-${text}`} onClick={() => send(text)}>{text}</button>
                ))}
              </div>
            ) : null}
          </div>
        </div>
      </ChromeRoot>
    );
  }

  return (
    <ChromeRoot>
      <div className="fl-thread" role="region" aria-label="Vendo conversation">
        {/* role="log" — aria-label is prohibited on a roleless div (WCAG 4.1.2), and a
            streaming message list is exactly what "log" names. */}
        <div className="fl-msglist-wrap">
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
            {messageWindow.windowed.map(message => {
              // ENG-225 — a user turn's attachments render BESIDE the bubble
              // (the designed .fl-turn-user-att block), not inside it; a
              // files-only send has no bubble at all.
              const sentFiles = message.role === "user"
                ? message.parts.filter((part): part is FilePart => part.type === "file")
                : [];
              const bubbleText = message.role === "user" ? userText(message) : assistantText(message);
              const skipBubble = message.role === "user" && bubbleText.length === 0
                && message.parts.every(part => part.type === "file");
              // ENG-225 — every settled turn carries a Copy action (hover-
              // revealed, see chrome-css); Edit stays on the last user turn and
              // Regenerate on the last assistant turn (ENG-215). The actively
              // streaming turn gets no actions — its text is still arriving.
              const streamingTurn = busy && message.role === "assistant" && message.id === activeAssistant?.id;
              const showEdit = !busy && message.role === "user" && message.id === lastUserId;
              const showRegenerate = !busy && message.role === "assistant" && message.id === lastAssistantId;
              const showActions = !streamingTurn && (bubbleText.length > 0 || showEdit || showRegenerate);
              return (
                <Fragment key={message.id}>
                  {sentFiles.length > 0 ? (
                    <div className={`fl-turn-user-att${isRestored(message.id) ? " fl-no-entrance" : ""}`}>
                      {sentFiles.map((part, index) => <SentAttachment key={index} part={part} />)}
                    </div>
                  ) : null}
                  {skipBubble ? null : (
                    <article
                      className={`${message.role === "user" ? "fl-turn-user" : "fl-turn-assistant"}${
                        isRestored(message.id) ? " fl-no-entrance" : ""}`}
                      data-role={message.role}
                      aria-label={`${message.role} message`}
                    >
                      {collapseToolRuns(message.parts).map(({ part, index, count }) => (
                        <ThreadPart
                          key={`${message.id}-${index}`}
                          part={part}
                          partKey={`${message.id}-${index}`}
                          role={message.role}
                          restored={isRestored(message.id)}
                          count={count}
                          risks={risks}
                        />
                      ))}
                      {showActions ? (
                        <div className="fl-turn-actions">
                          {bubbleText.length > 0 ? <CopyTurnButton text={bubbleText} /> : null}
                          {showEdit ? (
                            <button type="button" className="fl-turn-btn" aria-label="Edit message" onClick={editLast}>
                              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                <path d="M12 20h9" /><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
                              </svg>
                              Edit
                            </button>
                          ) : null}
                          {showRegenerate ? (
                            <button type="button" className="fl-turn-btn" aria-label="Regenerate" onClick={regenerateLast}>
                              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                <path d="M3 12a9 9 0 0 1 15-6.7L21 8" /><path d="M21 3v5h-5" /><path d="M21 12a9 9 0 0 1-15 6.7L3 16" /><path d="M3 21v-5h5" />
                              </svg>
                              Regenerate
                            </button>
                          ) : null}
                        </div>
                      ) : null}
                    </article>
                  )}
                </Fragment>
              );
            })}
            <ThreadApprovals
              approvals={approvals}
              risks={risks}
              guardApprovals={guardApprovals}
              cardRefs={approvalCardRefs}
              respond={response => thread.addToolApprovalResponse(response)}
              onMorph={setMorph}
            />
            <ThreadConnectRequests
              messages={thread.messages}
              sendMessage={message => thread.sendMessage(message)}
            />
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
        {errorBanner}
        {composer}
      </div>
      {morph ? <MorphToast {...morph} onDone={() => setMorph(null)} /> : null}
    </ChromeRoot>
  );
}
