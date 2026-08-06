/**
 * Cross-block internals — NOT a host surface.
 *
 * What is left after the engine fold: the thread LIFECYCLE, shared rather than
 * re-derived. A composition that serves turns through the harness runtime still
 * has to mint ids the same way, refuse a foreign thread the same way, derive the
 * same listing title, and — crucially — read the SAME canonical transcript
 * `createAgent` reads. Re-deriving any of those would give one product two
 * thread semantics depending on who ran the turn.
 *
 * Everything else this subpath used to carry (the loop, the tool bridge, the
 * discovery rails, the transcript rules, the wire error formatter) now lives in
 * `@vendoai/harnesses`, where the runtime that drives them lives.
 */
export { ThreadRepository } from "./threads.js";
export type { Thread, ThreadSummary } from "./threads.js";
