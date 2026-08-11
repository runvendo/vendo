/**
 * The reshape vocabulary in code-land (blueprint §5.4).
 *
 * Nine one-liners over core's PUBLIC {@link applyReshape} — one per LIVE op.
 * The two deprecated ops (`asOptions`, `template`) are deliberately absent:
 * the Kit's own props replace them, and wrapping them here would teach a
 * dialect that is being retired.
 *
 * ONE POSTURE, everywhere in this package: you get the value, or `undefined`.
 * `undefined` in stays `undefined` out (loading is never a mismatch), and a
 * type mismatch degrades to `undefined` too — a code-land app must render a
 * placeholder, never throw. When an app wants the REASON, it calls the
 * re-exported `applyReshape` directly and reads `result.reason`; there is no
 * second result type in this package.
 */

import { applyReshape, type Json, type ReshapeOp, type ReshapeResult } from "@vendoai/core";

/** One step, through the one implementation. */
const step = (value: Json | undefined, op: ReshapeOp, args: string[]): ReshapeResult =>
  applyReshape(value, [{ op, args }]);

const projected = (result: ReshapeResult): Json | undefined => (result.ok ? result.value : undefined);

/** An aggregate answers with a number or it has no answer: core's `null`
 *  (min/max over no values) is "no answer" exactly as a mismatch is, so
 *  both arrive as `undefined` and the one posture holds. */
const reduced = (result: ReshapeResult): number | undefined =>
  result.ok && typeof result.value === "number" ? result.value : undefined;

/**
 * The nine live reshape ops, as functions. Shaped as one bundle for the same
 * reason `fmt` is: these are pure projections a code-land app reaches for by
 * name, and `reshape.sum` never collides with the `$expr` aggregate `sum`.
 */
export const reshape = {
  /** Keep only these fields (per row on an array, direct on an object). */
  pick: (value: Json | undefined, ...fields: string[]): Json | undefined =>
    projected(step(value, "pick", fields)),
  /** Rename fields, as old/new pairs. */
  rename: (value: Json | undefined, ...pairs: string[]): Json | undefined =>
    projected(step(value, "rename", pairs)),
  /** Rows → `{ label, value }` points, for the Kit's charts. */
  asPoints: (value: Json | undefined, labelField: string, valueField: string): Json | undefined =>
    projected(step(value, "asPoints", [labelField, valueField])),
  /** `format(value, kind)` on a SINGLE value — there is no row form: a table's
   *  money goes through the column's own `format` token so the rows stay
   *  numeric and `sortBy` still sorts. The kind vocabulary is core's and is
   *  checked there: an unknown kind is a mismatch, and `applyReshape` names the
   *  valid ones in its reason. */
  format: (value: Json | undefined, kind: string): Json | undefined =>
    projected(step(value, "format", [kind])),
  sum: (value: Json | undefined, field: string): number | undefined =>
    reduced(step(value, "sum", [field])),
  min: (value: Json | undefined, field: string): number | undefined =>
    reduced(step(value, "min", [field])),
  max: (value: Json | undefined, field: string): number | undefined =>
    reduced(step(value, "max", [field])),
  count: (value: Json | undefined): number | undefined => reduced(step(value, "count", [])),
};
