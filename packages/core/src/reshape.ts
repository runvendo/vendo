import type { Json } from "./ids.js";
import { shapeAtPointer, type ShapeType } from "./shape.js";
import { isPlainObject } from "./tree.js";

/**
 * v2 spec §3 (docs/superpowers/specs/2026-07-18-vendo-v2-format-spec.md) —
 * the bounded reshape vocabulary: a small, pure, non-Turing projection
 * language that lets the model adapt `{ month, revenue }` to
 * `{ label, value }` WITHOUT a code island. Exactly the spec's families:
 * pick, field-rename, map (asPoints/asOptions), format, template (bounded
 * object→string interpolation for display slots), and aggregates.
 *
 * Three consumers share this module:
 * - `validateTreeV2` gates the canonical form via {@link findInvalidReshape}
 *   (the vocabulary is enforceable at the format gate, not just at compile);
 * - the wire compiler flows tool shapes through {@link reshapeShape}
 *   (wire-v2/shape-check.ts) to type-check bindings against shape cards;
 * - the renderer evaluates {@link applyReshape} on resolved data — total and
 *   defensive, so a runtime mismatch becomes a contained data-shape notice,
 *   never a broken render.
 */

/** v2 spec §3 — one reshape step in a binding's `$reshape` chain. */
export interface ReshapeStep {
  op: ReshapeOp;
  args: string[];
}

/** v2 spec §3 — the closed op registry. */
export const RESHAPE_OPS = [
  "pick",
  "rename",
  "asPoints",
  "asOptions",
  "format",
  "template",
  "sum",
  "avg",
  "min",
  "max",
  "count",
] as const;

/** v2 spec §3 */
export type ReshapeOp = (typeof RESHAPE_OPS)[number];

/** v2 spec §3 — chain-length cap: bounded and non-Turing by construction. */
export const RESHAPE_MAX_STEPS = 8;

/** format's closed kind vocabulary (deterministic en-US / USD / UTC). */
const FORMAT_KINDS = ["number", "currency", "currencyCents", "percent", "date"] as const;
type FormatKind = (typeof FORMAT_KINDS)[number];

const OP_SET: ReadonlySet<string> = new Set(RESHAPE_OPS);
const FORMAT_KIND_SET: ReadonlySet<string> = new Set(FORMAT_KINDS);

/** Per-op arity: [min, max] (Infinity = unbounded). */
const OP_ARITY: Record<ReshapeOp, readonly [number, number]> = {
  pick: [1, Number.POSITIVE_INFINITY],
  rename: [2, Number.POSITIVE_INFINITY],
  asPoints: [2, 2],
  asOptions: [2, 2],
  format: [1, 2],
  template: [1, 2],
  sum: [1, 1],
  avg: [1, 1],
  min: [1, 1],
  max: [1, 1],
  count: [0, 0],
};

const AGGREGATE_OPS: ReadonlySet<ReshapeOp> = new Set(["sum", "avg", "min", "max"]);

/** template's placeholder grammar: `{field}` or `{field.nested.path}` —
 *  identifier segments only (the wire's identifier grammar), resolved within
 *  the row/object the step runs on. */
