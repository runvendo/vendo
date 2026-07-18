/**
 * Internal: the vendo-genui/v2 wire markup compiler — wave-1 skeleton
 * (document shape, elements, attributes, nesting, deterministic id minting)
 * per the v2 spec §2 (docs/superpowers/specs/2026-07-18-vendo-v2-format-spec.md)
 * and plan decisions D3/D6
 * (docs/superpowers/plans/2026-07-18-vendo-v2-wave1-format-compiler-renderer.md).
 *
 * The wire is a single `<App ...>...</App>` element whose element children
 * become children of a synthetic `root` Stack node. The compiler is pure,
 * deterministic (identical wire → byte-identical result) and TOTAL: it never
 * throws — malformed input degrades to ordered issues plus a smaller tree
 * that still passes validateTreeV2.
 *
 * Wave-1 scope only. Query/Island elements, text children, actions, and
 * source resolution land in Task 4 (they hook into {@link compileOpenTag},
 * the single element-dispatch point); valid-while-partial refinement and the
 * §8 limits land in Task 5 (they rework {@link determineComplete} and the
 * accumulation sites).
 */

import { safeErrorMessage } from "../errors.js";
import { VENDO_TREE_FORMAT_V2 } from "../formats.js";
import type { Json } from "../ids.js";
import type { TreeNode } from "../tree.js";
import type { TreeV2 } from "../tree-v2.js";
import { parseExpression, type WireIssue } from "./expression.js";

/** v2 spec §2 / plan D3 — compiler options. `hostComponents` (the host
 *  catalog names) feeds Task 4's source resolution; the wave-1 skeleton
 *  accepts and ignores it so callers can thread it from day one. */
export interface WireCompileOptions {
  hostComponents?: readonly string[];
}

/** v2 spec §2 / plan D6 — the compile result. */
export interface WireCompileResult {
  tree: TreeV2;
  /** Generated-component sources (Islands). Always present; empty until
   *  Task 4 fills it. */
  components: Record<string, string>;
  /** The App element's `name` attribute, when present as a string (D3). */
  name?: string;
  /** Ordered issues in source order, sharing {@link WireIssue} with the
   *  expression grammar. Stable kebab-case codes. */
  issues: WireIssue[];
  /** D6 — true when the input parsed to a proper close of App. */
  complete: boolean;
}

/** D3 — component tag names are PascalCase. */
const PASCAL_TAG_PATTERN = /^[A-Z][A-Za-z0-9]*$/;
/** Characters that may appear in a candidate tag or attribute name. The
 *  attribute grammar /^[A-Za-z_][A-Za-z0-9_-]*$/ is enforced by requiring a
 *  letter/underscore start before reading this run. */
const NAME_CHAR = /[A-Za-z0-9_-]/;
const NAME_START = /[A-Za-z_]/;
const WHITESPACE = /\s/;

/** Task 4 threads the declared `<Query>` names into expression parsing; the
 *  wave-1 skeleton has none, so every bare identifier is unknown-reference. */
const NO_QUERY_NAMES: ReadonlySet<string> = new Set();

/** Internal EOF-truncation sentinel — flows up instead of a throw so every
 *  caller unwinds cleanly (same idiom as expression.ts's FAILED). */
const FAILED: unique symbol = Symbol("wire-truncated");
type Failed = typeof FAILED;

/** Internal marker: this attribute's value was dropped (with issues already
 *  recorded); the attribute is omitted from props. */
const DROPPED: unique symbol = Symbol("wire-attribute-dropped");
type Dropped = typeof DROPPED;

interface CompileState {
  readonly source: string;
  index: number;
  readonly issues: WireIssue[];
  readonly nodes: TreeNode[];
  /** Per-lowercased-component-name ordinal counters for id minting (D3). */
  readonly ordinals: Map<string, number>;
  /** True once `</App>` (or `<App/>`) properly closed the document. */
  appClosed: boolean;
  /** True when EOF truncated an open tag or left elements to auto-close. */
  eofTruncated: boolean;
  /** True when non-whitespace content after `</App>` was dropped. */
  droppedTrailing: boolean;
}

/** One open element: the synthetic root frame (tag `App`) sits at the
 *  bottom; component frames stack above it. */
interface Frame {
  tag: string;
  node: TreeNode;
}

const skipWhitespace = (state: CompileState): void => {
  while (state.index < state.source.length && WHITESPACE.test(state.source[state.index] as string)) {
    state.index += 1;
  }
};

const issue = (state: CompileState, code: string, message: string): void => {
  state.issues.push({ code, message });
};

/** ES2024 String.prototype.isWellFormed — guaranteed at runtime by the
 *  package's engines floor (node >= 20) but absent from this tsconfig's
 *  ES2022 lib, hence the local cast (same guard idiom as expression.ts:
 *  canonicalJson in jcs.ts throws on lone surrogates, so ill-formed UTF-16
 *  must never enter props). */
