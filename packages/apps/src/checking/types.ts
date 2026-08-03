/**
 * The checking floor's contract. The shapes themselves live in core
 * (`@vendoai/core` `pack.ts`, build contract §5) because a pack is how a host
 * plugs a check in, and a pack must be authorable without depending on the apps
 * block. This file re-exports them so the floor's own modules read naturally,
 * and adds the one shape that belongs to the floor rather than to the contract:
 * the assembled layer.
 *
 * A check REPORTS; it never throws. What it reports is not advice: at the
 * commit path a `block` stops the write (`runtime.ts` — nothing is persisted on
 * create, and on edit the previous app is left in its row, still serving). A
 * `warn` rides along on an app that ships.
 */
import type { Check, CheckInput, Finding } from "@vendoai/core";

export type { Check, CheckInput, Finding };

export interface CheckingLayer {
  /** Every registered check, both kinds, built-ins first — what a boot report
   *  or a diagnostic names. */
  checks: Check[];
  /**
   * The judgment rules, one sentence per line, in registration order.
   *
   * Separate lines, never concatenated into one string: the reviewer appends
   * them to its rubric as its own list items, and a joined blob would read as a
   * single garbled rule.
   */
  rubric: string[];
  /** Run every FACT check. Judgment rules are not code and are not run here —
   *  they are {@link CheckingLayer.rubric}. */
  run(input: CheckInput): Promise<Finding[]>;
}
