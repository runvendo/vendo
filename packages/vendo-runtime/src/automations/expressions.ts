/**
 * The automations expression layer — the ONLY place JSONata is touched.
 *
 * Three entry points (spec section a):
 *  - `validateExpression`: creation-time safe-profile check (AST-based).
 *  - `evaluateGuard`: bare predicate -> boolean, fail-closed on non-booleans.
 *  - `resolveInput`: walks a step input; `{{ expr }}` interpolates inside
 *    strings (stringified), a value that is EXACTLY one `{{ expr }}` resolves
 *    to the raw JSON value.
 *
 * Safe profile: expressions are data transforms, never code. `$eval` (JSONata's
 * own dynamic-eval builtin — no JS eval is involved anywhere here) and inline
 * lambda definitions are rejected at creation time; length, evaluation time,
 * and output size are capped so a pathological expression fails the step
 * instead of hanging a firing.
 */
import jsonata from "jsonata";

/** Ceilings for the safe profile. Exported for tests and the compiler prompt. */
export const MAX_EXPRESSION_LENGTH = 1_000;
export const MAX_OUTPUT_BYTES = 262_144; // 256 KiB
export const EVALUATION_TIMEOUT_MS = 250;

/** The closed world an expression can see. The interpreter may add loop bindings. */
export interface ExpressionScope {
  trigger: unknown;
  steps: Record<string, unknown>;
  run: Record<string, unknown>;
  user: Record<string, unknown>;
  [binding: string]: unknown;
}

/** jsonata throws plain objects ({ code, position, message }), not Errors. */
function errorDetail(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err !== null && typeof err === "object" && "message" in err) {
    return String((err as { message: unknown }).message);
  }
  return String(err);
}

/** Typed error naming the offending expression — the compiler's feedback loop. */
export class ExpressionError extends Error {
  readonly expression: string;

  constructor(expression: string, detail: string) {
    super(`invalid expression "${expression}": ${detail}`);
    this.name = "ExpressionError";
    this.expression = expression;
  }
}

const INTERPOLATION_RE = /\{\{([\s\S]+?)\}\}/g;

/**
 * Whole-value form: the string is exactly one {{ expr }} token (whitespace
 * around it allowed). Detected by tokenizing rather than an anchored regex —
 * anchors defeat non-greedy matching and would swallow "{{ a }} x {{ b }}".
 */
function wholeValueExpression(value: string): string | undefined {
  const tokens = [...value.matchAll(INTERPOLATION_RE)];
  if (tokens.length === 1 && tokens[0]![0].trim() === value.trim()) {
    return tokens[0]![1]!.trim();
  }
  return undefined;
}

/**
 * Builtins an expression may reference — an ALLOWLIST, not a denylist (review
 * P1: `($e := $eval; $e(...))` walks straight past a denylist that only looks
 * at call sites). Deliberately excluded:
 *  - `eval` (dynamic evaluation of untrusted trigger data),
 *  - `match` and every regex form (JS regex is synchronous, so ReDoS blocks
 *    the event loop before the async time cap can fire),
 *  - `now` / `millis` / `random` / `shuffle` (deterministic profile — firing
 *    time is exposed deterministically as `run.firedAt`).
 */
const ALLOWED_BUILTINS = new Set([
  // strings
  "string", "length", "substring", "substringBefore", "substringAfter",
  "uppercase", "lowercase", "trim", "pad", "contains", "split", "join",
  "replace", "base64encode", "base64decode", "encodeUrlComponent", "encodeUrl",
  "decodeUrlComponent", "decodeUrl",
  // numbers
  "number", "abs", "floor", "ceil", "round", "power", "sqrt", "formatNumber",
  "formatBase", "formatInteger", "parseInteger",
  // aggregation
  "sum", "max", "min", "average",
  // booleans
  "boolean", "not", "exists",
  // arrays
  "count", "append", "sort", "reverse", "distinct", "zip",
  // objects
  "keys", "lookup", "spread", "merge", "each", "sift", "type",
  // sequences (lambda-taking forms are unusable — lambdas are rejected — but harmless)
  "map", "filter", "reduce", "single",
  // date-time conversion (deterministic)
  "fromMillis", "toMillis",
  // diagnostics
  "error", "assert",
]);

/** Variable names bound locally with `:=` anywhere in the expression. */
function collectBoundNames(node: unknown, bound: Set<string>): void {
  if (Array.isArray(node)) {
    for (const child of node) collectBoundNames(child, bound);
    return;
  }
  if (node === null || typeof node !== "object") return;
  const record = node as Record<string, unknown>;
  if (record["type"] === "bind") {
    const lhs = record["lhs"] as Record<string, unknown> | undefined;
    if (lhs?.["type"] === "variable" && typeof lhs["value"] === "string") {
      bound.add(lhs["value"]);
    }
  }
  for (const value of Object.values(record)) collectBoundNames(value, bound);
}

