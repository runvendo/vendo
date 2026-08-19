/**
 * `$expr` — the COMPUTED binding value. The `{...}` gaps of a screen document
 * are REAL JavaScript expressions, stored verbatim and evaluated in a sealed
 * interpreter:
 * `{ $expr: "invoices.data.reduce((t, r) => t + r.amount_cents, 0) / 100" }`.
 *
 * A computed value is evaluated LIVE at bind resolution in the renderer — the
 * same place `$path` resolves — and re-evaluated whenever the query data
 * changes. Nothing is ever computed at generation time: a headline total that
 * was frozen into the document the moment a model wrote it would be a lie by
 * the next refresh.
 *
 * Four surfaces:
 *   - {@link parseExpr}    source → an ESTree expression. Total, size-capped.
 *   - {@link evaluateExpr} source + resolved query data → a value. Total: an
 *                          evaluation problem yields the issue, never a throw.
 *   - {@link checkExpr}    source + the declared query names → the fact
 *                          findings before it ships. The apps fact check
 *                          (checking/facts.ts) speaks these. TYPES are not
 *                          checked here: the screen is a strict TSX subset and
 *                          `tsc` reads it against the query result types
 *                          (checking/screen-typings.ts) — one compiler, not a
 *                          bespoke shape walker.
 *   - {@link warmExprRuntime} boots the interpreter. Evaluation is
 *                          SYNCHRONOUS; only this one-time boot is not.
 *
 * Grammar: a JavaScript expression, parsed by acorn. There is no closed call
 * vocabulary and no reshape dialect — arrays, objects, strings and numbers all
 * carry their own methods, so `rows.reduce(...)`, `rows.map(...)`,
 * `rows.filter(...)`, arrow functions, spread, template literals, optional
 * chaining and ternaries are simply available.
 *
 * Data that has not arrived is not a problem: a query the data map does not
 * carry resolves to `undefined` and flows through the expression as
 * `undefined` — the same discipline as `$reshape` (loading is never a
 * mismatch).
 *
 * THE SEAL. Evaluation runs inside a QuickJS WebAssembly VM
 * (`quickjs-emscripten`), not in this realm: the expression cannot reach the
 * DOM, the network, `process`, `require`, or any host object, because none of
 * them exist inside the VM. Two intrinsics are DELETED from the VM at boot —
 * `Date` and `Math.random` — so the same source over the same data is always
 * the same answer, which is what the smoke checks rest on. Execution is
 * bounded by an interrupt budget and the runtime's memory limit, so no
 * expression can hang the surface it renders on.
 */

import { parseExpressionAt } from "acorn";
import type { Expression, Node } from "acorn";
import type { QuickJSContext, QuickJSRuntime, QuickJSWASMModule } from "quickjs-emscripten-core";
import { isFail, newQuickJSWASMModuleFromVariant } from "quickjs-emscripten-core";
import type { Json } from "@vendoai/core";
import { stockVariant } from "./variant.js";

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

/** The one size gate on an expression source. Longer than any real computed
 *  value and short enough that parsing and evaluation stay cheap — it is what
 *  replaces the old dialect's nesting-depth bound. */
export const EXPR_MAX_CHARS = 1_000;

/** The JavaScript edition an expression is parsed against. Pinned rather than
 *  "latest" so the grammar a document is admitted under does not move when the
 *  parser is upgraded. */
const ECMA_VERSION = 2022;

export type ExprParse =
  | { ok: true; node: Expression }
  | { ok: false; issue: string };

/** Acorn reports position as `(line:column)` inside the message. An attribute
 *  is one fragment with no lines of its own, so the suffix is noise. */
const parseIssue = (error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error);
  return `this expression is not valid JavaScript: ${message.replace(/\s*\(\d+:\d+\)$/u, "")}`;
};

/**
 * Parse one expression source. Pure, deterministic, total: any input either
 * yields an ESTree expression or one issue written as a sentence. `node.end`
 * is where the expression stopped, which is how the wire compiler finds
 * trailing content.
 */
export function parseExpr(source: string): ExprParse {
  if (source.length > EXPR_MAX_CHARS) {
    return { ok: false, issue: `this expression is ${source.length} characters — an expression is at most ${EXPR_MAX_CHARS}; move the work into an <Island>` };
  }
  try {
    return { ok: true, node: parseExpressionAt(source, 0, { ecmaVersion: ECMA_VERSION }) };
  } catch (error) {
    return { ok: false, issue: parseIssue(error) };
  }
}

