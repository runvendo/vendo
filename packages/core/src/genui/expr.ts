/**
 * `$expr` — the COMPUTED binding value: `{ $expr: "sum(invoices.amount_cents) / count(clients)" }`.
 *
 * A computed value is evaluated LIVE at bind resolution in the renderer — the
 * same place `$path` resolves — and re-evaluated whenever the query data
 * changes. Nothing is ever computed at generation time: a headline total that
 * was frozen into the document the moment a model wrote it would be a lie by
 * the next refresh.
 *
 * Three surfaces:
 *   - {@link parseExpr}    source → AST. Total, depth-bounded.
 *   - {@link evaluateExpr} source + resolved query data → a value. Total: an
 *                          evaluation problem yields `undefined` plus a
 *                          described issue, never a throw.
 *   - {@link checkExpr}    source + the tool SHAPES → the fact findings before
 *                          it ships (parse errors, fields the shapes do not
 *                          carry, types that cannot compute). The apps fact
 *                          check (checking/facts.ts) speaks these.
 *
 * Grammar: field paths (`invoices.amount_cents`), numbers, `+ - * / ( )`, and
 * the closed call list {@link EXPR_CALLS}. A field name against a list of rows
 * reads the COLUMN (`invoices.amount_cents` is every row's cents), which is
 * what the aggregates consume.
 *
 * Data that has not arrived is not a problem: it resolves to `undefined` and
 * flows through arithmetic as `undefined` — the same discipline as `$reshape`
 * (loading is never a mismatch).
 */

import type { Json } from "../ids.js";
import type { ShapeType } from "../shape.js";
import { isPlainObject } from "./tree-node.js";

/** A computed binding value; the string is the expression source. */
export interface ExprBinding {
  $expr: string;
}

/** The `$path`/`$state` guards' sibling (tree-node.ts). */
export function isExprBinding(value: unknown): value is ExprBinding {
  return typeof value === "object"
    && value !== null
    && typeof (value as { $expr?: unknown }).$expr === "string";
}

/** The closed call vocabulary. Adding a call means adding it here first. */
export const EXPR_CALLS = [
  "sum",
  "count",
  "average",
  "min",
  "max",
  "difference",
  "days_until",
  "group_by",
] as const;

export type ExprCall = (typeof EXPR_CALLS)[number];

/** The `group_by` bucket vocabulary (its second argument). */
export const EXPR_BUCKETS = ["day", "month", "year"] as const;

type ExprBucket = (typeof EXPR_BUCKETS)[number];

const ARITY: Record<ExprCall, number> = {
  sum: 1,
  count: 1,
  average: 1,
  min: 1,
  max: 1,
  difference: 2,
  days_until: 1,
  group_by: 3,
};

const COUNT_WORDS = ["no", "one", "two", "three"] as const;

const argumentCount = (count: number): string =>
  `${COUNT_WORDS[count] ?? count} argument${count === 1 ? "" : "s"}`;

/** The calls that reduce numbers, and so may aggregate a `group_by` bucket. */
const NUMERIC_AGGREGATES: ReadonlySet<string> = new Set(["sum", "average", "min", "max"]);
const GROUPABLE: ReadonlySet<string> = new Set([...NUMERIC_AGGREGATES, "count"]);

const isExprCall = (name: string): name is ExprCall => (EXPR_CALLS as readonly string[]).includes(name);

// ── grammar ─────────────────────────────────────────────────────────────────

export type ExprNode =
  | { kind: "number"; value: number }
  | { kind: "string"; value: string }
  | { kind: "path"; segments: readonly string[]; text: string }
  | { kind: "negate"; operand: ExprNode }
  | { kind: "binary"; op: "+" | "-" | "*" | "/"; left: ExprNode; right: ExprNode }
  | { kind: "call"; name: ExprCall; args: readonly ExprNode[] };

export type ExprParse =
  | { ok: true; node: ExprNode }
  | { ok: false; issue: string };

/** Deeper than any real computed value; the bound is what keeps parsing and
 *  evaluation total (no input can reach the call-stack limit). */
const EXPR_MAX_DEPTH = 32;

type Token =
  | { type: "number"; at: number; text: string; value: number }
  | { type: "string"; at: number; text: string; value: string }
  | { type: "path"; at: number; text: string; segments: string[] }
  | { type: "punct"; at: number; text: string };

