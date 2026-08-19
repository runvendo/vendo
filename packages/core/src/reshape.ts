import type { Json } from "./ids.js";
import { shapeAtPointer, type ShapeType } from "./shape.js";
import { defineOwn, isPlainObject } from "./genui/tree-node.js";

/**
 * v2 spec §3 (docs/superpowers/specs/2026-07-18-vendo-v2-format-spec.md) —
 * the bounded reshape vocabulary: a small, pure, non-Turing projection
 * language over a STORED binding's `$reshape` chain. Exactly the spec's
 * families: pick, field-rename, map (asPoints/asOptions), format, template
 * (bounded object→string interpolation for display slots), and aggregates.
 *
 * NOT MODEL-FACING ANY MORE. The wire dialect cannot write a reshape: a
 * `{...}` gap in a screen document is a JavaScript expression, and JavaScript
 * already picks, renames, maps and reduces — a second projection language the
 * model has to learn buys nothing. What survives is the CANONICAL TREE
 * feature: a stored document may carry a chain, and three consumers still read
 * one —
 * - `validateTree` gates the canonical form via {@link findInvalidReshape}
 *   (the vocabulary is enforceable at the format gate, not just at compile);
 * - the wire compiler flows tool shapes through {@link reshapeShape}
 *   (genui/wire/shape-check.ts) to type-check such bindings;
 * - the renderer evaluates {@link applyReshape} on resolved data — total and
 *   defensive, so a runtime mismatch becomes a contained data-shape notice,
 *   never a broken render;
 * plus the Kit's code-land `reshape.*` bundle (`@vendoai/ui`), which is a
 * published function surface an island calls, not a dialect.
 */

/** v2 spec §3 — one reshape step in a binding's `$reshape` chain. */
export interface ReshapeStep {
  op: ReshapeOp;
  args: string[];
}

/** v2 spec §3 — the closed op registry. FROZEN at this set (v3 spec §Dialect
 *  retirement): pressure for a new op = a missing Kit prop or an island case.
 *  Never add an op here. */
export const RESHAPE_OPS = [
  "pick",
  "rename",
  "asPoints",
  "asOptions", // @deprecated (W5a) — Kit Select/MultiSelect read raw rows via labelField/valueField
  "format",
  "template", // @deprecated (W5a) — Kit DataTable/CardList dot-path column keys reach nested scalars
  "sum",
  "min",
  "max",
  "count",
] as const;

/** v2 spec §3 */
export type ReshapeOp = (typeof RESHAPE_OPS)[number];

/** v2 spec §3 — chain-length cap: bounded and non-Turing by construction. */
export const RESHAPE_MAX_STEPS = 8;

/** format's closed kind vocabulary (deterministic en-US / USD / UTC), the same
 *  tokens as the Kit's `ValueFormat`. `money` pretty-prints the value AS IT
 *  STANDS: formatters never convert units, so a minor-unit (cents) field is
 *  divided by 100 in the expression that reads it. */
const FORMAT_KINDS = ["number", "money", "percent", "date"] as const;
type FormatKind = (typeof FORMAT_KINDS)[number];

/** `format` has no row form: stringifying a column left DataTable sorting
 *  strings, so a table's money is printed by the screen's own code and the data
 *  stays numeric. One message, both venues (validation and runtime). */
const FORMAT_SCALAR_ONLY =
  'reshape op "format" formats a single value; to format a table column, format it in the screen\'s own code — where the rows are prepared, or in the column\'s cell: (row) => row.amount.toLocaleString("en-US", { style: "currency", currency: "USD" }) — so the data stays numeric and sortBy works';

const OP_SET: ReadonlySet<string> = new Set(RESHAPE_OPS);
const FORMAT_KIND_SET: ReadonlySet<string> = new Set(FORMAT_KINDS);

/** The three that reduce a FIELD to a number; `count` is an aggregate too but
 *  takes no field, so it is not one of these. */
