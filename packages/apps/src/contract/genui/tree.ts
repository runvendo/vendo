import { z } from "zod";
import {
  findInvalidReshape,
  isPlainObject,
  type Json,
  safeErrorMessage,
  TREE_MAX_NODES,
  TREE_MAX_QUERIES,
  type TreeNode,
  treeNodeSchema,
  VENDO_TREE_FORMAT,
} from "@vendoai/core";
import { FN_REFERENCE_PATTERN, findInvalidActionReference } from "../fn-references.js";

/** v2 spec §1–2 (docs/superpowers/specs/2026-07-18-vendo-v2-format-spec.md) —
 *  query names are bare identifiers: the query's result lives at JSON Pointer
 *  `"/" + name` by definition, so there is no `path` field to validate.
 *  Shared with the wire compiler (wire/compile.ts), which validates
 *  `<Query id>` against the same grammar. */
export const QUERY_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** v2 spec §1–2 (docs/superpowers/specs/2026-07-18-vendo-v2-format-spec.md) */
export interface TreeQuery {
  name: string;
  tool: string;
  input?: Record<string, Json>;
}

/**
 * v2 spec §1–2 (docs/superpowers/specs/2026-07-18-vendo-v2-format-spec.md) —
 * structural shape only (the types+zod pairing convention).
 * {@link validateTree} is the normative gate; this schema alone accepts
 * queries validateTree rejects.
 */
export const treeQuerySchema = z.object({
  name: z.string(),
  tool: z.string(),
  input: z.record(z.unknown()).optional(),
}).passthrough() satisfies z.ZodType<TreeQuery>;

/** v2 spec §1–2 (docs/superpowers/specs/2026-07-18-vendo-v2-format-spec.md) —
 *  mirrors v1 `Tree` minus `components`: trees never carry component
 *  sources (they live at the app-document level). Nodes are v1 nodes
 *  verbatim. */
export interface Tree {
  formatVersion: typeof VENDO_TREE_FORMAT;
  root: string;
  nodes: TreeNode[];
  data?: Record<string, Json>;
  queries?: TreeQuery[];
}

/**
 * v2 spec §1–2 (docs/superpowers/specs/2026-07-18-vendo-v2-format-spec.md) —
 * structural shape only (the types+zod pairing convention).
 * The pinned wire rules (caps, name grammar, root/id integrity, fn: syntax,
 * the no-components rule) live in {@link validateTree}, which is the
 * normative gate; this schema alone accepts trees validateTree rejects.
 */
export const treeSchema = z.object({
  formatVersion: z.literal(VENDO_TREE_FORMAT),
  root: z.string(),
  nodes: z.array(treeNodeSchema),
  data: z.record(z.unknown()).optional(),
  queries: z.array(treeQuerySchema).optional(),
}).passthrough() satisfies z.ZodType<Tree>;

type TreeValidation =
  | { ok: true; tree: Tree }
  | { ok: false; error: { code: "version" | "provision"; message: string } };

const fail = (code: "version" | "provision", message: string): TreeValidation => ({
  ok: false,
  error: { code, message },
});

/** The `queries` block: an array within the cap, each entry a well-formed
 *  declaration with a unique, non-reserved identifier name. */
const queriesError = (queries: unknown): TreeValidation | null => {
  if (!Array.isArray(queries)) {
    return fail("provision", "queries must be an array");
  }
  if (queries.length > TREE_MAX_QUERIES) {
    return fail("provision", `too many queries (max ${TREE_MAX_QUERIES})`);
  }
  const queryNames = new Set<string>();
  for (const query of queries) {
    if (!isPlainObject(query)) {
      return fail("provision", "each query must be an object");
    }
    if (typeof query.name !== "string" || !QUERY_NAME_PATTERN.test(query.name)) {
      return fail("provision", "query name must match /^[A-Za-z_][A-Za-z0-9_]*$/");
    }
    if (query.name === "state") {
      return fail("provision", 'query name "state" is reserved');
    }
    if (queryNames.has(query.name)) {
      return fail("provision", `duplicate query name "${query.name}"`);
    }
    queryNames.add(query.name);
    if (typeof query.tool !== "string" || query.tool.length === 0) {
      return fail("provision", "query tool must be a non-empty string");
    }
    if (query.tool.startsWith("fn:") && !FN_REFERENCE_PATTERN.test(query.tool)) {
      return fail("provision", `query tool "${query.tool}" is not a valid fn: reference`);
    }
    if (query.input !== undefined && !isPlainObject(query.input)) {
      return fail("provision", "query input must be a plain object");
    }
  }
  return null;
};

