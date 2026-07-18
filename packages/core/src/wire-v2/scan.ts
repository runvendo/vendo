/**
 * Internal: cursor-level scanners for the vendo-genui/v2 wire markup compiler
 * (v2 spec §2, docs/superpowers/specs/2026-07-18-vendo-v2-format-spec.md;
 * plan decision D3). Pure cursor movement over CompileState — no tree
 * building, no attribute semantics (those live one layer up in attributes.ts
 * and compile.ts).
 */

import { FAILED, issue, type CompileState, type Failed } from "./state.js";

/** Characters that may appear in a candidate tag or attribute name. The
 *  attribute grammar /^[A-Za-z_][A-Za-z0-9_-]*$/ is enforced by requiring a
 *  letter/underscore start before reading this run. */
export const NAME_CHAR = /[A-Za-z0-9_-]/;
export const NAME_START = /[A-Za-z_]/;
const WHITESPACE = /\s/;

export const skipWhitespace = (state: CompileState): void => {
  while (state.index < state.source.length && WHITESPACE.test(state.source[state.index] as string)) {
    state.index += 1;
  }
};

/** Reads a run of name characters at the cursor (possibly empty). */
export const readName = (state: CompileState): string => {
  const start = state.index;
  while (state.index < state.source.length && NAME_CHAR.test(state.source[state.index] as string)) {
    state.index += 1;
  }
  return state.source.slice(start, state.index);
};

/** Skips a quoted run inside an expression brace block (either quote style,
 *  backslash skips the next character). */
export const skipQuotedRun = (state: CompileState, quote: string): undefined | Failed => {
  state.index += 1; // consume the opening quote
  while (state.index < state.source.length) {
    const char = state.source[state.index] as string;
    if (char === quote) {
      state.index += 1;
      return undefined;
    }
    state.index += char === "\\" ? 2 : 1;
  }
  return FAILED;
};

/** Advances past a balanced `{...}` block, aware of strings (both quote
 *  styles, since the expression grammar allows both) and nested braces. The
 *  cursor must sit on the opening brace; it ends just past the close. */
export const skipBraceBlock = (state: CompileState): undefined | Failed => {
  state.index += 1; // consume "{"
  let depth = 1;
  while (state.index < state.source.length) {
    const char = state.source[state.index] as string;
    if (char === '"' || char === "'") {
      if (skipQuotedRun(state, char) === FAILED) return FAILED;
      continue;
    }
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        state.index += 1;
        return undefined;
      }
    }
    state.index += 1;
  }
  return FAILED;
};

/** Advances past the current open tag's attribute region without recording
 *  anything — used for skipped elements. Double-quoted strings and brace
 *  blocks are honored so a ">" inside them does not end the tag.
 *
 *  Known limitation: a MARKUP-level single-quoted run is not honored here (a
 *  `>` inside `attr='...'` ends the tag early). Markup strings are
 *  double-quoted by grammar — single quotes are already a malformed-attribute
 *  on the parsed path — so the skip path only degrades where the input was
 *  already invalid. Single quotes INSIDE brace blocks are honored via
 *  {@link skipBraceBlock}. */
export const scanTagEnd = (state: CompileState): { selfClosing: boolean } | Failed => {
  while (state.index < state.source.length) {
    const char = state.source[state.index] as string;
    if (char === '"') {
      if (skipQuotedRun(state, '"') === FAILED) return FAILED;
      continue;
    }
    if (char === "{") {
      if (skipBraceBlock(state) === FAILED) return FAILED;
      continue;
    }
    if (char === ">") {
      state.index += 1;
      return { selfClosing: false };
    }
    if (char === "/" && state.source[state.index + 1] === ">") {
      state.index += 2;
      return { selfClosing: true };
    }
    state.index += 1;
  }
  return FAILED;
};

/** Skips a skipped element's entire subtree: advance to the matching close
 *  tag, tolerant of nested same-name elements (a depth counter over open and
 *  close tags of the same name). Other tags inside are not parsed. */
export const skipElement = (state: CompileState, tag: string): void => {
  let depth = 1;
  while (state.index < state.source.length) {
    if (state.source[state.index] !== "<") {
      state.index += 1;
      continue;
    }
    if (state.source[state.index + 1] === "/") {
      state.index += 2;
      const name = readName(state);
      while (state.index < state.source.length && state.source[state.index] !== ">") {
        state.index += 1;
      }
      if (state.index < state.source.length) state.index += 1;
      if (name === tag) {
        depth -= 1;
        if (depth === 0) return;
      }
      continue;
    }
    state.index += 1;
    const name = readName(state);
    if (name === tag) {
      const end = scanTagEnd(state);
      if (end === FAILED) break;
      if (!end.selfClosing) depth += 1;
    }
  }
  state.eofTruncated = true;
  issue(state, "unclosed-element", `skipped element <${tag}> was not closed before end of input`);
};

/** Consumes text up to the next plausible tag start (`<` followed by a name
 *  character or `/`) or EOF, returning the raw run. The caller (compile.ts)
 *  turns non-whitespace runs into Text nodes (D3); whitespace-only runs are
 *  ignored silently. */
export const collectText = (state: CompileState): string => {
  const start = state.index;
  while (state.index < state.source.length) {
    if (state.source[state.index] === "<") {
      const next = state.source[state.index + 1];
      if (next !== undefined && (next === "/" || NAME_CHAR.test(next))) break;
    }
    state.index += 1;
  }
  return state.source.slice(start, state.index);
};
