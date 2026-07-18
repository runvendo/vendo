/**
 * Internal: the vendo-genui/v2 wire markup compiler
 * (document shape, elements, attributes, nesting, deterministic id minting,
 * query hoisting, raw-TSX islands, actions, text children, source resolution)
 * per the v2 spec §2 (docs/superpowers/specs/2026-07-18-vendo-v2-format-spec.md)
 * and plan decisions D3/D5/D6
 * (docs/superpowers/plans/2026-07-18-vendo-v2-wave1-format-compiler-renderer.md).
 *
 * The wire is a single `<App ...>...</App>` element whose element children
 * become children of a synthetic `root` Stack node. The compiler is pure,
 * deterministic (identical wire → byte-identical result) and TOTAL: it never
 * throws — malformed input degrades to ordered issues plus a smaller tree
 * that still passes validateTreeV2.
 *
 * Module stack (one-directional): compile → attributes → scan/limits →
 * state. This file owns element dispatch, the frame stack, the
 * forward-reference pre-scan, and result assembly; limits.ts guards every
 * accumulation site with the §8 caps so the emitted tree and components
 * always stay within the pinned limits.
 *
 * Valid-while-partial (D6) is property-tested in roundtrip.e2e.test.ts:
 * EVERY prefix of a wire compiles to a validateTreeV2-passing tree with
 * monotonically non-decreasing node counts, `complete` true only at a
 * proper full parse.
 */

import { safeErrorMessage } from "../errors.js";
import { FN_REFERENCE_PATTERN } from "../fn-references.js";
import { VENDO_TREE_FORMAT_V2 } from "../formats.js";
import type { Json } from "../ids.js";
import { isPlainObject, type TreeNode } from "../tree.js";
import { RESERVED_COMPONENT_NAMES } from "../tree-limits.js";
import { QUERY_NAME_PATTERN, type TreeQueryV2, type TreeV2 } from "../tree-v2.js";
import { parseAttributes } from "./attributes.js";
import type { WireIssue } from "./expression.js";
import { admitIslandSource, claimNodeSlot, claimQuerySlot } from "./limits.js";
import { collectText, NAME_CHAR, readName, scanTagEnd, skipElement, skipWhitespace } from "./scan.js";
import { FAILED, issue, isWellFormedUtf16, type CompileState, type Frame } from "./state.js";

/** v2 spec §2 / plan D3 — compiler options. `hostComponents` (the host
 *  catalog names) feeds source resolution: host brand wins over the prewired
 *  set and islands. */
export interface WireCompileOptions {
  hostComponents?: readonly string[];
}

/** v2 spec §2 / plan D6 — the compile result. */
export interface WireCompileResult {
  tree: TreeV2;
  /** Generated-component sources: `<Island name>` → raw TSX (D3). Always
   *  present; empty when no islands were declared. */
  components: Record<string, string>;
  /** The App element's `name` attribute, when present as a string (D3). */
  name?: string;
  /** Ordered issues in source order, sharing {@link WireIssue} with the
   *  expression grammar. Stable kebab-case codes. */
  issues: WireIssue[];
  /** D6 — true when the input parsed to a proper close of App. */
  complete: boolean;
}

/** D3 — component tag names (and Island names) are PascalCase. */
const PASCAL_TAG_PATTERN = /^[A-Z][A-Za-z0-9]*$/;

/** D3 — the branded prewired components beyond the 7 reserved layout
 *  primitives. Pinned mirror of the implementations in
 *  packages/ui/src/tree/branded.tsx (core cannot import ui). */
const BRANDED_PREWIRED_NAMES = ["Card", "Button", "Input", "Select", "Table", "Badge", "Stat", "Tabs"] as const;

/** D3 — the full prewired set: reserved layout primitives + branded. */
const PREWIRED_NAMES: ReadonlySet<string> = new Set([...RESERVED_COMPONENT_NAMES, ...BRANDED_PREWIRED_NAMES]);

const RESERVED_SET: ReadonlySet<string> = new Set(RESERVED_COMPONENT_NAMES);

/** D3 — island content ends at the FIRST occurrence of this literal. */
const ISLAND_CLOSE = "</Island>";

const NO_NAMES: ReadonlySet<string> = new Set();

