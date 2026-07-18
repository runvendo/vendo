/**
 * Internal: the attribute layer of the vendo-genui/v2 wire markup compiler
 * (v2 spec §2, docs/superpowers/specs/2026-07-18-vendo-v2-format-spec.md;
 * plan decisions D3/D4/D5). Parses one open tag's attribute region into
 * props, delegating brace values to the expression grammar (expression.ts)
 * and compiling string-form `on*` action attributes to the canonical
 * `{ action }` prop shape (D5).
 */

import { FN_REFERENCE_PATTERN, findInvalidActionReference } from "../fn-references.js";
import type { Json } from "../ids.js";
import { TOOL_NAME_PATTERN } from "../tools.js";
import { parseExpression } from "./expression.js";
import { NAME_START, readName, skipBraceBlock, skipQuotedRun, skipWhitespace } from "./scan.js";
import {
  DROPPED,
  FAILED,
  issue,
  isWellFormedUtf16,
  mergeIssues,
  type CompileState,
  type Dropped,
  type Failed,
} from "./state.js";

/** D5 — an attribute name in action position: `on` + uppercase letter. */
const ACTION_ATTR_PATTERN = /^on[A-Z][A-Za-z0-9_]*$/;

/**
 * Which element kind the attribute region belongs to (D3/D5):
 * - `component` — `id` is compiler-owned (ignored with an issue) and
 *   string-form `on*` attributes compile to canonical actions.
 * - `app` — `id` is ignored like a component's, but non-name attributes are
 *   silently discarded by the caller, so no action compilation runs.
 * - `declaration` — Query/Island: `id`/`name` are the declaration's own
 *   fields, kept verbatim; no action compilation.
 */
export type AttributeElement = "component" | "app" | "declaration";

/** D3 — markup-layer strings are double-quoted only; `\"` and `\\` are the
 *  only escapes (other backslash sequences pass through verbatim — rich
 *  escapes belong to the expression layer). Ill-formed UTF-16 drops the
 *  attribute: canonicalJson (jcs.ts) throws on lone surrogates, so letting
 *  one into props would un-total the pipeline one layer up. */
const parseMarkupString = (state: CompileState, name: string): string | Dropped | Failed => {
  state.index += 1; // consume the opening quote
  let text = "";
  while (state.index < state.source.length) {
    const char = state.source[state.index] as string;
    if (char === '"') {
      state.index += 1;
      if (!isWellFormedUtf16(text)) {
        issue(
          state,
          "malformed-attribute",
          `attribute "${name}" contains a lone surrogate (ill-formed UTF-16); the attribute was dropped`,
        );
        return DROPPED;
      }
      return text;
    }
    if (char === "\\") {
      const escaped = state.source[state.index + 1];
      if (escaped === undefined) {
        // Invariant: FAILED means EOF truncation, and every FAILED producer
        // leaves the cursor AT EOF — otherwise the caller resumes mid-tag
        // and mints the tail as phantom text (the D6 roundtrip property
        // sweep caught a dangling backslash doing exactly that).
        state.index = state.source.length;
        break;
      }
      text += escaped === '"' || escaped === "\\" ? escaped : `\\${escaped}`;
      state.index += 2;
      continue;
    }
    text += char;
    state.index += 1;
  }
  return FAILED; // unterminated at EOF — the whole tag is truncated
};

/** D3/D4 — `attr={expr}`: find the matching close brace, then delegate the
 *  inner text to parseExpression; its issues merge into the compile issues
 *  and a dropped expression drops the attribute. */
const parseExpressionAttribute = (state: CompileState): Json | Dropped | Failed => {
  const start = state.index + 1;
  if (skipBraceBlock(state) === FAILED) return FAILED;
  const inner = state.source.slice(start, state.index - 1);
  const result = parseExpression(inner, { queryNames: state.queryNames });
  mergeIssues(state, result.issues);
  return result.dropped ? DROPPED : (result.value as Json);
};

/** D5 — a string-form `on*` attribute must name a host tool or an fn:
 *  reference; it compiles to the v1 canonical action prop shape. Anything
 *  else is dropped. Expression-form `on*` attributes never come through
 *  here — a hand-written `{ action: ... }` object passes through as-is
 *  (validateTreeV2's props walk checks fn: grammar anywhere). */