const AGGREGATE_OPS: ReadonlySet<ReshapeOp> = new Set(["sum", "min", "max"]);

/** Per-op arity: [min, max] (Infinity = unbounded). */
const OP_ARITY: Record<ReshapeOp, readonly [number, number]> = {
  pick: [1, Number.POSITIVE_INFINITY],
  rename: [2, Number.POSITIVE_INFINITY],
  asPoints: [2, 2],
  asOptions: [2, 2],
  format: [1, 1],
  template: [1, 2],
  sum: [1, 1],
  min: [1, 1],
  max: [1, 1],
  count: [0, 0],
};


/** The reductions {@link reduceNumeric} performs — the union of the stored
 *  `$reshape` aggregates and the `$expr` aggregate calls. */
export type NumericReduction = "sum" | "average" | "min" | "max";

/**
 * The ONE numeric reduce in the codebase (blueprint §5.4: never two
 * implementations of `sum`). Both aggregate surfaces call it: the `$expr`
 * aggregates (genui/expr.ts) and the stored-document `$reshape` aggregates
 * below. `null` means "no values to reduce" — the callers differ on what that
 * means (`$expr` reports an issue, `$reshape` yields null), and `sum` of
 * nothing is 0 for both.
 */
export const reduceNumeric = (call: NumericReduction, numbers: readonly number[]): number | null => {
  if (call === "sum") return numbers.reduce((total, value) => total + value, 0);
  if (numbers.length === 0) return null;
  if (call === "average") return numbers.reduce((total, value) => total + value, 0) / numbers.length;
  return call === "min" ? Math.min(...numbers) : Math.max(...numbers);
};

/** template's placeholder grammar: `{field}` or `{field.nested.path}` —
 *  identifier segments only (the wire's identifier grammar), resolved within
 *  the row/object the step runs on. */