const WHITESPACE = /\s/;
const IDENTIFIER_START = /[A-Za-z_]/;
const IDENTIFIER_CHAR = /[A-Za-z0-9_]/;
const DIGIT = /[0-9]/;
/** JSON number grammar, matched sticky at the cursor (wire/expression.ts's). */
const NUMBER_PATTERN = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
const PUNCTUATION: ReadonlySet<string> = new Set(["+", "-", "*", "/", "(", ")", ","]);

/** Reads a dotted field path as ONE token: a call name is a path of one
 *  segment, so the parser never has to re-join dots. */
const readPath = (source: string, start: number): { segments: string[]; end: number } => {
  let end = start + 1;
  while (end < source.length && IDENTIFIER_CHAR.test(source[end] as string)) end += 1;
  const segments = [source.slice(start, end)];
  while (source[end] === "." && IDENTIFIER_CHAR.test(source[end + 1] ?? "")) {
    let segmentEnd = end + 1;
    while (segmentEnd < source.length && IDENTIFIER_CHAR.test(source[segmentEnd] as string)) segmentEnd += 1;
    segments.push(source.slice(end + 1, segmentEnd));
    end = segmentEnd;
  }
  return { segments, end };
};

const tokenize = (source: string): { tokens: Token[] } | { issue: string } => {
  const tokens: Token[] = [];
  let index = 0;
  while (index < source.length) {
    const char = source[index] as string;
    if (WHITESPACE.test(char)) {
      index += 1;
      continue;
    }
    if (char === '"' || char === "'") {
      const end = source.indexOf(char, index + 1);
      if (end === -1) {
        return { issue: `this expression has an unterminated string starting at position ${index + 1}` };
      }
      tokens.push({ type: "string", at: index, text: source.slice(index + 1, end), value: source.slice(index + 1, end) });
      index = end + 1;
      continue;
    }
    if (DIGIT.test(char)) {
      NUMBER_PATTERN.lastIndex = index;
      // A digit always starts a match — the pattern's integer part is `0` or
      // `[1-9]\d*` — so the fallback is unreachable, not a real branch.
      const [text = char] = NUMBER_PATTERN.exec(source) ?? [];
      const value = Number(text);
      if (!Number.isFinite(value)) {
        return { issue: `the number "${text}" in this expression is too large to compute with` };
      }
      tokens.push({ type: "number", at: index, text, value });
      index = NUMBER_PATTERN.lastIndex;
      continue;
    }
    if (IDENTIFIER_START.test(char)) {
      const path = readPath(source, index);
      tokens.push({ type: "path", at: index, text: path.segments.join("."), segments: path.segments });
      index = path.end;
      continue;
    }
    if (PUNCTUATION.has(char)) {
      tokens.push({ type: "punct", at: index, text: char });
      index += 1;
      continue;
    }
    return { issue: `"${char}" is not something an expression can contain (position ${index + 1})` };
  }
  return { tokens };
};

/** Internal parse-failure sentinel — flows up the recursion instead of a throw
 *  so every frame unwinds with the issue already recorded (wire/expression.ts's
 *  discipline). */
const PARSE_FAILED: unique symbol = Symbol("expr-parse-failed");
type ParseFailed = typeof PARSE_FAILED;

interface ParseState {
  readonly tokens: readonly Token[];
  index: number;
  issue: string | null;
}

const failParse = (state: ParseState, message: string): ParseFailed => {
  state.issue ??= message;
  return PARSE_FAILED;
};

const isPunct = (token: Token | undefined, text: string): boolean =>
  token !== undefined && token.type === "punct" && token.text === text;

const describeToken = (token: Token | undefined): string =>
  token === undefined ? "the end of the expression" : `"${token.text}"`;

const parseGroupBy = (state: ParseState, args: readonly ExprNode[]): ExprNode | ParseFailed => {
  const [key, bucket, aggregate] = args;
  if (key?.kind !== "path") {
    return failParse(state, "group_by() groups by a date field path, like group_by(invoices.due_date, \"month\", sum(invoices.amount_cents))");
  }
  if (bucket?.kind !== "string" || !(EXPR_BUCKETS as readonly string[]).includes(bucket.value)) {
    return failParse(state, `group_by() buckets by ${EXPR_BUCKETS.join(", ")} — write one of them as a quoted second argument`);
  }
  if (aggregate?.kind !== "call" || !GROUPABLE.has(aggregate.name) || aggregate.args[0]?.kind !== "path") {
    return failParse(state, `group_by()'s third argument aggregates each bucket, like sum(invoices.amount_cents) — one of ${[...GROUPABLE].join(", ")} over a field path`);
  }
  const collection = key.segments.slice(0, -1).join(".");
  const aggregated = aggregate.args[0].segments;
  const sameRows = aggregate.name === "count"
    ? aggregated.join(".") === collection || aggregated.slice(0, -1).join(".") === collection
    : aggregated.slice(0, -1).join(".") === collection;
  if (!sameRows) {
    return failParse(state, `group_by() aggregates the SAME rows it groups: ${aggregate.name}(${aggregate.args[0].text}) reads different rows than ${key.text}`);
  }
  return { kind: "call", name: "group_by", args };
};

