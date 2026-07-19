/**
 * Internal: the v2 wire expression grammar — the `attr={...}` sub-language of
 * the vendo-genui/v2 markup (v2 spec §2,
 * docs/superpowers/specs/2026-07-18-vendo-v2-format-spec.md). The wire-v2
 * markup compiler hands this module the text BETWEEN an attribute's braces;
 * it returns canonical JSON with `$path`/`$state` bindings compiled in. Only
 * the issue contract (`WIRE_ISSUE_CODES`, `WireIssueCode`, `WireIssue`) is
 * exported from the package root; the parser itself stays internal.
 *
 * The grammar is JSON5-lite: JSON literals, single- OR double-quoted strings,
 * arrays/objects with trailing commas and bare object keys, plus bare dotted
 * identifier paths in value position that compile to bindings. The parser is
 * total — malformed input yields `dropped: true` with issues, never a throw.
 */

import { safeErrorMessage } from "../errors.js";
import type { Json } from "../ids.js";
import { findInvalidReshapeSteps, type ReshapeStep } from "../reshape.js";
import { isPathBinding, isStateBinding, type PathBinding, type StateBinding } from "../tree.js";
import { isWellFormedUtf16 } from "./state.js";

/**
 * v2 spec §2 — the closed registry of stable issue codes across all six
 * wire-v2 modules. This is the renderer / wave-3-repair contract: a typo'd
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
  /** `|` reshape pipe violates the bounded vocabulary (unknown op, arity,
   *  arg kind, chain cap, malformed call syntax); attribute dropped. */
  "invalid-reshape",
  // — attribute layer (attributes.ts)
  /** Attribute syntax error (bad char, single-quoted string, missing value, ill-formed UTF-16); attribute dropped or char skipped. */
  "malformed-attribute",
  /** Same attribute name twice in one tag; the last one wins. */
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
  // — edit dialect (patch.ts; v2 spec §5)
  /** The patch document is not a single `<Edit>...</Edit>`; base returned. */
  "missing-edit",
  /** An op anchors an id/name that does not exist; the op was skipped. */
  "unknown-target",
  /** Unknown op element, missing required anchor/attrs, bad index, root or
   *  cycle violation; the op was skipped. */
  "invalid-patch-op",
  /** The applied result failed re-validation; the base was returned
   *  unchanged. Never expected from compiler-produced bases. */
  "patch-invalid",
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
  /** compileWireV2Unsafe threw; degraded to the empty valid tree. Never expected. */
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

/** v2 spec §2 — the declared `<Query>` names in scope for binding resolution. */
export interface ExpressionContext {
  queryNames: ReadonlySet<string>;
}

/** v2 spec §2 — `dropped: true` means the attribute must be omitted. Issues
 *  are ordered in source order; empty when the parse is clean. */
export type ExpressionResult =
  | { value: Json; dropped: false; issues: WireIssue[] }
  | { value?: undefined; dropped: true; issues: WireIssue[] };

/** Internal parse-failure sentinel — flows up the recursion instead of a
 *  throw so every frame unwinds cleanly with issues already recorded. */
const FAILED: unique symbol = Symbol("expression-parse-failed");
type Failed = typeof FAILED;

interface ParserState {
  readonly source: string;
  index: number;
  readonly issues: WireIssue[];
  readonly queryNames: ReadonlySet<string>;
}

const WHITESPACE = /\s/;
const IDENTIFIER_START = /[A-Za-z_]/;
const IDENTIFIER_CHAR = /[A-Za-z0-9_]/;
/** JSON number grammar, matched sticky at the cursor. */
const NUMBER_PATTERN = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;

const skipWhitespace = (state: ParserState): void => {
  while (state.index < state.source.length && WHITESPACE.test(state.source[state.index] as string)) {
    state.index += 1;
  }
};

const fail = (state: ParserState, code: WireIssueCode, message: string): Failed => {
  state.issues.push({ code, message });
  return FAILED;
};

const malformed = (state: ParserState, message: string): Failed =>
  fail(state, "malformed-expression", message);

const parseNumber = (state: ParserState): number | Failed => {
  NUMBER_PATTERN.lastIndex = state.index;
  const match = NUMBER_PATTERN.exec(state.source);
  if (match === null) {
    return malformed(state, `invalid number at index ${state.index}`);
  }
  state.index = NUMBER_PATTERN.lastIndex;
  const value = Number(match[0]);
  // A grammar-valid literal like 1e999 overflows to ±Infinity, which is not
  // JSON: canonicalJson (jcs.ts) throws on non-finite numbers, so letting it
  // through would un-drop the totality guarantee one layer up.
  if (!Number.isFinite(value)) {
    return malformed(state, `number literal "${match[0]}" overflows to a non-finite value`);
  }
  return value;
};

const HEX_ESCAPE = /^[0-9a-fA-F]{4}$/;