// ── free identifiers ────────────────────────────────────────────────────────

/** The child nodes of an ESTree node, whatever its type: every own value that
 *  is a node, or an array of them. Generic on purpose — a hand-written case per
 *  node type is a list that silently rots as the grammar edition moves. */
const childNodes = (node: Node): Node[] => {
  const children: Node[] = [];
  for (const value of Object.values(node as unknown as Record<string, unknown>)) {
    if (Array.isArray(value)) {
      for (const item of value) if (isNode(item)) children.push(item);
    } else if (isNode(value)) children.push(value);
  }
  return children;
};

const isNode = (value: unknown): value is Node =>
  typeof value === "object" && value !== null && typeof (value as { type?: unknown }).type === "string";

/** Every name a binding pattern introduces (an arrow function's parameters). */
const patternNames = (node: Node, into: Set<string>): void => {
  if (node.type === "Identifier") {
    into.add((node as unknown as { name: string }).name);
    return;
  }
  for (const child of childNodes(node)) patternNames(child, into);
};

/**
 * Every name a function BODY declares: `const`/`let`/`var` declarators, and any
 * function or class it declares. Collected BEFORE the body is walked, because a
 * name read above its own declaration is still that body's local and not a name
 * from outside. The walk stops at a nested function — its declarations belong to
 * IT, and its own pass collects them there.
 */
const declaredNames = (node: Node, into: Set<string>): void => {
  if (node.type === "VariableDeclarator") {
    patternNames((node as unknown as { id: Node }).id, into);
    return;
  }
  if (node.type === "FunctionDeclaration" || node.type === "ClassDeclaration") {
    const { id } = node as unknown as { id: Node | null };
    if (id !== null) patternNames(id, into);
    return;
  }
  if (node.type === "ArrowFunctionExpression" || node.type === "FunctionExpression") return;
  for (const child of childNodes(node)) declaredNames(child, into);
};

/**
 * The names an expression reads from OUTSIDE itself — the compiler's
 * unknown-reference gate and the fact check's. A function's parameters and the
 * locals its body declares are bound, not free, so
 * `rows.reduce((total, row) => total + row.n, 0)` and
 * `rows.map((r) => { const cents = r.amount; return cents / 100; })` both read
 * exactly `rows`.
 *
 * Non-computed member properties (`.data`) and non-computed object keys
 * (`{ label: … }`) are names of fields, not of values, so they are skipped.
 */
export function exprFreeIdentifiers(node: Node): string[] {
  const free: string[] = [];
  const walk = (current: Node, bound: ReadonlySet<string>): void => {
    if (current.type === "Identifier") {
      const { name } = current as unknown as { name: string };
      if (!bound.has(name) && !free.includes(name)) free.push(name);
      return;
    }
    if (current.type === "MemberExpression") {
      const member = current as unknown as { object: Node; property: Node; computed: boolean };
      walk(member.object, bound);
      if (member.computed) walk(member.property, bound);
      return;
    }
    if (current.type === "Property") {
      const property = current as unknown as { key: Node; value: Node; computed: boolean };
      if (property.computed) walk(property.key, bound);
      walk(property.value, bound);
      return;
    }
    if (current.type === "ArrowFunctionExpression" || current.type === "FunctionExpression" || current.type === "FunctionDeclaration") {
      const fn = current as unknown as { params: Node[]; body: Node };
      const inner = new Set(bound);
      for (const param of fn.params) patternNames(param, inner);
      declaredNames(fn.body, inner);
      walk(fn.body, inner);
      return;
    }
    for (const child of childNodes(current)) walk(child, bound);
  };
  walk(node, new Set());
  return free;
}

// ── the sealed interpreter ──────────────────────────────────────────────────

/** The total evaluation result. `ok: false` is the renderer's contained
 *  data-shape-notice path (the `$reshape` convention), never a throw. */
export type ExprResult =
  | { ok: true; value: Json | undefined }
  | { ok: false; issue: string };

/** Interrupt ticks one expression may spend. QuickJS calls the handler every
 *  few thousand bytecode operations, so this is generous for any real
 *  computation over a page of rows and still stops a runaway. */
const EXPR_MAX_TICKS = 10_000;

/** The VM's heap. An expression that tries to build a gigabyte of string dies
 *  with an out-of-memory error instead of taking the tab with it. */
const EXPR_MEMORY_LIMIT_BYTES = 32 * 1_024 * 1_024;