const parseCall = (state: ParseState, nameToken: Token & { type: "path" }, depth: number): ExprNode | ParseFailed => {
  const name = nameToken.text;
  if (nameToken.segments.length !== 1 || !isExprCall(name)) {
    return failParse(state, `"${name}" is not a function an expression can call — the functions are: ${EXPR_CALLS.join(", ")}`);
  }
  state.index += 1; // consume "("
  const args: ExprNode[] = [];
  if (isPunct(state.tokens[state.index], ")")) {
    state.index += 1;
  } else {
    for (;;) {
      const arg = parseSum(state, depth + 1);
      if (arg === PARSE_FAILED) return PARSE_FAILED;
      args.push(arg);
      const next = state.tokens[state.index];
      if (isPunct(next, ",")) {
        state.index += 1;
        continue;
      }
      if (isPunct(next, ")")) {
        state.index += 1;
        break;
      }
      return failParse(state, `the expression ends inside ${name}(…) where a "," or ")" was expected`);
    }
  }
  if (args.length !== ARITY[name]) {
    return failParse(state, `${name}() takes ${argumentCount(ARITY[name])}, not ${args.length}`);
  }
  if (name === "group_by") return parseGroupBy(state, args);
  return { kind: "call", name, args };
};

const parsePrimary = (state: ParseState, depth: number): ExprNode | ParseFailed => {
  const token = state.tokens[state.index];
  if (token === undefined) return failParse(state, "this expression ends where a value was expected");
  if (token.type === "number") {
    state.index += 1;
    return { kind: "number", value: token.value };
  }
  if (token.type === "string") {
    state.index += 1;
    return { kind: "string", value: token.value };
  }
  if (token.type === "path") {
    if (isPunct(state.tokens[state.index + 1], "(")) {
      state.index += 1;
      return parseCall(state, token, depth);
    }
    state.index += 1;
    return { kind: "path", segments: token.segments, text: token.text };
  }
  if (token.text === "(") {
    state.index += 1;
    const inner = parseSum(state, depth + 1);
    if (inner === PARSE_FAILED) return PARSE_FAILED;
    const close = state.tokens[state.index];
    if (!isPunct(close, ")")) {
      return failParse(state, `this expression is missing a ")" — ${describeToken(close)} appears where the closing parenthesis should be`);
    }
    state.index += 1;
    return inner;
  }
  return failParse(state, `${describeToken(token)} is not a value — an expression takes numbers, field paths, ${EXPR_CALLS.join("/")} calls, and ( )`);
};

const parseUnary = (state: ParseState, depth: number): ExprNode | ParseFailed => {
  if (depth > EXPR_MAX_DEPTH) {
    return failParse(state, `this expression is nested more than ${EXPR_MAX_DEPTH} levels deep`);
  }
  if (isPunct(state.tokens[state.index], "-")) {
    state.index += 1;
    const operand = parseUnary(state, depth + 1);
    return operand === PARSE_FAILED ? PARSE_FAILED : { kind: "negate", operand };
  }
  return parsePrimary(state, depth);
};

const parseBinary = (
  state: ParseState,
  depth: number,
  operators: readonly string[],
  next: (state: ParseState, depth: number) => ExprNode | ParseFailed,
): ExprNode | ParseFailed => {
  let left = next(state, depth);
  if (left === PARSE_FAILED) return PARSE_FAILED;
  for (;;) {
    const token = state.tokens[state.index];
    if (token === undefined || token.type !== "punct" || !operators.includes(token.text)) return left;
    state.index += 1;
    const right = next(state, depth + 1);
    if (right === PARSE_FAILED) return PARSE_FAILED;
    left = { kind: "binary", op: token.text as "+" | "-" | "*" | "/", left, right };
  }
};

const parseProduct = (state: ParseState, depth: number): ExprNode | ParseFailed =>
  parseBinary(state, depth, ["*", "/"], parseUnary);

function parseSum(state: ParseState, depth: number): ExprNode | ParseFailed {
  return parseBinary(state, depth, ["+", "-"], parseProduct);
}

