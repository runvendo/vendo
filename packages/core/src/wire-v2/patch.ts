/**
 * The vendo-genui/v2 edit dialect (v2 spec §5,
 * docs/superpowers/specs/2026-07-18-vendo-v2-format-spec.md): ONE dialect —
 * the model sees the app printed as wire markup with id anchors (print.ts)
 * and emits a small `<Edit>` document of op elements in the SAME
 * element/attribute/expression grammar; this module applies it against a
 * base compile result deterministically and re-validates the outcome
 * (validateTreeV2 + the wave-3 shape check). No JSON-ops dialect exists.
 *
 * Total like the create compiler: a bad op records an issue and is SKIPPED
 * whole (never half-applied); a truncated document applies the ops that
 * parsed and reports `complete: false`; the base inputs are never mutated
 * (copy-on-write), and untouched nodes keep their object identity — the
 * edit-locality guarantee hot-swap keys off.
 *
 * Ops: Set / Unset / Insert / Remove / Move (nodes, by compiler-stamped id),
 * Query / RemoveQuery (upsert/delete by name), Island / RemoveIsland,
 * SetName. Inserted subtrees compile exactly like wave-1 children (source
 * resolution, §8 caps, text minting), with fresh ids continuing each
 * component's ordinal past the maximum already present.
 */

import { VENDO_TREE_FORMAT_V2 } from "../formats.js";
// CORE-6: the §8-capped generated-components byte measure is the shared
// UTF-8 counter (the limits.ts pattern).
import { utf8ByteLength } from "../component-map.js";
import { safeErrorMessage } from "../errors.js";
import type { Json } from "../ids.js";
import { TREE_MAX_GENERATED_COMPONENTS, TREE_MAX_QUERIES, TREE_MAX_TOTAL_COMPONENT_BYTES } from "../tree-limits.js";
import { defineOwn, type TreeNode } from "../tree.js";
import { validateTreeV2, type TreeQueryV2, type TreeV2 } from "../tree-v2.js";
import { parseAttributes } from "./attributes.js";
import {
  compileIsland,
  compileQuery,
  makeState,
  opensRoot,
  parseChildren,
  prescanDeclarations,
  type WireCompileOptions,
  type WireCompileResult,
} from "./compile.js";
import type { WireIssue } from "./expression.js";
import { checkBindingShapes, mirrorBindingIssues } from "./shape-check.js";
import { collectText, readName, scanCloseTag, skipElement, skipWhitespace } from "./scan.js";
import { FAILED, issue, type CompileState, type Frame } from "./state.js";

/** v2 spec §5 — the patch input: a prior compile (or patch) result. */
export type WirePatchBase = Pick<WireCompileResult, "tree" | "components" | "name">;

/** v2 spec §5 — patch options: the create compiler's plus the extension-op
 *  declarations. Extension ops keep the dialect singular for CALLER-POLICY
 *  operations (the engine's ForkPin/SetDescription): a declared, self-closing
 *  op element parses in the same grammar and is handed back untouched in
 *  {@link WirePatchResult.extensionOps} instead of erroring — core stays
 *  policy-free, the model still speaks one grammar. */
export interface WirePatchOptions extends WireCompileOptions {
  extensionOps?: readonly string[];
}

/** v2 spec §5 — one collected extension op (document order). */
export interface PatchExtensionOp {
  op: string;
  props: Record<string, Json>;
}

/** v2 spec §5 — patch-only result additions: the collected extension ops and
 *  the count of successfully APPLIED ops (a valid op whose result happens to
 *  equal the input — a no-op Move — still counts; skipped ops do not). */

/** v2 spec §5 — mirrors {@link WireCompileResult}: the patched document plus
 *  ordered issues, the wave-3 repair contract, streaming completeness, and
 *  the caller's collected extension ops. */
export type WirePatchResult = WireCompileResult & { extensionOps: PatchExtensionOp[]; appliedOps: number };

const MINTED_ID_PATTERN = /^([a-z][a-z0-9]*)-([1-9]\d*)$/;

/** The attribute-only (self-closing) op elements. Insert/Query/Island parse
 *  their own content above; anything else inside <Edit> is unknown. */
const ATTRIBUTE_OPS: ReadonlySet<string> = new Set([
  "Set",
  "Unset",
  "Remove",
  "Move",
  "SetName",
  "RemoveQuery",
  "RemoveIsland",
]);

