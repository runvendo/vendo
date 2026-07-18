import { validateTreeV2 } from "@vendoai/core";
import { measure, summarize } from "../stats.js";
import { syntheticTree, TREE_SIZES } from "../trees.js";
import type { Suite, SuiteResult } from "../types.js";

/** @vendoai/core validateTreeV2 over synthetic trees at 10 / 100 / 1000 / 5000 nodes. */
export const treeValidateSuite: Suite = {
  name: "tree-validate",
  kind: "deterministic",
  async run(): Promise<SuiteResult> {
    const cases = [];
    for (const size of TREE_SIZES) {
      const tree = syntheticTree(size);
      const durations = await measure({
        warmup: size >= 1000 ? 3 : 20,
        iterations: size >= 1000 ? 40 : 200,
        fn: () => {
          const result = validateTreeV2(tree);
          if (!result.ok) throw new Error(`validateTreeV2 failed at ${size}: ${result.error.message}`);
        },
      });
      cases.push(summarize(`nodes-${size}`, durations));
    }
    return { suite: "tree-validate", kind: "deterministic", cases };
  },
};
