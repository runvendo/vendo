import { VENDO_TREE_FORMAT } from "@vendoai/core";
import type { Json, Tree, TreeNode, TreeQuery } from "@vendoai/core";
import { canonicalize } from "./canonicalize.js";

/**
 * Candidate A — CJT ("Compact JSON Tree"), a conservative JSON profile.
 *
 * Same JSON container as the readable tree, but the three sources of structural
 * redundancy are removed:
 *   - single-char keys (`f`,`r`,`k`,`n`,`d`,`q`,`c`) instead of the long ones;
 *   - a component-name **intern table** (`k`): every node names its component by
 *     integer index, so `"Text"`/`"Stack"`/`"Surface"` are spelled once;
 *   - **positional node tuples** `[id, compIdx, srcCode, props, children]` with
 *     trailing absent fields truncated, so per-node key names disappear entirely.
 *   - the `source` enum is a small integer (0=absent,1/2/3=prewired/host/generated).
 *
 * This is a MACHINE profile: the server would encode it and the client decode it.
 * The intern table means a correct document can only be written once the whole
 * node set is known, which is exactly why it is a poor fit for left-to-right LLM
 * emission and streaming (see DESIGN.md) — measured, not assumed.
 *
 * Lossless: `decodeCjt(encodeCjt(t))` deep-equals `canonicalize(t)`.
 */

const SRC_CODE: Record<NonNullable<TreeNode["source"]>, number> = {
  prewired: 1,
  host: 2,
  generated: 3,
};
const SRC_NAME: Record<number, TreeNode["source"]> = {
  1: "prewired",
  2: "host",
  3: "generated",
};

const CJT_TAG = "vendo-cjt/1";

/** A CJT node tuple. Slots past the first two are dropped when trailing-absent. */
type CjtNode = [string, number, ...Json[]];

/** A CJT query tuple: [path, tool] or [path, tool, input]. */
type CjtQuery = [string, string] | [string, string, Json];

export interface CjtDocument {
  f: typeof CJT_TAG;
  r: string;
  k: string[];
  n: CjtNode[];
  d?: Record<string, Json>;
  q?: CjtQuery[];
  c?: Record<string, string>;
}

