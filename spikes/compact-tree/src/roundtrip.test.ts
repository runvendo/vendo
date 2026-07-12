import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { validateTree, VENDO_TREE_FORMAT } from "@vendoai/core";
import type { Tree } from "@vendoai/core";
import { canonicalize } from "./canonicalize.js";
import { decodeCjt, encodeCjt, decodeCjtString, encodeCjtString } from "./profile-cjt.js";
import { decodeVtl, encodeVtl } from "./profile-vtl.js";
import { treeArbitrary } from "./arbitrary.js";

const NUM_RUNS = 200;
// Fixed seed → deterministic CI. On a failure fast-check prints the reproducing
// path; bump or clear the seed locally to explore more of the input space.
const SEED = 20260712;
const opts = (numRuns: number) => ({ numRuns, seed: SEED });

describe("lossless round-trip (property)", () => {
  it("CJT: decode(encode(t)) deep-equals canonicalize(t), and re-validates", () => {
    fc.assert(
      fc.property(treeArbitrary({ maxNodes: 60 }), (tree) => {
        const decoded = decodeCjt(encodeCjt(tree));
        expect(decoded).toEqual(canonicalize(tree));
        expect(validateTree(decoded).ok).toBe(true);
      }),
      opts(NUM_RUNS),
    );
  });

  it("CJT: string form round-trips too (wire is JSON)", () => {
    fc.assert(
      fc.property(treeArbitrary({ maxNodes: 40 }), (tree) => {
        expect(decodeCjtString(encodeCjtString(tree))).toEqual(canonicalize(tree));
      }),
      opts(NUM_RUNS),
    );
  });

  it("VTL: decode(encode(t)) deep-equals canonicalize(t), and re-validates", () => {
    fc.assert(
      fc.property(treeArbitrary({ maxNodes: 60 }), (tree) => {
        const decoded = decodeVtl(encodeVtl(tree));
        expect(decoded).toEqual(canonicalize(tree));
        expect(validateTree(decoded).ok).toBe(true);
      }),
      opts(NUM_RUNS),
    );
  });

  it("larger trees (up to ~250 nodes) still round-trip on both profiles", () => {
    fc.assert(
      fc.property(treeArbitrary({ minNodes: 100, maxNodes: 250 }), (tree) => {
        expect(decodeCjt(encodeCjt(tree))).toEqual(canonicalize(tree));
        expect(decodeVtl(encodeVtl(tree))).toEqual(canonicalize(tree));
      }),
      opts(60),
    );
  });

  it("canonicalize is idempotent (canonicalize(canonicalize(t)) == canonicalize(t))", () => {
    fc.assert(
      fc.property(treeArbitrary({ maxNodes: 40 }), (tree) => {
        const once = canonicalize(tree);
        expect(canonicalize(once)).toEqual(once);
      }),
      opts(NUM_RUNS),
    );
  });
});