/** Recursively walk a jsonata AST node rejecting unsafe constructs. */
function assertSafeAst(expression: string, node: unknown, bound: Set<string>): void {
  if (Array.isArray(node)) {
    for (const child of node) assertSafeAst(expression, child, bound);
    return;
  }
  if (node === null || typeof node !== "object") return;

  const record = node as Record<string, unknown>;
  const type = record["type"];
  if (type === "lambda") {
    throw new ExpressionError(expression, "inline function definitions are not allowed");
  }
  if (type === "regex") {
    throw new ExpressionError(
      expression,
      "regular expressions are not allowed (synchronous evaluation defeats the time cap)",
    );
  }
  if (type === "variable" && typeof record["value"] === "string") {
    const name = record["value"];
    // "" is `$` (context) and "$" is `$$` (root) — always fine. Forbidden
    // names are rejected even when locally bound, so no aliasing game works.
    if (name === "eval" || name === "now" || name === "millis" || name === "random" || name === "shuffle" || name === "match") {
      throw new ExpressionError(expression, `$${name} is not allowed`);
    }
    if (name !== "" && name !== "$" && !ALLOWED_BUILTINS.has(name) && !bound.has(name)) {
      throw new ExpressionError(
        expression,
        `$${name} is not an allowed builtin or local binding`,
      );
    }
  }
  for (const value of Object.values(record)) assertSafeAst(expression, value, bound);
}

/**
 * Creation-time validation: length cap, JSONata syntax, safe-profile AST scan.
 * Throws {@link ExpressionError}; returning means the expression is storable.
 */
export function validateExpression(expression: string): void {
  if (expression.length > MAX_EXPRESSION_LENGTH) {
    throw new ExpressionError(
      expression.slice(0, 80) + "…",
      `expression exceeds ${MAX_EXPRESSION_LENGTH} characters`,
    );
  }
  let compiled: ReturnType<typeof jsonata>;
  try {
    compiled = jsonata(expression);
  } catch (err) {
    throw new ExpressionError(expression, errorDetail(err));
  }
  const bound = new Set<string>();
  collectBoundNames(compiled.ast(), bound);
  assertSafeAst(expression, compiled.ast(), bound);
}

/** Compile + evaluate one expression against the scope, time-boxed. */
async function evaluateRaw(expression: string, scope: ExpressionScope): Promise<unknown> {
  validateExpression(expression);
  const compiled = jsonata(expression);

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new ExpressionError(expression, `evaluation exceeded ${EVALUATION_TIMEOUT_MS}ms`)),
      EVALUATION_TIMEOUT_MS,
    );
  });
  try {
    const result: unknown = await Promise.race([
      compiled.evaluate(scope),
      timeout,
    ]);
    assertOutputSize(expression, result);
    return result;
  } catch (err) {
    if (err instanceof ExpressionError) throw err;
    throw new ExpressionError(expression, errorDetail(err));
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function assertOutputSize(expression: string, value: unknown): void {
  if (value === undefined) return;
  const size = JSON.stringify(value)?.length ?? 0;
  if (size > MAX_OUTPUT_BYTES) {
    throw new ExpressionError(
      expression,
      `result of ${size} bytes exceeds the ${MAX_OUTPUT_BYTES}-byte cap`,
    );
  }
}

/**
 * Evaluate a bare guard predicate. Fail-closed: a result that is not a boolean
 * (and not "nothing matched", which is false) is an error, never a coercion.
 */
export async function evaluateGuard(
  expression: string,
  scope: ExpressionScope,
): Promise<boolean> {
  const result = await evaluateRaw(expression, scope);
  if (result === undefined) return false;
  if (typeof result === "boolean") return result;
  throw new ExpressionError(
    expression,
    `guards must produce a boolean, got ${typeof result}`,
  );
}

function stringify(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

async function resolveValue(value: unknown, scope: ExpressionScope): Promise<unknown> {
  if (typeof value === "string") {
    const whole = wholeValueExpression(value);
    if (whole !== undefined) return evaluateRaw(whole, scope);

    // Sequential async interpolation of every {{ expr }} occurrence.
    let out = "";
    let last = 0;
    for (const match of value.matchAll(INTERPOLATION_RE)) {
      out += value.slice(last, match.index);
      out += stringify(await evaluateRaw(match[1]!.trim(), scope));
      last = match.index + match[0].length;
    }
    out += value.slice(last);
    return out;
  }
  if (Array.isArray(value)) {
    const items: unknown[] = [];
    for (const item of value) items.push(await resolveValue(item, scope));
    return items;
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      out[key] = await resolveValue(entry, scope);
    }
    return out;
  }
  return value;
}

/**
 * Resolve a step `input` object against the scope. The resolved whole is also
 * size-capped so one mapping cannot bloat a run row.
 */
export async function resolveInput(
  input: Record<string, unknown> | undefined,
  scope: ExpressionScope,
): Promise<Record<string, unknown>> {
  if (input === undefined) return {};
  const resolved = (await resolveValue(input, scope)) as Record<string, unknown>;
  assertOutputSize("<step input>", resolved);
  return resolved;
}
