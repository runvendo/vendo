/**
 * Internal: the wire expression grammar — the `attr={...}` sub-language of
 * the vendo-genui/v2 markup (v2 spec §2,
 * docs/superpowers/specs/2026-07-18-vendo-v2-format-spec.md). The wire
 * markup compiler hands this module the text BETWEEN an attribute's braces;
 * it returns canonical JSON with `$path`/`$state` bindings compiled in. Only
 * the issue contract (`WIRE_ISSUE_CODES`, `WireIssueCode`, `WireIssue`) is
 * exported from the package root; the parser itself stays internal.
 *
 * The grammar is a JavaScript EXPRESSION. There is no second grammar and no
 * hand-rolled tokenizer: expr.ts parses the whole attribute once (acorn) and
 * this module LOWERS the resulting expression — literals become JSON, a dotted
 * reference rooted at a declared `<Query>` or `state` becomes a binding, and
 * everything that actually computes becomes `{ $expr }` carrying its source
 * VERBATIM so the printer re-emits exactly what the model wrote. Because the
 * grammar is real JavaScript, JSON5-lite comes for free — single quotes,
 * trailing commas and bare object keys are all already legal — and a binding
 * nested at any depth inside an array or object literal lowers in place.
 *
 * The parser is total: malformed input yields `dropped: true` with issues,
 * never a throw. Evaluation never happens here — it happens at bind resolution
 * in the renderer.
 */

import {
  defineOwn,
  isWellFormedUtf16,
  type Json,
  type PathBinding,
  safeErrorMessage,
  type StateBinding,
} from "@vendoai/core";
import type { Expression, Node } from "acorn";
import { exprFreeIdentifiers, parseExpr, SEALED_GLOBALS, type ExprBinding } from "../expr.js";

/**
 * v2 spec §2 — the closed registry of stable issue codes across all six
 * wire modules. This is the renderer / wave-3-repair contract: a typo'd
 * code fails compile, and adding a code means adding it here first.
 */
