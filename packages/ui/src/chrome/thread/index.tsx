import { isToolUIPart } from "ai";
import { useEffect, useMemo, useRef, useState } from "react";
import { useVendoDiscoverability, useVendoGreeting } from "../../context.js";
import { useVendoThread } from "../../hooks/use-vendo-thread.js";
import { StatusRibbon } from "../build-beat.js";
import { ChromeRoot } from "../chrome-root.js";
import { defaultVendoGreeting, hasSeen, markSeen, type VendoDiscoverability, type VendoGreeting } from "../discoverability.js";
import { MorphToast, type MorphToastProps } from "../morph-toast.js";
import { Composer, dragHasFiles, useComposer } from "./composer.js";
import { MessageList } from "./message-list.js";
import { useMessageWindow, useStickToBottom } from "./scrolling.js";
import { approvalByCall, riskByCall, userText } from "./message-data.js";

/** Lane pick 4B — a rich landing suggestion: two-line starter card. */
export interface VendoSuggestionCard {
  /** Card headline (verb-first reads best: "Build a view"). */
  title: string;
  /** One concrete outcome line under the title. */
  description: string;
  /** Sent as the message on tap; defaults to the title. */
  prompt?: string;
  /** Optional host-supplied leading icon node. */
  icon?: import("react").ReactNode;
}

export interface VendoThreadProps {
  threadId?: string;
  /** Landing headline shown above the composer while the thread is empty. */
  greeting?: string;
  /** Starter prompts on the empty landing; clicking sends one. Lane pick 4B —
   * a plain string keeps today's pill chip; the object form renders a two-line
   * starter card (title + concrete outcome, optional icon) with more scent. */
  suggestions?: (string | VendoSuggestionCard)[];
  /** Show a mic affordance in the composer that launches the host's voice surface. */
  onVoice?: () => void;
  /** ENG-222 — fires with the effective thread id once it is known, including
   * the fresh `thr_` the server mints for a new conversation. Lets a host
   * surface (e.g. VendoPage's sidebar) pull the new conversation into its list. */
  onThreadId?: (threadId: string) => void;
  /** The discoverability dial (ui-usage-dx §6), overriding the provider's:
   * `"quiet"` disables the fire-once greeting-as-tutorial below. */
  discoverability?: VendoDiscoverability;
  /** Greeting-as-tutorial content (intro + prompt chips) overriding the
   * provider's `greeting`. Distinct from `greeting` above (the returning-user
   * landing headline) — this one renders once per user, ever. */
  firstRunGreeting?: VendoGreeting;
  /** Rendered directly above the composer in both landing and conversation
   * layouts — the seam VendoOverlay uses for its command chip strip (the
   * one-surface ⌘K design). Presentation-only; the thread never reads it. */
  composerAccessory?: import("react").ReactNode;
}

