import { isToolUIPart } from "ai";
import { useEffect, useMemo, useRef, useState } from "react";
import { useVendoThread } from "../hooks/use-vendo-thread.js";
import { ChromeRoot } from "./chrome-root.js";
import { MorphToast, type MorphToastProps } from "./morph-toast.js";
import { Composer, useComposer } from "./thread/composer.js";
import { MessageList } from "./thread/message-list.js";
import { useMessageWindow, useStickToBottom } from "./thread/scrolling.js";
import { approvalByCall, riskByCall, userText } from "./thread/message-data.js";

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
        <MessageList
          scroll={scroll}
          messageWindow={messageWindow}
          busy={busy}
          risks={risks}
          isRestored={isRestored}
          activeAssistantId={activeAssistant?.id}
          lastUserId={lastUserId}
          lastAssistantId={lastAssistantId}
          onEditLast={editLast}
          onRegenerateLast={regenerateLast}
          approvals={approvals}
          guardApprovals={guardApprovals}
          cardRefs={approvalCardRefs}
          respond={response => thread.addToolApprovalResponse(response)}
          onMorph={setMorph}
          messages={thread.messages}
          sendMessage={message => thread.sendMessage(message)}
          awaitingFirstChunk={awaitingFirstChunk}
          working={working}
        />
        {errorBanner}
        {composer}
      </div>
      {morph ? <MorphToast {...morph} onDone={() => setMorph(null)} /> : null}
    </ChromeRoot>
  );
}
