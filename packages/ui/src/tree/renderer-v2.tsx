import {
  validateTreeV2,
  VENDO_TREE_FORMAT,
  VENDO_TREE_FORMAT_V2,
  type Json,
  type Tree,
  type TreeNode,
  type TreeQuery,
  type TreeQueryV2,
  type TreeV2,
} from "@vendoai/core";
import { useMemo } from "react";
import { ContainedNotice } from "./notice.js";
import { registerTreeRenderer, TreeView, type PayloadRendererProps } from "./renderer.js";

/**
 * v2 spec §1 (docs/superpowers/specs/2026-07-18-vendo-v2-format-spec.md) —
 * the v2 renderer IS the v1 render path: a validated `vendo-genui/v2` tree
 * converts mechanically to the v1 tree shape and walks through TreeView, so
 * jail, guard, bindings, `$state`, and outcome containment are shared, not
 * reimplemented. Only the payload surface differs:
 *
 * - `queries` name bare identifiers; the result lives at JSON Pointer
 *   `"/" + name` by definition, which is exactly a v1 `TreeQuery.path`.
 * - action props use the canonical `{ action: "..." }` shape the compiler
 *   emits (wire-v2 D5); the v1 walk dispatches `{ $action }`, so conversion
 *   rewrites the key.
 * - component sources ride on the PAYLOAD (app-document level), never the
 *   canonical tree — validateTreeV2 rejects tree-carried `components`, so
 *   they are lifted off before validation and re-attached for the walk.
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
const convertQuery = (query: TreeQueryV2): TreeQuery => ({
  path: `/${query.name}`,
  tool: query.tool,
  ...(query.input === undefined ? {} : { input: query.input }),
});

type ConvertedV2 =
  | { ok: true; tree: Tree }
  | { ok: false; error: { code: "version" | "provision"; message: string } };

function convertV2Payload(payload: PayloadRendererProps["payload"]): ConvertedV2 {
  // Sources live at the app-document level; the payload may carry them
  // alongside the tree, but the canonical v2 tree must not (validateTreeV2
  // rejects it), so they are lifted off before the gate.
  const { components, ...tree } = payload as { components?: unknown };
  const validation = validateTreeV2(tree);
  if (!validation.ok) return validation;
  // Payload extras beyond the TreeV2 shape (streaming, furnishings, inClient,
  // pinDrift…) survive the spread at runtime; the v1 walk reads them off the
  // tree object exactly as it does for v1 payloads.
  const valid: TreeV2 = validation.tree;
  return {
    ok: true,
    tree: {
      ...valid,
      formatVersion: VENDO_TREE_FORMAT,
      nodes: valid.nodes.map(convertNode),
      ...(valid.queries === undefined ? {} : { queries: valid.queries.map(convertQuery) }),
      ...(components === undefined ? {} : { components }),
    } as Tree,
  };
}

function VendoTreeV2Renderer({ payload, ...props }: PayloadRendererProps) {
  const converted = useMemo(() => convertV2Payload(payload), [payload]);
  if (!converted.ok) {
    return (
      <ContainedNotice label="Invalid UI tree" code={converted.error.code}>
        {`${converted.error.code}: ${converted.error.message}`}
      </ContainedNotice>
    );
  }
  return <TreeView tree={converted.tree} {...props} />;
}

registerTreeRenderer(VENDO_TREE_FORMAT_V2, VendoTreeV2Renderer);
