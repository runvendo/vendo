import type { UIMessage } from "ai";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { isAgentContext } from "./message-data.js";

/** Windowing for long threads. Rendering a reopened 200-turn thread
    mounts every turn's DOM (and runs every entrance animation) at once. Instead
    we render only a trailing window of the most recent messages and reveal older
    ones in chunks when the reader scrolls to the top — the DOM stays bounded, so
    scroll and paint stay smooth no matter how long the transcript is.

    The trailing window is what stick-to-bottom and jump-to-latest already care
    about (both operate at the end), so those behaviors are untouched. Only the
    unseen head of a genuinely long thread is deferred. */
const WINDOW_INITIAL = 60;
const WINDOW_STEP = 40;
const NEAR_TOP_PX = 200;

export function useMessageWindow(messages: UIMessage[], listRef: React.RefObject<HTMLDivElement | null>, threadKey?: string) {
  // How many trailing messages to render. Grows (never shrinks the head back
  // out from under the reader) as they scroll up; resets when the thread swaps.
  const [count, setCount] = useState(WINDOW_INITIAL);
  useEffect(() => { setCount(WINDOW_INITIAL); }, [threadKey]);

  const start = Math.max(0, messages.length - count);
  const windowed = start === 0 ? messages : messages.slice(start);
  const hasOlder = start > 0;

  // Anchor the viewport across a window growth: prepending older turns balloons
  // scrollHeight, which would otherwise yank the reader. Capture distance-from-
  // bottom at expand time and restore it after the new nodes lay out.
  const anchorRef = useRef<number | null>(null);
  const loadOlder = () => {
    if (start === 0) return;
    const node = listRef.current;
    anchorRef.current = node ? node.scrollHeight - node.scrollTop : null;
    setCount(current => current + WINDOW_STEP);
  };
  useLayoutEffect(() => {
    const node = listRef.current;
    if (anchorRef.current === null || !node) return;
    node.scrollTop = node.scrollHeight - anchorRef.current;
    anchorRef.current = null;
  });

  // Reveal more when the reader reaches the top of the rendered window.
  const onNearTop = () => {
    const node = listRef.current;
    if (node && node.scrollTop <= NEAR_TOP_PX) loadOlder();
  };

  return { windowed, hasOlder, olderCount: start, loadOlder, onNearTop };
}

/** Within this many pixels of the end the reader counts as "at the bottom" —
    a paragraph of slack so sub-line wobble (fractional scroll positions,
    entrance easing) never breaks the stick. */
const BOTTOM_SLACK_PX = 32;

/** How long the pill's smooth scroll owns the list. Comfortably longer than the
    browser's own smooth-scroll animation, short enough that a reader who
    changes their mind is back in charge before they notice. */
const JUMP_MS = 600;

/** Scroll management for the message list.

    Stick-to-bottom: while the reader is at the end, every content change
    (history load, streamed deltas, tool chips, approvals) keeps the latest
    content in view. The moment the reader scrolls up, the stick releases —
    streaming must never yank them — and it re-arms when they return to the
    bottom on their own. Jump-to-latest: when new content lands while the
    reader is scrolled up, the .fl-newbar pill appears; activating it scrolls
    smoothly to the latest turn and re-sticks. */