const makeState = (
  wire: string,
  queryNames: ReadonlySet<string>,
  islandNames: ReadonlySet<string>,
  hostComponents: ReadonlySet<string>,
): CompileState => ({
  source: wire,
  index: 0,
  issues: [],
  nodes: [],
  ordinals: new Map(),
  queryNames,
  islandNames,
  hostComponents,
  queries: [],
  hoistedQueryNames: new Set(),
  components: {},
  componentBytes: 0,
  nodeLimitIssued: false,
  queryLimitIssued: false,
  componentLimitIssued: false,
  appClosed: false,
  eofTruncated: false,
  droppedTrailing: false,
});

/** D3 — ids are compiler-owned: lowercase component name + `-` + ordinal in
 *  document order. The ordinal suffix makes a collision with the literal
 *  synthetic id `root` impossible by construction. Text children share the
 *  `text` ordinal pool with `<Text>` elements, keeping ids unique. */
const mintId = (state: CompileState, component: string): string => {
  const key = component.toLowerCase();
  const ordinal = (state.ordinals.get(key) ?? 0) + 1;
  state.ordinals.set(key, ordinal);
  return `${key}-${ordinal}`;
};

/** D3 — component resolution order: host catalog → prewired → islands
 *  (host brand wins); unknown names stay sourceless (the renderer shows its
 *  contained unknown-component notice). */
const resolveSource = (state: CompileState, name: string): TreeNode["source"] => {
  if (state.hostComponents.has(name)) return "host";
  if (PREWIRED_NAMES.has(name)) return "prewired";
  if (state.islandNames.has(name)) return "generated";
  return undefined;
};

/** D3 — `<Query id tool input?>` hoists to tree.queries wherever it appears
 *  (a nested one records a non-fatal issue). Produces no tree node. */
const compileQuery = (state: CompileState, frames: Frame[]): void => {
  const attrs = parseAttributes(state, "declaration");
  if (attrs === FAILED) {
    state.eofTruncated = true;
    issue(state, "truncated-tag", "<Query> tag was truncated at end of input; the query was dropped");
    return;
  }
  if (!attrs.selfClosing) {
    issue(state, "query-content", "<Query> elements are self-closing; the element content was skipped");
    skipElement(state, "Query");
  }
  if (frames.length > 1) {
    issue(state, "nested-query", "<Query> belongs at App level; the query was still hoisted");
  }
  const name = attrs.props?.id;
  if (typeof name !== "string" || !QUERY_NAME_PATTERN.test(name) || name === "state") {
    issue(
      state,
      "invalid-query-name",
      "<Query> needs an id naming the query (an identifier, not \"state\"); the query was dropped",
    );
    return;
  }
  const tool = attrs.props?.tool;
  if (
    typeof tool !== "string"
    || tool.length === 0
    || (tool.startsWith("fn:") && !FN_REFERENCE_PATTERN.test(tool))
  ) {
    issue(
      state,
      "invalid-query-tool",
      `query "${name}" needs a tool naming a host tool or a valid fn: reference; the query was dropped`,
    );
    return;
  }
  if (state.hoistedQueryNames.has(name)) {
    issue(state, "duplicate-query", `duplicate query name "${name}" (the first one wins; this one was dropped)`);
    return;
  }
  if (!claimQuerySlot(state)) return; // §8 — over-cap queries are dropped
  const query: TreeQueryV2 = { name, tool };
  const input = attrs.props?.input;
  if (input !== undefined) {
    if (isPlainObject(input)) {
      query.input = input as Record<string, Json>;
    } else {
      issue(state, "invalid-query-input", `query "${name}" input must be an object expression; the input was dropped`);
    }
  }
  state.queries.push(query);
  state.hoistedQueryNames.add(name);
};

/** D3 — `<Island name>raw TSX</Island>` captures everything between the open
 *  tag's `>` and the FIRST literal `</Island>` verbatim: no parsing, no
 *  nesting, quotes/braces/`<` all pass through (raw TSX — the v1 JSON
 *  escaping pain is the point). Produces no tree node. */