/** Quote char and backslash escape themselves; `\n`/`\t`/`\r` become
 *  newline/tab/carriage return; `\uXXXX` decodes a UTF-16 code unit
 *  (surrogate pairs combine); any other escaped character passes through
 *  verbatim (lenient, total). Ill-formed UTF-16 — a lone surrogate, literal
 *  or escape-produced — is rejected: canonicalJson (jcs.ts) throws on lone
 *  surrogates downstream, so letting one through would un-drop the totality
 *  guarantee one layer up. */
const parseString = (state: ParserState): string | Failed => {
  const quote = state.source[state.index] as string;
  state.index += 1;
  let text = "";
  while (state.index < state.source.length) {
    const char = state.source[state.index] as string;
    if (char === quote) {
      state.index += 1;
      if (!isWellFormedUtf16(text)) {
        return malformed(state, "string contains a lone surrogate (ill-formed UTF-16)");
      }
      return text;
    }
    if (char === "\\") {
      const escaped = state.source[state.index + 1];
      if (escaped === undefined) break;
      if (escaped === "u") {
        const hex = state.source.slice(state.index + 2, state.index + 6);
        if (!HEX_ESCAPE.test(hex)) {
          return malformed(state, `invalid \\u escape at index ${state.index} (expected 4 hex digits)`);
        }
        text += String.fromCharCode(Number.parseInt(hex, 16));
        state.index += 6;
        continue;
      }
      text += escaped === "n" ? "\n" : escaped === "t" ? "\t" : escaped === "r" ? "\r" : escaped;
      state.index += 2;
      continue;
    }
    text += char;
    state.index += 1;
  }
  return malformed(state, `unterminated string (opened with ${quote})`);
};

const parseIdentifier = (state: ParserState): string | Failed => {
  const start = state.index;
  if (start >= state.source.length || !IDENTIFIER_START.test(state.source[start] as string)) {
    return malformed(state, `expected identifier at index ${state.index}`);
  }
  state.index += 1;
  while (state.index < state.source.length && IDENTIFIER_CHAR.test(state.source[state.index] as string)) {
    state.index += 1;
  }
  return state.source.slice(start, state.index);
};

/**
 * A bare dotted identifier path in value position: `true`/`false`/`null`
 * keywords (which always win over a same-named query), `state.<key>` →
 * StateBinding, `<queryName>[.<seg>...]` → PathBinding with a JSON Pointer,
 * anything else → `unknown-reference` (the containing attribute value is
 * dropped — the simplest total rule).
 */
const parseReference = (state: ParserState): Json | Failed => {
  const first = parseIdentifier(state);
  if (first === FAILED) return FAILED;
  const segments = [first];
  while (state.source[state.index] === ".") {
    state.index += 1;
    const segment = parseIdentifier(state);
    if (segment === FAILED) return FAILED;
    segments.push(segment);
  }
  if (segments.length === 1) {
    if (first === "true") return true;
    if (first === "false") return false;
    if (first === "null") return null;
  }
  if (first === "state") {
    if (segments.length !== 2) {
      return fail(
        state,
        "state-depth-unsupported",
        `state bindings take exactly one key (state.<key>); got "${segments.join(".")}"`,
      );
    }
    const binding: StateBinding = { $state: segments[1] as string };
    return binding;
  }
  if (state.queryNames.has(first)) {
    const binding: PathBinding = { $path: `/${segments.join("/")}` };
    return binding;
  }
  return fail(
    state,
    "unknown-reference",
    `"${segments.join(".")}" does not name a declared <Query> or state`,
  );
};

/** v2 spec §3 — one `op(arg, ...)` pipe segment. Args are bare identifiers
 *  or quoted strings; trailing commas are tolerated (same as arrays). All
 *  syntax failures are `invalid-reshape` (the attribute drops). */
const parsePipeStep = (state: ParserState): ReshapeStep | Failed => {
  skipWhitespace(state);
  if (state.index >= state.source.length || !IDENTIFIER_START.test(state.source[state.index] as string)) {
    return fail(state, "invalid-reshape", `expected a reshape op after "|" at index ${state.index}`);
  }
  const op = parseIdentifier(state);
  if (op === FAILED) return FAILED;
  skipWhitespace(state);
  if (state.source[state.index] !== "(") {
    return fail(state, "invalid-reshape", `reshape op "${op}" needs an argument list: ${op}(...)`);
  }
  state.index += 1;
  const args: string[] = [];
  for (;;) {
    skipWhitespace(state);
    if (state.index >= state.source.length) {
      return fail(state, "invalid-reshape", `unterminated reshape call "${op}(" (expected ')')`);
    }
    const char = state.source[state.index] as string;
    if (char === ")") {
      state.index += 1;
      break;
    }
    if (char === '"' || char === "'") {
      const text = parseString(state);
      if (text === FAILED) return FAILED;
      args.push(text);
    } else if (IDENTIFIER_START.test(char)) {
      const identifier = parseIdentifier(state);
      if (identifier === FAILED) return FAILED;
      args.push(identifier);
    } else {
      return fail(state, "invalid-reshape", `unexpected character "${char}" in reshape args at index ${state.index}`);
    }
    skipWhitespace(state);
    const next = state.source[state.index];
    if (next === ",") {
      state.index += 1;
      continue;
    }
    if (next === ")") {
      state.index += 1;
      break;
    }
    return fail(state, "invalid-reshape", `expected ',' or ')' in reshape args at index ${state.index}`);
  }
  // The step's op is validated as a chain by findInvalidReshapeSteps at the
  // pipe-chain level; the cast just carries the parsed surface form there.
  return { op, args } as ReshapeStep;
};