export function encodeCjt(input: unknown): CjtDocument {
  const tree = canonicalize(input);

  const table: string[] = [];
  const index = new Map<string, number>();
  const intern = (name: string): number => {
    let i = index.get(name);
    if (i === undefined) {
      i = table.length;
      table.push(name);
      index.set(name, i);
    }
    return i;
  };

  const n: CjtNode[] = tree.nodes.map((node) => {
    const tuple: Json[] = [
      node.id,
      intern(node.component),
      node.source ? SRC_CODE[node.source] : 0,
      node.props !== undefined ? node.props : 0,
      node.children !== undefined ? node.children : 0,
    ];
    // Drop trailing "absent" (0) slots, but never below [id, compIdx].
    while (tuple.length > 2 && tuple[tuple.length - 1] === 0) tuple.pop();
    return tuple as CjtNode;
  });

  const doc: CjtDocument = { f: CJT_TAG, r: tree.root, k: table, n };
  if (tree.data !== undefined) doc.d = tree.data;
  if (tree.queries !== undefined) {
    doc.q = tree.queries.map((query): CjtQuery =>
      query.input !== undefined ? [query.path, query.tool, query.input] : [query.path, query.tool],
    );
  }
  if (tree.components !== undefined) doc.c = { ...tree.components };
  return doc;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const DOC_KEYS = new Set(["f", "r", "k", "n", "d", "q", "c"]);

/**
 * STRICT decode — this decoder is the validity oracle for the live emission
 * measurement, so anything off-grammar throws: wrong/unknown `f` tag, unknown
 * document keys, wrong field types, tuple arity outside 2..5, out-of-range
 * component indexes, source codes outside {0,1,2,3}, non-object props/data/
 * input, non-string-array children, malformed query/component shapes.
 * (Duplicate node ids and the caps are the tree validator's job — parseArm
 * runs validateTree on every decode, so those still count as invalid.)
 */
export function decodeCjt(input: unknown): Tree {
  if (!isPlainObject(input)) throw new Error("cjt: document must be a JSON object");
  for (const key of Object.keys(input)) {
    if (!DOC_KEYS.has(key)) throw new Error(`cjt: unknown document key ${JSON.stringify(key)}`);
  }
  const doc = input as Record<string, unknown>;
  if (doc.f !== CJT_TAG) throw new Error(`cjt: format tag must be ${JSON.stringify(CJT_TAG)}`);
  if (typeof doc.r !== "string") throw new Error("cjt: r (root) must be a string");
  if (!Array.isArray(doc.k) || !doc.k.every((name) => typeof name === "string")) {
    throw new Error("cjt: k (intern table) must be an array of strings");
  }
  if (!Array.isArray(doc.n)) throw new Error("cjt: n (nodes) must be an array");

  const table = doc.k as string[];
  const nodes: TreeNode[] = (doc.n as unknown[]).map((raw, i) => {
    if (!Array.isArray(raw) || raw.length < 2 || raw.length > 5) {
      throw new Error(`cjt: node ${i} must be a tuple of arity 2..5`);
    }
    const tuple = raw as unknown[];
    if (typeof tuple[0] !== "string") throw new Error(`cjt: node ${i} id must be a string`);
    if (typeof tuple[1] !== "number" || !Number.isInteger(tuple[1]) || tuple[1] < 0 || tuple[1] >= table.length) {
      throw new Error(`cjt: node ${i} component index out of range`);
    }
    const node: TreeNode = { id: tuple[0], component: table[tuple[1]]! };

    if (tuple.length > 2) {
      const srcCode = tuple[2];
      if (srcCode !== 0 && srcCode !== 1 && srcCode !== 2 && srcCode !== 3) {
        throw new Error(`cjt: node ${i} source code must be 0..3`);
      }
      if (srcCode !== 0) node.source = SRC_NAME[srcCode];
    }
    if (tuple.length > 3) {
      const props = tuple[3];
      if (props !== 0) {
        if (!isPlainObject(props)) throw new Error(`cjt: node ${i} props must be an object or 0`);
        node.props = props as Record<string, Json>;
      }
    }
    if (tuple.length > 4) {
      const children = tuple[4];
      if (children !== 0) {
        if (!Array.isArray(children) || !children.every((c) => typeof c === "string")) {
          throw new Error(`cjt: node ${i} children must be an array of strings or 0`);
        }
        node.children = children as string[];
      }
    }
    return node;
  });

  const tree: Tree = { formatVersion: VENDO_TREE_FORMAT, root: doc.r, nodes };
  if (doc.d !== undefined) {
    if (!isPlainObject(doc.d)) throw new Error("cjt: d (data) must be an object");
    tree.data = doc.d as Record<string, Json>;
  }
  if (doc.q !== undefined) {
    if (!Array.isArray(doc.q)) throw new Error("cjt: q (queries) must be an array");
    tree.queries = (doc.q as unknown[]).map((raw, i): TreeQuery => {
      if (
        !Array.isArray(raw) ||
        raw.length < 2 ||
        raw.length > 3 ||
        typeof raw[0] !== "string" ||
        typeof raw[1] !== "string" ||
        (raw.length === 3 && !isPlainObject(raw[2]))
      ) {
        throw new Error(`cjt: query ${i} must be [path, tool] or [path, tool, inputObject]`);
      }
      const query: TreeQuery = { path: raw[0], tool: raw[1] };
      if (raw.length === 3) query.input = raw[2] as Record<string, Json>;
      return query;
    });
  }
  if (doc.c !== undefined) {
    if (!isPlainObject(doc.c) || !Object.values(doc.c).every((src) => typeof src === "string")) {
      throw new Error("cjt: c (components) must be an object of string sources");
    }
    tree.components = { ...(doc.c as Record<string, string>) };
  }
  return tree;
}

/** Serialize CJT to its wire string (minified JSON). */
export function encodeCjtString(input: unknown): string {
  return JSON.stringify(encodeCjt(input));
}

/** Parse a CJT wire string back to a Tree (strict). */
export function decodeCjtString(wire: string): Tree {
  return decodeCjt(JSON.parse(wire));
}