const TEMPLATE_PLACEHOLDER = /\{([^{}]*)\}/g;
const TEMPLATE_PATH = /^[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*$/;

/** The dot-paths a template pattern references, or null when the pattern has
 *  no placeholders or a malformed one (the closed-grammar violation — a
 *  placeholder-free template would be hardcoded display data). */
const templatePaths = (pattern: string): string[][] | null => {
  const paths: string[][] = [];
  for (const match of pattern.matchAll(TEMPLATE_PLACEHOLDER)) {
    const path = match[1] as string;
    if (!TEMPLATE_PATH.test(path)) return null;
    paths.push(path.split("."));
  }
  return paths.length === 0 ? null : paths;
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
  const [min, max] = OP_ARITY[op as ReshapeOp];
  if (args.length < min || args.length > max) {
    return `reshape op "${op}" takes ${min === max ? min : `${min}..${max === Number.POSITIVE_INFINITY ? "n" : max}`} args; got ${args.length}`;
  }
  if (op === "rename" && args.length % 2 !== 0) {
    return `reshape op "rename" takes old/new pairs; got ${args.length} args`;
  }
  if (op === "format" && !FORMAT_KIND_SET.has(args[args.length - 1] as string)) {
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
 * every chain against the closed vocabulary (the validateTreeV2 gate; same
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

const defineValue = (record: Record<string, unknown>, key: string, value: unknown): void => {
  Object.defineProperty(record, key, { value, enumerable: true, writable: true, configurable: true });
};

const pickFields = (row: Record<string, unknown>, fields: readonly string[]): Record<string, unknown> => {
  const picked: Record<string, unknown> = {};
  for (const field of fields) {
    if (Object.prototype.hasOwnProperty.call(row, field)) defineValue(picked, field, row[field]);
  }
  return picked;
};

const renameFields = (row: Record<string, unknown>, pairs: readonly string[]): Record<string, unknown> => {
  const renames = new Map<string, string>();
  for (let i = 0; i < pairs.length; i += 2) renames.set(pairs[i] as string, pairs[i + 1] as string);
  const renamed: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    defineValue(renamed, renames.get(key) ?? key, value);
  }
  return renamed;
};

const CURRENCY_FORMAT = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
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
  if (kind === "currency") return CURRENCY_FORMAT.format(value);
  // Host money fields are integer minor units (cents); scale to major units.
  if (kind === "currencyCents") return CURRENCY_FORMAT.format(value / 100);
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
  if (op === "sum") return { ok: true, value: values.reduce((total, value) => total + value, 0) };
  if (values.length === 0) return { ok: true, value: null };
  if (op === "avg") return { ok: true, value: values.reduce((total, value) => total + value, 0) / values.length };
  if (op === "min") return { ok: true, value: Math.min(...values) };
  return { ok: true, value: Math.max(...values) };
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
  if (op === "asPoints") {
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
  }
  if (op === "asOptions") {
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
  }
  if (op === "template") {
    const pattern = args[args.length - 1] as string;
    const paths = templatePaths(pattern) ?? [];
    const resolvePath = (row: Record<string, unknown>, path: readonly string[]): unknown => {
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
    const render = (row: Record<string, unknown>): { text: string } | { bad: string } => {
      let bad: string | null = null;
      const text = pattern.replace(TEMPLATE_PLACEHOLDER, (whole, raw: string) => {
        const resolved = resolvePath(row, raw.split("."));
        if (resolved === null || resolved === undefined) return "";
        if (typeof resolved === "object") {
          bad ??= whole;
          return "";
        }
        return String(resolved);
      });
      return bad === null ? { text } : { bad };
    };
    const nonScalar = (bad: string): ReshapeResult =>
      mismatch(`template placeholder ${bad} does not resolve to a scalar — reference a nested field (e.g. ${bad.slice(0, -1)}.name})`);
    if (args.length === 1) {
      if (!isPlainObject(value)) {
        return mismatch("template(pattern) needs a bare object; over rows use template(field, pattern)");
      }
      const rendered = render(value as Record<string, unknown>);
      return "bad" in rendered ? nonScalar(rendered.bad) : { ok: true, value: rendered.text };
    }
    const field = args[0] as string;
    const roots = [...new Set(paths.map((path) => path[0] as string))];
    const templateRow = (row: Record<string, unknown>): ReshapeResult => {
      const rendered = render(row);
      if ("bad" in rendered) return nonScalar(rendered.bad);
      const next = { ...row };
      defineValue(next, field, rendered.text);
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
      const absent = roots.filter((root) => !Object.prototype.hasOwnProperty.call(record, root));
      if (absent.length > 0) {
        return mismatch(`template placeholders reference ${absent.map((root) => `"${root}"`).join(", ")}, absent`);
      }
      return templateRow(record);
    }
    return mismatch("template needs an object or an array of rows");
  }
  if (op === "format") {
    if (args.length === 1) {
      const formatted = formatScalar(value, args[0] as FormatKind);
      return formatted === null
        ? mismatch(`format "${args[0]}" cannot format this value`)
        : { ok: true, value: formatted };
    }
    const [field, kind] = args as [string, FormatKind];
    if (!isRowArray(value)) return mismatch("per-field format needs an array of rows");
    if (!fieldPresent(value, field)) return mismatch(`field "${field}" is absent from the rows`);
    const rows: Json[] = [];
    for (const row of value) {
      if (!Object.prototype.hasOwnProperty.call(row, field)) {
        rows.push(row);
        continue;
      }
      const formatted = formatScalar(row[field], kind);
      if (formatted === null) return mismatch(`format "${kind}" cannot format "${field}" values`);
      const next = { ...row };
      defineValue(next, field, formatted);
      rows.push(next);
    }
    return { ok: true, value: rows };
  }
  // pick / rename — per-row on arrays, direct on objects.
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

  if (op === "format" && args.length === 1) {
    const kind = args[0] as FormatKind;
    const formattable = shape.kind === "json"
      || (kind === "date" ? shape.kind === "string" || shape.kind === "number" : shape.kind === "number");
    if (!formattable) return shapeError(`format "${kind}" cannot format a ${shape.kind} value`);
    return { ok: true, shape: STRING_SHAPE };
  }

  if (op === "template") {
    const paths = templatePaths(args[args.length - 1] as string) ?? [];
    /** Walks each placeholder path through the row/object shape: an absent
     *  root is the repair-carrying miss; an object/array leaf is the
     *  raw-braces class caught at compile. `json` regions stay defensive. */
    const placeholderMiss = (owner: ShapeType): ReshapeShapeResult | null => {
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
    if (args.length === 1) {
      if (shape.kind === "json") return { ok: true, shape: STRING_SHAPE };
      if (shape.kind !== "object") {
        return shapeError(`template(pattern) needs a bare object; over rows use template(field, pattern); the response shape is ${shape.kind}`);
      }
      return placeholderMiss(shape) ?? { ok: true, shape: STRING_SHAPE };
    }
    const view = viewRows(shape, op);
    if (view === null) return shapeError(`template needs an object or an array of rows; the response shape is ${shape.kind}`);
    if (view.fields === null) return { ok: true, shape: view.rebuild(JSON_SHAPE) };
    const violation = placeholderMiss(objectShape(view.fields, [...view.optional]));
    if (violation !== null) return violation;
    const target = args[0] as string;
    const fields: Record<string, ShapeType> = {};
    for (const [key, value] of Object.entries(view.fields)) {
      defineValue(fields as Record<string, unknown>, key, key === target ? STRING_SHAPE : value);
    }
    if (!Object.prototype.hasOwnProperty.call(fields, target)) {
      defineValue(fields as Record<string, unknown>, target, STRING_SHAPE);
    }
    // The target field is always written, so it leaves the optional set.
    return { ok: true, shape: view.rebuild(objectShape(fields, [...view.optional].filter((key) => key !== target))) };
  }

  const view = viewRows(shape, op);
  if (view === null) {
    return shapeError(`${op} needs ${AGGREGATE_OPS.has(op) || op === "asPoints" || op === "asOptions" ? "an array of rows" : "an object or an array of rows"}; the response shape is ${shape.kind}`);
  }

  if (AGGREGATE_OPS.has(op)) {
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
  }

  if (op === "asPoints") {
    const [labelField, valueField] = args as [string, string];
    const violation = checkedFields(view, [labelField, valueField], op);
    if (violation !== null) return violation;
    const labelShape = view.fields === null ? JSON_SHAPE : view.fields[labelField] as ShapeType;
    const valueShape = view.fields === null ? JSON_SHAPE : view.fields[valueField] as ShapeType;
    return {
      ok: true,
      shape: { kind: "array", items: { kind: "object", fields: { label: labelShape, value: valueShape } } },
    };
  }

  if (op === "asOptions") {
    const [valueField, labelField] = args as [string, string];
    const violation = checkedFields(view, [valueField, labelField], op);
    if (violation !== null) return violation;
    const valueShape = view.fields === null ? JSON_SHAPE : view.fields[valueField] as ShapeType;
    const labelShape = view.fields === null ? JSON_SHAPE : view.fields[labelField] as ShapeType;
    return {
      ok: true,
      shape: { kind: "array", items: { kind: "object", fields: { value: valueShape, label: labelShape } } },
    };
  }

  if (op === "format") {
    const [field, kind] = args as [string, FormatKind];
    const violation = checkedFields(view, [field], op);
    if (violation !== null) return violation;
    if (view.fields === null) return { ok: true, shape: view.rebuild(JSON_SHAPE) };
    const fieldShape = view.fields[field] as ShapeType;
    const formattable = fieldShape.kind === "json"
      || (kind === "date" ? fieldShape.kind === "string" || fieldShape.kind === "number" : fieldShape.kind === "number");
    if (!formattable) {
      return shapeError(
        `format "${kind}" cannot format "${field}" (${fieldShape.kind}) values`,
        undefined,
        Object.keys(view.fields),
      );
    }
    const fields: Record<string, ShapeType> = {};
    for (const [key, value] of Object.entries(view.fields)) {
      defineValue(fields as Record<string, unknown>, key, key === field ? STRING_SHAPE : value);
    }
    return { ok: true, shape: view.rebuild(objectShape(fields, [...view.optional])) };
  }

  // pick / rename
  const referenced = op === "pick" ? args : args.filter((_, index) => index % 2 === 0);
  const violation = checkedFields(view, referenced, op);
  if (violation !== null) return violation;
  if (view.fields === null) {
    return { ok: true, shape: view.isArray && shape.kind === "array" ? shape : JSON_SHAPE };
  }
  if (op === "pick") {
    const fields: Record<string, ShapeType> = {};
    for (const field of args) defineValue(fields as Record<string, unknown>, field, view.fields[field]);
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
    defineValue(fields as Record<string, unknown>, nextKey, value);
    if (view.optional.has(key)) optional.push(nextKey);
  }
  return { ok: true, shape: view.rebuild(objectShape(fields, optional)) };
}