describe("hand-built edge cases (outside the property loop)", () => {
  const roundtrips = (tree: Tree) => {
    expect(decodeCjt(encodeCjt(tree))).toEqual(canonicalize(tree));
    expect(decodeVtl(encodeVtl(tree))).toEqual(canonicalize(tree));
  };

  it("single-node tree, no source/props/children", () => {
    roundtrips({ formatVersion: VENDO_TREE_FORMAT, root: "r", nodes: [{ id: "r", component: "Text" }] });
  });

  it("hostile ids and component names round-trip (VTL token escaping)", () => {
    roundtrips({
      formatVersion: VENDO_TREE_FORMAT,
      root: "id with spaces",
      nodes: [
        { id: "id with spaces", component: "Stack", children: ['"quote', "tab\there", "узел 1", "", "dan gling"] },
        { id: '"quote', component: "Has Space" },
        { id: "tab\there", component: "Uni код", source: "host" },
        { id: "узел 1", component: "Text", source: "prewired", props: { t: 1 } },
      ],
    });
  });

  it("sigil-leading component with NO source does not misdecode (the .Foo collision)", () => {
    const tree: Tree = {
      formatVersion: VENDO_TREE_FORMAT,
      root: "r",
      nodes: [
        { id: "r", component: "Stack", children: ["a", "b", "c"] },
        { id: "a", component: ".Foo" }, // sourceless, sigil-leading — must NOT become prewired "Foo"
        { id: "b", component: ":Colon" },
        { id: "c", component: "*Star" },
      ],
    };
    const decoded = decodeVtl(encodeVtl(tree));
    expect(decoded.nodes[1]).toEqual({ id: "a", component: ".Foo" });
    expect(decoded.nodes[2]).toEqual({ id: "b", component: ":Colon" });
    expect(decoded.nodes[3]).toEqual({ id: "c", component: "*Star" });
    // and WITH a source, a sigil-leading name still survives:
    roundtrips({
      formatVersion: VENDO_TREE_FORMAT,
      root: "r",
      nodes: [{ id: "r", component: ".Dotted", source: "host" }],
    });
    roundtrips(tree);
  });

  it("canonicalize (and therefore both encoders) REJECTS unknown extension fields", () => {
    const base = { formatVersion: VENDO_TREE_FORMAT, root: "r", nodes: [{ id: "r", component: "Text" }] };
    // tree-level
    expect(() => canonicalize({ ...base, futureField: 1 })).toThrow(/unknown extension field "futureField"/);
    // node-level
    expect(() =>
      canonicalize({ ...base, nodes: [{ id: "r", component: "Text", meta: {} }] }),
    ).toThrow(/unknown extension field "meta"/);
    // query-level
    expect(() =>
      canonicalize({ ...base, queries: [{ path: "", tool: "t", cache: true }] }),
    ).toThrow(/unknown extension field "cache"/);
    // encoders inherit the rejection
    expect(() => encodeCjt({ ...base, futureField: 1 })).toThrow(/unknown extension field/);
    expect(() => encodeVtl({ ...base, futureField: 1 })).toThrow(/unknown extension field/);
  });

  it("strict CJT decoder rejects off-grammar documents", () => {
    const good = encodeCjt({ formatVersion: VENDO_TREE_FORMAT, root: "r", nodes: [{ id: "r", component: "Text" }] });
    expect(() => decodeCjt({ ...good, f: "vendo-cjt/9" })).toThrow(/format tag/);
    expect(() => decodeCjt({ ...good, extra: 1 })).toThrow(/unknown document key/);
    expect(() => decodeCjt({ ...good, n: [["r", 0, 7]] })).toThrow(/source code/);
    expect(() => decodeCjt({ ...good, n: [["r", 5]] })).toThrow(/component index/);
    expect(() => decodeCjt({ ...good, n: [["r", 0, 1, 0, 0, 0]] })).toThrow(/arity/);
    expect(() => decodeCjt({ ...good, n: [["r", 0, 1, "props"]] })).toThrow(/props/);
    expect(() => decodeCjt({ ...good, q: [["only-path"]] })).toThrow(/query/);
  });

  it("strict VTL decoder rejects off-grammar lines", () => {
    expect(() => decodeVtl("nope")).toThrow(/header/);
    expect(() => decodeVtl("vtl1 r\n-a Text\textra\ttabs\tboom")).toThrow(/too many tab segments/);
    expect(() => decodeVtl("vtl1 r\nX\t{}")).toThrow(/unrecognized opcode/);
    expect(() => decodeVtl('vtl1 r\nD\t{"a":1}\nD\t{"b":2}')).toThrow(/duplicate D/);
    expect(() => decodeVtl("vtl1 r\n-a Text\t[1,2]")).toThrow(/props segment must be a JSON object/);
    expect(() => decodeVtl('vtl1 r\nQ\t["path-only"]')).toThrow(/query/);
    expect(() => decodeVtl('vtl1 r\nC\t["Name"]')).toThrow(/component must be/);
    expect(() => decodeVtl('vtl1 r\nC\t["A","x"]\nC\t["A","y"]')).toThrow(/duplicate component/);
    expect(() => decodeVtl("vtl1 r r2\n-a Text")).toThrow(/more than one token/);
    expect(() => decodeVtl("vtl1 r\n-a Text extra")).toThrow(/more than two tokens/);
  });

  it("present-but-empty props and children are preserved distinctly from absent", () => {
    const tree: Tree = {
      formatVersion: VENDO_TREE_FORMAT,
      root: "r",
      nodes: [
        { id: "r", component: "Stack", source: "prewired", children: ["a", "b", "c"] },
        { id: "a", component: "Text", props: {} }, // props present, empty
        { id: "b", component: "Row", children: [] }, // children present, empty
        { id: "c", component: "Text" }, // both absent
      ],
    };
    const decoded = decodeVtl(encodeVtl(tree));
    expect(decoded.nodes[1]).toEqual({ id: "a", component: "Text", props: {} });
    expect(decoded.nodes[2]).toEqual({ id: "b", component: "Row", children: [] });
    expect(decoded.nodes[3]).toEqual({ id: "c", component: "Text" });
    roundtrips(tree);
  });

  it("shared children (DAG) and a self-cycle survive — VTL is flat, not nesting", () => {
    roundtrips({
      formatVersion: VENDO_TREE_FORMAT,
      root: "root",
      nodes: [
        { id: "root", component: "Stack", children: ["x", "y"] },
        { id: "x", component: "Stack", children: ["shared"] },
        { id: "y", component: "Stack", children: ["shared", "y"] }, // shared child + self-cycle
        { id: "shared", component: "Text", props: { text: "one node, two parents" } },
      ],
    });
  });

  it("dangling child ids render-as-skeleton and survive the round-trip", () => {
    roundtrips({
      formatVersion: VENDO_TREE_FORMAT,
      root: "r",
      nodes: [{ id: "r", component: "Stack", children: ["never-defined", "also-missing"] }],
    });
  });

  it("all binding kinds, fn: refs, queries at the cap, and a components map", () => {
    const queries = Array.from({ length: 16 }, (_, i) => ({
      path: i === 0 ? "" : `/q/${i}`,
      tool: i % 2 === 0 ? `host_tool_${i}` : `fn:load_${i}`,
      ...(i % 3 === 0 ? { input: { limit: i } } : {}),
    }));
    roundtrips({
      formatVersion: VENDO_TREE_FORMAT,
      root: "root",
      nodes: [
        { id: "root", component: "Stack", source: "prewired", children: ["t", "g"] },
        {
          id: "t",
          component: "Text",
          source: "host",
          props: { title: { $path: "/data/name" }, mode: { $state: "draft" }, onTap: { action: "fn:refresh", payload: { id: 1 } } },
        },
        { id: "g", component: "GenGauge", source: "generated", props: { value: { $path: "/g/v" } } },
      ],
      data: { name: "unicode 🎯 \"quotes\" \t tabs \n newlines" },
      queries,
      components: { GenGauge: "export default function GenGauge(p){ return null }" },
    });
  });

  it("escaping-hostile prop values do not break the tab-delimited VTL line", () => {
    roundtrips({
      formatVersion: VENDO_TREE_FORMAT,
      root: "r",
      nodes: [
        {
          id: "r",
          component: "Text",
          props: {
            tabbed: "a\tb\tc",
            multi: "line1\nline2",
            gt: "a > b > c",
            quote: 'he said "hi"',
            emoji: "🔥🎉",
          },
        },
      ],
    });
  });

  it("near the 5000-node cap (4999 nodes), with source + props + children", () => {
    const nodes: Tree["nodes"] = [
      { id: "root", component: "Stack", source: "prewired", children: Array.from({ length: 4998 }, (_, i) => `c${i}`) },
    ];
    for (let i = 0; i < 4998; i += 1) {
      nodes.push({ id: `c${i}`, component: "Text", source: "prewired", props: { text: `row ${i}` }, children: [] });
    }
    const tree: Tree = { formatVersion: VENDO_TREE_FORMAT, root: "root", nodes };
    expect(validateTree(tree).ok).toBe(true);
    roundtrips(tree);
  });

  it("at the 5000-node cap (5000 nodes)", () => {
    const nodes: Tree["nodes"] = [
      { id: "root", component: "Stack", children: Array.from({ length: 4999 }, (_, i) => `c${i}`) },
    ];
    for (let i = 0; i < 4999; i += 1) nodes.push({ id: `c${i}`, component: "Text", props: { i } });
    const tree: Tree = { formatVersion: VENDO_TREE_FORMAT, root: "root", nodes };
    expect(validateTree(tree).ok).toBe(true);
    roundtrips(tree);
  });
});