/** One node's own shape and prop grammar — everything checkable without
 *  looking at the rest of the tree. */
const nodeError = (node: unknown): TreeValidation | null => {
  if (!isPlainObject(node)) {
    return fail("provision", "each node must be an object");
  }
  if (typeof node.id !== "string" || node.id.length === 0) {
    return fail("provision", "each node must have a non-empty string id");
  }
  if (typeof node.component !== "string") {
    return fail("provision", `node "${node.id}" must have a string component`);
  }
  if (node.source !== undefined && !["prewired", "host", "generated"].includes(node.source as string)) {
    return fail("provision", `node "${node.id}" has an invalid source`);
  }
  if (node.children !== undefined
    && (!Array.isArray(node.children) || !node.children.every((child) => typeof child === "string"))) {
    return fail("provision", `node "${node.id}" children must be an array of strings`);
  }
  if (node.props !== undefined && !isPlainObject(node.props)) {
    return fail("provision", `node "${node.id}" props must be a plain object`);
  }
  if (node.props !== undefined) {
    // Same rule as v1 CORE-5 (01 §8): fn: grammar holds ANYWHERE a tree
    // names a callable — action names in props included. Machine-presence
    // and generated-component presence are enforced one level up by the
    // app-document validator, which knows `server` and `components`.
    const invalidAction = findInvalidActionReference(node.props);
    if (invalidAction !== null) {
      return fail("provision", `node "${node.id}" action "${invalidAction}" is not a valid fn: reference`);
    }
    // v2 spec §3 — the bounded reshape vocabulary is enforced here at the
    // format gate (same walk discipline as the fn: action rule above), so
    // an unknown op or malformed chain can never reach the renderer.
    const invalidReshape = findInvalidReshape(node.props);
    if (invalidReshape !== null) {
      return fail("provision", `node "${node.id}" has an invalid $reshape: ${invalidReshape}`);
    }
  }
  return null;
};

/** Every node, plus the cross-node id uniqueness rule. Fills `ids` so the
 *  caller can check the root against it. */
const nodesError = (nodes: readonly unknown[], ids: Set<string>): TreeValidation | null => {
  for (const node of nodes) {
    const violation = nodeError(node);
    if (violation !== null) return violation;
    const { id } = node as { id: string };
    if (ids.has(id)) {
      return fail("provision", `duplicate node id "${id}"`);
    }
    ids.add(id);
  }
  return null;
};

const validateTreeUnsafe = (input: unknown): TreeValidation => {
  if (!isPlainObject(input)) {
    return fail("provision", "tree must be a non-null object");
  }
  if (input.formatVersion !== VENDO_TREE_FORMAT) {
    return fail("version", `formatVersion must be "${VENDO_TREE_FORMAT}"`);
  }

  const { root, nodes } = input;
  if (typeof root !== "string" || root.length === 0) {
    return fail("provision", "root must be a non-empty string");
  }
  if (!Array.isArray(nodes)) {
    return fail("provision", "nodes must be an array");
  }
  if (nodes.length > TREE_MAX_NODES) {
    return fail("provision", `too many nodes (max ${TREE_MAX_NODES})`);
  }
  if (input.data !== undefined && !isPlainObject(input.data)) {
    return fail("provision", "data must be a plain object");
  }
  if (input.components !== undefined) {
    return fail("provision", "trees must not carry components (they live at the app-document level)");
  }

  if (input.queries !== undefined) {
    const violation = queriesError(input.queries);
    if (violation !== null) return violation;
  }

  const ids = new Set<string>();
  const violation = nodesError(nodes, ids);
  if (violation !== null) return violation;

  if (!ids.has(root)) {
    return fail("provision", `root "${root}" does not match any node id`);
  }
  return { ok: true, tree: input as unknown as Tree };
};

/** v2 spec §1–2 (docs/superpowers/specs/2026-07-18-vendo-v2-format-spec.md) */
export function validateTree(input: unknown): TreeValidation {
  try {
    return validateTreeUnsafe(input);
  } catch (error) {
    return fail("provision", `tree validation failed: ${safeErrorMessage(error)}`);
  }
}
