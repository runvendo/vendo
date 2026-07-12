import { describe, expect, it } from "vitest";
import {
  RESERVED_COMPONENT_NAMES,
  TREE_MAX_COMPONENT_SOURCE_CHARS,
  TREE_MAX_GENERATED_COMPONENTS,
  TREE_MAX_NODES,
  TREE_MAX_QUERIES,
  TREE_MAX_TOTAL_COMPONENT_CHARS,
  VENDO_TREE_FORMAT,
  isPathBinding,
  isStateBinding,
  validateTree,
  type Tree,
} from "./index.js";

const minimal = (): Record<string, unknown> => ({
  formatVersion: VENDO_TREE_FORMAT,
  root: "n1",
  nodes: [{ id: "n1", component: "Text" }],
});

const expectProvision = (input: unknown): void => {
  const result = validateTree(input);
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error.code).toBe("provision");
};

describe("validateTree compatibility", () => {
  it("accepts a valid minimal tree and narrows the result", () => {
    const result = validateTree(minimal());
    expect(result.ok).toBe(true);
    if (result.ok) {
      const tree: Tree = result.tree;
      expect(tree.root).toBe("n1");
    }
  });

  it("rejects non-object inputs as provision errors", () => {
    for (const input of [null, undefined, 42, "x", true]) expectProvision(input);
  });

  it("classifies wrong and absent formatVersion as version errors", () => {
    for (const input of [
      { ...minimal(), formatVersion: "vendo-genui/v2" },
      { root: "n1", nodes: [{ id: "n1", component: "Text" }] },
    ]) {
      const result = validateTree(input);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("version");
    }
  });

  it("rejects missing or empty roots and non-array nodes", () => {
    const { root: _root, ...withoutRoot } = minimal();
    void _root;
    for (const input of [withoutRoot, { ...minimal(), root: "" }, { ...minimal(), nodes: {} }]) {
      expectProvision(input);
    }
  });

  it("requires root to match a node id", () => {
    expectProvision({ ...minimal(), root: "missing" });
  });

  it("validates every node shape", () => {
    const invalidNodes = [
      [{ id: "n1" }],
      [{ component: "Text" }],
      [{ id: "n1", component: "Text", source: "wired" }],
      [{ id: "n1", component: "Stack", children: ["a", 2] }],
      [{ id: "n1", component: "Text", props: [] }],
      [{ id: "", component: "Text" }],
      [null],
      [42],
    ];
    for (const nodes of invalidNodes) expectProvision({ ...minimal(), nodes });
  });

  it("rejects non-object data and accepts absent or plain-object data", () => {
    for (const data of ["oops", 42, []]) expectProvision({ ...minimal(), data });
    expect(validateTree(minimal()).ok).toBe(true);
    expect(validateTree({ ...minimal(), data: { title: "Hi" } }).ok).toBe(true);
  });

  it("rejects duplicate ids but allows dangling child ids", () => {
    expectProvision({
      ...minimal(),
      nodes: [{ id: "n1", component: "Text" }, { id: "n1", component: "Text" }],
    });
    expect(validateTree({
      ...minimal(),
      nodes: [{ id: "n1", component: "Stack", children: ["not-yet-streamed"] }],
    }).ok).toBe(true);
  });

  it("accepts well-formed source, props, children, and data", () => {
    expect(validateTree({
      formatVersion: VENDO_TREE_FORMAT,
      root: "root",
      nodes: [
        { id: "root", component: "Stack", source: "host", children: ["t"] },
        { id: "t", component: "Text", source: "prewired", props: { value: { $path: "/title" } } },
      ],
      data: { title: "Hello" },
    }).ok).toBe(true);
  });
});

