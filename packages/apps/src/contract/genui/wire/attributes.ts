/**
 * Internal: the attribute layer of the vendo-genui/v2 wire markup compiler
 * (v2 spec §2, docs/superpowers/specs/2026-07-18-vendo-v2-format-spec.md;
 * plan decisions D3/D4/D5). Parses one open tag's attribute region into
 * props, delegating brace values to the expression grammar (expression.ts)
 * and compiling string-form `on*` action attributes to the canonical
 * `{ action }` prop shape (D5).
 */

import { FN_REFERENCE_PATTERN, findInvalidActionReference } from "../../fn-references.js";
import {
  defineOwn,
  isPlainObject,
  isWellFormedUtf16,
  type Json,
  TOOL_NAME_PATTERN,
} from "@vendoai/core";
import { parseExpression } from "./expression.js";
import { NAME_START, readName, skipBraceBlock, skipQuotedRun, skipWhitespace } from "./scan.js";
import { DROPPED, FAILED, issue, mergeIssues, type CompileState, type Dropped, type Failed } from "./state.js";

/** D5 — an attribute name in action position: `on` + uppercase letter. Shared
 *  with the printer (print.ts), which reads it as D5's inverse. */
export const ACTION_ATTR_PATTERN = /^on[A-Z][A-Za-z0-9_]*$/;

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
        state.index = state.source.length; // FAILED ⇒ cursor at EOF (see state.ts FAILED)
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
 *  (validateTree's props walk checks fn: grammar anywhere). */
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

/** D5's row exception — `rowAction={{label, tool, args}}` on DataTable/CardList.
 *  An `on*` attribute passes its tool nothing, so a mutation whose input schema
 *  requires an id can only be wired where the id is: on the row. The tool name
 *  arrives as a FIELD, and this lifts it into the canonical action shape one
 *  level DOWN, under `run` — the walk that hydrates actions (ui
 *  tree/convert-payload.ts) rewrites any object carrying a string `action` key
 *  into a bare callback, and at the top level that would swallow the label and
 *  the args with it. An already-canonical prop (a re-compiled print) is left
 *  alone; a name that is neither a tool nor an fn: reference drops the prop,
 *  exactly as `compileActionValue` drops an `on*` attribute. */
export const foldRowAction = (state: CompileState, props: Record<string, Json> | undefined): void => {
  if (props === undefined || !isPlainObject(props.rowAction)) return;
  const { tool, action, ...rest } = props.rowAction;
  if (tool === undefined && action === undefined) return;
  const named = typeof tool === "string" ? tool : action;
  if (typeof named !== "string" || !(TOOL_NAME_PATTERN.test(named) || FN_REFERENCE_PATTERN.test(named))) {
    issue(
      state,
      "invalid-action",
      "rowAction names neither a tool nor a valid fn: reference; the prop was dropped",
    );
    delete props.rowAction;
    return;
  }
  defineOwn(props, "rowAction", { ...rest, run: { action: named } });
};

/** The `=`-value forms of D3, with the cursor sitting on the `=`. Bare
 *  attributes never reach here — the caller keeps that form. */
const parseAttributeValue = (
  state: CompileState,
  element: AttributeElement,
  name: string,
): Json | Dropped | Failed => {
  state.index += 1;
  skipWhitespace(state);
  const opener = state.source[state.index];
  if (opener === '"') {
    const parsed = parseMarkupString(state, name);
    if (parsed === FAILED) return FAILED;
    if (typeof parsed === "string" && element === "component" && ACTION_ATTR_PATTERN.test(name)) {
      return compileActionValue(state, name, parsed);
    }
    return parsed;
  }
  if (opener === "{") {
    const parsed = parseExpressionAttribute(state);
    if (parsed === FAILED) return FAILED;
    // D6 always-validates: validateTree walks node props for the fn:
    // action grammar (same walk, ../fn-references.js), so an expression
    // value smuggling { action: "fn:9bad" } anywhere would un-validate
    // the tree. Drop the attribute here instead — only component props
    // land in tree nodes, so only "component" needs the walk.
    if (element === "component" && parsed !== DROPPED) {
      const invalidAction = findInvalidActionReference(parsed);
      if (invalidAction !== null) {
        issue(
          state,
          "invalid-action",
          `attribute "${name}" contains action "${invalidAction}", not a valid fn: reference; the attribute was dropped`,
        );
        return DROPPED;
      }
    }
    return parsed;
  }
  if (opener === "'") {
    issue(
      state,
      "malformed-attribute",
      `attribute "${name}" uses a single-quoted string (markup strings are double-quoted); the attribute was dropped`,
    );
    if (skipQuotedRun(state, "'") === FAILED) return FAILED;
    return DROPPED;
  }
  issue(state, "malformed-attribute", `attribute "${name}" has no value after "="; the attribute was dropped`);
  return DROPPED;
};

/** Reported AFTER the drop, because the outcome is what a retry acts on:
 *  saying the last one won when it was dropped sends the model back to
 *  re-write a value that never landed, and saying an earlier one stands
 *  when every value was dropped points it at a prop that is not there.
 *  props is the record of what actually landed; seen is only occurrence. */
const duplicateMessage = (name: string, value: Json | Dropped, props: Record<string, Json>): string => {
  if (value !== DROPPED) return `duplicate attribute "${name}" (the last one wins)`;
  return Object.prototype.hasOwnProperty.call(props, name)
    ? `duplicate attribute "${name}" (the last one was dropped, so the earlier one stands)`
    : `duplicate attribute "${name}" (every value was dropped, so the attribute is missing)`;
};

export interface ParsedAttributes {
  props?: Record<string, Json>;
  selfClosing: boolean;
}

/** Parses the attribute region of an open tag through its `>` or `/>`.
 *  Three value forms (D3): `attr="string"`, `attr={expr}`, bare `attr` →
 *  true. Duplicates: the last one wins unless it was dropped, either way with
 *  an issue naming the outcome. Outside declarations, `id` is
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
      const parsed = parseAttributeValue(state, element, name);
      if (parsed === FAILED) return FAILED;
      value = parsed;
    } else {
      state.index = beforeValue;
    }
    if (name === "id" && element !== "declaration") {
      issue(state, "wire-id-ignored", "wire-supplied id attributes are ignored (ids are compiler-owned)");
      seen.add(name);
      continue;
    }
    if (seen.has(name)) {
      issue(state, "duplicate-attribute", duplicateMessage(name, value, props));
    }
    seen.add(name);
    if (value === DROPPED) continue;
    // defineOwn: a wire attribute named __proto__ must become data, never
    // the props object's prototype.
    defineOwn(props, name, value);
  }
};