const compileIsland = (state: CompileState): void => {
  const attrs = parseAttributes(state, "declaration");
  if (attrs === FAILED) {
    state.eofTruncated = true;
    issue(state, "truncated-tag", "<Island> tag was truncated at end of input; the island was dropped");
    return;
  }
  const name = attrs.props?.name;
  const validName = typeof name === "string" && PASCAL_TAG_PATTERN.test(name) && !RESERVED_SET.has(name);
  const duplicate = validName && Object.prototype.hasOwnProperty.call(state.components, name);
  if (!validName) {
    issue(
      state,
      "invalid-island-name",
      "<Island> needs a PascalCase, non-reserved name attribute; the island was skipped",
    );
  } else if (duplicate) {
    issue(state, "duplicate-island", `duplicate island "${name}" (the first one wins; this one was dropped)`);
  } else if (attrs.selfClosing) {
    issue(state, "island-no-content", `island "${name}" is self-closing, so it has no source; the island was skipped`);
  }
  if (attrs.selfClosing) return;
  const start = state.index;
  const close = state.source.indexOf(ISLAND_CLOSE, start);
  if (close === -1) {
    state.index = state.source.length;
    state.eofTruncated = true;
    issue(state, "unclosed-skipped", "<Island> raw content was not closed before end of input; the island was dropped");
    return;
  }
  const sourceText = state.source.slice(start, close);
  state.index = close + ISLAND_CLOSE.length;
  // §8 + hygiene (limits.ts): UTF-16 well-formedness, count cap, per-source
  // and total byte caps all gate admission into the component map.
  if (validName && !duplicate) admitIslandSource(state, name, sourceText);
};

/**
 * The single element-dispatch point (D3). The cursor sits just past the tag
 * name. Query hoists, Island captures, a nested App is skipped with its
 * subtree, unknown tags are skipped, and component elements become nodes
 * with resolved sources.
 */
const compileOpenTag = (state: CompileState, frames: Frame[], name: string): void => {
  if (name === "Query") {
    compileQuery(state, frames);
    return;
  }
  if (name === "Island") {
    compileIsland(state);
    return;
  }
  if (name === "App") {
    issue(state, "nested-app", "<App> cannot nest; the element and its children were skipped");
    skipUnparsedElement(state, "App");
    return;
  }
  if (!PASCAL_TAG_PATTERN.test(name)) {
    issue(state, "unknown-element", `unknown element <${name}>; the element and its children were skipped`);
    skipUnparsedElement(state, name);
    return;
  }
  const attrs = parseAttributes(state, "component");
  if (attrs === FAILED) {
    state.eofTruncated = true;
    issue(state, "truncated-tag", `<${name}> tag was truncated at end of input; the element was dropped`);
    return;
  }
  if (!claimNodeSlot(state)) {
    // §8 — beyond TREE_MAX_NODES the element still parses for document
    // structure (attribute cursor movement above, close-tag balancing via
    // this frame), but no node is appended and no child id is recorded, so
    // children only ever reference emitted nodes. The frame's node is a
    // placeholder that can never be emitted or mutated: once the cap is hit
    // no descendant claims a slot either.
    if (!attrs.selfClosing) frames.push({ tag: name, node: { id: name, component: name } });
    return;
  }
  const node: TreeNode = { id: mintId(state, name), component: name };
  const source = resolveSource(state, name);
  if (source !== undefined) node.source = source;
  if (attrs.props !== undefined) node.props = attrs.props;
  state.nodes.push(node);
  const parent = frames[frames.length - 1] as Frame;
  (parent.node.children ??= []).push(node.id);
  if (!attrs.selfClosing) frames.push({ tag: name, node });
};