const isWellFormedUtf16 = (text: string): boolean =>
  (text as string & { isWellFormed(): boolean }).isWellFormed();

/** D3 — ids are compiler-owned: lowercase component name + `-` + ordinal in
 *  document order. The ordinal suffix makes a collision with the literal
 *  synthetic id `root` impossible by construction. */
const mintId = (state: CompileState, component: string): string => {
  const key = component.toLowerCase();
  const ordinal = (state.ordinals.get(key) ?? 0) + 1;
  state.ordinals.set(key, ordinal);
  return `${key}-${ordinal}`;
};

/** Reads a run of name characters at the cursor (possibly empty). */
const readName = (state: CompileState): string => {
  const start = state.index;
  while (state.index < state.source.length && NAME_CHAR.test(state.source[state.index] as string)) {
    state.index += 1;
  }
  return state.source.slice(start, state.index);
};

/** Skips a quoted run inside an expression brace block (either quote style,
 *  backslash skips the next character). */
const skipQuotedRun = (state: CompileState, quote: string): undefined | Failed => {
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
const skipBraceBlock = (state: CompileState): undefined | Failed => {
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

interface ParsedAttributes {
  props?: Record<string, Json>;
  selfClosing: boolean;
}

/** Parses the attribute region of an open tag through its `>` or `/>`.
 *  Three value forms (D3): `attr="string"`, `attr={expr}`, bare `attr` →
 *  true. Duplicates: last wins + issue. `id` is ignored with an issue (ids
 *  are compiler-owned). Returns FAILED only on EOF truncation. */
const parseAttributes = (state: CompileState): ParsedAttributes | Failed => {
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

/** Advances past the current open tag's attribute region without recording
 *  anything — used for skipped elements. Double-quoted strings and brace
 *  blocks are honored so a ">" inside them does not end the tag. */
const scanTagEnd = (state: CompileState): { selfClosing: boolean } | Failed => {
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
const skipElement = (state: CompileState, tag: string): void => {
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
 *  character or `/`) or EOF. Non-whitespace text is skipped with an issue —
 *  Task 4 turns it into Text nodes; whitespace is ignored silently (D3). */
const collectText = (state: CompileState): void => {
  const start = state.index;
  while (state.index < state.source.length) {
    if (state.source[state.index] === "<") {
      const next = state.source[state.index + 1];
      if (next !== undefined && (next === "/" || NAME_CHAR.test(next))) break;
    }
    state.index += 1;
  }
  if (state.source.slice(start, state.index).trim().length > 0) {
    issue(state, "text-unsupported-yet", "text children are not supported yet; the text was skipped");
  }
};

/**
 * The single element-dispatch point (D3). The cursor sits just past the tag
 * name. Task 4 replaces the Query/Island branch (query hoisting, raw-TSX
 * island capture) and adds source resolution to the component branch.
 */
const compileOpenTag = (state: CompileState, frames: Frame[], name: string): void => {
  if (name === "Query" || name === "Island") {
    issue(state, "unsupported-element-yet", `<${name}> is not supported yet; the element was skipped`);
    skipUnparsedElement(state, name);
    return;
  }
  if (!PASCAL_TAG_PATTERN.test(name)) {
    issue(state, "unknown-element", `unknown element <${name}>; the element and its children were skipped`);
    skipUnparsedElement(state, name);
    return;
  }
  const attrs = parseAttributes(state);
  if (attrs === FAILED) {
    state.eofTruncated = true;
    issue(state, "unclosed-element", `<${name}> tag was truncated at end of input; the element was dropped`);
    return;
  }
  const node: TreeNode = { id: mintId(state, name), component: name };
  if (attrs.props !== undefined) node.props = attrs.props;
  state.nodes.push(node);
  const parent = frames[frames.length - 1] as Frame;
  (parent.node.children ??= []).push(node.id);
  if (!attrs.selfClosing) frames.push({ tag: name, node });
};

/** Shared skip path for elements that compile to nothing in wave 1. */
const skipUnparsedElement = (state: CompileState, name: string): void => {
  const end = scanTagEnd(state);
  if (end === FAILED) {
    state.eofTruncated = true;
    issue(state, "unclosed-element", `<${name}> tag was truncated at end of input`);
    return;
  }
  if (!end.selfClosing) skipElement(state, name);
};

/** Handles `</name>`: pops the matching frame, implicitly closing anything
 *  above it (a mismatched close must never lose the rest of the document);
 *  no match → stray-close-tag. Frame 0 is App. */
const closeTag = (state: CompileState, frames: Frame[], name: string): void => {
  for (let i = frames.length - 1; i >= 0; i -= 1) {
    if ((frames[i] as Frame).tag !== name) continue;
    for (let j = frames.length - 1; j > i; j -= 1) {
      issue(state, "unclosed-element", `<${(frames[j] as Frame).tag}> was closed implicitly by </${name}>`);
    }
    frames.length = i;
    if (i === 0) state.appClosed = true;
    return;
  }
  issue(state, "stray-close-tag", `</${name}> does not match any open element`);
};

/** Iterative child loop over an explicit frame stack (no recursion, so
 *  pathological nesting cannot overflow the call stack). */
const parseChildren = (state: CompileState, frames: Frame[]): void => {
  while (state.index < state.source.length) {
    collectText(state);
    if (state.index >= state.source.length) break;
    // The cursor sits on a "<" that plausibly starts a tag.
    if (state.source[state.index + 1] === "/") {
      state.index += 2;
      const name = readName(state);
      while (state.index < state.source.length && state.source[state.index] !== ">") {
        state.index += 1;
      }
      if (state.index >= state.source.length) break; // truncated close tag
      state.index += 1;
      closeTag(state, frames, name);
      if (state.appClosed) return;
      continue;
    }
    state.index += 1;
    const name = readName(state);
    compileOpenTag(state, frames, name);
  }
  // EOF with the document still open: auto-close everything (D6).
  state.eofTruncated = true;
  for (let i = frames.length - 1; i >= 1; i -= 1) {
    issue(state, "unclosed-element", `<${(frames[i] as Frame).tag}> was auto-closed at end of input`);
  }
  issue(state, "unclosed-element", "<App> was not closed before end of input");
};

/** True when the cursor sits on `<App` followed by a tag-name boundary. */
const opensApp = (state: CompileState): boolean => {
  if (!state.source.startsWith("<App", state.index)) return false;
  const next = state.source[state.index + 4];
  return next === undefined || !NAME_CHAR.test(next);
};

/** D6 wave-1 partial heuristic, kept in one place for Task 5 to rework:
 *  complete iff App opened and properly closed, nothing was truncated or
 *  auto-closed at EOF, and no trailing content after `</App>` was dropped. */
const determineComplete = (state: CompileState): boolean =>
  state.appClosed && !state.eofTruncated && !state.droppedTrailing;

const finishResult = (state: CompileState, name: string | undefined): WireCompileResult => {
  const tree: TreeV2 = {
    formatVersion: VENDO_TREE_FORMAT_V2,
    root: "root",
    nodes: state.nodes,
  };
  const result: WireCompileResult = {
    tree,
    components: {},
    issues: state.issues,
    complete: determineComplete(state),
  };
  if (name !== undefined) result.name = name;
  return result;
};

const compileWireV2Unsafe = (wire: string, options: WireCompileOptions | undefined): WireCompileResult => {
  void options; // hostComponents feeds Task 4's source resolution
  const state: CompileState = {
    source: wire,
    index: 0,
    issues: [],
    nodes: [],
    ordinals: new Map(),
    appClosed: false,
    eofTruncated: false,
    droppedTrailing: false,
  };
  const root: TreeNode = { id: "root", component: "Stack", source: "prewired" };
  state.nodes.push(root);

  skipWhitespace(state);
  // D3 — the wire is one <App> element; anything else up front (no App at
  // all, or garbage before it) degrades to the empty valid tree.
  if (!opensApp(state)) {
    issue(state, "missing-app", "expected a single <App ...>...</App> element");
    return finishResult(state, undefined);
  }
  state.index += 4; // consume "<App"
  const app = parseAttributes(state);
  if (app === FAILED) {
    state.eofTruncated = true;
    issue(state, "unclosed-element", "<App ...> tag was truncated at end of input");
    return finishResult(state, undefined);
  }
  const name = typeof app.props?.name === "string" ? app.props.name : undefined;
  if (app.selfClosing) {
    state.appClosed = true;
  } else {
    parseChildren(state, [{ tag: "App", node: root }]);
  }
  if (state.appClosed) {
    skipWhitespace(state);
    if (state.index < state.source.length) {
      state.droppedTrailing = true;
      issue(state, "trailing-content", "content after </App> was dropped");
    }
  }
  return finishResult(state, name);
};

/**
 * v2 spec §2 / plan D3/D6 — compile one wire markup document to the
 * canonical v2 tree. Deterministic, pure, and total: never throws on any
 * input — an unexpected failure degrades to the empty valid tree plus a
 * `compile-failed` issue (same discipline as validateTreeV2).
 */
export function compileWireV2(wire: string, options?: WireCompileOptions): WireCompileResult {
  try {
    return compileWireV2Unsafe(wire, options);
  } catch (error) {
    return {
      tree: {
        formatVersion: VENDO_TREE_FORMAT_V2,
        root: "root",
        nodes: [{ id: "root", component: "Stack", source: "prewired" }],
      },
      components: {},
      issues: [{ code: "compile-failed", message: `wire compile failed: ${safeErrorMessage(error)}` }],
      complete: false,
    };
  }
}