const compileActionValue = (state: CompileState, name: string, value: string): Json | Dropped => {
  if (TOOL_NAME_PATTERN.test(value) || FN_REFERENCE_PATTERN.test(value)) {
    return { action: value };
  }
  issue(
    state,
    "invalid-action",
    `action attribute "${name}" names neither a tool nor a valid fn: reference; the attribute was dropped`,
  );
  return DROPPED;
};

export interface ParsedAttributes {
  props?: Record<string, Json>;
  selfClosing: boolean;
}

/** Parses the attribute region of an open tag through its `>` or `/>`.
 *  Three value forms (D3): `attr="string"`, `attr={expr}`, bare `attr` →
 *  true. Duplicates: last wins + issue. Outside declarations, `id` is
 *  ignored with an issue (ids are compiler-owned) and string-form `on*`
 *  attributes compile to actions on components (D5, see
 *  {@link AttributeElement}). Returns FAILED only on EOF truncation. */
export const parseAttributes = (state: CompileState, element: AttributeElement): ParsedAttributes | Failed => {
  const props: Record<string, Json> = {};
  const seen = new Set<string>();
  for (;;) {
    skipWhitespace(state);
    if (state.index >= state.source.length) return FAILED;
    const char = state.source[state.index] as string;
    if (char === ">") {
      state.index += 1;
      return { props: Object.keys(props).length > 0 ? props : undefined, selfClosing: false };
    }
    if (char === "/") {
      if (state.source[state.index + 1] === ">") {
        state.index += 2;
        return { props: Object.keys(props).length > 0 ? props : undefined, selfClosing: true };
      }
      issue(state, "malformed-attribute", `unexpected "/" inside a tag at index ${state.index}`);
      state.index += 1;
      continue;
    }
    if (!NAME_START.test(char)) {
      issue(state, "malformed-attribute", `unexpected character "${char}" inside a tag at index ${state.index}`);
      state.index += 1;
      continue;
    }
    const name = readName(state);
    const beforeValue = state.index;
    skipWhitespace(state);
    let value: Json | Dropped = true; // bare attribute form
    if (state.source[state.index] === "=") {
      state.index += 1;
      skipWhitespace(state);
      const opener = state.source[state.index];
      if (opener === '"') {
        const parsed = parseMarkupString(state, name);
        if (parsed === FAILED) return FAILED;
        value = parsed;
        if (typeof value === "string" && element === "component" && ACTION_ATTR_PATTERN.test(name)) {
          value = compileActionValue(state, name, value);
        }
      } else if (opener === "{") {
        const parsed = parseExpressionAttribute(state);
        if (parsed === FAILED) return FAILED;
        value = parsed;
        // D6 always-validates: validateTreeV2 walks node props for the fn:
        // action grammar (same walk, ../fn-references.js), so an expression
        // value smuggling { action: "fn:9bad" } anywhere would un-validate
        // the tree. Drop the attribute here instead — only component props
        // land in tree nodes, so only "component" needs the walk.
        if (element === "component" && value !== DROPPED) {
          const invalidAction = findInvalidActionReference(value);
          if (invalidAction !== null) {
            issue(
              state,
              "invalid-action",
              `attribute "${name}" contains action "${invalidAction}", not a valid fn: reference; the attribute was dropped`,
            );
            value = DROPPED;
          }
        }
      } else if (opener === "'") {
        issue(
          state,
          "malformed-attribute",
          `attribute "${name}" uses a single-quoted string (markup strings are double-quoted); the attribute was dropped`,
        );
        if (skipQuotedRun(state, "'") === FAILED) return FAILED;
        value = DROPPED;
      } else {
        issue(state, "malformed-attribute", `attribute "${name}" has no value after "="; the attribute was dropped`);
        value = DROPPED;
      }
    } else {
      state.index = beforeValue;
    }
    if (seen.has(name)) {
      issue(state, "duplicate-attribute", `duplicate attribute "${name}" (the last one wins)`);
    }
    seen.add(name);
    if (name === "id" && element !== "declaration") {
      issue(state, "wire-id-ignored", "wire-supplied id attributes are ignored (ids are compiler-owned)");
      continue;
    }
    if (value === DROPPED) continue;
    // Own-property define, not `props[name] = value`: a wire attribute named
    // __proto__ must become data, never the props object's prototype (same
    // rule as expression.ts's object parser).
    Object.defineProperty(props, name, {
      value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
};
