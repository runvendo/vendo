import { z } from "zod";
import { componentMapError } from "./component-map.js";
import { safeErrorMessage } from "./errors.js";
import { VENDO_TREE_FORMAT } from "./formats.js";
import { FN_REFERENCE_PATTERN, findInvalidActionReference } from "./fn-references.js";
import type { Json } from "./ids.js";
import { TREE_MAX_NODES, TREE_MAX_QUERIES } from "./tree-limits.js";

export {
  TREE_MAX_NODES,
  TREE_MAX_QUERIES,
  TREE_MAX_GENERATED_COMPONENTS,
  TREE_MAX_COMPONENT_SOURCE_BYTES,
  TREE_MAX_TOTAL_COMPONENT_BYTES,
  TREE_MAX_COMPONENT_SOURCE_CHARS,
  TREE_MAX_TOTAL_COMPONENT_CHARS,
  RESERVED_COMPONENT_NAMES,
} from "./tree-limits.js";

/** 01-core §8 */
export interface PathBinding {
  $path: string;
}

/** 01-core §8 */
export interface StateBinding {
  $state: string;
}

/** 01-core §8 */
export function isPathBinding(value: unknown): value is PathBinding {
  return typeof value === "object"
    && value !== null
    && typeof (value as { $path?: unknown }).$path === "string";
}

/** 01-core §8 */
export function isStateBinding(value: unknown): value is StateBinding {
  return typeof value === "object"
    && value !== null
    && typeof (value as { $state?: unknown }).$state === "string";
}

/** 01-core §8 */
export interface UIPayload {
  formatVersion: string;
  [key: string]: unknown;
}

/** 01-core §8 */
export const uiPayloadSchema = z.object({
  formatVersion: z.string(),
}).passthrough() satisfies z.ZodType<UIPayload>;

/** 01-core §8 */
export interface TreeNode {
  id: string;
  component: string;
  source?: "prewired" | "host" | "generated";
  props?: Record<string, Json>;
  children?: string[];
}

/** 01-core §8 */
export const treeNodeSchema = z.object({
  id: z.string(),
  component: z.string(),
  source: z.enum(["prewired", "host", "generated"]).optional(),
  props: z.record(z.unknown()).optional(),
  children: z.array(z.string()).optional(),
}).passthrough() satisfies z.ZodType<TreeNode>;

/** 01-core §8 */
export interface TreeQuery {
  path: string;
  tool: string;
  input?: Record<string, Json>;
}

/** 01-core §8 */
export const treeQuerySchema = z.object({
  path: z.string(),
  tool: z.string(),
  input: z.record(z.unknown()).optional(),
}).passthrough() satisfies z.ZodType<TreeQuery>;

/** 01-core §8 */
export interface Tree {
  formatVersion: typeof VENDO_TREE_FORMAT;
  root: string;
  nodes: TreeNode[];
  data?: Record<string, Json>;
  queries?: TreeQuery[];
  components?: Record<string, string>;
}

/**
 * 01-core §8 — structural shape only (the types+zod pairing convention).
 * The pinned wire rules (caps, reserved names, root/id integrity, fn: syntax)
 * live in {@link validateTree}, which is the normative validator; this schema
 * alone accepts trees validateTree rejects.
 */
export const treeSchema = z.object({
  formatVersion: z.literal(VENDO_TREE_FORMAT),
  root: z.string(),
  nodes: z.array(treeNodeSchema),
  data: z.record(z.unknown()).optional(),
  queries: z.array(treeQuerySchema).optional(),
  components: z.record(z.string()).optional(),
}).passthrough() satisfies z.ZodType<Tree>;

type TreeValidation =
  | { ok: true; tree: Tree }
  | { ok: false; error: { code: "version" | "provision"; message: string } };

/** The one canonical non-null, non-array object guard (kill-list B6) — every
 *  package already depends on core, so a per-file redefinition is duplication,
 *  not a layering workaround. */
export const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const fail = (code: "version" | "provision", message: string): TreeValidation => ({
  ok: false,
  error: { code, message },
});

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

  if (input.queries !== undefined) {
    if (!Array.isArray(input.queries)) {
      return fail("provision", "queries must be an array");
    }
    if (input.queries.length > TREE_MAX_QUERIES) {
      return fail("provision", `too many queries (max ${TREE_MAX_QUERIES})`);
    }
    for (const query of input.queries) {
      if (!isPlainObject(query)) {
        return fail("provision", "each query must be an object");
      }
      if (typeof query.path !== "string" || (query.path !== "" && !query.path.startsWith("/"))) {
        return fail("provision", "query path must be a JSON Pointer ('' or starting with '/')");
      }
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
      // CORE-5 (01 §8): fn: grammar holds ANYWHERE a tree names a callable —
      // action names in props included. (Machine-presence is enforced one
      // level up by validateAppDocument, which knows `server`.) The walk is
      // allocation-free: validateTree sits on the per-render hot path.
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

  if (input.components !== undefined && !isPlainObject(input.components)) {
    return fail("provision", "components must be a plain object");
  }
  const components = (input.components ?? {}) as Record<string, unknown>;
  const componentError = componentMapError(components);
  if (componentError !== null) {
    return fail("provision", componentError);
  }
  for (const node of nodes as TreeNode[]) {
    if (node.source === "generated" && !Object.prototype.hasOwnProperty.call(components, node.component)) {
      return fail(
        "provision",
        `node "${node.id}" references generated component "${node.component}" with no definition in components`,
      );
    }
  }
  if (!ids.has(root)) {
    return fail("provision", `root "${root}" does not match any node id`);
  }
  return { ok: true, tree: input as unknown as Tree };
};

/** 01-core §8 */
export function validateTree(input: unknown): TreeValidation {
  try {
    return validateTreeUnsafe(input);
  } catch (error) {
    return fail("provision", `tree validation failed: ${safeErrorMessage(error)}`);
  }
}
