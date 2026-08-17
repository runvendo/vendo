import { describe, expect, it } from "vitest";
import {
  TREE_MAX_NODES,
  TREE_MAX_QUERIES,
  VENDO_TREE_FORMAT,
} from "@vendoai/core";
import { validateTree } from "../../src/contract/index.js";

// Denial-of-service / resource-exhaustion regression suite for the tree
// validator (01-core §8). It guards the RENDER payload: `validateTree` is the
// gate the component gauntlet runs over the tree a screen just painted
// (checking/component-screen.ts) and the one the client runs over every open
// payload before it walks it (ui/src/tree/convert-payload.ts). Each cap here is
// exercised at the over-limit side; these are the bounds that stop a hostile
// screen from making the renderer walk an unbounded payload. The generated-component caps
// are NOT here: a tree carrying `components` is rejected outright before any
// cap is read, so they are pinned where they actually bite, in
// `component-map.test.ts`.

const treeWithNodes = (count: number): Record<string, unknown> => ({
  formatVersion: VENDO_TREE_FORMAT,
  root: "n0",
  nodes: Array.from({ length: count }, (_, index) => ({ id: `n${index}`, component: "Text" })),
});

const expectProvisionFailure = (input: unknown): void => {
  const result = validateTree(input);
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error.code).toBe("provision");
};

describe("validateTree resource caps", () => {
  it("rejects more than TREE_MAX_NODES nodes", () => {
    expect(validateTree(treeWithNodes(TREE_MAX_NODES)).ok).toBe(true);
    expectProvisionFailure(treeWithNodes(TREE_MAX_NODES + 1));
  });

  it("rejects more than TREE_MAX_QUERIES queries", () => {
    const withQueries = (count: number) => ({
      ...treeWithNodes(1),
      queries: Array.from({ length: count }, (_, index) => ({ name: `q${index}`, tool: "t" })),
    });
    expect(validateTree(withQueries(TREE_MAX_QUERIES)).ok).toBe(true);
    expectProvisionFailure(withQueries(TREE_MAX_QUERIES + 1));
  });

  it("rejects duplicate node ids", () => {
    expectProvisionFailure({
      formatVersion: VENDO_TREE_FORMAT,
      root: "dup",
      nodes: [{ id: "dup", component: "Text" }, { id: "dup", component: "Text" }],
    });
  });

  it("rejects a missing / non-matching root", () => {
    expectProvisionFailure({
      formatVersion: VENDO_TREE_FORMAT,
      root: "ghost",
      nodes: [{ id: "real", component: "Text" }],
    });
  });
});
