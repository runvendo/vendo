/**
 * Internal: the attribute layer of the vendo-genui/v2 wire markup compiler
 * (v2 spec §2, docs/superpowers/specs/2026-07-18-vendo-v2-format-spec.md;
 * plan decisions D3/D4). Parses one open tag's attribute region into props,
 * delegating brace values to the expression grammar (expression.ts).
 */

import type { Json } from "../ids.js";
import { parseExpression } from "./expression.js";
import { NAME_START, readName, skipBraceBlock, skipQuotedRun, skipWhitespace } from "./scan.js";
import {
  DROPPED,
  FAILED,
  issue,
  isWellFormedUtf16,
  type CompileState,
  type Dropped,
  type Failed,
} from "./state.js";

/** Task 4 threads the declared `<Query>` names into expression parsing; the
 *  wave-1 skeleton has none, so every bare identifier is unknown-reference. */
const NO_QUERY_NAMES: ReadonlySet<string> = new Set();

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
      if (escaped === undefined) break;
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
  const result = parseExpression(inner, { queryNames: NO_QUERY_NAMES });
  state.issues.push(...result.issues);
  return result.dropped ? DROPPED : (result.value as Json);
};

export interface ParsedAttributes {
  props?: Record<string, Json>;
  selfClosing: boolean;
}

/** Parses the attribute region of an open tag through its `>` or `/>`.
 *  Three value forms (D3): `attr="string"`, `attr={expr}`, bare `attr` →
 *  true. Duplicates: last wins + issue. `id` is ignored with an issue (ids
 *  are compiler-owned). Returns FAILED only on EOF truncation. */
export const parseAttributes = (state: CompileState): ParsedAttributes | Failed => {
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
      } else if (opener === "{") {
        const parsed = parseExpressionAttribute(state);
        if (parsed === FAILED) return FAILED;
        value = parsed;
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
    if (name === "id") {
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
