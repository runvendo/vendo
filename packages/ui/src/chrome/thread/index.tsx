import { isToolUIPart } from "ai";
import { useEffect, useMemo, useRef, useState } from "react";
import { APPROVALS_DECIDED_EVENT, type ApprovalsDecidedDetail } from "../../client-impl.js";
import { useVendoDiscoverability, useVendoGreeting } from "../../context.js";
import { useVendoThread } from "../../hooks/use-vendo-thread.js";
import { ChromeRoot } from "../chrome-root.js";
import { defaultVendoGreeting, hasSeen, markSeen, type VendoDiscoverability, type VendoGreeting } from "../discoverability.js";
import { MorphToast, type MorphToastProps } from "../morph-toast.js";
import { Composer, dragHasFiles, useComposer } from "./composer.js";
import { MessageList } from "./message-list.js";
import { useMessageWindow, useStickToBottom } from "./scrolling.js";
import { approvalByCall, grantSetByCall, riskByCall, toolCallPending, turnErrorSentence, userText } from "./message-data.js";

/** A rich landing suggestion: two-line starter card. */
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
  /** One quiet capability line under the landing headline (muted, centered).
   * Purely additive: absent means today's headline-only landing. */
  intro?: string;
  /** Starter prompts on the empty landing; clicking sends one.
   * a plain string keeps today's pill chip; the object form renders a two-line
   * starter card (title + concrete outcome, optional icon) with more scent. */
  suggestions?: (string | VendoSuggestionCard)[];
  /** Show a mic affordance in the composer that launches the host's voice surface. */
  onVoice?: () => void;
  /** Fires with the effective thread id once it is known, including
   * the fresh `thr_` the server mints for a new conversation. Lets a host
   * surface (e.g. a host's own conversation list) pull the new one in. */
  onThreadId?: (threadId: string) => void;
  /** The discoverability dial, overriding the provider's:
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

/** Conversation chrome over the headless thread transport. */
export function VendoThread({
  threadId,
  greeting = "What can I help you build?",
  intro,
  suggestions = [],
  onVoice,
  onThreadId,
  discoverability,
  firstRunGreeting,
  composerAccessory,
}: VendoThreadProps) {
  const thread = useVendoThread(threadId);
  // Greeting-as-tutorial: the user's FIRST-ever conversation
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
  // thread (a host flipping threadId props on one instance) become eligible
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
  // Surface the effective (possibly server-minted) thread id upward.
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
      // flex column can leave the list shorter than the card itself at a
      // short viewport
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
  // Entrance-animation gating on restore. The .fl-item-in rise runs
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
  const composerApi = useComposer({
    busy,
    sendMessage: message => thread.sendMessage(message),
    // A message typed mid-turn is offered to that turn before it queues.
    ...(thread.steer === undefined ? {} : { steer: thread.steer }),
  });
  const { setDraft, setQueued, textareaRef, send } = composerApi;
  const risks = useMemo(() => riskByCall(thread.messages), [thread.messages]);
  const guardApprovals = useMemo(() => approvalByCall(thread.messages), [thread.messages]);
  // Grant SETS (demo-live-readiness): a parked call claimed by a
  // data-vendo-grant-set part renders the set card inline (ThreadPart) —
  // ThreadApprovals must skip it — and its resume matches on set membership.
  const grantSets = useMemo(() => grantSetByCall(thread.messages), [thread.messages]);
  // Approve-anywhere resume: a consent decided on ANY surface sharing the page
  // (activity panel, workspace queue, voice stage — they all decide through
  // client.approvals.decide, which announces the decided guard-approval ids)
  // must resume a thread parked on that approval, exactly like the in-thread
  // card's own Approve/Deny. When an announced id matches a still-parked
  // in-thread card, the same native approval response goes out — the server
  // resume already keys off the approval decision, not the clicking surface.
  // respondOnce dedupes the two paths racing (card click → decide → event →
  // this listener → the card's own respond) into a single response.
  const respondedRef = useRef(new Set<string>());
  const respondOnce = (response: { id: string; approved: boolean }) => {
    if (respondedRef.current.has(response.id)) return;
    respondedRef.current.add(response.id);
    thread.addToolApprovalResponse(response);
  };
  const decidedElsewhereRef = useRef<(detail: ApprovalsDecidedDetail) => void>(() => undefined);
  decidedElsewhereRef.current = detail => {
    const decided = new Set(detail.ids);
    for (const message of thread.messages) {
      for (const part of message.parts) {
        if (!isToolUIPart(part) || part.state !== "approval-requested") continue;
        const nativeId = (part as { approval?: { id?: string } }).approval?.id;
        if (nativeId === undefined) continue;
        // A call parked on a grant SET resumes when the announcement names its
        // set (grantSetId) or decides ANY member ask — the set is decided
        // atomically, so sibling-surface decisions never leave it parked.
        const set = grantSets.get(part.toolCallId);
        if (set !== undefined) {
          const matchesSet = (detail.grantSetId !== undefined && detail.grantSetId === set.grantSetId)
            || set.approvalIds.some(approvalId => decided.has(approvalId));
          if (matchesSet) respondOnce({ id: nativeId, approved: detail.approved });
          continue;
        }
        const guardId = guardApprovals.get(part.toolCallId)?.approvalId;
        if (guardId === undefined || !decided.has(guardId)) continue;
        respondOnce({ id: nativeId, approved: detail.approved });
      }
    }
  };
  useEffect(() => {
    const onDecided = (event: Event) => {
      const detail = (event as CustomEvent<ApprovalsDecidedDetail>).detail;
      if (detail !== undefined && Array.isArray(detail.ids)) decidedElsewhereRef.current(detail);
    };
    window.addEventListener(APPROVALS_DECIDED_EVENT, onDecided);
    return () => window.removeEventListener(APPROVALS_DECIDED_EVENT, onDecided);
  }, []);
  const landing = thread.messages.length === 0;
  const activeAssistant = thread.messages.at(-1)?.role === "assistant" ? thread.messages.at(-1) : undefined;
  const assistantHasVisibleText = activeAssistant?.parts.some(
    part => part.type === "text" && part.text.trim().length > 0,
  ) ?? false;
  // The streaming moments each get exactly ONE affordance: a streamed
  // turn whose text is still empty shows the lone caret (renderPart); once
  // text flows the trailing caret rides .fl-md--streaming. FluidThinking covers
  // every remaining gap, INCLUDING the wait before the first chunk — that
  // window used to get a document-shaped skeleton card, which promised a view
  // on turns that never build one (live demo, 2026-07-28).
  const lastPart = activeAssistant?.parts.at(-1);
  const caretShowing = busy && lastPart?.type === "text" && lastPart.state === "streaming"
    && lastPart.text.trim().length === 0;
  // Once ANY build beat exists in the active turn, the checklist is the
  // progress voice — the thinking indicator between beats reads as two
  // indicators fighting.
  const hasBeats = activeAssistant?.parts.some(part => isToolUIPart(part)) ?? false;
  const working = busy && !assistantHasVisibleText && !caretShowing && !hasBeats;

  // Edit the last user turn: drop it (and anything after) from the
  // transcript and refill the composer, so re-sending amends rather than
  // duplicates. Only meaningful when idle.
  const lastUserIndex = (() => {
    for (let index = thread.messages.length - 1; index >= 0; index -= 1) {
      if (thread.messages[index]?.role === "user") return index;
    }
    return -1;
  })();
  // Turn actions attach by id, not list index: the map below renders a windowed
  // slice, so positional indices no longer line up with thread.messages.
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

  // Regenerate the last assistant turn (re-issues from the preserved
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

  // A broken turn (failed send, mid-stream drop, any thread.error)
  // surfaces VISIBLY in the thread, not only through the hidden status span.
  // The copy stays friendly — raw transport errors are announced to assistive
  // tech below but never printed to end users.
  // A "Vendo: " prefixed message is the agent's OWN safe error (VendoError
  // code + operator-crafted text, wireErrorMessage in @vendoai/harnesses) — the
  // ONE error shape end users may see in detail. Raw transport/provider
  // Strings never match the prefix and stay hidden.
  // self-serve P — a live turn error now ALSO lands in the turn itself (the
  // data-vendo-turn-error part, which survives reload); when that part is
  // already saying it, the banner keeps only its headline + Retry so the same
  // sentence isn't printed twice.
  const turnErrorInThread = activeAssistant?.parts.some(part => part.type === "data-vendo-turn-error") ?? false;
  const errorDetail = turnErrorInThread ? undefined : turnErrorSentence(thread.error?.message);
  // The copy law governs the surfaces where the AGENT CAN SPEAK, and this is
  // one: the banner used to carry its own Retry button, a bespoke failure
  // control beside a conversation that already has one recovery path (the turn's
  // Regenerate action, and the composer). The banner states what happened and
  // stops there.
  const errorBanner = thread.error ? (
    <div className="fl-error">
      <span>
        Something went wrong and the response didn&rsquo;t finish.
        {errorDetail === undefined ? null : <span className="fl-error-detail">{errorDetail}</span>}
      </span>
    </div>
  ) : null;

  // The jump affordance is a bar with a COUNT and a snippet ("2 new replies ·
  // …") docked flush onto the composer's top edge (rendered inside its
  // .fl-dock-anchor, tray-style, so the two read as one piece); at mobile
  // widths the same element re-clothes as a bottom-center pill, in CSS alone.
  const jumpBar = scroll.showJump ? (
    <button
      type="button"
      className="fl-newbar"
      aria-label={`Jump to latest — ${scroll.unseenCount === 1 ? "1 new reply" : `${scroll.unseenCount} new replies`}`}
      onClick={scroll.jumpToLatest}
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M12 5v14" /><path d="m19 12-7 7-7-7" />
      </svg>
      {scroll.unseenCount === 1 ? "1 new reply" : `${scroll.unseenCount} new replies`}
      {scroll.snippet ? <small>{scroll.snippet}</small> : null}
    </button>
  ) : null;

  const composer = (
    <Composer
      composer={composerApi}
      busy={busy}
      status={thread.status}
      errorMessage={thread.status === "error" && thread.error ? thread.error.message : undefined}
      onStop={() => void thread.stop()}
      onVoice={onVoice}
      jumpBar={jumpBar}
    />
  );

  // Grant-set parked calls render their own inline card (ThreadPart), so the
  // generic parked-approval list excludes them — one consent surface per ask.
  const approvals = thread.messages.flatMap(message => message.parts).filter(isToolUIPart)
    .filter((part): part is Extract<typeof part, { state: "approval-requested" }> =>
      part.state === "approval-requested" && !grantSets.has(part.toolCallId));

  // The ribbon no longer narrates tool calls: the TRANSCRIPT owns the
  // work now (one beat per call, at its position in the conversation), so a
  // second live narration above the composer would say the same thing twice.
  // All that survives above the composer is the between-steps gap below.
  const activeToolParts = (activeAssistant?.parts ?? []).filter(isToolUIPart);
  // A call parked on an approval NEVER narrates here: its card is right there
  // in the transcript, with the ask in its eyebrow, its title and its buttons.
  // The ribbon used to add "Send money — waiting for your approval" directly
  // above a card reading "NEEDS YOUR APPROVAL / Send money" — the same words
  // twice (the D1 ruling: the card IS the step). A parked turn is not in
  // progress either, so the pulsing orb was a lie.
  const narratable = activeToolParts.filter(part => part.state !== "approval-requested");
  // M22 — "live" is the SAME terminal set the transcript uses (`toolCallPending`):
  // this list left out `output-denied`, so a refused ask counted as a live step
  // forever and the between-steps ribbon never came back for the rest of the turn.
  const liveToolPart = [...narratable].reverse().find(part => toolCallPending(part));
  // 2026-07 loading-state audit — the between-steps gap: a busy turn whose
  // prose has already streamed and whose tool parts have all settled had NO
  // indicator anywhere (no live beat, the caret needs streaming text,
  // FluidThinking stands down once text exists). Only while text deltas are
  // actively flowing does the caret own the floor; every other busy moment
  // narrates through the quiet WorkingBeat — a RUNNING call excepted, since
  // its beat is already ticking in the transcript.
  const textActivelyStreaming = lastPart?.type === "text" && lastPart.state === "streaming"
    && lastPart.text.trim().length > 0;
  // 2026-08-06 polish — the quiet beat is pinned to real work: a beat must
  // exist (a text-only turn is never "between steps") and the gap must outlast
  // the end-of-stream teardown, which used to flash "Working… 0.5s" under an
  // already-finished answer while `busy` drained.
  const quietBusyEligible = busy && hasBeats && liveToolPart === undefined
    && !textActivelyStreaming && !caretShowing && !working;
  const [quietBusy, setQuietBusy] = useState(false);
  useEffect(() => {
    if (!quietBusyEligible) {
      setQuietBusy(false);
      return;
    }
    const timer = setTimeout(() => setQuietBusy(true), 800);
    return () => clearTimeout(timer);
  }, [quietBusyEligible]);
  // The gap narrates the latest harness beat when there is one;
  // "Working" is the floor for a harness that says nothing. It renders as a
  // WorkingBeat at the transcript tail (2026-08-06 polish: one beat
  // vocabulary, no separate ribbon pill).
  const quietLabel = quietBusy ? thread.beats.at(-1)?.label ?? "Working" : undefined;

  // The WHOLE thread surface is the drop target (the composer
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
    // Landing layout (2026-07 fix): the COMPOSER is pinned to the panel bottom
    // — the exact slot it occupies in an active conversation — so sending the
    // first message never relocates it. The greeting + starter cards flow in
    // the scrollable .fl-landing area above it.
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
              <>
                <h1 className="fl-greet">{greeting}</h1>
                {intro ? <p className="fl-intro">{intro}</p> : null}
              </>
            )}
            {!tutorialActive && suggestions.length > 0 ? (
              // Object suggestions render as two-line starter
              // cards (title + concrete outcome, optional host icon); plain
              // strings keep the pill chip. A MIXED array renders both
              // containers (cards grid, then one plain chips row) so string
              // entries never stretch as grid cells (AI-review catch). Both
              // send on tap, unchanged.
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
          {errorBanner}
          {composerAccessory}
          {composer}
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
          respond={respondOnce}
          onMorph={setMorph}
          sendMessage={message => thread.sendMessage(message)}
          working={working}
          quietLabel={quietLabel}
        />
        {errorBanner}
        {composerAccessory}
        {composer}
      </div>
      {morph ? <MorphToast {...morph} onDone={() => setMorph(null)} /> : null}
    </ChromeRoot>
  );
}
