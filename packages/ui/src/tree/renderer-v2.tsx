import {
  validateTreeV2,
  type Json,
  type TreeNode,
  type TreeQueryV2,
  type TreeV2,
} from "@vendoai/core";

/**
 * v2 spec §1 (docs/superpowers/specs/2026-07-18-vendo-v2-format-spec.md) —
 * the v2 renderer IS the v1 render path: a validated `vendo-genui/v2` tree
 * converts mechanically to the v1 tree shape and walks through TreeView, so
 * jail, guard, bindings, `$state`, and outcome containment are shared, not
 * reimplemented. Only the payload surface differs:
 *
 * - `queries` name bare identifiers; the result lives at JSON Pointer
 *   `"/" + name` by definition — the walk's path-keyed query shape.
 * - action props use the canonical `{ action: "..." }` shape the compiler
 *   emits (wire-v2 D5); the v1 walk dispatches `{ $action }`, so conversion
 *   rewrites the key.
 * - component sources ride on the PAYLOAD (app-document level), never the
 *   canonical tree — validateTreeV2 rejects tree-carried `components`, so
 *   they are lifted off before validation and re-attached for the walk.
 *
 * This module is a PURE converter. The registry registration lives in
 * renderer.tsx next to PayloadView: the ui package is `sideEffects: false`,
 * so a registration-only side-effect import would be tree-shaken out of
 * host bundles (caught live in the Wave 2 browser gate).
 */

/** wire-v2 D5 — the canonical action prop shape `{ action: "tool" | "fn:..." }`. */
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

const convertNode = (node: TreeNode): TreeNode => node.props === undefined
  ? node
  : { ...node, props: convertPropValue(node.props) as Record<string, Json> };

/** v2 query results reside at `"/" + name` — that pointer is the v1 path. */
const convertQuery = (query: TreeQueryV2): { path: string; tool: string; input?: Record<string, Json> } => ({
  path: `/${query.name}`,
  tool: query.tool,
  ...(query.input === undefined ? {} : { input: query.input }),
});

import type { WalkTree } from "./renderer.js";

export type ConvertedV2 =
  | { ok: true; tree: WalkTree }
  | { ok: false; error: { code: "version" | "provision"; message: string } };

export function convertV2Payload(payload: { formatVersion: string }): ConvertedV2 {
  // Sources live at the app-document level; the payload may carry them
  // alongside the tree, but the canonical v2 tree must not (validateTreeV2
  // rejects it), so they are lifted off before the gate.
  const { components, ...tree } = payload as { components?: unknown };
  const validation = validateTreeV2(tree);
  if (!validation.ok) return validation;
  // Payload extras beyond the TreeV2 shape (streaming, furnishings, inClient,
  // pinDrift…) survive the spread at runtime; the shared walk reads them off
  // the tree object (v2 spec §6 — the mechanics survive, the v1 format
  // surface around them is gone).
  const valid: TreeV2 = validation.tree;
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