interface PatchTree {
  /** Node order: base order, then inserts, minus removals (applied last). */
  order: string[];
  byId: Map<string, TreeNode>;
  parentOf: Map<string, string>;
  removed: Set<string>;
  /** Copy-on-write: ids whose node object is already this patch's own. */
  owned: Set<string>;
}

const buildPatchTree = (tree: TreeV2): PatchTree => {
  const byId = new Map(tree.nodes.map((node) => [node.id, node]));
  const parentOf = new Map<string, string>();
  for (const node of tree.nodes) {
    for (const childId of node.children ?? []) parentOf.set(childId, node.id);
  }
  return {
    order: tree.nodes.map((node) => node.id),
    byId,
    parentOf,
    removed: new Set(),
    owned: new Set(),
  };
};

/** Copy-on-write node access: the first mutation of a base node replaces it
 *  with a shallow-cloned copy (props/children cloned one level), so the base
 *  result is never mutated and untouched nodes keep identity. */
const mutable = (patch: PatchTree, id: string): TreeNode => {
  const node = patch.byId.get(id) as TreeNode;
  if (patch.owned.has(id)) return node;
  const clone: TreeNode = { ...node };
  if (node.props !== undefined) clone.props = { ...node.props };
  if (node.children !== undefined) clone.children = [...node.children];
  patch.byId.set(id, clone);
  patch.owned.add(id);
  return clone;
};

const liveTarget = (patch: PatchTree, id: unknown): string | null =>
  typeof id === "string" && patch.byId.has(id) && !patch.removed.has(id) ? id : null;

/** Primes the mint ordinals past every id already present, so inserted nodes
 *  never collide with base ids (including ids removed by this same patch). */
const primeOrdinals = (state: CompileState, ids: Iterable<string>): void => {
  for (const id of ids) {
    const match = MINTED_ID_PATTERN.exec(id);
    if (match === null) continue;
    const ordinal = Number(match[2]);
    const key = match[1] as string;
    if (ordinal > (state.ordinals.get(key) ?? 0)) state.ordinals.set(key, ordinal);
  }
};

/** `at={n}` — a non-negative integer when present; null = append. */
const parseIndex = (value: unknown): number | null | typeof FAILED => {
  if (value === undefined) return null;
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) return value;
  return FAILED;
};

/** Structural ops take a CLOSED attribute set (Set/Unset are open by
 *  design — their attributes ARE the payload). A typo like position= must be
 *  loud, not a silent misplacement. Returns the violation message or null. */
const OP_ALLOWED_ATTRS: Readonly<Record<string, readonly string[]>> = {
  Insert: ["into", "at"],
  Move: ["id", "into", "at"],
  Remove: ["id"],
  SetName: ["name"],
  RemoveQuery: ["id"],
  RemoveIsland: ["name"],
};

const unknownAttrs = (op: string, props: Record<string, unknown>): string | null => {
  const allowed = OP_ALLOWED_ATTRS[op];
  if (allowed === undefined) return null;
  const unexpected = Object.keys(props).filter((key) => !allowed.includes(key));
  if (unexpected.length === 0) return null;
  return `<${op}> does not take ${unexpected.map((key) => `"${key}"`).join(", ")} (allowed: ${allowed.join(", ")}); the op was skipped`;
};

/** An explicit index past the current child count is a gap — loud, not a
 *  silent append (the model misread the structure; repair teaches it). */
const gapIndex = (patch: PatchTree, parentId: string, at: number | null): boolean => {
  if (at === null) return false;
  return at > (patch.byId.get(parentId)?.children ?? []).length;
};

const spliceChildren = (patch: PatchTree, parentId: string, at: number | null, ids: readonly string[]): void => {
  const parent = mutable(patch, parentId);
  const children = parent.children ?? [];
  const index = at === null ? children.length : Math.min(at, children.length);
  parent.children = [...children.slice(0, index), ...ids, ...children.slice(index)];
  for (const id of ids) patch.parentOf.set(id, parentId);
};

