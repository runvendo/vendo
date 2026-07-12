import { validateTree, VENDO_TREE_FORMAT } from "@vendoai/core";
import type { Tree, TreeNode, TreeQuery } from "@vendoai/core";

/**
 * The canonical form of a Tree — the target both compact profiles must
 * round-trip to. Defined explicitly so the property test's equality check has a
 * precise, documented reference (`decode(encode(t))` deep-equals `canonicalize(t)`).
 *
 * canonicalize does exactly four things:
 *
 *  1. Rejects anything `@vendoai/core.validateTree` rejects (throws). A compact
 *     profile is only ever asked to round-trip a *valid* v1 tree.
 *  2. REJECTS (throws on) unknown extension fields — LOUDLY, not silently.
 *     `validateTree` is passthrough at the tree, node, and query levels: it
 *     accepts documents carrying keys outside the contract. Neither profile
 *     encodes such keys, so silently accepting them would make "lossless vs
 *     canonicalize(t)" quietly weaker than "lossless vs what validateTree
 *     accepts". The spike draws that boundary explicitly: any key outside the
 *     contract's field set at those three levels throws here (and therefore in
 *     both `encode`s, which call this first). `props` / `data` / `components`
 *     CONTENTS are data, not extension fields — they pass through untouched.
 *     Boundary stated plainly in DESIGN.md §4.
 *  3. Omits every optional field that is `undefined`, so `{ props: undefined }`
 *     and `{}` are the same value under structural equality.
 *  4. Normalizes an **empty** top-level `queries` array or `components` map to
 *     absent. An empty `queries: []` / `components: {}` carries no information —
 *     no queries, no generated components — so it is equivalent to omitting the
 *     field, exactly as a consumer sees it. This is the ONLY value-level
 *     normalization; it exists because a line-oriented profile represents these
 *     collections by the presence of their lines, and "zero lines" cannot encode
 *     "present but empty" without spending tokens on a marker that no real tree
 *     needs. (Round 4 field audits in the contracts make the same "no consumer,
 *     drop it" call for other fields.)
 *
 * What canonicalize deliberately does NOT touch — all of it is preserved
 * byte-for-value by both profiles, so it needs no normalization:
 *
 *  - **Node array order.** The flat `nodes` array is a set keyed by unique id;
 *    render order is driven by `root` + `children`, never by array position.
 *    Both profiles emit nodes in the input's array order and decode restores it,
 *    so order survives without being canonicalized away.
 *  - **`children` order and contents**, including dangling ids and shared/cyclic
 *    references (the tree is a DAG, not a strict tree).
 *  - **`props` / `data` object contents** (bindings `{$path}` / `{$state}`,
 *    actions, `fn:` strings, arbitrary JSON, unicode). Object *key* order is
 *    irrelevant under structural equality, so it is not normalized.
 *  - **Empty `props: {}` / `children: []` on a node** (present-but-empty is kept
 *    distinct from absent — both profiles can encode the distinction here).
 *  - **`data: {}`** (a present, empty model is kept present).
 */

const TREE_KEYS = new Set(["formatVersion", "root", "nodes", "data", "queries", "components"]);
const NODE_KEYS = new Set(["id", "component", "source", "props", "children"]);
const QUERY_KEYS = new Set(["path", "tool", "input"]);

function rejectUnknownKeys(obj: object, allowed: Set<string>, where: string): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) {
      throw new Error(
        `canonicalize: unknown extension field ${JSON.stringify(key)} on ${where} — ` +
          "the compact profiles do not encode fields outside the vendo-genui/v1 contract " +
          "(loud rejection, per DESIGN.md §4; validateTree alone is passthrough here)",
      );
    }
  }
}

export function canonicalize(input: unknown): Tree {
  const result = validateTree(input);
  if (!result.ok) {
    throw new Error(`canonicalize: not a valid vendo-genui/v1 tree: ${result.error.message}`);
  }
  const t = result.tree;

  rejectUnknownKeys(t, TREE_KEYS, "the tree");
  const nodes: TreeNode[] = t.nodes.map((node) => {
    rejectUnknownKeys(node, NODE_KEYS, `node ${JSON.stringify(node.id)}`);
    const out: TreeNode = { id: node.id, component: node.component };
    if (node.source !== undefined) out.source = node.source;
    if (node.props !== undefined) out.props = node.props;
    if (node.children !== undefined) out.children = node.children;
    return out;
  });

  const canonical: Tree = { formatVersion: VENDO_TREE_FORMAT, root: t.root, nodes };
  if (t.data !== undefined) canonical.data = t.data;
  if (t.queries !== undefined && t.queries.length > 0) {
    canonical.queries = t.queries.map((q, i) => {
      rejectUnknownKeys(q, QUERY_KEYS, `query ${i}`);
      const out: TreeQuery = { path: q.path, tool: q.tool };
      if (q.input !== undefined) out.input = q.input;
      return out;
    });
  }
  if (t.components !== undefined && Object.keys(t.components).length > 0) {
    canonical.components = { ...t.components };
  }
  return canonical;
}