/** 08-ui §4 — conversation chrome over the headless thread transport. */
export function VendoThread({
  threadId,
  greeting = "What can I help you build?",
  suggestions = [],
  onVoice,
  onThreadId,
  discoverability,
  firstRunGreeting,
  composerAccessory,
}: VendoThreadProps) {
  const thread = useVendoThread(threadId);
  // ui-usage-dx §6 — greeting-as-tutorial: the user's FIRST-ever conversation
  // open (fresh thread only — an adopted thread with history is not a first
  // open and does not burn the flag) renders the agent-voiced intro + starter
  // chips locally. Presentation-only: nothing here touches the transport or
  // the transcript; chips prefill the composer and never send.
  const providerDial = useVendoDiscoverability();
  const dial = discoverability ?? providerDial;
  const contextGreeting = useVendoGreeting();
  const tutorial = firstRunGreeting ?? contextGreeting ?? defaultVendoGreeting;
  const [tutorialActive, setTutorialActive] = useState(false);
  // Arming is REACTIVE, not mount-only: surfaces that don't remount their
  // thread (VendoPage flips threadId props on one instance) become eligible
  // later — e.g. when the page's dial gate opens on an explicit "New
  // conversation". Burned on first showing (not on interaction) — a reload
  // mid-look never replays it, per the once-per-user-ever rule.
  const messageCount = thread.messages.length;
  useEffect(() => {
    if (tutorialActive || dial === "quiet" || threadId !== undefined) return;
    if (messageCount > 0 || hasSeen("greeting")) return;
    markSeen("greeting");
    setTutorialActive(true);
  }, [tutorialActive, dial, threadId, messageCount]);
  // Once the landing is left (a turn exists, or the surface switches to a
  // stored thread), the tutorial is done for good on this instance too — the
  // burned flag keeps every later landing plain.
  useEffect(() => {
    if (tutorialActive && (messageCount > 0 || threadId !== undefined)) setTutorialActive(false);
  }, [tutorialActive, messageCount, threadId]);
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
  // A "Vendo: " prefixed message is the agent's OWN safe error (VendoError
  // code + operator-crafted text, wireErrorMessage in @vendoai/agent) — the
  // ONE error shape end users may see in detail. Raw transport/provider
  // strings never match the prefix and stay hidden (ENG-214 policy).
  const errorDetail = thread.error?.message?.startsWith("Vendo: ") === true
    ? thread.error.message.slice("Vendo: ".length)
    : null;
  const errorBanner = thread.error ? (
    <div className="fl-error">
      <span>
        Something went wrong and the response didn&rsquo;t finish.
        {errorDetail !== null && <span className="fl-error-detail">{errorDetail}</span>}
      </span>
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

  // Lane pick C1 — the live status ribbon: while the turn works through tool
  // calls (and no text has started flowing), the ACTIVE call narrates above
  // the composer — label · elapsed · step N of M. The transcript stays
  // beat-free (parts.tsx renders only errored calls). Once text streams the
  // ribbon yields the floor to the caret choreography.
  const activeToolParts = (activeAssistant?.parts ?? []).filter(isToolUIPart);
  const liveToolPart = [...activeToolParts].reverse()
    .find(part => part.state !== "output-available" && part.state !== "output-error");
  // A turn parked on an approval is not "busy" (the stream yielded), but the
  // pause still narrates: the ribbon holds "— waiting for your approval" while
  // the card sits in the transcript.
  const awaitingApprovalPart = activeToolParts.find(part => part.state === "approval-requested");
  const activeToolPart = busy && !assistantHasVisibleText
    ? liveToolPart ?? (activeToolParts.length > 0 && !caretShowing ? activeToolParts.at(-1) : undefined)
    : awaitingApprovalPart;
  const ribbon = activeToolPart ? (
    <StatusRibbon
      part={activeToolPart}
      stepIndex={activeToolParts.indexOf(activeToolPart) + 1}
      stepTotal={activeToolParts.length}
      risk={risks.get(activeToolPart.toolCallId) ?? "read"}
    />
  ) : null;

  // Lane pick 2E — the WHOLE thread surface is the drop target (the composer
  // bar no longer owns drag): a huge, overshoot-proof zone with a centered
  // card naming what will happen. Depth counter as before (child crossings).
  const { dragDepth, setDragDepth, setFiles } = composerApi;
  const dropProps = {
    onDragEnter: (event: React.DragEvent) => {
      if (!dragHasFiles(event)) return;
      event.preventDefault();
      setDragDepth(depth => depth + 1);
    },
    onDragOver: (event: React.DragEvent) => {
      if (dragHasFiles(event)) event.preventDefault();
    },
    onDragLeave: (event: React.DragEvent) => {
      if (dragHasFiles(event)) setDragDepth(depth => Math.max(0, depth - 1));
    },
    onDrop: (event: React.DragEvent) => {
      if (!dragHasFiles(event)) return;
      event.preventDefault();
      setDragDepth(0);
      const dropped = Array.from(event.dataTransfer.files);
      if (dropped.length > 0) setFiles(current => [...current, ...dropped]);
    },
  };
  const dropOverlay = dragDepth > 0 ? (
    <div className="fl-drop fl-drop--thread">
      <div className="fl-drop-card">
        <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48" />
        </svg>
        Drop files to attach to your message
      </div>
    </div>
  ) : null;

  if (landing) {
    return (
      <ChromeRoot>
        <div className="fl-thread" role="region" aria-label="Vendo conversation" {...dropProps}>
          {dropOverlay}
          <div className="fl-landing">
            {tutorialActive ? (
              // The one-time tutorial replaces the headline (and the host's
              // send-on-tap suggestion chips — two chip rows with different
              // behaviors would read as one). Chips PREFILL, never send.
              <div className="fl-greeting" role="group" aria-label="Getting started">
                <p className="fl-greeting-intro">{tutorial.intro}</p>
                <div className="fl-chips fl-greeting-chips">
                  {tutorial.prompts.slice(0, 3).map((text, i) => (
                    <button
                      type="button"
                      className="fl-chip"
                      key={`${i}-${text}`}
                      onClick={() => {
                        setDraft(text);
                        requestAnimationFrame(() => textareaRef.current?.focus());
                      }}
                    >
                      {text}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <h1 className="fl-greet">{greeting}</h1>
            )}
            {errorBanner}
            {composerAccessory}
            <div className="fl-landing-composer">{composer}</div>
            {!tutorialActive && suggestions.length > 0 ? (
              // Lane pick 4B — object suggestions render as two-line starter
              // cards (title + concrete outcome, optional host icon); plain
              // strings keep the pill chip. A MIXED array renders both
              // containers (cards grid, then a chips row) so string entries
              // never stretch as grid cells (AI-review catch). Both send on
              // tap, unchanged.
              <>
                {suggestions.some(s => typeof s !== "string") ? (
                  <div className="fl-cards">
                    {suggestions.flatMap((suggestion, i) => {
                      if (typeof suggestion === "string") return [];
                      const prompt = suggestion.prompt ?? suggestion.title;
                      return [(
                        <button type="button" className="fl-card" key={`${i}-${suggestion.title}`} onClick={() => send(prompt)}>
                          {suggestion.icon}
                          <b>{suggestion.title}</b>
                          <span>{suggestion.description}</span>
                        </button>
                      )];
                    })}
                  </div>
                ) : null}
                {suggestions.some(s => typeof s === "string") ? (
                  <div className="fl-chips">
                    {suggestions.flatMap((text, i) => (
                      typeof text === "string"
                        ? [<button type="button" className="fl-chip" key={`${i}-${text}`} onClick={() => send(text)}>{text}</button>]
                        : []
                    ))}
                  </div>
                ) : null}
              </>
            ) : null}
          </div>
        </div>
      </ChromeRoot>
    );
  }

  return (
    <ChromeRoot>
      <div className="fl-thread" role="region" aria-label="Vendo conversation" {...dropProps}>
        {dropOverlay}
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
        {composerAccessory}
        {ribbon}
        {composer}
      </div>
      {morph ? <MorphToast {...morph} onDone={() => setMorph(null)} /> : null}
    </ChromeRoot>
  );
}