const unlinkFromParent = (patch: PatchTree, id: string): void => {
  const parentId = patch.parentOf.get(id);
  if (parentId === undefined) return;
  const parent = mutable(patch, parentId);
  parent.children = (parent.children ?? []).filter((childId) => childId !== id);
  if (parent.children.length === 0) delete parent.children;
  patch.parentOf.delete(id);
};

const removeSubtree = (patch: PatchTree, id: string): void => {
  unlinkFromParent(patch, id);
  const pending = [id];
  while (pending.length > 0) {
    const current = pending.pop() as string;
    if (patch.removed.has(current)) continue;
    patch.removed.add(current);
    pending.push(...(patch.byId.get(current)?.children ?? []));
  }
};

/** True when `candidate` is `ancestorOf` or sits anywhere below it. */
const inSubtree = (patch: PatchTree, candidate: string, ancestorOf: string): boolean => {
  let current: string | undefined = candidate;
  while (current !== undefined) {
    if (current === ancestorOf) return true;
    current = patch.parentOf.get(current);
  }
  return false;
};

/** Ops are self-closing; paired content is skipped with an issue (the
 *  query-content stance). */
const skipOpContent = (state: CompileState, selfClosing: boolean, op: string): void => {
  if (selfClosing) return;
  issue(state, "invalid-patch-op", `<${op}> is self-closing; the element content was skipped`);
  skipElement(state, op);
};