/** The two names the VM must NOT carry, because an expression that reads them
 *  answers differently on two identical renders and the smoke checks compare
 *  renders. Everything else QuickJS provides (the rest of Math, JSON, Object,
 *  Array, String, Number, Intl) is deterministic and stays.
 *
 *  `Math.random` is replaced rather than deleted: deleted, it reads as the
 *  useless "not a function", and the model repairing the expression has to
 *  guess what went wrong. */
const SEAL = `delete globalThis.Date;
Math.random = function () { throw new TypeError("Math.random() is not available here — a value on screen has to read the same twice"); };
0`;

/** The intrinsics that survive the SEAL, and therefore the names an expression
 *  may read that are NOT query data. The scope gates below need this list
 *  because a free name they refuse reads as loading forever and a fact finding
 *  says it names no query — both of which would be lies about a name the VM
 *  really carries. `Date` is absent on purpose: the SEAL deletes it, so an
 *  expression that reads it IS a finding. Add a name here only when the SEAL
 *  leaves it deterministic. */
export const SEALED_GLOBALS: ReadonlySet<string> = new Set(["Math", "JSON", "Object", "Array", "String", "Number", "Intl"]);

/** The VM's own call-stack bound. Without one, a self-recursive expression
 *  overflows the WEBASSEMBLY stack, which surfaces as a host RangeError that
 *  tears through this module — the one input that could make evaluation
 *  non-total. With one, QuickJS raises a catchable "stack overflow" instead. */
const EXPR_MAX_STACK_BYTES = 512 * 1_024;

let booting: Promise<QuickJSWASMModule> | null = null;
let runtime: QuickJSRuntime | null = null;
/** The live context and the data identity it was built around (see
 *  {@link contextFor}). */
let held: { data: object; context: QuickJSContext } | null = null;

/**
 * Boot the interpreter. Evaluation is synchronous, but the WebAssembly module
 * behind it loads once, asynchronously — so a caller that must not miss the
 * first render (a server-side render, a test) awaits this first. A renderer
 * does not have to: an expression evaluated before the boot lands reads as
 * `undefined`, which is exactly how it reads while its query data is still in
 * flight, and the boot races a network round-trip it reliably wins.
 *
 * The variant is the engine's own — ./variant.ts, one build and one set of
 * WebAssembly bytes for the screen engine and for this.
 */
export async function warmExprRuntime(): Promise<void> {
  booting ??= newQuickJSWASMModuleFromVariant(stockVariant());
  const quickjs = await booting;
  runtime ??= quickjs.newRuntime();
  runtime.setMemoryLimit(EXPR_MEMORY_LIMIT_BYTES);
  runtime.setMaxStackSize(EXPR_MAX_STACK_BYTES);
}

/** Kick the boot off on first use so a renderer never has to think about it. */
const startBoot = (): void => {
  if (booting === null) void warmExprRuntime().catch(() => undefined);
};

/** The query names an expression may read. A key that is not a bare identifier
 *  cannot be a parameter name, so it is not offered — the expression grammar
 *  could not have named it either. */
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/**
 * ONE context per `data` identity, disposed when the identity moves on.
 *
 * A context is where the marshalled data lives, and re-marshalling a page of
 * rows for every binding on the screen is the whole cost of evaluation (~14x).
 * A render passes the SAME data object for every binding it resolves, so one
 * context per render is both the cheap answer and the isolated one: two apps on
 * a page hold different data objects and therefore never share a context, and
 * the only thing an expression can reach is a sibling binding of its own app —
 * which is data it can already read.
 */
const discardContext = (): void => {
  held?.context.dispose();
  held = null;
};

const contextFor = (data: Record<string, Json>, names: readonly string[]): QuickJSContext | null => {
  if (runtime === null) return null;
  if (held?.data === data) return held.context;
  discardContext();
  const context = runtime.newContext();
  held = { data, context };
  const setup = context.evalCode(
    `${SEAL}; var $vendoData = JSON.parse(${JSON.stringify(JSON.stringify(pick(data, names)))}); 0`,
  );
  (isFail(setup) ? setup.error : setup.value).dispose();
  return context;
};

const pick = (data: Record<string, Json>, names: readonly string[]): Record<string, Json> =>
  Object.fromEntries(names.map((name) => [name, data[name] as Json]));