/** Parse one expression source. Pure, deterministic, total: any input either
 *  yields an AST or one issue written as a sentence naming the bad token. */
export function parseExpr(source: string): ExprParse {
  const tokenized = tokenize(source);
  if ("issue" in tokenized) return { ok: false, issue: tokenized.issue };
  const state: ParseState = { tokens: tokenized.tokens, index: 0, issue: null };
  const node = parseSum(state, 0);
  if (node === PARSE_FAILED) {
    return { ok: false, issue: state.issue ?? "this expression could not be read" };
  }
  const trailing = state.tokens[state.index];
  if (trailing !== undefined) {
    return { ok: false, issue: `${describeToken(trailing)} trails the end of this expression (position ${trailing.at + 1})` };
  }
  return { ok: true, node };
}

/** The query names an expression reads — the compiler's unknown-reference gate. */
export function exprPathHeads(node: ExprNode): string[] {
  const heads: string[] = [];
  const walk = (current: ExprNode): void => {
    if (current.kind === "path") {
      const head = current.segments[0];
      if (head !== undefined && !heads.includes(head)) heads.push(head);
      return;
    }
    if (current.kind === "negate") walk(current.operand);
    else if (current.kind === "binary") {
      walk(current.left);
      walk(current.right);
    } else if (current.kind === "call") current.args.forEach(walk);
  };
  walk(node);
  return heads;
}

/** How a node reads back in an issue message. */
const printExpr = (node: ExprNode): string => {
  if (node.kind === "number") return String(node.value);
  if (node.kind === "string") return `"${node.value}"`;
  if (node.kind === "path") return node.text;
  if (node.kind === "negate") return `-${printExpr(node.operand)}`;
  if (node.kind === "call") return `${node.name}(${node.args.map(printExpr).join(", ")})`;
  return `${printExpr(node.left)} ${node.op} ${printExpr(node.right)}`;
};

// ── evaluation ──────────────────────────────────────────────────────────────

/** The total evaluation result. `ok: false` is the renderer's contained
 *  data-shape-notice path (the `$reshape` convention), never a throw. */
export type ExprResult =
  | { ok: true; value: Json | undefined }
  | { ok: false; issue: string };

export interface ExprEvalOptions {
  /** `days_until`'s reference instant in epoch ms; defaults to now. Supplied
   *  so evaluation is deterministic under test. */
  now?: number;
}

const EVAL_FAILED: unique symbol = Symbol("expr-evaluation-failed");
type EvalFailed = typeof EVAL_FAILED;

interface EvalState {
  readonly data: Record<string, Json>;
  readonly now: number;
  issue: string | null;
}

const failEval = (state: EvalState, message: string): EvalFailed => {
  state.issue ??= message;
  return EVAL_FAILED;
};

const describeValue = (value: unknown): string => {
  if (value === null || value === undefined) return "empty";
  if (Array.isArray(value)) return `a list of ${value.length}`;
  if (isPlainObject(value)) return "an object";
  if (typeof value === "string") return `the text "${value}"`;
  return String(value);
};

const INDEX_PATTERN = /^(?:0|[1-9]\d*)$/;

const fieldsOf = (rows: readonly Record<string, unknown>[]): string => {
  const fields: string[] = [];
  for (const row of rows) {
    for (const field of Object.keys(row)) if (!fields.includes(field)) fields.push(field);
  }
  return fields.join(", ");
};

const walkValue = (
  state: EvalState,
  value: unknown,
  segments: readonly string[],
  consumed: readonly string[],
): unknown | EvalFailed => {
  if (segments.length === 0) return value === null ? undefined : value;
  if (value === null || value === undefined) return undefined;
  const [head, ...rest] = segments as [string, ...string[]];
  const at = `"${consumed.join(".")}"`;
  if (Array.isArray(value)) {
    if (INDEX_PATTERN.test(head)) return walkValue(state, value[Number(head)], rest, [...consumed, head]);
    const rows = value.filter(isPlainObject);
    if (rows.length === 0) {
      if (value.length === 0) return [];
      return failEval(state, `"${head}" reads a field out of ${at}, but its items are not rows (the first is ${describeValue(value[0])})`);
    }
    const carrying = rows.filter((row) => Object.prototype.hasOwnProperty.call(row, head));
    if (carrying.length === 0) {
      return failEval(state, `"${head}" is absent from the rows of ${at} — the fields they carry are: ${fieldsOf(rows)}`);
    }
    // A field name against rows reads the COLUMN; nested lists flatten, so a
    // column of columns is still one column for the aggregates.
    const column: unknown[] = [];
    for (const row of carrying) {
      const item = walkValue(state, row[head], rest, [...consumed, head]);
      if (item === EVAL_FAILED) return EVAL_FAILED;
      if (item === undefined) continue;
      if (Array.isArray(item)) column.push(...item);
      else column.push(item);
    }
    return column;
  }
  if (isPlainObject(value)) {
    if (!Object.prototype.hasOwnProperty.call(value, head)) {
      return failEval(state, `"${head}" is absent from ${at} — its fields are: ${Object.keys(value).join(", ")}`);
    }
    return walkValue(state, value[head], rest, [...consumed, head]);
  }
  return failEval(state, `"${head}" reads past ${describeValue(value)} in ${at}`);
};

