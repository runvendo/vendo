import { describe, expect, it } from "vitest";
import {
  TREE_MAX_NODES,
  TREE_MAX_QUERIES,
  VENDO_TREE_FORMAT,
  VENDO_TREE_FORMAT_V2,
  validateTreeV2,
  type TreeV2,
} from "./index.js";

const minimal = (): Record<string, unknown> => ({
  formatVersion: VENDO_TREE_FORMAT_V2,
  root: "n1",
  nodes: [{ id: "n1", component: "Text" }],
});

const expectProvision = (input: unknown): void => {
  const result = validateTreeV2(input);
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error.code).toBe("provision");
};

describe("validateTreeV2 compatibility", () => {
  it("accepts a valid minimal v2 tree and narrows the result", () => {
    const result = validateTreeV2(minimal());
    expect(result.ok).toBe(true);
    if (result.ok) {
      const tree: TreeV2 = result.tree;
      expect(tree.formatVersion).toBe(VENDO_TREE_FORMAT_V2);
      expect(tree.root).toBe("n1");
    }
  });

  it("rejects non-object inputs as provision errors", () => {
    for (const input of [null, undefined, 42, "x", true]) expectProvision(input);
  });

  it("classifies wrong and absent formatVersion as version errors — v1 tag included", () => {
    for (const input of [
      { ...minimal(), formatVersion: VENDO_TREE_FORMAT },
      { ...minimal(), formatVersion: "vendo-genui/v3" },
      { root: "n1", nodes: [{ id: "n1", component: "Text" }] },
    ]) {
      const result = validateTreeV2(input);
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
    expect(validateTreeV2(minimal()).ok).toBe(true);
    expect(validateTreeV2({ ...minimal(), data: { title: "Hi" } }).ok).toBe(true);
  });

  it("rejects duplicate ids but allows dangling child ids", () => {
    expectProvision({
      ...minimal(),
      nodes: [{ id: "n1", component: "Text" }, { id: "n1", component: "Text" }],
    });
    expect(validateTreeV2({
      ...minimal(),
      nodes: [{ id: "n1", component: "Stack", children: ["not-yet-streamed"] }],
    }).ok).toBe(true);
  });

  it("accepts and rejects the node-count boundary", () => {
    const atCap = Array.from({ length: TREE_MAX_NODES }, (_, index) => ({ id: `n${index}`, component: "Text" }));
    expect(validateTreeV2({ ...minimal(), root: "n0", nodes: atCap }).ok).toBe(true);
    expectProvision({
      ...minimal(),
      root: "n0",
      nodes: [...atCap, { id: `n${TREE_MAX_NODES}`, component: "Text" }],
    });
  });
});

describe("validateTreeV2 components rejection", () => {
  it("rejects any tree-level components member — components live on the app document", () => {
    expectProvision({ ...minimal(), components: {} });
    expectProvision({
      ...minimal(),
      components: { Gauge: "export default function Gauge(){ return null; }" },
    });
  });

  it("tolerates unknown top-level keys other than components", () => {
    // The rejection is components-specific: any other stray key passes through.
    expect(validateTreeV2({ ...minimal(), extra: 1 }).ok).toBe(true);
  });

  it("accepts a generated-source node without a document-level component", () => {
    // The presence rule is the app-document layer's to enforce, not the tree's.
    expect(validateTreeV2({
      ...minimal(),
      nodes: [{ id: "n1", component: "Gauge", source: "generated" }],
    }).ok).toBe(true);
  });
});

describe("validateTreeV2 queries", () => {
  it("accepts ordinary and fn: query tools addressed by name", () => {
    expect(validateTreeV2({
      ...minimal(),
      data: { revenue: [] },
      queries: [
        { name: "revenue", tool: "metrics.revenue", input: { limit: 5 } },
        { name: "_refresh", tool: "fn:refresh_data" },
      ],
    }).ok).toBe(true);
  });

  it("rejects grammar-violating query names", () => {
    for (const name of ["", "9startsWithDigit", "has space", "has-dash", "with/slash"]) {
      expectProvision({ ...minimal(), queries: [{ name, tool: "t" }] });
    }
  });

  it("rejects duplicate query names", () => {
    expectProvision({
      ...minimal(),
      queries: [{ name: "revenue", tool: "a" }, { name: "revenue", tool: "b" }],
    });
  });

  it("rejects the reserved query name \"state\"", () => {
    expectProvision({ ...minimal(), queries: [{ name: "state", tool: "t" }] });
  });

  it("rejects malformed fn: query references", () => {
    for (const tool of ["fn:", "fn:bad name", "fn:9startsWithDigit", "fn:name/slash"]) {
      expectProvision({ ...minimal(), queries: [{ name: "q", tool }] });
    }
  });

  it("rejects every malformed query shape", () => {
    const invalidQueries: unknown[] = [
      "nope",
      [{ name: "q", tool: "" }],
      [{ name: "q" }],
      [{ tool: "t" }],
      [{ name: "q", tool: "t", input: "x" }],
      [null],
    ];
    for (const queries of invalidQueries) expectProvision({ ...minimal(), queries });
  });

  it("accepts and rejects the query-count boundary", () => {
    const atCap = Array.from({ length: TREE_MAX_QUERIES }, (_, index) => ({ name: `q${index}`, tool: "t" }));
    expect(validateTreeV2({ ...minimal(), queries: atCap }).ok).toBe(true);
    expectProvision({ ...minimal(), queries: [...atCap, { name: `q${TREE_MAX_QUERIES}`, tool: "t" }] });
  });
});

describe("validateTreeV2 action references", () => {
  it("rejects grammar-violating fn: actions anywhere in props", () => {
    expectProvision({
      ...minimal(),
      nodes: [{ id: "n1", component: "Button", props: { action: "fn:bad name" } }],
    });
    expectProvision({
      ...minimal(),
      nodes: [{
        id: "n1",
        component: "Stack",
        props: { rows: [{ cta: { action: "fn:9startsWithDigit" } }] },
      }],
    });
  });

  it("accepts well-formed fn: actions and non-fn actions", () => {
    expect(validateTreeV2({
      ...minimal(),
      nodes: [{
        id: "n1",
        component: "Button",
        props: { action: "fn:refresh_data", fallback: { action: "create_invoice" } },
      }],
    }).ok).toBe(true);
  });
});

/** v2 spec §3 — the bounded reshape vocabulary is enforced at the format
 *  gate: unknown ops or malformed chains fail provision. */
describe("validateTreeV2 reshape gate", () => {
  const withProps = (props: Record<string, unknown>): Record<string, unknown> => ({
    ...minimal(),
    nodes: [{ id: "n1", component: "LineChart", props }],
  });

  it("accepts a binding with a valid $reshape chain", () => {
    expect(validateTreeV2(withProps({
      points: { $path: "/revenue/rows", $reshape: [{ op: "asPoints", args: ["month", "revenue"] }] },
    })).ok).toBe(true);
  });

  it("rejects unknown ops, bad arity, non-string args, and non-array chains — nested at any depth", () => {
    for (const props of [
      { points: { $path: "/a", $reshape: [{ op: "eval", args: [] }] } },
      { points: { $path: "/a", $reshape: [{ op: "asPoints", args: ["one"] }] } },
      { points: { $path: "/a", $reshape: [{ op: "pick", args: [42] }] } },
      { points: { $path: "/a", $reshape: { op: "pick", args: ["a"] } } },
      { deep: [{ inner: { $path: "/a", $reshape: [{ op: "format", args: ["x", "loud"] }] } }] },
    ]) {
      expectProvision(withProps(props));
    }
  });
});

describe("validateTreeV2 hostile inputs", () => {
  it("never throws on inputs with throwing getters", () => {
    const hostile = Object.defineProperty({}, "formatVersion", {
      enumerable: true,
      get() {
        throw Object.defineProperty(new Error("boom"), "message", {
          get() {
            throw new Error("nested boom");
          },
        });
      },
    });
    const result = validateTreeV2(hostile);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("provision");
  });
});
