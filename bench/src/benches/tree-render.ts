import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { validateTree, type Json, type ToolOutcome, type Tree } from "@vendoai/core";
import { TreeView } from "@vendoai/ui/tree";
import { measure, summarize } from "../stats.js";
import { syntheticTree, TREE_SIZES } from "../trees.js";
import type { Suite, SuiteResult } from "../types.js";

const noAction = async (): Promise<ToolOutcome> => ({ status: "ok", output: null });

const renderTree = (tree: Tree): string =>
  renderToString(
    createElement(TreeView, {
      tree,
      components: {},
      data: tree.data as Record<string, Json> | undefined,
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
      const big = size >= 1000;

      const renderOnly = await measure({
        warmup: big ? 3 : 10,
        iterations: big ? 30 : 100,
        fn: () => {
          renderTree(tree);
        },
      });
      cases.push(summarize(`render-${size}`, renderOnly));

      const validateRender = await measure({
        warmup: big ? 3 : 10,
        iterations: big ? 30 : 100,
        fn: () => {
          const result = validateTree(tree);
          if (!result.ok) throw new Error(`validateTree failed at ${size}`);
          renderTree(result.tree);
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