const resolveSegments = (state: EvalState, segments: readonly string[]): unknown | EvalFailed => {
  const [head, ...rest] = segments;
  // A query whose data has not arrived resolves to `undefined` — loading is
  // never a mismatch. A head that names no query at all is a FACT, caught by
  // checkExpr before the app ships (the renderer cannot tell them apart).
  if (head === undefined || !Object.prototype.hasOwnProperty.call(state.data, head)) return undefined;
  return walkValue(state, state.data[head], rest, [head]);
};

const asNumber = (state: EvalState, value: unknown, label: string): number | EvalFailed => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) {
    return failEval(state, `${label} is a list of ${value.length} values, not a single number — reduce it with sum(), count(), or average() first`);
  }
  return failEval(state, `${label} is ${describeValue(value)}, not a number — arithmetic needs numbers`);
};

const numbersOf = (state: EvalState, value: unknown, call: string, label: string): number[] | EvalFailed => {
  const items = Array.isArray(value) ? value : [value];
  const numbers: number[] = [];
  for (const item of items) {
    // Sparse data carries explicit nulls; they are not a type mismatch.
    if (item === null || item === undefined) continue;
    if (typeof item !== "number" || !Number.isFinite(item)) {
      return failEval(state, `${call}() needs numeric values, but ${label} holds ${describeValue(item)}`);
    }
    numbers.push(item);
  }
  return numbers;
};

const reduceNumbers = (state: EvalState, numbers: readonly number[], call: string, label: string): number | EvalFailed => {
  if (call === "sum") return numbers.reduce((total, value) => total + value, 0);
  if (numbers.length === 0) return failEval(state, `${call}() has no values to work with in ${label}`);
  if (call === "average") return numbers.reduce((total, value) => total + value, 0) / numbers.length;
  return call === "min" ? Math.min(...numbers) : Math.max(...numbers);
};

const DAY_MS = 86_400_000;

/** Whole days from the reference instant's UTC day to the target's. */
const daysUntil = (state: EvalState, value: unknown, label: string): number | EvalFailed => {
  if (Array.isArray(value)) {
    return failEval(state, `days_until() reads one date, but ${label} is a list of ${value.length} — point it at a single row's date field`);
  }
  if (typeof value !== "string") {
    return failEval(state, `days_until() reads an ISO date string, but ${label} is ${describeValue(value)}`);
  }
  const time = Date.parse(value);
  if (!Number.isFinite(time)) {
    return failEval(state, `days_until() reads an ISO date string, and "${value}" is not one`);
  }
  return Math.floor(time / DAY_MS) - Math.floor(state.now / DAY_MS);
};

const bucketKey = (value: unknown, bucket: ExprBucket): string | null => {
  // ISO date strings only: an epoch-ms number read as a date is how a numeric
  // field silently buckets into 1970 instead of saying it is not a date.
  if (typeof value !== "string") return null;
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return null;
  const iso = new Date(time).toISOString();
  return bucket === "year" ? iso.slice(0, 4) : bucket === "month" ? iso.slice(0, 7) : iso.slice(0, 10);
};