export const WIRE_ISSUE_CODES = [
  // — expression layer (this module; no index, positions are attribute-relative)
  /** Expression text violates the literal/binding grammar; attribute dropped. */
  "malformed-expression",
  /** Bare identifier names no declared `<Query>` or `state`; attribute dropped. */
  "unknown-reference",
  /** `state.<a>.<b>` — state bindings take exactly one key; attribute dropped. */
  "state-depth-unsupported",
  // — attribute layer (attributes.ts)
  /** Attribute syntax error (bad char, single-quoted string, missing value, ill-formed UTF-16); attribute dropped or char skipped. */
  "malformed-attribute",
  /** Same attribute name twice in one tag; the last one wins, unless it was
   *  dropped — then whichever value actually landed stands, and the message
   *  says which, up to none of them. */
  "duplicate-attribute",
  /** Wire-supplied `id` on a non-declaration element ignored (ids are compiler-owned). */
  "wire-id-ignored",
  /** Action names neither a host tool nor a valid fn: reference (string form), or an invalid fn: action hides anywhere in an expression value; attribute dropped. */
  "invalid-action",
  // — document shape (compile.ts)
  /** Input is not a single `<App ...>...</App>` element; empty tree emitted. */
  "missing-app",
  /** `<App>` cannot nest; the inner App and its subtree skipped. */
  "nested-app",
  /** Non-whitespace content after `</App>` dropped; marks incomplete. */
  "trailing-content",
  /** Close tag matches no open element; ignored. */
  "stray-close-tag",
  /** Non-PascalCase/unknown tag; the element and its subtree skipped. */
  "unknown-element",
  /** Junk inside a close tag (close tags take no attributes); ignored, still closes. */
  "malformed-close-tag",
  /** Text child contains a lone surrogate (ill-formed UTF-16); text skipped. */
  "malformed-text",
  /** v3 §5 (D5) — braces in text position are not interpolation; the run was
   *  skipped. A value reaches text through a binding (`<Text text={q.f}/>`);
   *  `{q.f}` written between tags renders literally, which is the raw-braces
   *  class. `{/* … *␘/}` is the one legal brace run in text (a comment, D4). */
  "braces-in-text",
  // — truncation & closing (compile.ts, scan.ts)
  /** Mismatched close tag implicitly closed the elements above its match. */
  "unclosed-element",
  /** Element (or App) still open at EOF was auto-closed; marks incomplete. */
  "eof-unclosed",
  /** Open tag truncated at EOF (incl. a lone trailing `<`); element dropped. */
  "truncated-tag",
  /** Skipped/raw element (unknown subtree, Island content) unterminated at EOF. */
  "unclosed-skipped",
  // — queries (compile.ts)
  /** `<Query>` below App level; the query was still hoisted. */
  "nested-query",
  /** Paired `<Query>` content is not allowed; content skipped, query kept. */
  "query-content",
  /** `<Query>` id missing/not an identifier/reserved "state"; query dropped. */
  "invalid-query-name",
  /** `<Query>` tool missing/empty/bad fn: grammar; query dropped. */
  "invalid-query-tool",
  /** `<Query>` input is not an object expression; input dropped, query kept. */
  "invalid-query-input",
  /** Duplicate query name; the first one wins. */
  "duplicate-query",
  // — islands (compile.ts)
  /** `<Island>` name missing/not PascalCase/reserved; island skipped. */
  "invalid-island-name",
  /** Duplicate island name; the first one wins. */
  "duplicate-island",
  /** Self-closing `<Island/>` has no source; island skipped. */
  "island-no-content",
  // — shape check (shape-check.ts)
  /** A binding names fields absent from the tool's KNOWN response shape (or
   *  a reshape op incompatible with it); mirrored one-per-binding in
   *  WireCompileResult.bindingErrors, the per-binding repair contract. */
  "shape-mismatch",
  // — §8 limits & hygiene (limits.ts, state.ts)
  /** TREE_MAX_NODES reached; further elements parse but produce no nodes (once). */
  "node-limit",
  /** TREE_MAX_QUERIES hoisted; further queries dropped (once). */
  "query-limit",
  /** TREE_MAX_GENERATED_COMPONENTS admitted; further islands dropped (once). */
  "component-limit",
  /** Island source over the per-source or total UTF-8 byte cap; island dropped. */
  "component-size-limit",
  /** Island raw TSX contains a lone surrogate (ill-formed UTF-16); island dropped. */
  "malformed-island",
  /** Issue list capped at WIRE_MAX_ISSUES; always the final entry when present. */
  "issues-truncated",
  // — totality (compile.ts)
  /** compileWireUnsafe threw; degraded to the empty valid tree. Never expected. */
  "compile-failed",
] as const;

/** v2 spec §2 — a stable wire issue code (see {@link WIRE_ISSUE_CODES}). */
export type WireIssueCode = (typeof WIRE_ISSUE_CODES)[number];

/** v2 spec §2 — one compiler-visible issue. Codes are stable kebab-case from
 *  the closed {@link WIRE_ISSUE_CODES} registry; the markup compiler reuses
 *  this shape. `index` is a best-effort source position: the markup compiler
 *  records its cursor when the position is at hand; expression-layer issues
 *  omit it (their indices are relative to the attribute's inner text, not
 *  the wire). */
export interface WireIssue {
  code: WireIssueCode;
  message: string;
  index?: number;
}

/**
 * The ADVISORY codes: the compiler normalized something and the tree it produced
 * is already what the author meant, so there is nothing to repair and no
 * validation door may refuse a document over one.
 *
 * `wire-id-ignored` is the reason this exists. It is what our OWN printer
 * produces — an app's `app.vendo` is written with
 * `printWire(…, { includeIds: true })` (`@vendoai/apps` app-source.ts), so every
 * element of a checked-out app carries an id the compiler then ignores. The paint
 * seam waved that through and painted it; the create/edit validators turned every
 * wire issue into a block and refused the same bytes. Every OTHER code drops
 * something the author actually wrote, so it stays blocking.
 */
