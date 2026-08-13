/**
 * What stops a screen that will not stop — in the unit the venue can measure.
 *
 * A screen runs synchronously inside a QuickJS VM, so the only way out of a
 * `while (true)` is the interrupt handler QuickJS polls while it burns. What that
 * handler is allowed to ask is the whole question here, and the answer is not the
 * same in both venues:
 *
 * - **Node reads the clock.** "Has this screen had its fifth of a second" is the
 *   question actually being asked, and a deadline answers it whatever the loop
 *   happens to contain. {@link wallClockBudget} is the default for that reason.
 * - **workerd freezes the clock.** During a synchronous burn `Date.now()` and
 *   `performance.now()` do not advance at all, so a deadline handler is asked a
 *   million times and truthfully answers "not yet" every time: a measured runaway
 *   screen spent 37 seconds of CPU and died on a platform error instead of a
 *   refusal. {@link opsBudget} counts the polls instead, and a count rises
 *   whether or not the clock does.
 *
 * An interrupt count is a coarser unit — the same `while (true)` costs a
 * different number of them depending on what is in the loop — so the counts are
 * calibrated with room to spare rather than cut fine. QuickJS comes up for air
 * about every ten thousand bytecode operations, which puts real work and a
 * runaway three orders apart: booting a 60-row screen spends ONE interrupt and
 * re-painting it spends none, against budgets of 7000 and 650.
 *
 * This file lives under contract/, so it stays browser-safe: `InterruptHandler`
 * is imported as a TYPE and nothing here runs anything from that package.
 */
import type { InterruptHandler } from "quickjs-emscripten-core";

/** The two things a screen does, and the two limits they get. Boot is the longer
 *  of the pair: it parses Preact and the screen's own source before it paints. */
export type ScreenTurn = "boot" | "op";

/** One turn's allowance, made the moment the turn starts. */
export interface TurnLimit {
  /** Installed on the runtime for the length of the turn. */
  readonly handler: InterruptHandler;
  /** Is the allowance gone? Asked between drain rounds, where no VM code is
   *  running and so nothing would poll the handler. */
  spent(): boolean;
  /** The refusal, naming THIS turn's limit — a sentence that names the wrong one
   *  sends a repair after the wrong problem. */
  readonly message: string;
}

export interface ScreenBudget {
  limit(turn: ScreenTurn): TurnLimit;
}

/** Wall-clock a single event or paint may spend. A 60-row render measured 3.3ms
 *  in this VM, so this is ~60x headroom for real work and still a fifth of a
 *  second for a runaway. */
const OP_BUDGET_MS = 200;

/** Wall-clock the boot may spend. Longer because it parses Preact and this
 *  screen's own source before it paints for the first time. */
const BOOT_BUDGET_MS = 2_000;

/** Interrupts a single event or paint may spend. Calibrated against the 200ms
 *  above: a VM burning a tight loop reaches this in 60-125ms. */
export const OP_INTERRUPT_BUDGET = 650;

/** Interrupts the boot may spend, calibrated the same way against the 2000ms:
 *  a boot that loops while it renders reaches this in ~2.2s. */
export const BOOT_INTERRUPT_BUDGET = 7_000;

const finishMessage = (limit: string): string =>
  `this screen did not finish inside ${limit} — a loop that never ends, or work too heavy for a paint`;

/**
 * The default, and the only one that is right in Node: a deadline per turn.
 *
 * The handler is `shouldInterruptAfterDeadline`'s own body, written out rather
 * than imported — contract/ must bundle for a browser, and a type import is all
 * this file may take from `quickjs-emscripten-core`.
 */
export const wallClockBudget = (options: { opMs?: number; bootMs?: number } = {}): ScreenBudget => ({
  limit: (turn) => {
    const budgetMs = turn === "boot" ? options.bootMs ?? BOOT_BUDGET_MS : options.opMs ?? OP_BUDGET_MS;
    const deadline = Date.now() + budgetMs;
    const over = (): boolean => Date.now() > deadline;
    return { handler: over, spent: over, message: finishMessage(`${budgetMs}ms`) };
  },
});

/** The edge's budget: how many times QuickJS came up for air, which no runtime
 *  can freeze. Deterministic, so the same runaway is contained identically on
 *  every machine — and unlike a deadline it cannot be defeated by a stopped
 *  clock. */
export const opsBudget = (options: { opInterrupts?: number; bootInterrupts?: number } = {}): ScreenBudget => ({
  limit: (turn) => {
    const allowed = turn === "boot"
      ? options.bootInterrupts ?? BOOT_INTERRUPT_BUDGET
      : options.opInterrupts ?? OP_INTERRUPT_BUDGET;
    let polls = 0;
    return {
      handler: () => (polls += 1) > allowed,
      spent: () => polls > allowed,
      message: finishMessage(`${allowed} interrupts`),
    };
  },
});
