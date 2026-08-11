/**
 * The aggregates in code-land (blueprint §5.4) — ONE implementation, shared
 * with `$expr`.
 *
 * Every function here builds an expression source and hands it to core's
 * PUBLIC, total {@link evaluateExpr}: `sum(rows, "amount_cents")` runs the
 * literally same code path a `.vendo` file's `sum(invoices.amount_cents)`
 * takes. There is no second `sum` in this repo, and adding one here would be
 * the §0 violation this file exists to prevent.
 *
 * (The blueprint's original instruction was to export `walkValue` /
 * `numbersOf` / `reduceNumbers` from core. Those three are module-private
 * arrows over a private `EvalState` that answer with a private
 * `EVAL_FAILED` symbol, so exporting them verbatim would leak core's internal
 * failure protocol into its public surface. Delegating to `evaluateExpr`
 * reaches the same code with none of that.)
 *
 * One posture, as everywhere in this package: the number, or `undefined`
 * (loading, and a mismatch, both). The reason is available by calling the
 * re-exported `evaluateExpr` directly.
 */

import {
  type Json,
} from "@vendoai/core";
import {
  evaluateExpr,
} from "@vendoai/apps/contract";

/** The root name the collection is bound to inside the built source. Ours, not
 *  the app author's, so it can never collide with a field name. */
const ROOT = "v";

/** The expression grammar's identifier (expr.ts's IDENTIFIER_START/CHAR over a
 *  dotted path). A field name that is not one cannot be interpolated into a
 *  source — that would let a field name carry syntax — so it is a mismatch,
 *  the same as a field the rows do not carry. */
const FIELD_PATH = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;

/** A field name as an expression-source literal, or `undefined` when it is not
 *  a bare dotted path — a name carrying a quote or a paren would let syntax ride
 *  in, so it is refused here, the same as a field the rows do not carry. This is
 *  the one place a field crosses into source text. */
const fieldLiteral = (field: string): string | undefined =>
  FIELD_PATH.test(field) ? `"${field}"` : undefined;

/**
 * THE ONE SEAM. Every aggregate below builds its source here, on the §5.2/§5.3
 * D2+D3 grammar `#808` landed: an aggregate takes the rows first and the field
 * as a quoted argument (`sum(v, "amount_cents")`), never the old field-implicit
 * `sum(v.amount_cents)`. `count` takes only the rows. If the grammar moves
 * again, this function and `groupBy`'s descriptor are the only places in this
 * package that change.
 */
const callSource = (call: string, field?: string): string | undefined => {
  if (field === undefined) return `${call}(${ROOT})`;
  const literal = fieldLiteral(field);
  return literal === undefined ? undefined : `${call}(${ROOT}, ${literal})`;
};

/** Loading (`undefined`) binds no root at all, which is exactly how
 *  `evaluateExpr` reads "the query has not arrived": `undefined` out. */
const bind = (value: Json | undefined): Record<string, Json> =>
  value === undefined ? {} : { [ROOT]: value };

const evaluate = (source: string | undefined, data: Record<string, Json>, now?: number): Json | undefined => {
  if (source === undefined) return undefined;
  const result = evaluateExpr(source, data, now === undefined ? {} : { now });
  return result.ok ? result.value : undefined;
};

const number = (value: Json | undefined): number | undefined => (typeof value === "number" ? value : undefined);

const reduce = (call: string, rows: Json | undefined, field: string): number | undefined =>
  number(evaluate(callSource(call, field), bind(rows)));

/** Total of a numeric column. Nulls in the column are sparse data, not a
 *  mismatch; a non-numeric value is a mismatch. */
export const sum = (rows: Json | undefined, field: string): number | undefined => reduce("sum", rows, field);

/** Mean of a numeric column; no values means no answer. */
export const average = (rows: Json | undefined, field: string): number | undefined => reduce("average", rows, field);

export const min = (rows: Json | undefined, field: string): number | undefined => reduce("min", rows, field);

export const max = (rows: Json | undefined, field: string): number | undefined => reduce("max", rows, field);

/** How many rows the list holds. */
export const count = (rows: Json | undefined): number | undefined =>
  number(evaluate(callSource("count"), bind(rows)));

/** `left - right`, through the same engine — so a screen that renders a
 *  delta and a `.vendo` screen that computes one cannot disagree. */
export const difference = (left: Json | undefined, right: Json | undefined): number | undefined => {
  if (left === undefined || right === undefined) return undefined;
  return number(evaluate("difference(a, b)", { a: left, b: right }));
};

/** Whole days from now (UTC day boundaries) to an ISO date string. `now` is
 *  injectable so a render is testable. */
export const daysUntil = (date: Json | undefined, options: { now?: number } = {}): number | undefined => {
  if (date === undefined) return undefined;
  return number(evaluate("days_until(d)", { d: date }, options.now));
};

/** The `group_by` bucket vocabulary — core's `EXPR_BUCKETS`. */
export type GroupByBucket = "day" | "month" | "year";

/** The calls `group_by` may aggregate a bucket with — core's GROUPABLE set. */
export type GroupByAggregate = "sum" | "average" | "min" | "max" | "count";

/** One bucket of a `groupBy`, ready for a Kit chart's `{ key, value }`. */
export interface GroupedPoint {
  key: string;
  value: number;
}

const isGroupedPoints = (value: Json | undefined): value is GroupedPoint[] =>
  Array.isArray(value)
  && value.every((point) =>
    typeof point === "object" && point !== null && !Array.isArray(point)
    && typeof (point as GroupedPoint).key === "string"
    && typeof (point as GroupedPoint).value === "number");

/**
 * Bucket rows by a date field and aggregate each bucket — the code-land shape
 * of the §5.2 D3 form `group_by(invoices, "issued_at", "month",
 * sum.of("amount_cents"))`. The fourth argument is a `<call>.of("field")`
 * descriptor (`count.of()` for count, which needs no field). `valueField` is
 * unused by (and unnecessary for) `count`.
 */
export const groupBy = (
  rows: Json | undefined,
  keyField: string,
  bucket: GroupByBucket,
  aggregate: GroupByAggregate,
  valueField?: string,
): GroupedPoint[] | undefined => {
  const key = fieldLiteral(keyField);
  if (key === undefined) return undefined;
  let descriptor: string;
  if (aggregate === "count") {
    descriptor = "count.of()";
  } else {
    const inner = valueField === undefined ? undefined : fieldLiteral(valueField);
    if (inner === undefined) return undefined;
    descriptor = `${aggregate}.of(${inner})`;
  }
  const value = evaluate(`group_by(${ROOT}, ${key}, "${bucket}", ${descriptor})`, bind(rows));
  return isGroupedPoints(value) ? value : undefined;
};
