/**
 * Internal: the v2 wire expression grammar — the `attr={...}` sub-language of
 * the vendo-genui/v2 markup (v2 spec §2,
 * docs/superpowers/specs/2026-07-18-vendo-v2-format-spec.md). The wire-v2
 * markup compiler hands this module the text BETWEEN an attribute's braces;
 * it returns canonical JSON with `$path`/`$state` bindings compiled in. Not
 * exported from the package root.
 *
 * The grammar is JSON5-lite: JSON literals, single- OR double-quoted strings,
 * arrays/objects with trailing commas and bare object keys, plus bare dotted
 * identifier paths in value position that compile to bindings. The parser is
 * total — malformed input yields `dropped: true` with issues, never a throw.
 */

import { safeErrorMessage } from "../errors.js";
import type { Json } from "../ids.js";
import type { PathBinding, StateBinding } from "../tree.js";
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
  /** `|` reshape pipe parsed but not executed in wave 1; pipe stripped. */
  "reshape-unsupported",
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
  if (IDENTIFIER_START.test(char)) return parseReference(state);
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
    if (source[state.index] === "|") {
      // Reshape pipe: compile the base value as-is and swallow the rest —
      // the reshape vocabulary lands in a later wave. Top level only by
      // design: a pipe nested inside an array/object falls to
      // malformed-expression in wave 1; wave 3 revisits when the reshape
      // vocabulary lands.
      state.index = source.length;
      state.issues.push({
        code: "reshape-unsupported",
        message: "reshape pipes are not supported yet (the reshape vocabulary lands in a later wave); the base value was used as-is",
      });
    } else {
      malformed(state, `unexpected trailing content at index ${state.index}`);
      return { dropped: true, issues: state.issues };
    }
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