export function useStickToBottom(messages: UIMessage[], threadKey?: string, contentRevision?: unknown) {
  const listRef = useRef<HTMLDivElement>(null);
  // The stick is a ref, not state: it flips inside scroll/effect timing and
  // must be readable synchronously without re-render races.
  const stuckRef = useRef(true);
  // Deadline, not a flag: a smooth scroll can be cancelled by the reader's own
  // wheel and would then never report landing, so the window in which we
  // ignore our own scrolling expires on its own instead of waiting on an event.
  const jumpUntilRef = useRef(0);
  const jumping = () => Date.now() < jumpUntilRef.current;
  const lastScrollHeightRef = useRef(0);
  const [unseen, setUnseen] = useState(false);
  // The jump affordance is a bar with a COUNT of turns that landed while
  // scrolled away and a snippet of the newest text. Count = messages appended
  // since the stick released; snippet = the latest turn's trailing text
  // (best-effort, purely presentational).
  const [unseenCount, setUnseenCount] = useState(0);
  const seenLengthRef = useRef(messages.length);

  // A different conversation is a different reader position: when the caller
  // switches the hook to another thread, re-arm the stick and forget the
  // previous thread's growth baseline — otherwise a scroll-up in the old
  // thread would keep the new one from opening at its latest turn.
  const previousThreadKeyRef = useRef(threadKey);
  useEffect(() => {
    const previousKey = previousThreadKeyRef.current;
    previousThreadKeyRef.current = threadKey;
    // A server-minted id is NOT a thread switch: a conversation started without
    // an id gets its server-minted thr_ fed back mid-first-stream (a host's
    // onThreadId loop), flipping this key while the reader is mid-read. The
    // messages are the same conversation — KEEP the growth baseline: zeroing
    // it makes previousHeight === 0 read as "at bottom by definition", so the
    // next streamed chunk yanks a reader who had scrolled up (deterministic on
    // slow runners — the "streaming must never yank" conformance failure).
    // Re-arm the stick and clear the bar though: with the real baseline
    // intact, the next mutation's previous-height guard releases a genuinely
    // scrolled-up reader, while a bottom reader stays pinned instead of
    // leaking a transient new-replies bar.
    if (previousKey === undefined && threadKey !== undefined && messages.length > 0) {
      stuckRef.current = true;
      setUnseen(false);
      setUnseenCount(0);
      return;
    }
    stuckRef.current = true;
    lastScrollHeightRef.current = 0;
    setUnseen(false);
    setUnseenCount(0);
    // messages.length is deliberately unlisted: this effect keys on identity
    // changes only, and the mint guard needs the length at flip time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadKey]);

  const atBottom = (node: HTMLElement) =>
    node.scrollHeight - node.scrollTop - node.clientHeight <= BOTTOM_SLACK_PX;

  const onScroll = () => {
    const node = listRef.current;
    if (!node) return;
    // A smooth jump scrolls the list itself, one event per frame the whole way
    // down. Those frames are not the reader moving: reading them as a scroll-up
    // would release the stick before the jump ever landed.
    if (jumping() && !atBottom(node)) return;
    // Both user scrolls and our own programmatic sticks land here; either way
    // the reader's actual position is the single source of truth.
    stuckRef.current = atBottom(node);
    if (stuckRef.current) {
      setUnseen(false);
      setUnseenCount(0);
      seenLengthRef.current = messages.length;
    }
  };

  // A wheel or a touch drag is unambiguously the READER: the pill's own smooth
  // scroll emits scroll events the whole way down but never these. Either one
  // ends the jump's ownership on the spot, so the scroll handler and the size
  // observer read the reader's real position again instead of holding the
  // stick for the rest of the window — without this, a reader who changes
  // their mind mid-jump is pulled back down by the next streamed growth.
  const endJump = () => { jumpUntilRef.current = 0; };

  const jumpToLatest = () => {
    const node = listRef.current;
    if (!node) return;
    stuckRef.current = true;
    setUnseen(false);
    setUnseenCount(0);
    seenLengthRef.current = messages.length;
    // The one scroll a PERSON asked for, so it travels rather than teleports.
    // (jsdom leaves scrollTo undefined; browsers always have it. Same guard the
    // chrome's scrollIntoView call sites keep.)
    jumpUntilRef.current = Date.now() + JUMP_MS;
    if (typeof node.scrollTo === "function") node.scrollTo({ top: node.scrollHeight, behavior: "smooth" });
    else node.scrollTop = node.scrollHeight;
  };

  // After every content change: stick if the reader is at the bottom, or flag
  // the new content if they've scrolled away.
  //
  // ONE function for both callers below, because they share a growth baseline:
  // whichever of them sees a growth first CONSUMES it. With the flagging here
  // alone, mid-stream growth always reached the size observer first — streamed
  // text is revealed between deltas, changing no message identity — so by the
  // time this ran the baseline was already current, `grew` was false, and a
  // reader who scrolled away mid-reply got no pill at all.
  const follow = () => {
    const node = listRef.current;
    if (!node) return;
    const previousHeight = lastScrollHeightRef.current;
    const grew = node.scrollHeight > previousHeight;
    lastScrollHeightRef.current = node.scrollHeight;
    // The scroll event that releases the stick is ASYNC: a reader who just
    // scrolled up can have content land before onScroll flips stuckRef, and
    // trusting the stale ref would yank them back down ("streaming must never
    // yank"). Their position against the PREVIOUS content height is ground
    // truth: stuck growth leaves scrollTop at the old bottom; a scroll-up
    // puts it well above. Release the stick here instead of yanking.
    const atPreviousBottom = previousHeight === 0
      || previousHeight - node.scrollTop - node.clientHeight <= BOTTOM_SLACK_PX;
    // …unless they are at the CURRENT bottom: when content SHRINKS (a connect
    // card or generated view swaps out), scrollTop can no longer equal the old
    // taller bottom, and the previous-height test alone misreads the reader as
    // scrolled-up — releasing the stick and leaking a new-replies bar on the
    // next turn even though they never moved. At-current-bottom is at bottom.
    // …and not while the pill's scroll is still travelling: mid-flight it is
    // at neither bottom, and content landing then would release a stick the
    // reader just asked for.
    if (stuckRef.current && !jumping() && !atPreviousBottom && !atBottom(node)) stuckRef.current = false;
    if (stuckRef.current) {
      node.scrollTop = node.scrollHeight;
      seenLengthRef.current = messages.length;
    } else if (grew) {
      setUnseen(true);
      setUnseenCount(Math.max(1, messages.length - seenLengthRef.current));
    }
  };
  // The observer below outlives the render that built it, so it must call the
  // LATEST follow — an older closure counts turns against a stale length.
  const followRef = useRef(follow);
  followRef.current = follow;

  // Pre-paint (a LAYOUT effect): the growth and the scroll that answers it land
  // in the same frame, so streamed text grows upward from a fixed baseline.
  // Post-paint, the browser first painted every burst with the old scrollTop —
  // one frame of the newest wrapped line below the fold, per chunk, which is
  // the flicker that read as the thread jumping while it followed.
  // contentRevision — turn-actions (Edit/Regenerate) mount below the last turn
  // the instant a stream settles (busy→false), adding height AFTER the
  // message-driven stick already ran. Re-run so the reader stays pinned.
  useLayoutEffect(follow, [messages, contentRevision]);

  // A generated view mounts and grows AFTER the messages effect runs (the frame
  // renders async; logos/images load late), and streamed text is REVEALED at
  // its own paced rate between deltas (chrome/markdown's useSmoothText), which
  // changes no message identity at all. Without watching actual size, the stick
  // fires before the growth and the newest content — the approval card, the
  // line still being typed — lands below the fold. Observe the content box and
  // re-stick whenever it grows while the reader is at the bottom.
  // Keyed on whether the list EXISTS: an empty thread renders the landing
  // instead of .fl-msglist, so a mount-only observer attaches to nothing and,
  // having nothing to re-run on, stays absent for the rest of the session —
  // the first turn of every new conversation then followed only the wire's
  // deltas and streamed a third of its frames below the fold.
  const listMounted = messages.length > 0;
  useEffect(() => {
    const node = listRef.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => followRef.current());
    for (const child of Array.from(node.children)) observer.observe(child);
    const mutation = new MutationObserver(() => {
      for (const child of Array.from(node.children)) observer.observe(child);
    });
    mutation.observe(node, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
      mutation.disconnect();
    };
  }, [listMounted]);

  // 3A snippet: trailing text of the newest message (bounded; presentational).
  // Agent-context parts are hidden turns the surfaces send on the person's
  // behalf (the remix grounding, the connect card's continuations) — quoting
  // one here would print machinery to a reader who is merely scrolled away.
  const lastMessage = messages.at(-1);
  const snippet = unseen && lastMessage
    ? lastMessage.parts
        .filter((part): part is Extract<typeof part, { type: "text" }> =>
          part.type === "text" && !isAgentContext(part))
        .map(part => part.text)
        .join(" ")
        .trim()
        .slice(0, 120)
    : "";

  return { listRef, onScroll, endJump, jumpToLatest, showJump: unseen, unseenCount, snippet };
}
