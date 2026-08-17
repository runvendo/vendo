/**
 * How much of a long transcript is actually on screen.
 *
 * A reopened 200-turn thread does not mount every turn: the client renders only
 * a trailing window and defers the head behind a "Show N earlier messages"
 * control (`packages/ui/src/chrome/thread/scrolling.ts`). A deferred message is
 * not merely scrolled out of view — it is not in the DOM at all, so nothing it
 * contains has been drawn.
 *
 * The number lives HERE, in core, because it stopped being a rendering detail
 * the moment the server needed the same answer: arrival marks an app seen when a
 * person's thread read renders it (`packages/vendo/src/wire/threads.ts`), and a
 * server that walked the whole stored transcript would mark apps buried in the
 * deferred head — permanently, since a first-seen record cannot be un-answered.
 * The render window and the mark window are ONE invariant, and `packages/vendo`
 * cannot import `packages/ui`.
 */
export const THREAD_WINDOW_INITIAL = 60;