describe("validateTree generated components", () => {
  const code = "export default function Gauge(){ return null; }";
  const generated = {
    formatVersion: VENDO_TREE_FORMAT,
    root: "r",
    nodes: [{ id: "r", component: "Gauge", source: "generated" }],
  };

  it("requires generated definitions and accepts matching definitions", () => {
    expect(validateTree({ ...generated, components: { Gauge: code } }).ok).toBe(true);
    expectProvision({ ...generated, components: {} });
  });

  it("keeps components optional for ordinary trees", () => {
    expect(validateTree(minimal()).ok).toBe(true);
  });

  it("requires PascalCase names, string sources, and non-reserved names", () => {
    expectProvision({
      ...generated,
      nodes: [{ id: "r", component: "bad-name", source: "generated" }],
      components: { "bad-name": code },
    });
    expectProvision({ ...generated, components: { Gauge: 42 } });
    for (const reserved of RESERVED_COMPONENT_NAMES) {
      expectProvision({
        ...generated,
        nodes: [{ id: "r", component: reserved, source: "generated" }],
        components: { [reserved]: code },
      });
    }
  });

  it("accepts and rejects the generated-component count boundary", () => {
    const atCap: Record<string, string> = { Gauge: code };
    for (let index = 0; index < TREE_MAX_GENERATED_COMPONENTS - 1; index += 1) atCap[`C${index}`] = code;
    expect(Object.keys(atCap)).toHaveLength(TREE_MAX_GENERATED_COMPONENTS);
    expect(validateTree({ ...generated, components: atCap }).ok).toBe(true);
    expectProvision({ ...generated, components: { ...atCap, Extra: code } });
  });

  it("accepts and rejects the per-source character boundary", () => {
    expect(validateTree({
      ...generated,
      components: { Gauge: "x".repeat(TREE_MAX_COMPONENT_SOURCE_CHARS) },
    }).ok).toBe(true);
    expectProvision({
      ...generated,
      components: { Gauge: "x".repeat(TREE_MAX_COMPONENT_SOURCE_CHARS + 1) },
    });
  });

  it("accepts and rejects the total-source character boundary", () => {
    const quarter = "x".repeat(TREE_MAX_COMPONENT_SOURCE_CHARS);
    const atCap = { A: quarter, B: quarter, C: quarter, D: quarter };
    expect(quarter.length * 4).toBe(TREE_MAX_TOTAL_COMPONENT_CHARS);
    expect(validateTree({
      ...generated,
      nodes: [{ id: "r", component: "A", source: "generated" }],
      components: atCap,
    }).ok).toBe(true);
    expectProvision({
      ...generated,
      nodes: [{ id: "r", component: "A", source: "generated" }],
      components: { ...atCap, E: "x" },
    });
  });
});

describe("validateTree queries and caps", () => {
  it("accepts ordinary and fn: query tools", () => {
    expect(validateTree({
      ...minimal(),
      data: { tx: [] },
      queries: [
        { path: "/tx", tool: "get_transactions", input: { limit: 40 } },
        { path: "", tool: "fn:refresh_data" },
      ],
    }).ok).toBe(true);
  });

  it("rejects malformed fn: query references", () => {
    for (const tool of ["fn:", "fn:bad name", "fn:9startsWithDigit", "fn:name/slash"]) {
      expectProvision({ ...minimal(), queries: [{ path: "", tool }] });
    }
  });

  it("rejects every legacy malformed query shape", () => {
    const invalidQueries: unknown[] = [
      "nope",
      [{ path: "tx", tool: "t" }],
      [{ path: "/tx", tool: "" }],
      [{ path: "/tx", tool: "t", input: "x" }],
      [{ path: "/tx" }],
    ];
    for (const queries of invalidQueries) expectProvision({ ...minimal(), queries });
  });

  it("accepts and rejects the query-count boundary", () => {
    const atCap = Array.from({ length: TREE_MAX_QUERIES }, () => ({ path: "/t", tool: "t" }));
    expect(validateTree({ ...minimal(), queries: atCap }).ok).toBe(true);
    expectProvision({ ...minimal(), queries: [...atCap, { path: "/t", tool: "t" }] });
  });

  it("accepts and rejects the node-count boundary", () => {
    const atCap = Array.from({ length: TREE_MAX_NODES }, (_, index) => ({ id: `n${index}`, component: "Text" }));
    expect(validateTree({ ...minimal(), root: "n0", nodes: atCap }).ok).toBe(true);
    expectProvision({ ...minimal(), root: "n0", nodes: [...atCap, { id: `n${TREE_MAX_NODES}`, component: "Text" }] });
  });
});

describe("prop binding guards", () => {
  it("recognizes only string path and state bindings", () => {
    expect(isPathBinding({ $path: "/a" })).toBe(true);
    expect(isPathBinding({ $path: 5 })).toBe(false);
    expect(isPathBinding("/a")).toBe(false);
    expect(isPathBinding(null)).toBe(false);
    expect(isStateBinding({ $state: "draft" })).toBe(true);
    expect(isStateBinding({ $state: 5 })).toBe(false);
    expect(isStateBinding({})).toBe(false);
  });
});
