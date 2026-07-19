import type { UIMessage } from "ai";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

/** ENG-218 — windowing for long threads. Rendering a reopened 200-turn thread
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

/** ENG-213 — scroll management for the message list.

    Stick-to-bottom: while the reader is at the end, every content change
    (history load, streamed deltas, tool chips, approvals) keeps the latest
    content in view. The moment the reader scrolls up, the stick releases —
    streaming must never yank them — and it re-arms when they return to the
    bottom on their own. Jump-to-latest: when new content lands while the
    reader is scrolled up, the stylesheet's .fl-jump affordance appears;
    activating it scrolls to the latest turn and re-sticks. */
export function useStickToBottom(messages: UIMessage[], threadKey?: string, contentRevision?: unknown) {
  const listRef = useRef<HTMLDivElement>(null);
  // The stick is a ref, not state: it flips inside scroll/effect timing and
  // must be readable synchronously without re-render races.
  const stuckRef = useRef(true);
  const lastScrollHeightRef = useRef(0);
  const [unseen, setUnseen] = useState(false);

  // A different conversation is a different reader position: when the caller
  // switches the hook to another thread, re-arm the stick and forget the
  // previous thread's growth baseline — otherwise a scroll-up in the old
  // thread would keep the new one from opening at its latest turn.
  useEffect(() => {
    stuckRef.current = true;
    lastScrollHeightRef.current = 0;
    setUnseen(false);
  }, [threadKey]);

  const atBottom = (node: HTMLElement) =>
    node.scrollHeight - node.scrollTop - node.clientHeight <= BOTTOM_SLACK_PX;

  const onScroll = () => {
    const node = listRef.current;
    if (!node) return;
    // Both user scrolls and our own programmatic sticks land here; either way
    // the reader's actual position is the single source of truth.
    stuckRef.current = atBottom(node);
    if (stuckRef.current) setUnseen(false);
  };

  const jumpToLatest = () => {
    const node = listRef.current;
    if (!node) return;
    stuckRef.current = true;
    setUnseen(false);
    node.scrollTop = node.scrollHeight;
  };

  // After every content change: stick if the reader is at the bottom, or flag
  // the new content if they've scrolled away. Layout effects would run before
  // paint, but streamed markdown re-renders arrive in bursts — post-paint is
  // indistinguishable here and cheaper.
  useEffect(() => {
    const node = listRef.current;
    if (!node) return;
    const grew = node.scrollHeight > lastScrollHeightRef.current;
    lastScrollHeightRef.current = node.scrollHeight;
    if (stuckRef.current) {
      node.scrollTop = node.scrollHeight;
    } else if (grew) {
      setUnseen(true);
    }
    // contentRevision — ENG-215: turn-actions (Edit/Regenerate) mount below the
    // last turn the instant a stream settles (busy→false), adding height AFTER
    // the message-driven stick already ran. Re-run so the reader stays pinned.
  }, [messages, contentRevision]);

  // A generated view mounts and grows AFTER the messages effect runs (the jail
  // renders async; logos/images load late). Without watching actual size, the
  // stick fires before the growth and the newest content — the approval card,
  // the closing line — lands below the fold. Observe the content box and
  // re-stick whenever it grows while the reader is at the bottom.
  useEffect(() => {
    const node = listRef.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      lastScrollHeightRef.current = node.scrollHeight;
      if (stuckRef.current) node.scrollTop = node.scrollHeight;
    });
    for (const child of Array.from(node.children)) observer.observe(child);
    const mutation = new MutationObserver(() => {
      for (const child of Array.from(node.children)) observer.observe(child);
    });
    mutation.observe(node, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
      mutation.disconnect();
    };
  }, []);

  return { listRef, onScroll, jumpToLatest, showJump: unseen };
}
