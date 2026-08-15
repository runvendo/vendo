import type { WalkTree } from "./renderer.js";
import {
  type Json,
  type TreeNode,
  type UIPayload,
} from "@vendoai/core";
import {
  validateTree,
  type TreeQuery,
  type Tree,
} from "@vendoai/apps/contract";

/**
 * The `vendo-genui/v2` payload converts mechanically to the walk tree TreeView
 * renders, so guard, bindings, `$state` and outcome containment are
 * shared rather than reimplemented. Only the payload surface differs:
 *
 * - `queries` name bare identifiers; the result lives at JSON Pointer
 *   `"/" + name` — the walk's path-keyed query shape.
 * - action props use the canonical `{ action: "..." }` shape the compiler
 *   emits; the walk dispatches `{ $action }`, so conversion rewrites the key.
 * - component sources ride on the PAYLOAD (app-document level), never the
 *   canonical tree — validateTree rejects tree-carried `components`, so
 *   they are lifted off before validation and re-attached for the walk.
 *
 * This module is a PURE converter.
 */

/** The canonical action prop shape `{ action: "tool" | "fn:..." }`. */
const isActionProp = (value: Record<string, unknown>): value is { action: string; payload?: Json } =>
  typeof value.action === "string";

const convertPropValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(convertPropValue);
  if (typeof value !== "object" || value === null) return value;
  const record = value as Record<string, unknown>;
  if (isActionProp(record)) {
    return {
      $action: record.action,
      ...(record.payload === undefined ? {} : { payload: convertPropValue(record.payload) }),
    };
  }
  return Object.fromEntries(Object.entries(record).map(([key, child]) => [key, convertPropValue(child)]));
};

/** One node's props, converted. Exported for the interactive swap: a tree the
 *  screen VM produced enters the walk the same way the served payload did
 *  (use-screen.ts). */
export const convertNode = (node: TreeNode): TreeNode => node.props === undefined
  ? node
  : { ...node, props: convertPropValue(node.props) as Record<string, Json> };

/** Query results reside at `"/" + name` — that pointer is the walk's path. */
const convertQuery = (query: TreeQuery): { path: string; tool: string; input?: Record<string, Json> } => ({
  path: `/${query.name}`,
  tool: query.tool,
  ...(query.input === undefined ? {} : { input: query.input }),
});

export type ConvertedPayload =
  | { ok: true; tree: WalkTree }
  | { ok: false; error: { code: "version" | "provision"; message: string } };

export function convertPayload(payload: UIPayload): ConvertedPayload {
  // Sources live at the app-document level; the payload may carry them
  // alongside the tree, but the canonical tree must not (validateTree
  // rejects it), so they are lifted off before the gate.
  const { components, ...tree } = payload as { components?: unknown };
  const validation = validateTree(tree);
  if (!validation.ok) return validation;
  // Payload extras beyond the Tree shape (streaming, furnishings, inClient,
  // pinDrift…) survive the spread at runtime; the shared walk reads them off
  // the tree object.
  const valid: Tree = validation.tree;
  return {
    ok: true,
    tree: {
      ...valid,
      nodes: valid.nodes.map(convertNode),
      ...(valid.queries === undefined ? {} : { queries: valid.queries.map(convertQuery) }),
      ...(components === undefined ? {} : { components }),
    } as unknown as WalkTree,
  };
}