/** Shared skip path for elements that compile to nothing. */
const skipUnparsedElement = (state: CompileState, name: string): void => {
  const end = scanTagEnd(state);
  if (end === FAILED) {
    state.eofTruncated = true;
    issue(state, "truncated-tag", `<${name}> tag was truncated at end of input`);
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

/** D3 — a non-whitespace text run becomes a prewired Text child of the
 *  enclosing element (of root when directly inside App): ends trimmed,
 *  internal whitespace preserved. Ill-formed UTF-16 is skipped (canonicalJson
 *  in jcs.ts throws on lone surrogates downstream). */
const appendTextChild = (state: CompileState, frames: Frame[], raw: string): void => {
  const text = raw.trim();
  if (text.length === 0) return; // whitespace-only runs are ignored silently
  if (!claimNodeSlot(state)) return; // §8 — beyond the cap, text produces no node
  if (!isWellFormedUtf16(text)) {
    issue(state, "malformed-text", "text child contains a lone surrogate (ill-formed UTF-16); the text was skipped");
    return;
  }
  const node: TreeNode = { id: mintId(state, "Text"), component: "Text", source: "prewired", props: { text } };
  state.nodes.push(node);
  const parent = frames[frames.length - 1] as Frame;
  (parent.node.children ??= []).push(node.id);
};

/** Iterative child loop over an explicit frame stack (no recursion, so
 *  pathological nesting cannot overflow the call stack). */
const parseChildren = (state: CompileState, frames: Frame[]): void => {
  while (state.index < state.source.length) {
    appendTextChild(state, frames, collectText(state));
    if (state.index >= state.source.length) break;
    // The cursor sits on a "<" that plausibly starts a tag.
    if (state.source[state.index + 1] === "/") {
      state.index += 2;
      const name = readName(state);
      let junk = false;
      while (state.index < state.source.length && state.source[state.index] !== ">") {
        if (!/\s/.test(state.source[state.index] as string)) junk = true;
        state.index += 1;
      }
      if (state.index >= state.source.length) break; // truncated close tag
      state.index += 1;
      if (junk) {
        issue(state, "malformed-attribute", `unexpected content in close tag </${name}> was ignored`);
      }
      closeTag(state, frames, name);
      if (state.appClosed) return;
      continue;
    }
    state.index += 1;
    const name = readName(state);
    if (name.length === 0 && state.index >= state.source.length) {
      // D6 — a lone "<" at EOF is an incomplete trailing tag on a streaming
      // prefix (the next chunk may extend it into a real tag), never text:
      // as text it would mint a phantom Text node that a longer prefix takes
      // back, breaking node-count monotonicity (the roundtrip property sweep
      // caught exactly that).
      issue(state, "truncated-tag", '"<" at end of input starts an incomplete tag; it was dropped');
      break;
    }
    compileOpenTag(state, frames, name);
  }
  // EOF with the document still open: auto-close everything (D6).
  state.eofTruncated = true;
  for (let i = frames.length - 1; i >= 1; i -= 1) {
    issue(state, "eof-unclosed", `<${(frames[i] as Frame).tag}> was auto-closed at end of input`);
  }
  issue(state, "eof-unclosed", "<App> was not closed before end of input");
};

/** True when the cursor sits on `<App` followed by a tag-name boundary. */
const opensApp = (state: CompileState): boolean => {
  if (!state.source.startsWith("<App", state.index)) return false;
  const next = state.source[state.index + 4];
  return next === undefined || !NAME_CHAR.test(next);
};

/**
 * D3 forward references — a lightweight pre-scan over the raw wire that
 * collects the declared `<Query id>` names (all grammar-valid ones, so a
 * dropped duplicate's name still resolves — it is the same name) and the
 * `<Island name>` names BEFORE the main parse, so binding attributes may
 * reference a declaration that appears later in the wire.
 *
 * §8 interplay (pinned decision): this set deliberately ignores the caps the
 * main pass enforces, so it may contain names of queries/islands the main
 * pass DROPS (over-cap, like dropped duplicates). A binding to such a name
 * still compiles to a valid `{ $path }` — it renders as absent data, and
 * wave-3 shape checking is the layer that surfaces it. Keeping resolution
 * cap-blind keeps prefix compiles consistent: whether a name resolves never
 * depends on how much of the document has streamed in.
 *
 * It reuses the quote-aware scanners and skips Island raw content and
 * skipped subtrees (unknown elements, nested App, paired-Query content)
 * exactly like the main pass, so fake declarations inside them are NOT
 * collected. It records nothing except names: all validation and every
 * issue happen in the main pass, in source order (this pass runs on a
 * throwaway state whose issues are discarded).
 */
const prescanDeclarations = (wire: string): { queryNames: Set<string>; islandNames: Set<string> } => {
  const queryNames = new Set<string>();
  const islandNames = new Set<string>();
  const state = makeState(wire, NO_NAMES, NO_NAMES, NO_NAMES);
  skipWhitespace(state);
  if (!opensApp(state)) return { queryNames, islandNames };
  state.index += 4; // consume "<App"
  const app = parseAttributes(state, "app");
  if (app === FAILED || app.selfClosing) return { queryNames, islandNames };
  while (state.index < state.source.length) {
    collectText(state);
    if (state.index >= state.source.length) break;
    if (state.source[state.index + 1] === "/") {
      state.index += 2;
      const name = readName(state);
      while (state.index < state.source.length && state.source[state.index] !== ">") {
        state.index += 1;
      }
      if (state.index >= state.source.length) break;
      state.index += 1;
      // Nested <App> elements are skipped-with-subtree below, so any </App>
      // reaching the main stream closes the document in the main pass too.
      if (name === "App") break;
      continue;
    }
    state.index += 1;
    const name = readName(state);
    if (name === "Query") {
      const attrs = parseAttributes(state, "declaration");
      if (attrs === FAILED) break;
      const id = attrs.props?.id;
      if (typeof id === "string" && QUERY_NAME_PATTERN.test(id) && id !== "state") queryNames.add(id);
      if (!attrs.selfClosing) skipElement(state, "Query");
      continue;
    }
    if (name === "Island") {
      const attrs = parseAttributes(state, "declaration");
      if (attrs === FAILED) break;
      if (attrs.selfClosing) continue; // no content — the main pass skips it
      const close = state.source.indexOf(ISLAND_CLOSE, state.index);
      if (close === -1) break; // unterminated — the main pass drops it
      state.index = close + ISLAND_CLOSE.length;
      const islandName = attrs.props?.name;
      if (typeof islandName === "string" && PASCAL_TAG_PATTERN.test(islandName) && !RESERVED_SET.has(islandName)) {
        islandNames.add(islandName);
      }
      continue;
    }
    if (name === "App" || !PASCAL_TAG_PATTERN.test(name)) {
      const end = scanTagEnd(state);
      if (end === FAILED) break;
      if (!end.selfClosing) skipElement(state, name);
      continue;
    }
    // Component open tags move through parseAttributes, NOT scanTagEnd: the
    // main pass parses them, and only identical cursor movement (by
    // construction) keeps declarations inside attribute values — e.g. a
    // single-quoted run hiding a fake <Island>/<Query> — invisible to both
    // passes alike (scanTagEnd is single-quote-blind at the markup layer).
    if (parseAttributes(state, "component") === FAILED) break;
  }
  return { queryNames, islandNames };
};

/** D6 — complete iff App opened and properly closed, nothing was truncated
 *  or auto-closed at EOF, and no trailing content after `</App>` was
 *  dropped. Structural only: §8 cap drops do NOT clear `complete` (the wire
 *  itself parsed fully). Pinned by the roundtrip property sweep: false for
 *  every proper prefix, true only at full length. */
const determineComplete = (state: CompileState): boolean =>
  state.appClosed && !state.eofTruncated && !state.droppedTrailing;

const finishResult = (state: CompileState, name: string | undefined): WireCompileResult => {
  const tree: TreeV2 = {
    formatVersion: VENDO_TREE_FORMAT_V2,
    root: "root",
    nodes: state.nodes,
  };
  if (state.queries.length > 0) tree.queries = state.queries;
  const result: WireCompileResult = {
    tree,
    components: state.components,
    issues: state.issues,
    complete: determineComplete(state),
  };
  if (name !== undefined) result.name = name;
  return result;
};

const compileWireV2Unsafe = (wire: string, options: WireCompileOptions | undefined): WireCompileResult => {
  const declared = prescanDeclarations(wire);
  const state = makeState(wire, declared.queryNames, declared.islandNames, new Set(options?.hostComponents ?? []));
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
  const app = parseAttributes(state, "app");
  if (app === FAILED) {
    state.eofTruncated = true;
    issue(state, "truncated-tag", "<App ...> tag was truncated at end of input");
    return finishResult(state, undefined);
  }
  // D3 — only App's name attribute means anything; the rest are discarded.
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
 * v2 spec §2 / plan D3/D5/D6 — compile one wire markup document to the
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