/**
 * v2 spec §3 — an optional `| op(...) | op2(...)` chain after a reference.
 * Legal only on query/state bindings (a pipe after a literal is malformed);
 * the parsed chain is validated against the closed vocabulary
 * (findInvalidReshapeSteps — unknown op, arity, format kinds, chain cap) and
 * compiles onto the binding as canonical `$reshape` steps.
 */
const parsePipes = (state: ParserState, base: Json): Json | Failed => {
  const beforePipe = state.index;
  skipWhitespace(state);
  if (state.source[state.index] !== "|") {
    state.index = beforePipe;
    return base;
  }
  if (!isPathBinding(base) && !isStateBinding(base)) {
    return malformed(state, `reshape pipes apply to query/state bindings only (at index ${state.index})`);
  }
  const steps: ReshapeStep[] = [];
  while (state.source[state.index] === "|") {
    state.index += 1;
    const step = parsePipeStep(state);
    if (step === FAILED) return FAILED;
    steps.push(step);
    skipWhitespace(state);
  }
  const violation = findInvalidReshapeSteps(steps);
  if (violation !== null) {
    return fail(state, "invalid-reshape", violation);
  }
  (base as PathBinding | StateBinding).$reshape = steps;
  return base;
};

const parseArray = (state: ParserState): Json[] | Failed => {
  state.index += 1; // consume "["
  const items: Json[] = [];
  for (;;) {
    skipWhitespace(state);
    if (state.index >= state.source.length) {
      return malformed(state, "unterminated array (expected ']')");
    }
    if (state.source[state.index] === "]") {
      state.index += 1;
      return items;
    }
    const item = parseValue(state);
    if (item === FAILED) return FAILED;
    items.push(item);
    skipWhitespace(state);
    const next = state.source[state.index];
    if (next === ",") {
      state.index += 1;
      continue;
    }
    if (next === "]") {
      state.index += 1;
      return items;
    }
    return malformed(state, `expected ',' or ']' in array at index ${state.index}`);
  }
};

const parseObject = (state: ParserState): Record<string, Json> | Failed => {
  state.index += 1; // consume "{"
  const record: Record<string, Json> = {};
  for (;;) {
    skipWhitespace(state);
    if (state.index >= state.source.length) {
      return malformed(state, "unterminated object (expected '}')");
    }
    if (state.source[state.index] === "}") {
      state.index += 1;
      return record;
    }
    const keyChar = state.source[state.index] as string;
    const key = keyChar === '"' || keyChar === "'" ? parseString(state) : parseIdentifier(state);
    if (key === FAILED) return FAILED;
    skipWhitespace(state);
    if (state.source[state.index] !== ":") {
      return malformed(state, `expected ':' after object key "${key}" at index ${state.index}`);
    }
    state.index += 1;
    const value = parseValue(state);
    if (value === FAILED) return FAILED;
    // Own-property define, not `record[key] = value`: a wire key named
    // __proto__ must become data, never the result's prototype.
    Object.defineProperty(record, key, {
      value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
    skipWhitespace(state);
    const next = state.source[state.index];
    if (next === ",") {
      state.index += 1;
      continue;
    }
    if (next === "}") {
      state.index += 1;
      return record;
    }
    return malformed(state, `expected ',' or '}' in object at index ${state.index}`);
  }
};

const parseValue = (state: ParserState): Json | Failed => {
  skipWhitespace(state);
  if (state.index >= state.source.length) {
    return malformed(state, "empty expression (expected a value)");
  }
  const char = state.source[state.index] as string;
  if (char === '"' || char === "'") return parseString(state);
  if (char === "[") return parseArray(state);
  if (char === "{") return parseObject(state);
  if (char === "-" || (char >= "0" && char <= "9")) return parseNumber(state);
  if (IDENTIFIER_START.test(char)) {
    const reference = parseReference(state);
    if (reference === FAILED) return FAILED;
    return parsePipes(state, reference);
  }
  return malformed(state, `unexpected character "${char}" at index ${state.index}`);
};

const parseExpressionUnsafe = (source: string, context: ExpressionContext): ExpressionResult => {
  const state: ParserState = { source, index: 0, issues: [], queryNames: context.queryNames };
  const value = parseValue(state);
  if (value === FAILED) {
    return { dropped: true, issues: state.issues };
  }
  skipWhitespace(state);
  if (state.index < source.length) {
    // A pipe reaching here followed a non-reference value (parsePipes handles
    // pipes after references, nested included); it is malformed like any
    // other trailing content.
    malformed(state, `unexpected trailing content at index ${state.index}`);
    return { dropped: true, issues: state.issues };
  }
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