const compileWirePatchV2Unsafe = (
  wire: string,
  base: WirePatchBase,
  options: WirePatchOptions | undefined,
): WirePatchResult => {
  const failResult = (issues: WireIssue[]): WirePatchResult => ({
    tree: base.tree,
    components: base.components,
    ...(base.name === undefined ? {} : { name: base.name }),
    issues,
    bindingErrors: [],
    extensionOps: [],
    appliedOps: 0,
    complete: false,
  });
  const declaredExtensions = new Set(options?.extensionOps ?? []);
  const extensionOps: PatchExtensionOp[] = [];
  let appliedOps = 0;

  // Forward references: bindings and source resolution see base declarations
  // plus everything this patch declares anywhere (the wave-1 cap-blind
  // pre-scan stance).
  const declared = prescanDeclarations(wire, "Edit");
  for (const query of base.tree.queries ?? []) declared.queryNames.add(query.name);
  for (const name of Object.keys(base.components)) declared.islandNames.add(name);
  const state = makeState(wire, declared.queryNames, declared.islandNames, new Set(options?.hostComponents ?? []));
  const patch = buildPatchTree(base.tree);
  primeOrdinals(state, patch.byId.keys());
  // The §8 node cap must count base + inserted: seed the array with the base
  // nodes (references only; emitNode appends, never mutates entries).
  state.nodes.push(...base.tree.nodes);
  let name = base.name;
  let removedIslands: Set<string> | null = null;
  const removedQueries = new Set<string>();

  skipWhitespace(state);
  if (!opensRoot(state, "Edit")) {
    return failResult([{ code: "missing-edit", message: "expected a single <Edit>...</Edit> document" }]);
  }
  state.index += 5; // consume "<Edit"
  const editTag = parseAttributes(state, "declaration");
  if (editTag === FAILED) {
    return failResult([{ code: "truncated-tag", message: "<Edit ...> tag was truncated at end of input" }]);
  }

  let editClosed = editTag.selfClosing;
  while (!editClosed && state.index < state.source.length) {
    const text = collectText(state).trim();
    if (text.length > 0) {
      issue(state, "invalid-patch-op", "bare text inside <Edit> means nothing; it was ignored");
    }
    if (state.index >= state.source.length) break;
    if (state.source[state.index + 1] === "/") {
      const close = scanCloseTag(state);
      if (close === FAILED) break;
      if (close.name === "Edit") {
        editClosed = true;
        break;
      }
      issue(state, "stray-close-tag", `</${close.name}> does not match any open element`);
      continue;
    }
    state.index += 1;
    const op = readName(state);
    if (op.length === 0 && state.index >= state.source.length) {
      issue(state, "truncated-tag", '"<" at end of input starts an incomplete tag; it was dropped');
      break;
    }

    if (op === "Query") {
      // Document order: a hoist AFTER a <RemoveQuery> of the same name is a
      // replacement, so the removal must not suppress it at assembly.
      const hoistedBefore = state.queries.length;
      compileQuery(state, [{ tag: "Edit", node: { id: "", component: "Edit" } }]);
      if (state.queries.length > hoistedBefore) {
        removedQueries.delete((state.queries[hoistedBefore] as TreeQueryV2).name);
      }
      continue;
    }
    if (op === "Island") {
      // Document order, same as Query: an admitted source un-does an earlier
      // <RemoveIsland> of the same name (defineOwn appends, so the new name
      // is the last key).
      const admittedBefore = Object.keys(state.components).length;
      compileIsland(state);
      const islandNames = Object.keys(state.components);
      if (islandNames.length > admittedBefore) {
        removedIslands?.delete(islandNames[islandNames.length - 1] as string);
      }
      continue;
    }
    if (op === "Insert") {
      const attrs = parseAttributes(state, "patch");
      if (attrs === FAILED) {
        issue(state, "truncated-tag", "<Insert> tag was truncated at end of input; the op was dropped");
        break;
      }
      const at = parseIndex(attrs.props?.at);
      const target = liveTarget(patch, attrs.props?.into);
      const badAttrs = unknownAttrs("Insert", attrs.props ?? {});
      if (attrs.selfClosing) {
        issue(state, "invalid-patch-op", "<Insert> has no content; the op was skipped");
        continue;
      }
      // Parse the subtree regardless of target validity — the cursor must
      // advance identically for determinism; a bad anchor discards the
      // parsed nodes afterwards.
      const container: TreeNode = { id: "", component: "Insert" };
      const before = state.nodes.length;
      parseChildren(state, [{ tag: "Insert", node: container }], "Insert");
      state.appClosed = false; // parseChildren's frame-0 close is our </Insert>
      const inserted = state.nodes.slice(before);
      const insertGap = target !== null && at !== FAILED && gapIndex(patch, target, at);
      if (target === null || at === FAILED || badAttrs !== null || insertGap) {
        issue(
          state,
          target === null ? "unknown-target" : "invalid-patch-op",
          target === null
            ? `<Insert> into "${String(attrs.props?.into ?? "")}" does not name a node; the op was skipped`
            : badAttrs !== null
              ? badAttrs
              : at === FAILED
                ? "<Insert> at must be a non-negative integer; the op was skipped"
                : `<Insert> at={${String(at)}} leaves a gap in "${target}" children; the op was skipped`,
        );
        state.nodes.length = before; // discard the parsed subtree
        continue;
      }
      for (const node of inserted) {
        patch.order.push(node.id);
        patch.byId.set(node.id, node);
        patch.owned.add(node.id);
        for (const childId of node.children ?? []) patch.parentOf.set(childId, node.id);
      }
      spliceChildren(patch, target, at, container.children ?? []);
      appliedOps += 1;
      continue;
    }

    // Every remaining op is a self-closing attribute-only element.
    const attrs = parseAttributes(state, "patch");
    if (attrs === FAILED) {
      issue(state, "truncated-tag", `<${op}> tag was truncated at end of input; the op was dropped`);
      break;
    }
    if (!ATTRIBUTE_OPS.has(op)) {
      if (declaredExtensions.has(op)) {
        // A caller-declared extension op: collected verbatim, never applied
        // here. Content is skipped like every attribute-only op's.
        extensionOps.push({ op, props: attrs.props ?? {} });
        skipOpContent(state, attrs.selfClosing, op);
        continue;
      }
      // Unknown op (nested App/Edit included): skip the element and subtree.
      issue(state, "invalid-patch-op", `<${op}> is not an edit op; the element was skipped`);
      if (!attrs.selfClosing) skipElement(state, op);
      continue;
    }
    skipOpContent(state, attrs.selfClosing, op);
    const props = attrs.props ?? {};
    const badAttrs = unknownAttrs(op, props);
    if (badAttrs !== null) {
      issue(state, "invalid-patch-op", badAttrs);
      continue;
    }

    if (op === "Set" || op === "Unset") {
      const target = liveTarget(patch, props.id);
      if (target === null) {
        issue(state, "unknown-target", `<${op}> id "${String(props.id ?? "")}" does not name a node; the op was skipped`);
        continue;
      }
      const node = mutable(patch, target);
      const entries = Object.entries(props).filter(([key]) => key !== "id");
      if (op === "Set") {
        if (entries.length === 0) continue;
        const merged: Record<string, Json> = { ...(node.props ?? {}) };
        for (const [key, value] of entries) {
          defineOwn(merged, key, value);
        }
        node.props = merged;
        appliedOps += 1;
      } else {
        const remaining: Record<string, Json> = { ...(node.props ?? {}) };
        for (const [key, value] of entries) {
          if (value !== true) {
            issue(state, "invalid-patch-op", `<Unset> names props as bare attributes; "${key}" had a value and was ignored`);
            continue;
          }
          delete remaining[key];
        }
        if (Object.keys(remaining).length === 0) {
          delete node.props;
        } else {
          node.props = remaining;
        }
        appliedOps += 1;
      }
      continue;
    }

    if (op === "Remove") {
      const target = liveTarget(patch, props.id);
      if (target === null) {
        issue(state, "unknown-target", `<Remove> id "${String(props.id ?? "")}" does not name a node; the op was skipped`);
        continue;
      }
      if (target === base.tree.root) {
        issue(state, "invalid-patch-op", "the root node cannot be removed; the op was skipped");
        continue;
      }
      removeSubtree(patch, target);
      appliedOps += 1;
      continue;
    }

    if (op === "Move") {
      const target = liveTarget(patch, props.id);
      const into = liveTarget(patch, props.into);
      const at = parseIndex(props.at);
      if (target === null || into === null) {
        issue(state, "unknown-target", `<Move> needs live id and into anchors; the op was skipped`);
        continue;
      }
      if (target === base.tree.root || at === FAILED || inSubtree(patch, into, target) || gapIndex(patch, into, at)) {
        issue(
          state,
          "invalid-patch-op",
          target === base.tree.root
            ? "the root node cannot be moved; the op was skipped"
            : at === FAILED
              ? "<Move> at must be a non-negative integer; the op was skipped"
              : inSubtree(patch, into, target)
                ? `moving "${target}" under its own descendant "${into}" would create a cycle; the op was skipped`
                : `<Move> at leaves a gap in "${into}" children; the op was skipped`,
        );
        continue;
      }
      unlinkFromParent(patch, target);
      spliceChildren(patch, into, at, [target]);
      appliedOps += 1;
      continue;
    }

    if (op === "SetName") {
      if (typeof props.name !== "string") {
        issue(state, "invalid-patch-op", "<SetName> needs a string name attribute; the op was skipped");
        continue;
      }
      name = props.name;
      appliedOps += 1;
      continue;
    }

    if (op === "RemoveQuery") {
      const queryName = props.id;
      const exists = typeof queryName === "string"
        && !removedQueries.has(queryName)
        && ((base.tree.queries ?? []).some((query) => query.name === queryName)
          || state.queries.some((query) => query.name === queryName));
      if (!exists) {
        issue(state, "unknown-target", `<RemoveQuery> id "${String(queryName ?? "")}" does not name a query; the op was skipped`);
        continue;
      }
      removedQueries.add(queryName as string);
      appliedOps += 1;
      continue;
    }

    if (op === "RemoveIsland") {
      const islandName = props.name;
      removedIslands ??= new Set();
      const exists = typeof islandName === "string"
        && !removedIslands.has(islandName)
        && (Object.prototype.hasOwnProperty.call(base.components, islandName)
          || Object.prototype.hasOwnProperty.call(state.components, islandName));
      if (!exists) {
        issue(state, "unknown-target", `<RemoveIsland> name "${String(islandName ?? "")}" does not name an island; the op was skipped`);
        continue;
      }
      removedIslands.add(islandName as string);
      appliedOps += 1;
      continue;
    }

  }

  if (!editClosed) {
    state.eofTruncated = true;
    issue(state, "eof-unclosed", "<Edit> was not closed before end of input");
  } else {
    skipWhitespace(state);
    if (state.index < state.source.length) {
      state.droppedTrailing = true;
      issue(state, "trailing-content", "content after </Edit> was dropped");
    }
  }

  // — assembly: queries (base order + upserts − removals, §8-capped) —
  const queries: TreeQueryV2[] = [];
  const upserts = new Map(state.queries.map((query) => [query.name, query]));
  for (const query of base.tree.queries ?? []) {
    if (removedQueries.has(query.name)) continue;
    const replacement = upserts.get(query.name);
    queries.push(replacement ?? query);
    upserts.delete(query.name);
  }
  for (const query of state.queries) {
    if (!upserts.has(query.name) || removedQueries.has(query.name)) continue;
    if (queries.length >= TREE_MAX_QUERIES) {
      if (!state.queryLimitIssued) {
        state.queryLimitIssued = true;
        issue(state, "query-limit", `too many queries (max ${TREE_MAX_QUERIES}); further queries were dropped`);
      }
      continue;
    }
    queries.push(query);
    upserts.delete(query.name);
  }

  // — islands (upsert − removals, §8 count/byte caps re-enforced globally) —
  const components: Record<string, string> = {};
  for (const [key, source] of Object.entries(base.components)) {
    if (removedIslands?.has(key)) continue;
    defineOwn(components, key, Object.prototype.hasOwnProperty.call(state.components, key)
      ? state.components[key] as string
      : source);
  }
  for (const [key, source] of Object.entries(state.components)) {
    if (Object.prototype.hasOwnProperty.call(components, key) || removedIslands?.has(key)) continue;
    const names = Object.keys(components);
    const totalBytes = names.reduce((total, existing) => total + utf8ByteLength(components[existing] as string), 0);
    if (names.length >= TREE_MAX_GENERATED_COMPONENTS || totalBytes + utf8ByteLength(source) > TREE_MAX_TOTAL_COMPONENT_BYTES) {
      if (!state.componentLimitIssued) {
        state.componentLimitIssued = true;
        issue(state, "component-limit", "generated-component caps reached; further islands were dropped");
      }
      continue;
    }
    defineOwn(components, key, source);
  }

  // — nodes: base order + inserts − removals; dangling-generated degrades
  //   sourceless (the wave-1 reconciliation stance) —
  const nodes: TreeNode[] = [];
  for (const id of patch.order) {
    if (patch.removed.has(id)) continue;
    const node = patch.byId.get(id) as TreeNode;
    if (node.source === "generated" && components[node.component] === undefined) {
      delete mutable(patch, id).source; // mutable() is a no-op copy on owned nodes
    }
    nodes.push(patch.byId.get(id) as TreeNode);
  }

  const tree: TreeV2 = {
    formatVersion: VENDO_TREE_FORMAT_V2,
    root: base.tree.root,
    nodes,
  };
  if (base.tree.data !== undefined) tree.data = base.tree.data;
  if (queries.length > 0) tree.queries = queries;

  // v2 spec §5 — re-validate: the applied result must pass the same gates as
  // a create. A failure (impossible from compiler-produced bases) degrades
  // to the untouched base.
  const validation = validateTreeV2(tree);
  if (!validation.ok) {
    return failResult([
      ...state.issues,
      { code: "patch-invalid", message: `patched tree failed re-validation: ${validation.error.message}` },
    ]);
  }
  const bindingErrors = options?.toolShapes === undefined
    ? []
    : checkBindingShapes(nodes, queries, options.toolShapes);
  mirrorBindingIssues(state, bindingErrors);

  const result: WirePatchResult = {
    tree,
    components,
    issues: state.issues,
    bindingErrors,
    extensionOps,
    // Hoisted Query/Island declarations are ops too.
    appliedOps: appliedOps + state.queries.length + Object.keys(state.components).length,
    complete: editClosed && !state.eofTruncated && !state.droppedTrailing,
  };
  if (name !== undefined) result.name = name;
  return result;
};

/**
 * v2 spec §5 — apply one `<Edit>` wire patch to a base compile result.
 * Deterministic, pure, total: never throws, never mutates the base, and the
 * result always passes validateTreeV2 (a re-validation failure returns the
 * base unchanged with a `patch-invalid` issue).
 */
export function compileWirePatchV2(
  wire: string,
  base: WirePatchBase,
  options?: WirePatchOptions,
): WirePatchResult {
  try {
    return compileWirePatchV2Unsafe(wire, base, options);
  } catch (error) {
    return {
      tree: base.tree,
      components: base.components,
      ...(base.name === undefined ? {} : { name: base.name }),
      issues: [{ code: "compile-failed", message: `wire patch failed: ${safeErrorMessage(error)}` }],
      bindingErrors: [],
      extensionOps: [],
      appliedOps: 0,
      complete: false,
    };
  }
}