export const WIRE_ADVISORY_ISSUE_CODES: readonly WireIssueCode[] = ["wire-id-ignored"];

/** True for an issue no door may block on — the one classification all four
 *  share (see {@link WIRE_ADVISORY_ISSUE_CODES}). */
export const isAdvisoryWireIssue = ({ code }: WireIssue): boolean =>
  WIRE_ADVISORY_ISSUE_CODES.includes(code);

/** v2 spec §2 — the declared `<Query>` names in scope for binding resolution. */
export interface ExpressionContext {
  queryNames: ReadonlySet<string>;
}

/** v2 spec §2 — `dropped: true` means the attribute must be omitted. Issues
 *  are ordered in source order; empty when the parse is clean. */
export type ExpressionResult =
  | { value: Json; dropped: false; issues: WireIssue[] }
  | { value?: undefined; dropped: true; issues: WireIssue[] };

/** Internal lowering-failure sentinel — flows up the recursion instead of a
 *  throw so every frame unwinds cleanly with issues already recorded. */
const FAILED: unique symbol = Symbol("expression-lowering-failed");
type Failed = typeof FAILED;

interface LowerState {
  readonly source: string;
  readonly issues: WireIssue[];
  readonly queryNames: ReadonlySet<string>;
}

const fail = (state: LowerState, code: WireIssueCode, message: string): Failed => {
  state.issues.push({ code, message });
  return FAILED;
};

const malformed = (state: LowerState, message: string): Failed =>
  fail(state, "malformed-expression", message);

const unknownReference = (state: LowerState, name: string, tail: string): Failed => fail(
  state,
  "unknown-reference",
  `"${name}" does not name a declared <Query> or state; the queries are: ${[...state.queryNames].join(", ") || "(none declared)"}${tail}`,
);

/** The narrow node shapes this module reads. Acorn's own types model every
 *  edition at once, so the fields are read through these instead of a cast at
 *  each site. */
type Named = Node & { name: string };
type Valued = Node & { value: unknown; regex?: unknown; bigint?: unknown };
type Member = Node & { object: Node; property: Node; computed: boolean; optional: boolean };
type Unary = Node & { operator: string; argument: Node };

/**
 * A dotted reference's segments, or null when the node is not a pure reference:
 * identifier hops (`invoices.data`) and numeric-index hops
 * (`accounts.data.0.field`, written either way), nothing optional, nothing
 * computed by a value. Anything else COMPUTES, and computing is `$expr`'s job.
 */
const referenceSegments = (node: Node): string[] | null => {
  if (node.type === "Identifier") return [(node as Named).name];
  if (node.type !== "MemberExpression") return null;
  const member = node as Member;
  if (member.optional) return null;
  const head = referenceSegments(member.object);
  if (head === null) return null;
  if (!member.computed) {
    if (member.property.type !== "Identifier") return null;
    const name = (member.property as Named).name;
    // `length` is JavaScript's, not the data's: a JSON Pointer walk cannot
    // reach an array's length, so lowering `rows.length` to a `$path` would
    // bind an empty value instead of a count. It COMPUTES.
    return name === "length" ? null : [...head, name];
  }
  // `rows[0]` and `rows.0` address the same place; a computed STRING key
  // (`row["a b"]`) is a field name a JSON Pointer can carry too.
  const key = member.property.type === "Literal" ? (member.property as Valued).value : undefined;
  if (typeof key === "number" && Number.isInteger(key) && key >= 0) return [...head, String(key)];
  if (typeof key === "string" && key.length > 0 && !key.includes("/") && !key.includes("~")) {
    return [...head, key];
  }
  return null;
};