/**
 * Evaluate one expression against the renderer's resolved query data (keyed by
 * query name). Total: an evaluation problem yields the issue the renderer shows
 * as its contained data-shape notice, never a throw. Deterministic — same
 * source, same data, same answer.
 *
 * The scope is EXACTLY the query data. There is no `fmt`, no `tools`, no
 * ambient host object and no clock: a value is formatted by the component that
 * displays it, and an island is where code that needs more than this belongs.
 */
export function evaluateExpr(source: string, data: Record<string, Json>): ExprResult {
  const parsed = parseExpr(source);
  if (!parsed.ok) return { ok: false, issue: parsed.issue };
  startBoot();
  const names = Object.keys(data).filter((name) => IDENTIFIER.test(name));
  // A query this expression reads has not answered yet. In JavaScript, reading
  // through it would THROW, and the renderer would paint a data-shape notice
  // over every value on screen for as long as the fetch is in flight — so the
  // whole expression reads as empty instead. Loading is never a mismatch, the
  // same discipline `$path` and `$reshape` keep, and the same answer the old
  // dialect gave (either operand still loading meant the value was loading).
  //
  // A key present with a `null` value has not answered either: `null` is what a
  // query reads as before its answer lands, so `invoices.length` over it would
  // throw for the same reason an absent key would.
  const arrived = new Set(names.filter((name) => data[name] !== null));
  if (exprFreeIdentifiers(parsed.node).some((name) => !arrived.has(name) && !SEALED_GLOBALS.has(name))) {
    return { ok: true, value: undefined };
  }
  const context = contextFor(data, names);
  // The boot has not landed yet. Reads as loading, never as a mismatch.
  if (context === null || runtime === null) return { ok: true, value: undefined };
  let ticks = 0;
  runtime.setInterruptHandler(() => (ticks += 1) > EXPR_MAX_TICKS);
  // The result is wrapped in an object so an expression yielding `undefined`
  // arrives as an ABSENT field rather than as the string "undefined".
  const code = `(function({${names.join(",")}}){ return JSON.stringify({ v: (${source}) }); })($vendoData)`;
  let result;
  try {
    result = context.evalCode(code);
  } catch (error) {
    // The VM itself failed, not the expression — an exhausted WebAssembly
    // stack or a broken module. The context cannot be trusted afterwards, so
    // it is dropped and the next expression builds a fresh one.
    discardContext();
    runtime.removeInterruptHandler();
    return { ok: false, issue: `this expression could not be computed: ${error instanceof Error ? error.message : String(error)}` };
  }
  runtime.removeInterruptHandler();
  if (isFail(result)) {
    const thrown = context.dump(result.error) as { name?: unknown; message?: unknown };
    result.error.dispose();
    const name = typeof thrown.name === "string" ? thrown.name : "Error";
    const message = typeof thrown.message === "string" ? thrown.message : String(thrown);
    return {
      ok: false,
      issue: ticks > EXPR_MAX_TICKS
        ? "this expression did not finish — it is doing too much work for a value on screen; move it into an <Island>"
        : `this expression threw ${name}: ${message}`,
    };
  }
  const json = context.dump(result.value) as unknown;
  result.value.dispose();
  if (typeof json !== "string") return { ok: true, value: undefined };
  const wrapper = JSON.parse(json) as { v?: Json };
  return { ok: true, value: wrapper.v };
}

// ── the fact check ──────────────────────────────────────────────────────────

export interface ExprCheckContext {
  /** The declared query names; a free name matching none is a fact finding. */
  queryNames: readonly string[];
}

/**
 * The FACT check behind an `$expr`: it parses as a JavaScript expression, it is
 * within the size cap, and every name it reads is a query the screen declared or
 * an intrinsic the sealed VM carries ({@link SEALED_GLOBALS}).
 *
 * FIELD existence and TYPES are deliberately not here. The screen prints back
 * as a strict TSX subset and the checks floor runs the real compiler over it
 * against the queries' declared result types (checking/screen-typings.ts), so
 * `invoices.data.reduce((t, r) => t + r.amont, 0)` is a tsc error naming the
 * real fields — a better finding than a bespoke walker could write, from the
 * one type checker instead of a second one that can disagree with it.
 */
export function checkExpr(source: string, context: ExprCheckContext): string[] {
  const parsed = parseExpr(source);
  if (!parsed.ok) return [parsed.issue];
  const declared = new Set(context.queryNames);
  return exprFreeIdentifiers(parsed.node)
    .filter((name) => !declared.has(name) && !SEALED_GLOBALS.has(name))
    .map((name) => `"${name}" does not name a declared query; the queries are: ${context.queryNames.join(", ") || "(none declared)"}`);
}
