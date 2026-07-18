import { z } from "zod";
import { safeErrorMessage } from "./errors.js";
import { VENDO_TREE_FORMAT_V2 } from "./formats.js";
import { FN_REFERENCE_PATTERN, findInvalidActionReference } from "./fn-references.js";
import type { Json } from "./ids.js";
import { TREE_MAX_NODES, TREE_MAX_QUERIES } from "./tree-limits.js";
import { isPlainObject, treeNodeSchema, type TreeNode } from "./tree.js";

/** v2 spec §1–2 (docs/superpowers/specs/2026-07-18-vendo-v2-format-spec.md) —
 *  query names are bare identifiers: the query's result lives at JSON Pointer
 *  `"/" + name` by definition, so there is no `path` field to validate. */
const QUERY_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** v2 spec §1–2 (docs/superpowers/specs/2026-07-18-vendo-v2-format-spec.md) */
export interface TreeQueryV2 {
  name: string;
  tool: string;
  input?: Record<string, Json>;
}

/**
 * v2 spec §1–2 (docs/superpowers/specs/2026-07-18-vendo-v2-format-spec.md) —
 * structural shape only (the types+zod pairing convention).
 * {@link validateTreeV2} is the normative gate; this schema alone accepts
 * queries validateTreeV2 rejects.
 */
export const treeQueryV2Schema = z.object({
  name: z.string(),
  tool: z.string(),
  input: z.record(z.unknown()).optional(),
}).passthrough() satisfies z.ZodType<TreeQueryV2>;

/** v2 spec §1–2 (docs/superpowers/specs/2026-07-18-vendo-v2-format-spec.md) —
 *  mirrors v1 `Tree` minus `components`: v2 trees never carry component
 *  sources (they live at the app-document level). Nodes are v1 nodes
 *  verbatim. */
export interface TreeV2 {
  formatVersion: typeof VENDO_TREE_FORMAT_V2;
  root: string;
  nodes: TreeNode[];
  data?: Record<string, Json>;
  queries?: TreeQueryV2[];
}

/**
 * v2 spec §1–2 (docs/superpowers/specs/2026-07-18-vendo-v2-format-spec.md) —
 * structural shape only (the types+zod pairing convention).
 * The pinned wire rules (caps, name grammar, root/id integrity, fn: syntax,
 * the no-components rule) live in {@link validateTreeV2}, which is the
 * normative gate; this schema alone accepts trees validateTreeV2 rejects.
 */
export const treeV2Schema = z.object({
  formatVersion: z.literal(VENDO_TREE_FORMAT_V2),
  root: z.string(),
  nodes: z.array(treeNodeSchema),
  data: z.record(z.unknown()).optional(),
  queries: z.array(treeQueryV2Schema).optional(),
}).passthrough() satisfies z.ZodType<TreeV2>;

type TreeV2Validation =
  | { ok: true; tree: TreeV2 }
  | { ok: false; error: { code: "version" | "provision"; message: string } };

const fail = (code: "version" | "provision", message: string): TreeV2Validation => ({
  ok: false,
  error: { code, message },
});

const validateTreeV2Unsafe = (input: unknown): TreeV2Validation => {
  if (!isPlainObject(input)) {
    return fail("provision", "tree must be a non-null object");
  }
  if (input.formatVersion !== VENDO_TREE_FORMAT_V2) {
    return fail("version", `formatVersion must be "${VENDO_TREE_FORMAT_V2}"`);
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
    return fail("provision", "v2 trees must not carry components (they live at the app-document level)");
  }

  if (input.queries !== undefined) {
    if (!Array.isArray(input.queries)) {
      return fail("provision", "queries must be an array");
    }
    if (input.queries.length > TREE_MAX_QUERIES) {
      return fail("provision", `too many queries (max ${TREE_MAX_QUERIES})`);
    }
    const queryNames = new Set<string>();
    for (const query of input.queries) {
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
  }

  const ids = new Set<string>();
  for (const node of nodes) {
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
    }
    if (ids.has(node.id)) {
      return fail("provision", `duplicate node id "${node.id}"`);
    }
    ids.add(node.id);
  }

  if (!ids.has(root)) {
    return fail("provision", `root "${root}" does not match any node id`);
  }
  return { ok: true, tree: input as unknown as TreeV2 };
};

/** v2 spec §1–2 (docs/superpowers/specs/2026-07-18-vendo-v2-format-spec.md) */
export function validateTreeV2(input: unknown): TreeV2Validation {
  try {
    return validateTreeV2Unsafe(input);
  } catch (error) {
    return fail("provision", `tree validation failed: ${safeErrorMessage(error)}`);
  }
}