const TEMPLATE_PLACEHOLDER = /\{([^{}]*)\}/g;
const TEMPLATE_PATH = /^[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*$/;

/** The dot-paths a template pattern references, or null when the pattern has
 *  no placeholders, a malformed one, or stray braces outside placeholders
 *  (the closed-grammar violation — a placeholder-free template would be
 *  hardcoded display data, and a leftover brace would re-render the exact
 *  raw-braces output this op exists to prevent). */
const templatePaths = (pattern: string): string[][] | null => {
  const paths: string[][] = [];
  for (const match of pattern.matchAll(TEMPLATE_PLACEHOLDER)) {
    const path = match[1] as string;
    if (!TEMPLATE_PATH.test(path)) return null;
    paths.push(path.split("."));
  }
  if (paths.length === 0) return null;
  const residue = pattern.replace(TEMPLATE_PLACEHOLDER, "");
  if (residue.includes("{") || residue.includes("}")) return null;
  return paths;
};

/** Validates ONE step's structure against the closed registry. Returns a
 *  violation message or null. */
const invalidStep = (value: unknown): string | null => {
  if (!isPlainObject(value)) return "each $reshape step must be an object";
  const { op, args } = value as { op?: unknown; args?: unknown };
  if (typeof op !== "string" || !OP_SET.has(op)) {
    return `"${String(op)}" is not a reshape op (known: ${RESHAPE_OPS.join(", ")})`;
  }
  if (!Array.isArray(args) || !args.every((arg) => typeof arg === "string")) {
    return `reshape op "${op}" args must be an array of strings`;
  }
  if (op === "format" && args.length !== 1) return FORMAT_SCALAR_ONLY;
  const [min, max] = OP_ARITY[op as ReshapeOp];
  if (args.length < min || args.length > max) {
    return `reshape op "${op}" takes ${min === max ? min : `${min}..${max === Number.POSITIVE_INFINITY ? "n" : max}`} args; got ${args.length}`;
  }
  if (op === "rename" && args.length % 2 !== 0) {
    return `reshape op "rename" takes old/new pairs; got ${args.length} args`;
  }
  if (op === "format" && !FORMAT_KIND_SET.has(args[0] as string)) {
    return `reshape op "format" kind must be one of ${FORMAT_KINDS.join(", ")}`;
  }
  if (op === "template" && templatePaths(args[args.length - 1] as string) === null) {
    return 'reshape op "template" pattern must contain {field} or {field.nested} placeholders';
  }
  return null;
};

/** v2 spec §3 — validate a `$reshape` chain. Null when valid. */
export const findInvalidReshapeSteps = (steps: unknown): string | null => {
  if (!Array.isArray(steps)) return "$reshape must be an array of steps";
  if (steps.length > RESHAPE_MAX_STEPS) {
    return `$reshape chains are capped at ${RESHAPE_MAX_STEPS} steps`;
  }
  for (const entry of steps) {
    const violation = invalidStep(entry);
    if (violation !== null) return violation;
  }
  return null;
};

/**
 * v2 spec §3 — deep-walk a props value for `$reshape` members and validate
 * every chain against the closed vocabulary (the validateTree gate; same
 * walk discipline as fn-references' findInvalidActionReference). Returns the
 * first violation message, or null.
 */
export function findInvalidReshape(value: unknown): string | null {
  if (Array.isArray(value)) {
    for (const item of value) {
      const violation = findInvalidReshape(item);
      if (violation !== null) return violation;
    }
    return null;
  }
  if (!isPlainObject(value)) return null;
  if (Object.prototype.hasOwnProperty.call(value, "$reshape")) {
    const violation = findInvalidReshapeSteps((value as { $reshape: unknown }).$reshape);
    if (violation !== null) return violation;
  }
  for (const child of Object.values(value)) {
    const violation = findInvalidReshape(child);
    if (violation !== null) return violation;
  }
  return null;
}

/** v2 spec §3 — the total runtime evaluation result. `ok: false` is the
 *  contained data-shape-notice path, never a throw. */
export type ReshapeResult =
  | { ok: true; value: Json | undefined }
  | { ok: false; reason: string };

const mismatch = (reason: string): ReshapeResult => ({ ok: false, reason });

const isRowArray = (value: unknown): value is Record<string, unknown>[] =>
  Array.isArray(value) && value.every(isPlainObject);

/** A field is "applicable" when at least one row carries it (optional fields
 *  are real); a field absent from EVERY non-empty row is the mislabeled-field
 *  mismatch the notice exists for. */
const fieldPresent = (rows: readonly Record<string, unknown>[], field: string): boolean =>
  rows.length === 0 || rows.some((row) => Object.prototype.hasOwnProperty.call(row, field));

const pickFields = (row: Record<string, unknown>, fields: readonly string[]): Record<string, unknown> => {
  const picked: Record<string, unknown> = {};
  for (const field of fields) {
    if (Object.prototype.hasOwnProperty.call(row, field)) defineOwn(picked, field, row[field]);
  }
  return picked;
};

const renameFields = (row: Record<string, unknown>, pairs: readonly string[]): Record<string, unknown> => {
  const renames = new Map<string, string>();
  for (let i = 0; i < pairs.length; i += 2) renames.set(pairs[i] as string, pairs[i + 1] as string);
  const renamed: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    defineOwn(renamed, renames.get(key) ?? key, value);
  }
  return renamed;
};

const MONEY_FORMAT = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const NUMBER_FORMAT = new Intl.NumberFormat("en-US", { maximumFractionDigits: 6 });
const PERCENT_FORMAT = new Intl.NumberFormat("en-US", { style: "percent", maximumFractionDigits: 2 });
const DATE_FORMAT = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});