/**
 * A dotted reference lowers to a binding: `state.<key>` → StateBinding,
 * `<queryName>[.<seg>...]` → PathBinding with a JSON Pointer, anything else →
 * `unknown-reference` (the containing attribute value is dropped — the
 * simplest total rule). `true`/`false`/`null` never arrive here: they are
 * JavaScript literals, so they can no longer be shadowed by a query of the
 * same name.
 */
const lowerReference = (state: LowerState, segments: readonly string[], text: string): Json | Failed => {
  const first = segments[0] as string;
  if (first === "state") {
    if (segments.length !== 2) {
      return fail(
        state,
        "state-depth-unsupported",
        `state bindings take exactly one key (state.<key>); got "${text}"`,
      );
    }
    const binding: StateBinding = { $state: segments[1] as string };
    return binding as unknown as Json;
  }
  if (state.queryNames.has(first)) {
    const binding: PathBinding = { $path: `/${segments.join("/")}` };
    return binding as unknown as Json;
  }
  return unknownReference(state, text, " — there is no loop variable, so a fixed row reads by position off one of them (cities[0].temp)");
};

/**
 * A node that COMPUTES becomes `{ $expr }` carrying its own source slice
 * verbatim, so the printer re-emits exactly what the model wrote. Every name
 * the expression reads from outside itself must be a declared query — a
 * function's own parameters and locals are bound, so
 * `rows.reduce((t, r) => t + r.n, 0)` is checked against `rows` alone.
 * Evaluation happens at bind resolution in the renderer, never here.
 */
const lowerComputed = (state: LowerState, node: Node): Json | Failed => {
  // The sealed VM's own intrinsics are not query data, but they are really there:
  // this gate must admit exactly what expr.ts's fact check passes and its
  // evaluator computes, or the compiler drops an attribute over a name that works.
  const unknown = exprFreeIdentifiers(node)
    .filter((name) => !state.queryNames.has(name) && !SEALED_GLOBALS.has(name));
  if (unknown.length > 0) {
    for (const name of unknown) unknownReference(state, name, "");
    return FAILED;
  }
  const binding: ExprBinding = { $expr: state.source.slice(node.start, node.end) };
  return binding as unknown as Json;
};

/** A string literal's value, refused when it is ill-formed UTF-16: canonicalJson
 *  (jcs.ts) throws on lone surrogates downstream, so letting one through would
 *  un-drop the totality guarantee one layer up. */
const lowerString = (state: LowerState, text: string): Json | Failed =>
  isWellFormedUtf16(text) ? text : malformed(state, "string contains a lone surrogate (ill-formed UTF-16)");

/** A numeric literal's value, refused when the literal overflowed to ±Infinity
 *  (`1e999`) — the same reason a lone surrogate is refused: canonicalJson
 *  (jcs.ts) throws on a non-finite number downstream, so letting one through
 *  would un-drop the totality guarantee one layer up. */
const lowerNumber = (state: LowerState, value: number, text: string): Json | Failed =>
  Number.isFinite(value)
    ? value
    : malformed(state, `${text} overflows to ${String(value)}, which is not a value an attribute can carry`);

const lowerArray = (state: LowerState, node: Node): Json | Failed => {
  const { elements } = node as Node & { elements: (Node | null)[] };
  // A hole (`[1, , 2]`) or a spread cannot be lowered element-wise, so the
  // whole literal computes instead.
  if (elements.some((element) => element === null || element.type === "SpreadElement")) {
    return lowerComputed(state, node);
  }
  const items: Json[] = [];
  for (const element of elements) {
    const item = lower(state, element as Node);
    if (item === FAILED) return FAILED;
    items.push(item);
  }
  return items;
};

