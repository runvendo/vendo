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
 * Module stack (one-directional): compile → attributes → scan → state.
 * This file owns element dispatch, the frame stack, and result assembly.
 *
 * Wave-1 scope only. Query/Island elements, text children, actions, and
 * source resolution land in Task 4 (they hook into {@link compileOpenTag},
 * the single element-dispatch point); valid-while-partial refinement and the
 * §8 limits land in Task 5 (they rework {@link determineComplete} and the
 * accumulation sites).
 */

import { safeErrorMessage } from "../errors.js";
import { VENDO_TREE_FORMAT_V2 } from "../formats.js";
import type { TreeNode } from "../tree.js";
import type { TreeV2 } from "../tree-v2.js";
import { parseAttributes } from "./attributes.js";
import type { WireIssue } from "./expression.js";
import { collectText, NAME_CHAR, readName, scanTagEnd, skipElement, skipWhitespace } from "./scan.js";
import { FAILED, issue, type CompileState, type Frame } from "./state.js";

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

/** D3 — ids are compiler-owned: lowercase component name + `-` + ordinal in
 *  document order. The ordinal suffix makes a collision with the literal
 *  synthetic id `root` impossible by construction. */
const mintId = (state: CompileState, component: string): string => {
  const key = component.toLowerCase();
  const ordinal = (state.ordinals.get(key) ?? 0) + 1;
  state.ordinals.set(key, ordinal);
  return `${key}-${ordinal}`;
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