const formatScalar = (value: unknown, kind: FormatKind): string | null => {
  if (kind === "date") {
    if (typeof value !== "string" && typeof value !== "number") return null;
    const time = typeof value === "number" ? value : Date.parse(value);
    if (!Number.isFinite(time)) return null;
    return DATE_FORMAT.format(new Date(time));
  }
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  if (kind === "money") return MONEY_FORMAT.format(value);
  if (kind === "percent") return PERCENT_FORMAT.format(value);
  return NUMBER_FORMAT.format(value);
};

const applyAggregate = (op: ReshapeOp, rows: readonly Record<string, unknown>[], field: string): ReshapeResult => {
  const values: number[] = [];
  for (const row of rows) {
    if (!Object.prototype.hasOwnProperty.call(row, field)) continue;
    const value = row[field];
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return mismatch(`aggregate "${op}" needs numeric "${field}" values`);
    }
    values.push(value);
  }
  if (rows.length > 0 && values.length === 0) {
    return mismatch(`field "${field}" is absent from the rows`);
  }
  return { ok: true, value: reduceNumeric(op as NumericReduction, values) };
};

const applyAsPoints = (value: Json, args: readonly string[]): ReshapeResult => {
  const [labelField, valueField] = args as [string, string];
  if (!isRowArray(value)) return mismatch("asPoints needs an array of rows");
  // Strict per-row: a chart silently missing rows IS the broken-chart
  // class, so any row lacking either axis field is a mismatch (an absent
  // key signals mis-binding; sparse data carries explicit nulls, which
  // still plot). pick/rename stay lenient — they are projections, not axes.
  const missing = [labelField, valueField]
    .filter((field) => value.some((row) => !Object.prototype.hasOwnProperty.call(row, field)));
  if (missing.length > 0) {
    return mismatch(`asPoints fields ${missing.map((field) => `"${field}"`).join(", ")} are absent from one or more rows`);
  }
  return { ok: true, value: value.map((row) => ({ label: row[labelField], value: row[valueField] })) };
};

const applyAsOptions = (value: Json, args: readonly string[]): ReshapeResult => {
  const [valueField, labelField] = args as [string, string];
  if (!isRowArray(value)) return mismatch("asOptions needs an array of rows");
  // Strict per-row (mirrors asPoints): a Select silently missing an option's
  // value or label IS the blank-option class, so any row lacking either
  // field is a mismatch — an absent key signals mis-binding.
  const missing = [valueField, labelField]
    .filter((field) => value.some((row) => !Object.prototype.hasOwnProperty.call(row, field)));
  if (missing.length > 0) {
    return mismatch(`asOptions fields ${missing.map((field) => `"${field}"`).join(", ")} are absent from one or more rows`);
  }
  return { ok: true, value: value.map((row) => ({ value: row[valueField], label: row[labelField] })) };
};

