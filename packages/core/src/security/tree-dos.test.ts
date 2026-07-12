import { describe, expect, it } from "vitest";
import {
  TREE_MAX_COMPONENT_SOURCE_CHARS,
  TREE_MAX_GENERATED_COMPONENTS,
  TREE_MAX_NODES,
  TREE_MAX_QUERIES,
  TREE_MAX_TOTAL_COMPONENT_CHARS,
  VENDO_APP_FORMAT,
  VENDO_TREE_FORMAT,
  validateAppDocument,
  validateTree,
} from "../index.js";

// Denial-of-service / resource-exhaustion regression suite for the tree and
// app-document validators (01-core §8/§9). Every pinned cap is exercised at the
// over-limit side; these are the bounds that stop a hostile generator from
// making the jail compile an unbounded payload.

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

const componentCode = "export default function C(){ return null; }";

describe("validateTree resource caps", () => {
  it("rejects more than TREE_MAX_NODES nodes", () => {
    expect(validateTree(treeWithNodes(TREE_MAX_NODES)).ok).toBe(true);
    expectProvisionFailure(treeWithNodes(TREE_MAX_NODES + 1));
  });

  it("rejects more than TREE_MAX_QUERIES queries", () => {
    const withQueries = (count: number) => ({
      ...treeWithNodes(1),
      queries: Array.from({ length: count }, () => ({ path: "/x", tool: "t" })),
    });
    expect(validateTree(withQueries(TREE_MAX_QUERIES)).ok).toBe(true);
    expectProvisionFailure(withQueries(TREE_MAX_QUERIES + 1));
  });

  it("rejects more than TREE_MAX_GENERATED_COMPONENTS generated components", () => {
    const components: Record<string, string> = {};
    for (let index = 0; index <= TREE_MAX_GENERATED_COMPONENTS; index += 1) {
      components[`Gen${index}`] = componentCode;
    }
    expect(Object.keys(components).length).toBe(TREE_MAX_GENERATED_COMPONENTS + 1);
    expectProvisionFailure({
      ...treeWithNodes(1),
      nodes: [{ id: "n0", component: "Gen0", source: "generated" }],
      components,
    });
  });

  it("rejects a single component source larger than TREE_MAX_COMPONENT_SOURCE_CHARS", () => {
    expectProvisionFailure({
      ...treeWithNodes(1),
      nodes: [{ id: "n0", component: "Gen0", source: "generated" }],
      components: { Gen0: "x".repeat(TREE_MAX_COMPONENT_SOURCE_CHARS + 1) },
    });
  });

  it("rejects total component source larger than TREE_MAX_TOTAL_COMPONENT_CHARS", () => {
    // Four maxed-out sources exactly hit the total cap; a single extra char busts it.
    const quarter = "x".repeat(TREE_MAX_COMPONENT_SOURCE_CHARS);
    expect(quarter.length * 4).toBe(TREE_MAX_TOTAL_COMPONENT_CHARS);
    expectProvisionFailure({
      ...treeWithNodes(1),
      nodes: [{ id: "n0", component: "A", source: "generated" }],
      components: { A: quarter, B: quarter, C: quarter, D: quarter, E: "x" },
    });
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
        queries: [{ path: "", tool: "fn:load_data" }],
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

describe("validateTree DoS bound gaps (recorded by-contract)", () => {
  it("does NOT bound the byte size of node data / props (delegated upstream)", () => {
    // GAP (intentional, recorded for visibility): validateTree caps node COUNT,
    // query COUNT, and generated-component SOURCE bytes — but it does not bound
    // the size of `data` or a node's `props`. A single node can carry a
    // multi-hundred-KB `data` blob and still PASS. This DoS bound is delegated to
    // an upstream request-body limit (the HTTP layer), not the core validator.
    const bigBlob = "y".repeat(400_000); // ~400 KB, well past any component cap
    const result = validateTree({
      formatVersion: VENDO_TREE_FORMAT,
      root: "n0",
      nodes: [{ id: "n0", component: "Text", props: { huge: bigBlob } }],
      data: { huge: bigBlob },
    });
    expect(result.ok).toBe(true);
  });
});