const evaluateGroupBy = (state: EvalState, args: readonly ExprNode[]): unknown | EvalFailed => {
  const key = args[0] as ExprNode & { kind: "path" };
  const bucket = (args[1] as ExprNode & { kind: "string" }).value as ExprBucket;
  const aggregate = args[2] as ExprNode & { kind: "call" };
  const valuePath = aggregate.args[0] as ExprNode & { kind: "path" };
  const collection = key.segments.slice(0, -1);
  const keyField = key.segments[key.segments.length - 1] as string;
  const valueField = valuePath.segments[valuePath.segments.length - 1] as string;

  const resolved = resolveSegments(state, collection);
  if (resolved === EVAL_FAILED) return EVAL_FAILED;
  if (resolved === undefined) return undefined;
  if (!Array.isArray(resolved)) {
    return failEval(state, `group_by() groups a list of rows, but "${collection.join(".")}" is ${describeValue(resolved)}`);
  }
  const rows = resolved.filter(isPlainObject);
  if (rows.length === 0) {
    if (resolved.length === 0) return [];
    return failEval(state, `group_by() groups a list of rows, but "${collection.join(".")}" holds ${describeValue(resolved[0])}`);
  }
  if (aggregate.name !== "count"
    && !rows.some((row) => Object.prototype.hasOwnProperty.call(row, valueField))) {
    return failEval(state, `"${valueField}" is absent from the rows of "${collection.join(".")}" — the fields they carry are: ${fieldsOf(rows)}`);
  }
  const groups = new Map<string, unknown[]>();
  for (const row of rows) {
    if (!Object.prototype.hasOwnProperty.call(row, keyField)) {
      return failEval(state, `group_by() reads "${keyField}" from each row of "${collection.join(".")}" — the fields they carry are: ${fieldsOf(rows)}`);
    }
    const groupKey = bucketKey(row[keyField], bucket);
    if (groupKey === null) {
      return failEval(state, `group_by() buckets by date, and ${describeValue(row[keyField])} in "${keyField}" is not an ISO date`);
    }
    const existing = groups.get(groupKey);
    if (existing === undefined) groups.set(groupKey, [row[valueField]]);
    else existing.push(row[valueField]);
  }
  const buckets = [...groups.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const label = `"${collection.join(".")}.${valueField}"`;
  const points: Array<{ key: string; value: number }> = [];
  for (const [groupKey, values] of buckets) {
    if (aggregate.name === "count") {
      points.push({ key: groupKey, value: values.length });
      continue;
    }
    const numbers = numbersOf(state, values, aggregate.name, label);
    if (numbers === EVAL_FAILED) return EVAL_FAILED;
    const reduced = reduceNumbers(state, numbers, aggregate.name, label);
    if (reduced === EVAL_FAILED) return EVAL_FAILED;
    points.push({ key: groupKey, value: reduced });
  }
  return points;
};

const evaluateCall = (state: EvalState, node: ExprNode & { kind: "call" }): unknown | EvalFailed => {
  if (node.name === "group_by") return evaluateGroupBy(state, node.args);
  const label = printExpr(node.args[0] as ExprNode);
  const first = evaluate(state, node.args[0] as ExprNode);
  if (first === EVAL_FAILED) return EVAL_FAILED;
  if (first === undefined) return undefined;
  if (node.name === "count") {
    if (Array.isArray(first)) return first.length;
    const listFields = isPlainObject(first)
      ? Object.entries(first).filter(([, value]) => Array.isArray(value)).map(([field]) => field)
      : [];
    const hint = listFields.length > 0 ? ` — name the list (e.g. ${label}.${listFields[0]})` : "";
    return failEval(state, `count() counts a list, but ${label} is ${describeValue(first)}${hint}`);
  }
  if (node.name === "days_until") return daysUntil(state, first, label);
  if (node.name === "difference") {
    const second = evaluate(state, node.args[1] as ExprNode);
    if (second === EVAL_FAILED) return EVAL_FAILED;
    if (second === undefined) return undefined;
    const left = asNumber(state, first, label);
    if (left === EVAL_FAILED) return EVAL_FAILED;
    const right = asNumber(state, second, printExpr(node.args[1] as ExprNode));
    return right === EVAL_FAILED ? EVAL_FAILED : left - right;
  }
  const numbers = numbersOf(state, first, node.name, label);
  if (numbers === EVAL_FAILED) return EVAL_FAILED;
  return reduceNumbers(state, numbers, node.name, label);
};

function evaluate(state: EvalState, node: ExprNode): unknown | EvalFailed {
  if (node.kind === "number") return node.value;
  if (node.kind === "string") return node.value;
  if (node.kind === "path") return resolveSegments(state, node.segments);
  if (node.kind === "call") return evaluateCall(state, node);
  if (node.kind === "negate") {
    const operand = evaluate(state, node.operand);
    if (operand === EVAL_FAILED) return EVAL_FAILED;
    if (operand === undefined) return undefined;
    const number = asNumber(state, operand, printExpr(node.operand));
    return number === EVAL_FAILED ? EVAL_FAILED : -number;
  }
  const left = evaluate(state, node.left);
  if (left === EVAL_FAILED) return EVAL_FAILED;
  const right = evaluate(state, node.right);
  if (right === EVAL_FAILED) return EVAL_FAILED;
  // Either side still loading means the whole value is still loading.
  if (left === undefined || right === undefined) return undefined;
  const a = asNumber(state, left, printExpr(node.left));
  if (a === EVAL_FAILED) return EVAL_FAILED;
  const b = asNumber(state, right, printExpr(node.right));
  if (b === EVAL_FAILED) return EVAL_FAILED;
  if (node.op === "+") return a + b;
  if (node.op === "-") return a - b;
  if (node.op === "*") return a * b;
  if (b === 0) {
    return failEval(state, `${printExpr(node.right)} is zero, and dividing by zero has no value`);
  }
  return a / b;
}

/**
 * Evaluate one expression against the renderer's resolved query data (keyed by
 * query name). Total: an evaluation problem yields the issue the renderer shows
 * as its contained data-shape notice, never a throw. Pure — same source, same
 * data, same answer.
 */
export function evaluateExpr(
  source: string,
  data: Record<string, Json>,
  options: ExprEvalOptions = {},
): ExprResult {
  const parsed = parseExpr(source);
  if (!parsed.ok) return { ok: false, issue: parsed.issue };
  const state: EvalState = { data, now: options.now ?? Date.now(), issue: null };
  const value = evaluate(state, parsed.node);
  if (value === EVAL_FAILED) {
    return { ok: false, issue: state.issue ?? "this expression could not be computed" };
  }
  return { ok: true, value: value as Json | undefined };
}

// ── the fact check ──────────────────────────────────────────────────────────

export interface ExprCheckContext {
  /** The declared query names; a path head naming none is a fact finding. */
  queryNames: readonly string[];
  /** The query's response shape, or undefined when nothing is known about it —
   *  unknown regions stay silent, as in the binding shape check. */
  shapeOf(queryName: string): ShapeType | undefined;
}

const UNKNOWN: ShapeType = { kind: "json" };

type ShapeWalk =
  | { ok: true; shape: ShapeType; container?: Record<string, ShapeType> }
  | { ok: false; issue: string };

const numericFields = (fields: Record<string, ShapeType>): string[] =>
  Object.entries(fields).filter(([, field]) => field.kind === "number").map(([name]) => name);

const walkShape = (
  shape: ShapeType,
  segments: readonly string[],
  consumed: readonly string[],
  container: Record<string, ShapeType> | undefined,
): ShapeWalk => {
  if (segments.length === 0) {
    return container === undefined ? { ok: true, shape } : { ok: true, shape, container };
  }
  const [head, ...rest] = segments as [string, ...string[]];
  const at = `"${consumed.join(".")}"`;
  if (shape.kind === "json") return { ok: true, shape: UNKNOWN };
  if (shape.kind === "object") {
    const field = shape.fields[head];
    if (field === undefined) {
      return { ok: false, issue: `"${head}" is absent from ${at} — the real fields are: ${Object.keys(shape.fields).join(", ")}` };
    }
    return walkShape(field, rest, [...consumed, head], shape.fields);
  }
  if (shape.kind === "array") {
    if (INDEX_PATTERN.test(head)) return walkShape(shape.items, rest, [...consumed, head], container);
    // A field name against rows reads the column: the resolved shape is an
    // array of the field's shape.
    const inner = walkShape(shape.items, segments, consumed, container);
    if (!inner.ok) return inner;
    return inner.container === undefined
      ? { ok: true, shape: { kind: "array", items: inner.shape } }
      : { ok: true, shape: { kind: "array", items: inner.shape }, container: inner.container };
  }
  return { ok: false, issue: `"${head}" reads past the ${shape.kind} at ${at}` };
};

/** The item shape behind a column (`invoices.amount_cents` is `number[]`). */
const columnItems = (shape: ShapeType): ShapeType => (shape.kind === "array" ? shape.items : shape);

interface CheckState {
  readonly context: ExprCheckContext;
  readonly issues: string[];
}

/** The static shape of an expression node, recording every issue it finds.
 *  `undefined` means "nothing known" — the defensive silence. */
const shapeOfNode = (state: CheckState, node: ExprNode): ShapeType => {
  if (node.kind === "number") return { kind: "number" };
  if (node.kind === "string") return { kind: "string" };
  if (node.kind === "path") return pathShape(state, node).shape;
  if (node.kind === "negate") {
    requireNumeric(state, node.operand, "arithmetic");
    return { kind: "number" };
  }
  if (node.kind === "binary") {
    requireNumeric(state, node.left, "arithmetic");
    requireNumeric(state, node.right, "arithmetic");
    return { kind: "number" };
  }
  return callShape(state, node);
};

const pathShape = (state: CheckState, node: ExprNode & { kind: "path" }): { shape: ShapeType; container?: Record<string, ShapeType> } => {
  const head = node.segments[0] as string;
  if (!state.context.queryNames.includes(head)) {
    state.issues.push(`"${node.text}" does not name a declared query; the queries are: ${state.context.queryNames.join(", ")}`);
    return { shape: UNKNOWN };
  }
  const shape = state.context.shapeOf(head);
  if (shape === undefined) return { shape: UNKNOWN };
  const walked = walkShape(shape, node.segments.slice(1), [head], undefined);
  if (!walked.ok) {
    state.issues.push(walked.issue);
    return { shape: UNKNOWN };
  }
  return walked.container === undefined ? { shape: walked.shape } : { shape: walked.shape, container: walked.container };
};

const requireNumeric = (state: CheckState, node: ExprNode, call: string): void => {
  if (node.kind === "path") {
    const { shape, container } = pathShape(state, node);
    const items = columnItems(shape);
    if (items.kind === "json" || items.kind === "number") return;
    if (call === "arithmetic" && shape.kind === "array") {
      state.issues.push(`${node.text} is a list, not a single number — reduce it with sum(), count(), or average() first`);
      return;
    }
    const hint = container === undefined || numericFields(container).length === 0
      ? ""
      : ` — the numeric fields are: ${numericFields(container).join(", ")}`;
    state.issues.push(call === "arithmetic"
      ? `${node.text} is a ${items.kind} field, not a number — arithmetic needs numbers${hint}`
      : `${call}() needs numeric values, but ${node.text} is a ${items.kind} field${hint}`);
    return;
  }
  const shape = shapeOfNode(state, node);
  const items = columnItems(shape);
  if (items.kind === "json" || items.kind === "number") return;
  if (call === "arithmetic" && shape.kind === "array") {
    state.issues.push(`${printExpr(node)} is a list, not a single number — reduce it with sum(), count(), or average() first`);
    return;
  }
  state.issues.push(call === "arithmetic"
    ? `${printExpr(node)} is ${items.kind}, not a number — arithmetic needs numbers`
    : `${call}() needs numeric values, but ${printExpr(node)} is ${items.kind}`);
};

const callShape = (state: CheckState, node: ExprNode & { kind: "call" }): ShapeType => {
  const first = node.args[0] as ExprNode;
  if (node.name === "group_by") {
    const key = node.args[0] as ExprNode & { kind: "path" };
    const keyShape = columnItems(pathShape(state, key).shape);
    if (keyShape.kind !== "json" && keyShape.kind !== "string") {
      state.issues.push(`group_by() buckets by date, but ${key.text} is a ${keyShape.kind} field — group by an ISO date field`);
    }
    callShape(state, node.args[2] as ExprNode & { kind: "call" });
    return { kind: "array", items: { kind: "object", fields: { key: { kind: "string" }, value: { kind: "number" } } } };
  }
  if (node.name === "count") {
    const shape = shapeOfNode(state, first);
    if (shape.kind !== "json" && shape.kind !== "array") {
      state.issues.push(`count() counts a list, but ${printExpr(first)} is ${shape.kind === "object" ? "an object" : `a ${shape.kind}`}`);
    }
    return { kind: "number" };
  }
  if (node.name === "days_until") {
    const shape = columnItems(shapeOfNode(state, first));
    if (shape.kind !== "json" && shape.kind !== "string") {
      state.issues.push(`days_until() reads an ISO date string, but ${printExpr(first)} is a ${shape.kind} field`);
    }
    return { kind: "number" };
  }
  requireNumeric(state, first, node.name);
  if (node.name === "difference") requireNumeric(state, node.args[1] as ExprNode, node.name);
  return { kind: "number" };
};

/**
 * The FACT check behind an `$expr`: it parses, every field path reaches a field
 * the tool shapes really expose, and every slot's type can actually compute.
 * Returns one sentence per finding — teaching messages that name the real
 * fields, since the model reading them has to pick the right one.
 */
export function checkExpr(source: string, context: ExprCheckContext): string[] {
  const parsed = parseExpr(source);
  if (!parsed.ok) return [parsed.issue];
  const state: CheckState = { context, issues: [] };
  shapeOfNode(state, parsed.node);
  return state.issues;
}
