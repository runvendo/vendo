import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { validateTreeV2, type Json, type ToolOutcome, type TreeV2 } from "@vendoai/core";
import { TreeView, type WalkTree } from "@vendoai/ui/tree";
import { measure, summarize } from "../stats.js";
import { syntheticTree, TREE_SIZES } from "../trees.js";
import type { Suite, SuiteResult } from "../types.js";

const noAction = async (): Promise<ToolOutcome> => ({ status: "ok", output: null });

/** The walk input the v2 renderer produces: named queries become "/" + name
 *  pointers (pre-converted here so the render-only case times the walk). */
const toWalkTree = (tree: TreeV2): WalkTree => ({
  root: tree.root,
  nodes: tree.nodes,
  ...(tree.data === undefined ? {} : { data: tree.data }),
  ...(tree.queries === undefined ? {} : {
    queries: tree.queries.map((query) => ({
      path: `/${query.name}`,
      tool: query.tool,
      ...(query.input === undefined ? {} : { input: query.input }),
    })),
  }),
});

const renderTree = (walkTree: WalkTree): string =>
  renderToString(
    createElement(TreeView, {
      tree: walkTree,
      components: {},
      data: walkTree.data as Record<string, Json> | undefined,
      onAction: noAction,
    }),
  );

/**
 * The @vendoai/ui TreeView rendered with react-dom/server renderToString.
 * renderToString needs no DOM (prewired primitives only — no jail iframe), so
 * jsdom is not required here. Reports render-only and validate+render per size.
 */
export const treeRenderSuite: Suite = {
  name: "tree-render",
  kind: "deterministic",
  async run(): Promise<SuiteResult> {
    const cases = [];
    for (const size of TREE_SIZES) {
      const tree = syntheticTree(size);
      const walkTree = toWalkTree(tree);
      const big = size >= 1000;

      const renderOnly = await measure({
        warmup: big ? 3 : 10,
        iterations: big ? 30 : 100,
        fn: () => {
          renderTree(walkTree);
        },
      });
      cases.push(summarize(`render-${size}`, renderOnly));

      const validateRender = await measure({
        warmup: big ? 3 : 10,
        iterations: big ? 30 : 100,
        fn: () => {
          const result = validateTreeV2(tree);
          if (!result.ok) throw new Error(`validateTreeV2 failed at ${size}`);
          renderTree(toWalkTree(result.tree));
        },
      });
      cases.push(summarize(`validate+render-${size}`, validateRender));
    }
    return {
      suite: "tree-render",
      kind: "deterministic",
      cases,
      notes: ["renderToString (SSR); prewired primitives only, no jsdom needed."],
    };
  },
};
