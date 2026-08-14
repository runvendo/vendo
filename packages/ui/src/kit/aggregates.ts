/**
 * The aggregates in code-land — the handful of reductions an island reaches for
 * by name, over core's ONE numeric reduce ({@link reduceNumeric}).
 *
 * They no longer build expression SOURCE and hand it to an evaluator. They
 * used to, because `$expr` was a closed dialect with its own `sum` and the rule
 * was that this repo may hold only one. A `{...}` gap is JavaScript now, so
 * `sum(rows, "amount_cents")` here and
 * `rows.reduce((t, r) => t + r.amount_cents, 0)` in a screen are the same
 * language reaching the same arithmetic — there is no second implementation to
 * avoid, only a second copy of the REDUCE, and that still lives in core.
 *
 * One posture, as everywhere in this package: the number (or the points), or
 * `undefined` — loading and a mismatch both. An island renders a placeholder,
 * never a throw.
 */

import {
  reduceNumeric,
  type Json,
  type NumericReduction,
} from "@vendoai/core";
import { readField } from "./row.js";

const isRow = (value: unknown): value is Record<string, Json> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const rowsOf = (value: Json | undefined): Record<string, Json>[] | undefined =>
  Array.isArray(value) ? value.filter(isRow) : undefined;

/** The column, as numbers. Rows carrying an explicit null are sparse data, not
 *  a mismatch, so they are skipped; a non-numeric value IS a mismatch, and the
 *  whole answer degrades to `undefined` rather than to a wrong number. An ABSENT
 *  field is a mismatch too: skipping it made `sum(rows, "nope")` answer 0, a
 *  wrong number that reads as real. */
const column = (rows: readonly Record<string, Json>[], field: string): number[] | undefined => {
  const numbers: number[] = [];
  for (const row of rows) {
    // The ONE resolver, the same one every `field` prop and every column key
    // reads a dotted path with — a nested numeric field reduces too.
    const value = readField(row, field);
    if (value === null) continue;
    if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
    numbers.push(value);
  }
  return numbers;
};

const reduce = (call: NumericReduction, value: Json | undefined, field: string): number | undefined => {
  const rows = rowsOf(value);
  if (rows === undefined) return undefined;
  const numbers = column(rows, field);
  if (numbers === undefined) return undefined;
  return reduceNumeric(call, numbers) ?? undefined;
};

/** Total of a numeric column. */
export const sum = (rows: Json | undefined, field: string): number | undefined => reduce("sum", rows, field);

/** Mean of a numeric column; no values means no answer. */
export const average = (rows: Json | undefined, field: string): number | undefined => reduce("average", rows, field);

export const min = (rows: Json | undefined, field: string): number | undefined => reduce("min", rows, field);

export const max = (rows: Json | undefined, field: string): number | undefined => reduce("max", rows, field);

/** How many rows the list holds. */
export const count = (rows: Json | undefined): number | undefined =>
  Array.isArray(rows) ? rows.length : undefined;

/** `left - right`, with either side absent meaning no answer. */
export const difference = (left: Json | undefined, right: Json | undefined): number | undefined =>
  typeof left === "number" && typeof right === "number" && Number.isFinite(left) && Number.isFinite(right)
    ? left - right
    : undefined;

const DAY_MS = 86_400_000;

/** Whole days from now (UTC day boundaries) to an ISO date string. `now` is
 *  injectable so a render is testable — the ONE clock read in this module, and
 *  the reason it is a parameter rather than an ambient call. */
export const daysUntil = (date: Json | undefined, options: { now?: number } = {}): number | undefined => {
  if (typeof date !== "string") return undefined;
  const time = Date.parse(date);
  if (!Number.isFinite(time)) return undefined;
  return Math.floor(time / DAY_MS) - Math.floor((options.now ?? Date.now()) / DAY_MS);
};

/** The buckets {@link groupBy} can cut a date field into. */
export type GroupByBucket = "day" | "month" | "year";

/** The reductions {@link groupBy} can aggregate a bucket with. */
export type GroupByAggregate = NumericReduction | "count";

/** One bucket of a {@link groupBy}, ready for a Kit chart's `{ key, value }`. */
export interface GroupedPoint {
  key: string;
  value: number;
}

/** The bucket key of one date value: ISO date strings only. An epoch-ms number
 *  read as a date is how a numeric field silently buckets into 1970 instead of
 *  saying it is not a date. */
const bucketKey = (value: unknown, bucket: GroupByBucket): string | null => {
  if (typeof value !== "string") return null;
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return null;
  const iso = new Date(time).toISOString();
  return bucket === "year" ? iso.slice(0, 4) : bucket === "month" ? iso.slice(0, 7) : iso.slice(0, 10);
};

/**
 * Bucket rows by a date field and aggregate each bucket, oldest bucket first.
 * `valueField` is unused by (and unnecessary for) `count`.
 */
export const groupBy = (
  rows: Json | undefined,
  keyField: string,
  bucket: GroupByBucket,
  aggregate: GroupByAggregate,
  valueField?: string,
): GroupedPoint[] | undefined => {
  const source = rowsOf(rows);
  if (source === undefined) return undefined;
  if (aggregate !== "count" && valueField === undefined) return undefined;
  const groups = new Map<string, Record<string, Json>[]>();
  for (const row of source) {
    const key = bucketKey(readField(row, keyField), bucket);
    if (key === null) return undefined;
    const existing = groups.get(key);
    if (existing === undefined) groups.set(key, [row]);
    else existing.push(row);
  }
  const points: GroupedPoint[] = [];
  for (const [key, bucketRows] of [...groups].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (aggregate === "count") {
      points.push({ key, value: bucketRows.length });
      continue;
    }
    const value = reduce(aggregate, bucketRows, valueField as string);
    if (value === undefined) return undefined;
    points.push({ key, value });
  }
  return points;
};