const resolveTemplatePath = (row: Record<string, unknown>, path: readonly string[]): unknown => {
  let current: unknown = row;
  for (const segment of path) {
    if (!isPlainObject(current)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
};

/** Interpolate one row/object; a placeholder resolving to an object or
 *  array is the raw-braces class the op exists to prevent — a mismatch,
 *  never a stringified object. */
const renderTemplate = (pattern: string, row: Record<string, unknown>): { text: string } | { bad: string } => {
  let bad: string | null = null;
  const text = pattern.replace(TEMPLATE_PLACEHOLDER, (whole, raw: string) => {
    const resolved = resolveTemplatePath(row, raw.split("."));
    if (resolved === null || resolved === undefined) return "";
    if (typeof resolved === "object") {
      bad ??= whole;
      return "";
    }
    return String(resolved);
  });
  return bad === null ? { text } : { bad };
};

const nonScalarTemplate = (bad: string): ReshapeResult =>
  mismatch(`template placeholder ${bad} does not resolve to a scalar — reference a nested field (e.g. ${bad.slice(0, -1)}.name})`);

const applyTemplate = (value: Json, args: readonly string[]): ReshapeResult => {
  const pattern = args[args.length - 1] as string;
  const paths = templatePaths(pattern) ?? [];
  const roots = [...new Set(paths.map((path) => path[0] as string))];
  const absentFrom = (record: Record<string, unknown>): string[] =>
    roots.filter((root) => !Object.prototype.hasOwnProperty.call(record, root));
  if (args.length === 1) {
    if (!isPlainObject(value)) {
      return mismatch("template(pattern) needs a bare object; over rows use template(field, pattern)");
    }
    const record = value as Record<string, unknown>;
    const absent = absentFrom(record);
    if (absent.length > 0) {
      return mismatch(`template placeholders reference ${absent.map((root) => `"${root}"`).join(", ")}, absent`);
    }
    const rendered = renderTemplate(pattern, record);
    return "bad" in rendered ? nonScalarTemplate(rendered.bad) : { ok: true, value: rendered.text };
  }
  const field = args[0] as string;
  const templateRow = (row: Record<string, unknown>): ReshapeResult => {
    const rendered = renderTemplate(pattern, row);
    if ("bad" in rendered) return nonScalarTemplate(rendered.bad);
    const next = { ...row };
    defineOwn(next, field, rendered.text);
    return { ok: true, value: next as Json };
  };
  if (isRowArray(value)) {
    const absent = roots.filter((root) => !fieldPresent(value, root));
    if (absent.length > 0) {
      return mismatch(`template placeholders reference ${absent.map((root) => `"${root}"`).join(", ")}, absent from the rows`);
    }
    const out: Json[] = [];
    for (const row of value) {
      const result = templateRow(row);
      if (!result.ok) return result;
      out.push(result.value as Json);
    }
    return { ok: true, value: out };
  }
  if (isPlainObject(value)) {
    const record = value as Record<string, unknown>;
    const absent = absentFrom(record);
    if (absent.length > 0) {
      return mismatch(`template placeholders reference ${absent.map((root) => `"${root}"`).join(", ")}, absent`);
    }
    return templateRow(record);
  }
  return mismatch("template needs an object or an array of rows");
};

const applyFormat = (value: Json, args: readonly string[]): ReshapeResult => {
  if (Array.isArray(value)) return mismatch(FORMAT_SCALAR_ONLY);
  const kind = args[0] as FormatKind;
  const formatted = formatScalar(value, kind);
  return formatted === null
    ? mismatch(`format "${kind}" cannot format this value`)
    : { ok: true, value: formatted };
};

// pick / rename — per-row on arrays, direct on objects.
const applyPickRename = (op: ReshapeOp, value: Json, args: readonly string[]): ReshapeResult => {
  const perRow = op === "pick"
    ? (row: Record<string, unknown>) => pickFields(row, args)
    : (row: Record<string, unknown>) => renameFields(row, args);
  const referenced = op === "pick" ? args : args.filter((_, index) => index % 2 === 0);
  if (isRowArray(value)) {
    const missing = referenced.filter((field) => !fieldPresent(value, field));
    if (missing.length > 0) {
      return mismatch(`${op} fields ${missing.map((field) => `"${field}"`).join(", ")} are absent from the rows`);
    }
    return { ok: true, value: value.map(perRow) };
  }
  if (isPlainObject(value)) {
    const record = value as Record<string, unknown>;
    const missing = referenced.filter((field) => !Object.prototype.hasOwnProperty.call(record, field));
    if (missing.length > 0) {
      return mismatch(`${op} fields ${missing.map((field) => `"${field}"`).join(", ")} are absent`);
    }
    return { ok: true, value: perRow(record) };
  }
  return mismatch(`${op} needs an object or an array of rows`);
};

const applyStep = (value: Json, step: ReshapeStep): ReshapeResult => {
  const { op, args } = step;
  if (op === "count") {
    if (!Array.isArray(value)) return mismatch("count needs an array");
    return { ok: true, value: value.length };
  }
  if (AGGREGATE_OPS.has(op)) {
    if (!isRowArray(value)) return mismatch(`aggregate "${op}" needs an array of rows`);
    return applyAggregate(op, value, args[0] as string);
  }
  if (op === "asPoints") return applyAsPoints(value, args);
  if (op === "asOptions") return applyAsOptions(value, args);
  if (op === "template") return applyTemplate(value, args);
  if (op === "format") return applyFormat(value, args);
  return applyPickRename(op, value, args);
};

/**
 * v2 spec §3 — evaluate a `$reshape` chain on resolved binding data. Total
 * and defensive: `undefined` in ⇒ ok/`undefined` out (loading is not a
 * mismatch); a type mismatch returns `ok: false` with a reason — the
 * renderer's contained data-shape notice — and never throws.
 */
export function applyReshape(value: Json | undefined, steps: readonly ReshapeStep[]): ReshapeResult {
  try {
    const violation = findInvalidReshapeSteps(steps);
    if (violation !== null) return mismatch(violation);
    if (value === undefined) return { ok: true, value: undefined };
    let current: Json = value;
    for (const step of steps) {
      const result = applyStep(current, step);
      if (!result.ok) return result;
      current = result.value as Json;
    }
    return { ok: true, value: current };
  } catch (error) {
    return mismatch(`reshape failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** v2 spec §3 — a compile-time shape violation, with the missing/available
 *  field lists the per-binding repair prompt needs. */
export interface ReshapeShapeError {
  message: string;
  missing?: string[];
  available?: string[];
}

/** v2 spec §3 — the result of flowing a shape through one step. */
export type ReshapeShapeResult =
  | { ok: true; shape: ShapeType }
  | { ok: false; error: ReshapeShapeError };

const JSON_SHAPE: ShapeType = { kind: "json" };
const NUMBER_SHAPE: ShapeType = { kind: "number" };
const STRING_SHAPE: ShapeType = { kind: "string" };

const shapeError = (message: string, missing?: string[], available?: string[]): ReshapeShapeResult => ({
  ok: false,
  error: {
    message,
    ...(missing === undefined ? {} : { missing }),
    ...(available === undefined ? {} : { available }),
  },
});

interface RowsView {
  /** The object shape the op's fields check against (array items or the
   *  object itself); null when the region is unknown (`json`). */
  fields: Record<string, ShapeType> | null;
  optional: ReadonlySet<string>;
  /** Rebuild the container around a transformed object shape. */
  rebuild: (object: ShapeType) => ShapeType;
  isArray: boolean;
}

/** Views the op's working surface: an array of rows, a bare object, or an
 *  unknown region. Scalars return null (the op cannot apply). */
const viewRows = (shape: ShapeType, op: ReshapeOp): RowsView | null => {
  if (shape.kind === "json") {
    return { fields: null, optional: new Set(), rebuild: () => JSON_SHAPE, isArray: true };
  }
  if (shape.kind === "array") {
    const items = shape.items;
    if (items.kind === "json") {
      return { fields: null, optional: new Set(), rebuild: () => shape, isArray: true };
    }
    if (items.kind !== "object") return null;
    return {
      fields: items.fields,
      optional: new Set(items.optional ?? []),
      rebuild: (object) => ({ kind: "array", items: object }),
      isArray: true,
    };
  }
  if (shape.kind === "object" && !AGGREGATE_OPS.has(op) && op !== "asPoints" && op !== "asOptions") {
    return {
      fields: shape.fields,
      optional: new Set(shape.optional ?? []),
      rebuild: (object) => object,
      isArray: false,
    };
  }
  return null;
};

const missingFields = (fields: Record<string, ShapeType>, referenced: readonly string[]): string[] =>
  referenced.filter((field) => !Object.prototype.hasOwnProperty.call(fields, field));

const checkedFields = (
  view: RowsView,
  referenced: readonly string[],
  op: ReshapeOp,
): ReshapeShapeResult | null => {
  if (view.fields === null) return null; // unknown region — defensive pass
  const missing = missingFields(view.fields, referenced);
  if (missing.length > 0) {
    return shapeError(
      `${op} references ${missing.map((field) => `"${field}"`).join(", ")}, absent from the response shape`,
      missing,
      Object.keys(view.fields),
    );
  }
  return null;
};

const objectShape = (fields: Record<string, ShapeType>, optional: readonly string[]): ShapeType =>
  optional.length > 0 ? { kind: "object", fields, optional: [...optional] } : { kind: "object", fields };

/** Walks each placeholder path through the row/object shape: an absent
 *  root is the repair-carrying miss; an object/array leaf is the
 *  raw-braces class caught at compile. `json` regions stay defensive. */
const placeholderMiss = (owner: ShapeType, paths: readonly string[][]): ReshapeShapeResult | null => {
  for (const path of paths) {
    const at = shapeAtPointer(owner, `/${path.join("/")}`);
    if (at === undefined) {
      return shapeError(
        `template placeholder "{${path.join(".")}}" is absent from the response shape`,
        [path[0] as string],
        owner.kind === "object" ? Object.keys(owner.fields) : undefined,
      );
    }
    if (at.kind === "object" || at.kind === "array") {
      return shapeError(`template placeholder "{${path.join(".")}}" is an ${at.kind}, not a scalar — reference a nested field (e.g. {${path.join(".")}.name})`);
    }
  }
  return null;
};

const templateShape = (shape: ShapeType, args: readonly string[]): ReshapeShapeResult => {
  const paths = templatePaths(args[args.length - 1] as string) ?? [];
  if (args.length === 1) {
    if (shape.kind === "json") return { ok: true, shape: STRING_SHAPE };
    if (shape.kind !== "object") {
      return shapeError(`template(pattern) needs a bare object; over rows use template(field, pattern); the response shape is ${shape.kind}`);
    }
    return placeholderMiss(shape, paths) ?? { ok: true, shape: STRING_SHAPE };
  }
  const view = viewRows(shape, "template");
  if (view === null) return shapeError(`template needs an object or an array of rows; the response shape is ${shape.kind}`);
  if (view.fields === null) return { ok: true, shape: view.rebuild(JSON_SHAPE) };
  const violation = placeholderMiss(objectShape(view.fields, [...view.optional]), paths);
  if (violation !== null) return violation;
  const target = args[0] as string;
  const fields: Record<string, ShapeType> = {};
  for (const [key, value] of Object.entries(view.fields)) {
    defineOwn(fields, key, key === target ? STRING_SHAPE : value);
  }
  if (!Object.prototype.hasOwnProperty.call(fields, target)) {
    defineOwn(fields, target, STRING_SHAPE);
  }
  // The target field is always written, so it leaves the optional set.
  return { ok: true, shape: view.rebuild(objectShape(fields, [...view.optional].filter((key) => key !== target))) };
};

const aggregateShape = (view: RowsView, op: ReshapeOp, args: readonly string[]): ReshapeShapeResult => {
  const field = args[0] as string;
  const violation = checkedFields(view, [field], op);
  if (violation !== null) return violation;
  if (view.fields !== null) {
    const fieldShape = view.fields[field] as ShapeType;
    if (fieldShape.kind !== "number" && fieldShape.kind !== "json") {
      return shapeError(
        `aggregate "${op}" needs numeric "${field}" values; the response shape has ${fieldShape.kind}`,
        undefined,
        Object.keys(view.fields),
      );
    }
  }
  return { ok: true, shape: NUMBER_SHAPE };
};

const asPointsShape = (view: RowsView, args: readonly string[]): ReshapeShapeResult => {
  const [labelField, valueField] = args as [string, string];
  const violation = checkedFields(view, [labelField, valueField], "asPoints");
  if (violation !== null) return violation;
  const labelShape = view.fields === null ? JSON_SHAPE : view.fields[labelField] as ShapeType;
  const valueShape = view.fields === null ? JSON_SHAPE : view.fields[valueField] as ShapeType;
  return {
    ok: true,
    shape: { kind: "array", items: { kind: "object", fields: { label: labelShape, value: valueShape } } },
  };
};

const asOptionsShape = (view: RowsView, args: readonly string[]): ReshapeShapeResult => {
  const [valueField, labelField] = args as [string, string];
  const violation = checkedFields(view, [valueField, labelField], "asOptions");
  if (violation !== null) return violation;
  const valueShape = view.fields === null ? JSON_SHAPE : view.fields[valueField] as ShapeType;
  const labelShape = view.fields === null ? JSON_SHAPE : view.fields[labelField] as ShapeType;
  return {
    ok: true,
    shape: { kind: "array", items: { kind: "object", fields: { value: valueShape, label: labelShape } } },
  };
};

const pickRenameShape = (
  view: RowsView,
  shape: ShapeType,
  op: ReshapeOp,
  args: readonly string[],
): ReshapeShapeResult => {
  const referenced = op === "pick" ? args : args.filter((_, index) => index % 2 === 0);
  const violation = checkedFields(view, referenced, op);
  if (violation !== null) return violation;
  if (view.fields === null) {
    return { ok: true, shape: view.isArray && shape.kind === "array" ? shape : JSON_SHAPE };
  }
  if (op === "pick") {
    const fields: Record<string, ShapeType> = {};
    for (const field of args) defineOwn(fields, field, view.fields[field] as ShapeType);
    return {
      ok: true,
      shape: view.rebuild(objectShape(fields, args.filter((field) => view.optional.has(field)))),
    };
  }
  const renames = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) renames.set(args[i] as string, args[i + 1] as string);
  const fields: Record<string, ShapeType> = {};
  const optional: string[] = [];
  for (const [key, value] of Object.entries(view.fields)) {
    const nextKey = renames.get(key) ?? key;
    defineOwn(fields, nextKey, value);
    if (view.optional.has(key)) optional.push(nextKey);
  }
  return { ok: true, shape: view.rebuild(objectShape(fields, optional)) };
};

/**
 * v2 spec §3 — flow a response shape through one reshape step (the wire
 * compiler's binding type-check). `json` regions stay defensive (no error);
 * a known-shape violation returns the typed error with missing/available
 * fields for the per-binding repair prompt.
 */
export function reshapeShape(shape: ShapeType, step: ReshapeStep): ReshapeShapeResult {
  const structural = invalidStep(step);
  if (structural !== null) return shapeError(structural);
  const { op, args } = step;

  if (op === "count") {
    if (shape.kind !== "json" && shape.kind !== "array") return shapeError("count needs an array");
    return { ok: true, shape: NUMBER_SHAPE };
  }

  if (op === "format") {
    const kind = args[0] as FormatKind;
    if (shape.kind === "array") return shapeError(FORMAT_SCALAR_ONLY);
    const formattable = shape.kind === "json"
      || (kind === "date" ? shape.kind === "string" || shape.kind === "number" : shape.kind === "number");
    if (!formattable) return shapeError(`format "${kind}" cannot format a ${shape.kind} value`);
    return { ok: true, shape: STRING_SHAPE };
  }

  if (op === "template") return templateShape(shape, args);

  const view = viewRows(shape, op);
  if (view === null) {
    return shapeError(`${op} needs ${AGGREGATE_OPS.has(op) || op === "asPoints" || op === "asOptions" ? "an array of rows" : "an object or an array of rows"}; the response shape is ${shape.kind}`);
  }

  if (AGGREGATE_OPS.has(op)) return aggregateShape(view, op, args);
  if (op === "asPoints") return asPointsShape(view, args);
  if (op === "asOptions") return asOptionsShape(view, args);
  // pick / rename
  return pickRenameShape(view, shape, op, args);
}
