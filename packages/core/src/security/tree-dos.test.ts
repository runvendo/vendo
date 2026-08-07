import { describe, expect, it } from "vitest";
import {
  TREE_MAX_NODES,
  TREE_MAX_QUERIES,
  VENDO_APP_FORMAT,
  VENDO_TREE_FORMAT,
  validateAppDocument,
  validateTree,
} from "../index.js";

// Denial-of-service / resource-exhaustion regression suite for the tree and
// app-document validators (01-core §8/§9). Each cap here is exercised at the
// over-limit side; these are the bounds that stop a hostile generator from
// making the jail compile an unbounded payload. The generated-component caps
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

describe("validateAppDocument fn:-requires-a-machine", () => {
  it("rejects an fn: query reference when the app document has no server", () => {
    const doc = {
      format: VENDO_APP_FORMAT,
      id: "app_fn_no_server",
      name: "Needs a machine",
      ui: "tree" as const,
      tree: {
        formatVersion: VENDO_TREE_FORMAT,
        root: "root",
        nodes: [{ id: "root", component: "Text" }],
        queries: [{ name: "data", tool: "fn:load_data" }],
      },
    };
    const result = validateAppDocument(doc);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("validation");

    // Same document, now with a server reference, validates — proving the failure
    // above is specifically the fn:-without-machine rule, not a shape defect.
    expect(validateAppDocument({ ...doc, server: "e2b:snap_ok" }).ok).toBe(true);
  });
});