const lowerObject = (state: LowerState, node: Node): Json | Failed => {
  const { properties } = node as Node & { properties: Node[] };
  const keyed: Array<[string, Node]> = [];
  for (const property of properties) {
    const entry = property as Node & { key: Node; value: Node; computed: boolean; kind?: string };
    if (property.type !== "Property" || entry.computed || (entry.kind !== undefined && entry.kind !== "init")) {
      return lowerComputed(state, node);
    }
    const key = entry.key.type === "Identifier"
      ? (entry.key as Named).name
      : entry.key.type === "Literal" ? String((entry.key as Valued).value) : null;
    if (key === null) return lowerComputed(state, node);
    keyed.push([key, entry.value]);
  }
  const record: Record<string, Json> = {};
  for (const [key, value] of keyed) {
    const lowered = lower(state, value);
    if (lowered === FAILED) return FAILED;
    // defineOwn: a wire key named __proto__ must become data, never the
    // result's prototype.
    defineOwn(record, key, lowered);
  }
  return record;
};

function lower(state: LowerState, node: Node): Json | Failed {
  if (node.type === "Literal") {
    const literal = node as Valued;
    if (literal.regex !== undefined || literal.bigint !== undefined) {
      return malformed(state, `${state.source.slice(node.start, node.end)} is not a value an attribute can carry`);
    }
    const { value } = literal;
    if (typeof value === "string") return lowerString(state, value);
    if (typeof value === "number") return lowerNumber(state, value, state.source.slice(node.start, node.end));
    if (typeof value === "boolean" || value === null) return value;
    return malformed(state, `${state.source.slice(node.start, node.end)} is not a value an attribute can carry`);
  }
  // A signed literal is still a literal (`-0` and `-2.5` stay numbers).
  if (node.type === "UnaryExpression") {
    const unary = node as Unary;
    const inner = unary.argument as Valued;
    if ((unary.operator === "-" || unary.operator === "+") && inner.type === "Literal" && typeof inner.value === "number") {
      const signed = unary.operator === "-" ? -inner.value : inner.value;
      return lowerNumber(state, signed, state.source.slice(node.start, node.end));
    }
    return lowerComputed(state, node);
  }
  if (node.type === "ArrayExpression") return lowerArray(state, node);
  if (node.type === "ObjectExpression") return lowerObject(state, node);
  const segments = referenceSegments(node);
  // A sealed global reads as itself, never as a path into query data: `/Math/PI`
  // would bind an empty value, so `Math.PI` COMPUTES in the VM like any other
  // expression naming an intrinsic.
  if (segments !== null && !SEALED_GLOBALS.has(segments[0] as string)) {
    return lowerReference(state, segments, state.source.slice(node.start, node.end));
  }
  return lowerComputed(state, node);
}

const parseExpressionUnsafe = (source: string, context: ExpressionContext): ExpressionResult => {
  const state: LowerState = { source, issues: [], queryNames: context.queryNames };
  const parsed = parseExpr(source);
  if (!parsed.ok) {
    malformed(state, parsed.issue);
    return { dropped: true, issues: state.issues };
  }
  const node: Expression = parsed.node;
  const trailing = source.slice(node.end).trim();
  if (trailing !== "") {
    malformed(state, `unexpected trailing content at index ${node.end} ("${trailing.slice(0, 24)}")`);
    return { dropped: true, issues: state.issues };
  }
  const value = lower(state, node);
  if (value === FAILED) return { dropped: true, issues: state.issues };
  return { value, dropped: false, issues: state.issues };
};

/**
 * v2 spec §2 — parse one attribute expression (`source` is the text between
 * the attribute braces; the caller strips the outer braces). Total: never
 * throws on any input — malformed input, including pathological nesting,
 * yields `dropped: true` with a `malformed-expression` issue.
 */
export function parseExpression(source: string, context: ExpressionContext): ExpressionResult {
  const issues: WireIssue[] = [];
  try {
    return parseExpressionUnsafe(source, context);
  } catch (error) {
    issues.push({
      code: "malformed-expression",
      message: `expression parse failed: ${safeErrorMessage(error)}`,
    });
    return { dropped: true, issues };
  }
}
