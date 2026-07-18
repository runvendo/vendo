import { describe, expect, it } from "vitest";
import { VENDO_TREE_FORMAT_V2 } from "../formats.js";
import { validateTreeV2 } from "../tree-v2.js";
import { compileWireV2, type WireCompileOptions, type WireCompileResult } from "./compile.js";

/** D6 — every compiled tree must pass validateTreeV2, whatever the input.
 *  (Shared gate: all tests below go through this helper unless the input
 *  deliberately exceeds the §8 caps, which Task 5 enforces at compile.) */
const compile = (wire: string, options?: WireCompileOptions): WireCompileResult => {
  const result = compileWireV2(wire, options);
  const validation = validateTreeV2(result.tree);
  expect(validation).toEqual({ ok: true, tree: result.tree });
  return result;
};

const codes = (result: WireCompileResult): string[] =>
  result.issues.map((issue) => issue.code);

/** The degraded output for no-App/hostile input: root Stack, no children. */
const EMPTY_TREE = {
  formatVersion: VENDO_TREE_FORMAT_V2,
  root: "root",
  nodes: [{ id: "root", component: "Stack", source: "prewired" }],
};

const SPEC_DOC = `
<App name="Cash Overview">
  <Stack gap={16}>
    <PageHeader title="Cash Overview" subtitle="Live cash position" compact/>
    <Grid cols={3}>
      <LineChart title="Revenue" points={[1, 2, 3]}/>
      <LineChart title="Costs" points={[{ x: 1, y: 2 }]}/>
      <DataTable rows={[]} dense/>
    </Grid>
  </Stack>
</App>
`;

describe("compileWireV2 document shape", () => {
  it("compiles a nested query-free document to the exact expected tree", () => {
    const result = compile(SPEC_DOC);
    expect(result.tree).toStrictEqual({
      formatVersion: VENDO_TREE_FORMAT_V2,
      root: "root",
      nodes: [
        { id: "root", component: "Stack", source: "prewired", children: ["stack-1"] },
        { id: "stack-1", component: "Stack", source: "prewired", props: { gap: 16 }, children: ["pageheader-1", "grid-1"] },
        {
          id: "pageheader-1",
          component: "PageHeader",
          props: { title: "Cash Overview", subtitle: "Live cash position", compact: true },
        },
        {
          id: "grid-1",
          component: "Grid",
          source: "prewired",
          props: { cols: 3 },
          children: ["linechart-1", "linechart-2", "datatable-1"],
        },
        { id: "linechart-1", component: "LineChart", props: { title: "Revenue", points: [1, 2, 3] } },
        { id: "linechart-2", component: "LineChart", props: { title: "Costs", points: [{ x: 1, y: 2 }] } },
        { id: "datatable-1", component: "DataTable", props: { rows: [], dense: true } },
      ],
    });
    expect(result.name).toBe("Cash Overview");
    expect(result.components).toStrictEqual({});
    expect(result.issues).toEqual([]);
    expect(result.complete).toBe(true);
  });

  it("is deterministic: two runs are deep-equal and stringify-identical", () => {
    const first = compile(SPEC_DOC);
    const second = compile(SPEC_DOC);
    expect(second).toStrictEqual(first);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it("compiles self-closing and paired forms to the same tree", () => {
    const selfClosing = compile("<App><Card/></App>");
    const paired = compile("<App><Card></Card></App>");
    expect(paired.tree).toStrictEqual(selfClosing.tree);
    expect(selfClosing.tree.nodes[1]).toStrictEqual({ id: "card-1", component: "Card", source: "prewired" });
  });

  it("compiles a self-closing App to the empty tree, complete", () => {
    const result = compile('<App name="Tiny"/>');
    expect(result.tree).toStrictEqual(EMPTY_TREE);
    expect(result.name).toBe("Tiny");
    expect(result.complete).toBe(true);
    expect(result.issues).toEqual([]);
  });

  it("leaves name undefined when App has no name attribute or a non-string one", () => {
    expect(compile("<App><Card/></App>").name).toBeUndefined();
    expect(compile("<App name={5}><Card/></App>").name).toBeUndefined();
  });

  it("mints per-component ordinals in document order", () => {
    const result = compile("<App><Badge/><Card/><Badge/><Badge/></App>");
    expect(result.tree.nodes.map((node) => node.id)).toEqual([
      "root",
      "badge-1",
      "card-1",
      "badge-2",
      "badge-3",
    ]);
  });
});

describe("compileWireV2 attributes", () => {
  it("decodes markup-layer string escapes for quote and backslash only", () => {
    const result = compile('<App><Card title="say \\"hi\\" \\\\ done" path="a\\nb"/></App>');
    expect(result.tree.nodes[1]?.props).toStrictEqual({
      title: 'say "hi" \\ done',
      path: "a\\nb",
    });
    expect(result.issues).toEqual([]);
  });

  it("compiles bare attributes to true", () => {
    const result = compile("<App><Card dense compact/></App>");
    expect(result.tree.nodes[1]?.props).toStrictEqual({ dense: true, compact: true });
  });

  it("delegates expression attributes to parseExpression (literals land in props)", () => {
    const result = compile(
      '<App><Card count={3} config={{ mode: "dark", tags: [\'a\', "b"] }} list={[1, [2], null]}/></App>',
    );
    expect(result.tree.nodes[1]?.props).toStrictEqual({
      count: 3,
      config: { mode: "dark", tags: ["a", "b"] },
      list: [1, [2], null],
    });
    expect(result.issues).toEqual([]);
  });

  it("drops a bare-identifier expression with unknown-reference (no queries yet)", () => {
    const result = compile('<App><Card points={revenue} title="ok"/></App>');
    expect(result.tree.nodes[1]).toStrictEqual({
      id: "card-1",
      component: "Card",
      source: "prewired",
      props: { title: "ok" },
    });
    expect(codes(result)).toEqual(["unknown-reference"]);
    expect(result.complete).toBe(true);
  });

  it("drops a malformed expression attribute and keeps the rest", () => {
    const result = compile('<App><Card bad={[1,} good={2}/></App>');
    expect(result.tree.nodes[1]?.props).toStrictEqual({ good: 2 });
    expect(codes(result)).toContain("malformed-expression");
  });

  it("resolves duplicate attributes last-wins with an issue", () => {
    const result = compile('<App><Card a="1" a="2"/></App>');
    expect(result.tree.nodes[1]?.props).toStrictEqual({ a: "2" });
    expect(codes(result)).toEqual(["duplicate-attribute"]);
  });

  it("drops an ill-formed UTF-16 string attribute (lone surrogate)", () => {
    const result = compile('<App><Card title="a\uD800b"/></App>');
    expect(result.tree.nodes[1]).toStrictEqual({ id: "card-1", component: "Card", source: "prewired" });
    expect(codes(result)).toEqual(["malformed-attribute"]);
  });

  it("ignores wire-supplied id attributes with wire-id-ignored", () => {
    const result = compile('<App><Card id="mine" title="kept"/></App>');
    expect(result.tree.nodes[1]).toStrictEqual({
      id: "card-1",
      component: "Card",
      source: "prewired",
      props: { title: "kept" },
    });
    expect(codes(result)).toEqual(["wire-id-ignored"]);
  });

  it("omits props entirely when a node has no attributes", () => {
    const result = compile("<App><Card/></App>");
    expect(result.tree.nodes[1]).toStrictEqual({ id: "card-1", component: "Card", source: "prewired" });
    expect("props" in (result.tree.nodes[1] as object)).toBe(false);
  });

  it("treats a __proto__ attribute as data, never the props prototype", () => {
    const result = compile("<App><Card __proto__={{ evil: true }} a={1}/></App>");
    const props = result.tree.nodes[1]?.props as Record<string, unknown>;
    expect(Object.getPrototypeOf(props)).toBe(Object.prototype);
    expect(Object.getOwnPropertyNames(props)).toEqual(["__proto__", "a"]);
    expect(props.a).toBe(1);
  });

  it("merges expression issues into compile issues in source order", () => {
    const result = compile('<App><Card a={mystery} id="x"/></App>');
    expect(codes(result)).toEqual(["unknown-reference", "wire-id-ignored"]);
  });
});

describe("compileWireV2 element recovery", () => {
  it("skips unknown lowercase tags including their subtree", () => {
    const result = compile('<App><div class="x"><Card/></div><Badge/></App>');
    expect(result.tree.nodes.map((node) => node.id)).toEqual(["root", "badge-1"]);
    expect(codes(result)).toEqual(["unknown-element"]);
    expect(result.complete).toBe(true);
  });

  it("skips unknown tags tolerant of same-name nesting", () => {
    const result = compile("<App><div><div>deep</div><Card/></div><Badge/></App>");
    expect(result.tree.nodes.map((node) => node.id)).toEqual(["root", "badge-1"]);
    expect(codes(result)).toEqual(["unknown-element"]);
  });

  it("treats digits-first tags as unknown elements", () => {
    const result = compile("<App><1abc/><Card/></App>");
    expect(result.tree.nodes.map((node) => node.id)).toEqual(["root", "card-1"]);
    expect(codes(result)).toEqual(["unknown-element"]);
  });

  it("hoists Query and captures Island without producing tree nodes (Task 4)", () => {
    const result = compile(
      '<App><Query id="revenue" tool="metrics.revenue"/><Island name="Spark">export default x</Island><Card/></App>',
    );
    expect(result.tree.nodes.map((node) => node.id)).toEqual(["root", "card-1"]);
    expect(result.tree.queries).toStrictEqual([{ name: "revenue", tool: "metrics.revenue" }]);
    expect(result.components).toStrictEqual({ Spark: "export default x" });
    expect(result.issues).toEqual([]);
  });

  it("records stray close tags and keeps parsing", () => {
    const result = compile("<App></Grid><Card/></App>");
    expect(result.tree.nodes.map((node) => node.id)).toEqual(["root", "card-1"]);
    expect(codes(result)).toEqual(["stray-close-tag"]);
    expect(result.complete).toBe(true);
  });

  it("recovers from a mismatched close by implicitly closing inner elements", () => {
    const result = compile("<App><Stack><Card></Stack><Badge/></App>");
    expect(result.tree.nodes).toStrictEqual([
      { id: "root", component: "Stack", source: "prewired", children: ["stack-1", "badge-1"] },
      { id: "stack-1", component: "Stack", source: "prewired", children: ["card-1"] },
      { id: "card-1", component: "Card", source: "prewired" },
      { id: "badge-1", component: "Badge", source: "prewired" },
    ]);
    expect(codes(result)).toEqual(["unclosed-element"]);
    expect(result.complete).toBe(true);
  });

  it("compiles non-whitespace text children to Text nodes (Task 4)", () => {
    const result = compile("<App><Card>hello world</Card></App>");
    expect(result.tree.nodes.slice(1)).toStrictEqual([
      { id: "card-1", component: "Card", source: "prewired", children: ["text-1"] },
      { id: "text-1", component: "Text", source: "prewired", props: { text: "hello world" } },
    ]);
    expect(result.issues).toEqual([]);
  });

  it("ignores whitespace-only text silently", () => {
    const result = compile("<App>\n  <Card/>\n  \t</App>");
    expect(result.issues).toEqual([]);
    expect(result.complete).toBe(true);
  });
});

describe("compileWireV2 document errors", () => {
  it.each(["", "   \n\t", "hello", "<app></app>", "not markup at all"])(
    "compiles no-App input %j to the empty tree with missing-app",
    (wire) => {
      const result = compile(wire);
      expect(result.tree).toStrictEqual(EMPTY_TREE);
      expect(codes(result)).toEqual(["missing-app"]);
      expect(result.complete).toBe(false);
      expect(result.name).toBeUndefined();
    },
  );

  it("treats garbage before App as missing-app (locked)", () => {
    const result = compile("junk <App><Card/></App>");
    expect(result.tree).toStrictEqual(EMPTY_TREE);
    expect(codes(result)).toEqual(["missing-app"]);
    expect(result.complete).toBe(false);
  });

  it("records trailing content after </App> and marks incomplete", () => {
    const result = compile("<App><Card/></App> trailing junk");
    expect(result.tree.nodes.map((node) => node.id)).toEqual(["root", "card-1"]);
    expect(codes(result)).toEqual(["trailing-content"]);
    expect(result.complete).toBe(false);
  });

  it("tolerates trailing whitespace after </App>", () => {
    const result = compile("<App><Card/></App>\n  ");
    expect(result.issues).toEqual([]);
    expect(result.complete).toBe(true);
  });
});

describe("compileWireV2 partial input (wave-1 heuristic; Task 5 refines)", () => {
  it("auto-closes unclosed elements at EOF and marks incomplete", () => {
    const result = compile("<App><Stack><Card/>");
    expect(result.tree.nodes).toStrictEqual([
      { id: "root", component: "Stack", source: "prewired", children: ["stack-1"] },
      { id: "stack-1", component: "Stack", source: "prewired", children: ["card-1"] },
      { id: "card-1", component: "Card", source: "prewired" },
    ]);
    expect(codes(result)).toEqual(["unclosed-element", "unclosed-element"]);
    expect(result.complete).toBe(false);
  });

  it("drops an element whose tag is truncated at EOF", () => {
    const result = compile('<App><Card title="x');
    expect(result.tree.nodes).toStrictEqual([
      { id: "root", component: "Stack", source: "prewired" },
    ]);
    expect(codes(result)).toContain("unclosed-element");
    expect(result.complete).toBe(false);
  });

  it("compiles a truncated App open tag to the empty tree, incomplete", () => {
    const result = compile('<App name="half');
    expect(result.tree).toStrictEqual(EMPTY_TREE);
    expect(codes(result)).toEqual(["unclosed-element"]);
    expect(result.complete).toBe(false);
  });
});

describe("compileWireV2 totality", () => {
  it("never throws on hostile input, and the tree stays valid", () => {
    const nasty = [
      "<",
      "<<<<>>>>",
      "<App",
      "<App/",
      '<App name="unterminated',
      '<App><Card title="oops></App>',
      "<App>" + "<Stack>".repeat(300),
      "<".repeat(50_000),
      "<App>" + "{".repeat(10_000),
      "<App><Card points={" + "[".repeat(5_000) + "/></App>",
      "<App>𐀀 text \uD800</App>",
      "</Card>",
      "<App></App></App>",
      "<App><Card a={'unterminated/></App>",
      "<App><Card a= /></App>",
      "<App><Card a='single'/></App>",
    ];
    for (const wire of nasty) {
      let result: WireCompileResult | undefined;
      expect(() => {
        result = compileWireV2(wire);
      }).not.toThrow();
      expect(Array.isArray(result?.issues)).toBe(true);
      expect(typeof result?.complete).toBe("boolean");
      expect(result?.components).toStrictEqual({});
      expect(validateTreeV2(result?.tree)).toEqual({ ok: true, tree: result?.tree });
    }
  });

  it("survives huge nesting without throwing (cap enforcement lands in Task 5)", () => {
    // 20k nested Stacks exceed TREE_MAX_NODES, so the tree does not validate
    // yet — Task 5 makes over-cap input stop accumulating. Totality only here.
    const wire = "<App>" + "<Stack>".repeat(20_000);
    let result: WireCompileResult | undefined;
    expect(() => {
      result = compileWireV2(wire);
    }).not.toThrow();
    expect(result?.complete).toBe(false);
    expect(result?.tree.nodes.length).toBe(20_001);
  });
});

describe("compileWireV2 queries (D3)", () => {
  it("hoists queries into tree.queries in document order, wherever they appear", () => {
    const result = compile(
      '<App><Query id="a" tool="t.a"/><Card/><Query id="b" tool="t.b"/></App>',
    );
    expect(result.tree.queries).toStrictEqual([
      { name: "a", tool: "t.a" },
      { name: "b", tool: "t.b" },
    ]);
    expect(result.tree.nodes.map((node) => node.id)).toEqual(["root", "card-1"]);
    expect(result.issues).toEqual([]);
  });

  it("leaves tree.queries absent when no queries were declared", () => {
    expect("queries" in compile("<App><Card/></App>").tree).toBe(false);
  });

  it("hoists a nested query with a non-fatal nested-query issue", () => {
    const result = compile('<App><Stack><Query id="a" tool="t"/></Stack></App>');
    expect(result.tree.queries).toStrictEqual([{ name: "a", tool: "t" }]);
    expect(codes(result)).toEqual(["nested-query"]);
    expect(result.complete).toBe(true);
  });

  it("parses the input expression into the query", () => {
    const result = compile('<App><Query id="a" tool="t" input={{ limit: 5, tag: "x" }}/></App>');
    expect(result.tree.queries).toStrictEqual([{ name: "a", tool: "t", input: { limit: 5, tag: "x" } }]);
  });

  it("keeps the query but drops a non-object input with invalid-query-input", () => {
    const result = compile('<App><Query id="a" tool="t" input={5}/></App>');
    expect(result.tree.queries).toStrictEqual([{ name: "a", tool: "t" }]);
    expect(codes(result)).toEqual(["invalid-query-input"]);
  });

  it.each([
    '<App><Query tool="t"/></App>',
    '<App><Query id={5} tool="t"/></App>',
    '<App><Query id="9bad" tool="t"/></App>',
    '<App><Query id="has space" tool="t"/></App>',
    '<App><Query id="state" tool="t"/></App>',
  ])("drops a query with a missing/bad/reserved name: %s", (wire) => {
    const result = compile(wire);
    expect(result.tree.queries).toBeUndefined();
    expect(codes(result)).toEqual(["invalid-query-name"]);
  });

  it.each([
    '<App><Query id="a"/></App>',
    '<App><Query id="a" tool=""/></App>',
    '<App><Query id="a" tool={5}/></App>',
    '<App><Query id="a" tool="fn:9bad"/></App>',
    '<App><Query id="a" tool="fn:"/></App>',
  ])("drops a query with a missing/empty/bad tool: %s", (wire) => {
    const result = compile(wire);
    expect(result.tree.queries).toBeUndefined();
    expect(codes(result)).toEqual(["invalid-query-tool"]);
  });

  it("accepts an fn: tool matching the fn-reference grammar", () => {
    const result = compile('<App><Query id="a" tool="fn:load_data"/></App>');
    expect(result.tree.queries).toStrictEqual([{ name: "a", tool: "fn:load_data" }]);
    expect(result.issues).toEqual([]);
  });

  it("drops the later duplicate query name with duplicate-query", () => {
    const result = compile('<App><Query id="a" tool="t1"/><Query id="a" tool="t2"/></App>');
    expect(result.tree.queries).toStrictEqual([{ name: "a", tool: "t1" }]);
    expect(codes(result)).toEqual(["duplicate-query"]);
  });

  it("treats paired Query content as an error without losing the document", () => {
    const result = compile('<App><Query id="a" tool="t"><Card/></Query><Badge/></App>');
    expect(result.tree.queries).toStrictEqual([{ name: "a", tool: "t" }]);
    expect(result.tree.nodes.map((node) => node.id)).toEqual(["root", "badge-1"]);
    expect(codes(result)).toEqual(["query-content"]);
    expect(result.complete).toBe(true);
  });
});

describe("compileWireV2 forward references", () => {
  it("resolves a binding to a query declared later in the wire", () => {
    const result = compile('<App><Card rows={payments}/><Query id="payments" tool="p.list"/></App>');
    expect(result.tree.nodes[1]?.props).toStrictEqual({ rows: { $path: "/payments" } });
    expect(result.tree.queries).toStrictEqual([{ name: "payments", tool: "p.list" }]);
    expect(result.issues).toEqual([]);
  });

  it("does not collect fake Query tags inside Island raw TSX", () => {
    const result = compile(
      '<App><Card x={fake}/><Island name="A"><Query id="fake" tool="t"/></Island></App>',
    );
    expect(result.tree.queries).toBeUndefined();
    expect(result.components).toStrictEqual({ A: '<Query id="fake" tool="t"/>' });
    expect(codes(result)).toEqual(["unknown-reference"]);
  });

  it("does not collect fake Query tags inside skipped unknown-element subtrees", () => {
    const result = compile('<App><Card x={ghost}/><div><Query id="ghost" tool="t"/></div></App>');
    expect(result.tree.queries).toBeUndefined();
    expect(codes(result)).toEqual(["unknown-reference", "unknown-element"]);
  });

  it("moves through single-quoted attributes exactly like the main pass (no phantom declarations)", () => {
    // The single-quoted run swallows the fake Island and Query on BOTH
    // passes: the pre-scan must not collect what the main pass never parses.
    const result = compile(
      "<App><Widget a='> <Island name=\"Fake\">body</Island> <Query id=\"ghost\" tool=\"t\"/> '/>"
      + "<Chart y={ghost.total}/><Fake/></App>",
    );
    expect(result.components).toStrictEqual({});
    expect(result.tree.queries).toBeUndefined();
    // Fake must not become a phantom island-backed component...
    expect(result.tree.nodes.find((node) => node.id === "fake-1")).toStrictEqual({
      id: "fake-1",
      component: "Fake",
    });
    // ...and ghost must not resolve: the binding drops as unknown-reference.
    expect(result.tree.nodes.find((node) => node.id === "chart-1")).toStrictEqual({
      id: "chart-1",
      component: "Chart",
    });
    expect(codes(result)).toEqual(["malformed-attribute", "unknown-reference"]);
    expect(result.complete).toBe(true);
  });

  it("resolves a name whose duplicate declaration was dropped (same name)", () => {
    const result = compile(
      '<App><Query id="a" tool="t1"/><Query id="a" tool="t2"/><Card x={a}/></App>',
    );
    expect(result.tree.queries).toStrictEqual([{ name: "a", tool: "t1" }]);
    expect(result.tree.nodes[1]?.props).toStrictEqual({ x: { $path: "/a" } });
    expect(codes(result)).toEqual(["duplicate-query"]);
  });
});

describe("compileWireV2 islands (D3)", () => {
  it("captures raw TSX verbatim: quotes, braces, and < pass through unparsed", () => {
    const source = 'export default function N() { if (1<2) { return "}{ <div/>"; } }';
    const result = compile(`<App><Island name="Note">${source}</Island></App>`);
    expect(result.components).toStrictEqual({ Note: source });
    expect(result.tree.nodes.map((node) => node.id)).toEqual(["root"]);
    expect(result.issues).toEqual([]);
    expect(result.complete).toBe(true);
  });

  it("cuts island content at the FIRST literal </Island>", () => {
    const result = compile('<App><Island name="A">outer <Island name="B">inner</Island> tail</Island></App>');
    expect(result.components).toStrictEqual({ A: 'outer <Island name="B">inner' });
    // The remainder re-enters the markup stream: " tail" becomes a Text node
    // and the second </Island> is a stray close.
    expect(result.tree.nodes[1]?.props).toStrictEqual({ text: "tail" });
    expect(codes(result)).toEqual(["stray-close-tag"]);
  });

  it.each([
    "<App><Island>src</Island><Badge/></App>",
    '<App><Island name="lower">src</Island><Badge/></App>',
    '<App><Island name={5}>src</Island><Badge/></App>',
    '<App><Island name="Text">src</Island><Badge/></App>',
  ])("skips an island with a missing/bad/reserved name: %s", (wire) => {
    const result = compile(wire);
    expect(result.components).toStrictEqual({});
    expect(codes(result)).toEqual(["invalid-island-name"]);
    // The document survives: content is consumed, the Badge still compiles.
    expect(result.tree.nodes.map((node) => node.id)).toEqual(["root", "badge-1"]);
  });

  it("drops the later duplicate island with duplicate-island", () => {
    const result = compile('<App><Island name="A">first</Island><Island name="A">second</Island></App>');
    expect(result.components).toStrictEqual({ A: "first" });
    expect(codes(result)).toEqual(["duplicate-island"]);
  });

  it("skips a self-closing island with island-no-content", () => {
    const result = compile('<App><Island name="A"/><Badge/></App>');
    expect(result.components).toStrictEqual({});
    expect(codes(result)).toEqual(["island-no-content"]);
    expect(result.tree.nodes.map((node) => node.id)).toEqual(["root", "badge-1"]);
  });

  it("drops an unterminated island at EOF and marks incomplete", () => {
    const result = compile('<App><Island name="A">export default');
    expect(result.components).toStrictEqual({});
    expect(codes(result)).toContain("unclosed-element");
    expect(result.complete).toBe(false);
  });
});

describe("compileWireV2 source resolution (D3)", () => {
  it("marks host-catalog names as host", () => {
    const result = compile("<App><RevenuePanel/></App>", { hostComponents: ["RevenuePanel"] });
    expect(result.tree.nodes[1]).toStrictEqual({ id: "revenuepanel-1", component: "RevenuePanel", source: "host" });
  });

  it("marks the 7 reserved + 8 branded prewired names as prewired", () => {
    const result = compile("<App><Row/><Divider/><Stat/><Tabs/></App>");
    expect(result.tree.nodes.slice(1).map((node) => node.source)).toEqual([
      "prewired",
      "prewired",
      "prewired",
      "prewired",
    ]);
  });

  it("marks island-backed names as generated, including forward references", () => {
    const result = compile('<App><Note/><Island name="Note">src</Island></App>');
    expect(result.tree.nodes[1]).toStrictEqual({ id: "note-1", component: "Note", source: "generated" });
  });

  it("host beats prewired beats island for the same name", () => {
    const host = compile("<App><Card/></App>", { hostComponents: ["Card"] });
    expect(host.tree.nodes[1]?.source).toBe("host");
    const prewiredOverIsland = compile('<App><Card/><Island name="Card">src</Island></App>');
    expect(prewiredOverIsland.tree.nodes[1]?.source).toBe("prewired");
    expect(prewiredOverIsland.components).toStrictEqual({ Card: "src" });
  });

  it("leaves source undefined for unknown names, with no issue", () => {
    const result = compile("<App><Mystery/></App>");
    expect(result.tree.nodes[1]).toStrictEqual({ id: "mystery-1", component: "Mystery" });
    expect(result.issues).toEqual([]);
  });
});

describe("compileWireV2 text children (D3)", () => {
  it("trims the ends but preserves internal whitespace", () => {
    const result = compile("<App><Card>\n  hello   world \n</Card></App>");
    expect(result.tree.nodes[2]?.props).toStrictEqual({ text: "hello   world" });
  });

  it("interleaves text nodes with element siblings in document order", () => {
    const result = compile("<App><Card>a<Badge/>b</Card></App>");
    expect(result.tree.nodes[1]?.children).toEqual(["text-1", "badge-1", "text-2"]);
    expect(result.tree.nodes[2]?.props).toStrictEqual({ text: "a" });
    expect(result.tree.nodes[4]?.props).toStrictEqual({ text: "b" });
  });

  it("compiles text directly inside App to a Text child of root", () => {
    const result = compile("<App>welcome</App>");
    expect(result.tree.nodes).toStrictEqual([
      { id: "root", component: "Stack", source: "prewired", children: ["text-1"] },
      { id: "text-1", component: "Text", source: "prewired", props: { text: "welcome" } },
    ]);
    expect(result.issues).toEqual([]);
  });

  it("shares the ordinal pool with Text elements so ids stay unique", () => {
    const result = compile("<App><Text/>hi</App>");
    expect(result.tree.nodes.map((node) => node.id)).toEqual(["root", "text-1", "text-2"]);
  });

  it("skips ill-formed UTF-16 text with malformed-text", () => {
    const result = compile("<App><Card>bad \uD800 text</Card></App>");
    expect(result.tree.nodes).toHaveLength(2);
    expect(result.tree.nodes[1]?.children).toBeUndefined();
    expect(codes(result)).toEqual(["malformed-text"]);
  });
});

describe("compileWireV2 actions (D5)", () => {
  it("compiles on* string attributes naming a tool to the canonical action prop", () => {
    const result = compile('<App><Button onClick="save"/></App>');
    expect(result.tree.nodes[1]?.props).toStrictEqual({ onClick: { action: "save" } });
    expect(result.issues).toEqual([]);
  });

  it("compiles on* string attributes naming an fn: reference", () => {
    const result = compile('<App><Button onSubmit="fn:do_thing"/></App>');
    expect(result.tree.nodes[1]?.props).toStrictEqual({ onSubmit: { action: "fn:do_thing" } });
  });

  it.each([
    '<App><Button onClick="fn:9bad"/></App>',
    '<App><Button onClick="not a tool!"/></App>',
    '<App><Button onClick=""/></App>',
  ])("drops an on* string naming neither a tool nor a valid fn: %s", (wire) => {
    const result = compile(wire);
    expect(result.tree.nodes[1]?.props).toBeUndefined();
    expect(codes(result)).toEqual(["invalid-action"]);
  });

  it("passes expression-form on* attributes through untouched", () => {
    const result = compile('<App><Button onClick={{ action: "fn:do_thing", confirm: true }}/></App>');
    expect(result.tree.nodes[1]?.props).toStrictEqual({
      onClick: { action: "fn:do_thing", confirm: true },
    });
    expect(result.issues).toEqual([]);
  });

  it("leaves non-action-shaped attributes alone", () => {
    const result = compile('<App><Button onclick="save" title="fn:do_thing" onFire/></App>');
    expect(result.tree.nodes[1]?.props).toStrictEqual({
      onclick: "save",
      title: "fn:do_thing",
      onFire: true,
    });
    expect(result.issues).toEqual([]);
  });
});

describe("compileWireV2 behavior pins (review)", () => {
  it("skips a nested <App> with its subtree", () => {
    const result = compile("<App><App><Card/></App><Badge/></App>");
    expect(result.tree.nodes.map((node) => node.id)).toEqual(["root", "badge-1"]);
    expect(codes(result)).toEqual(["nested-app"]);
    expect(result.complete).toBe(true);
  });

  it("silently discards App attributes other than name", () => {
    const result = compile('<App name="X" theme="dark" gap={4} onLoad="boot"><Card/></App>');
    expect(result.name).toBe("X");
    expect(result.issues).toEqual([]);
    expect(result.tree.nodes[0]).toStrictEqual({
      id: "root",
      component: "Stack",
      source: "prewired",
      children: ["card-1"],
    });
  });

  it("records close-tag junk as malformed-attribute but still closes", () => {
    const result = compile("<App><Card></Card junk></App>");
    expect(result.tree.nodes[1]).toStrictEqual({ id: "card-1", component: "Card", source: "prewired" });
    expect(codes(result)).toEqual(["malformed-attribute"]);
    expect(result.complete).toBe(true);
  });

  it('parses the expression boundary a={"}"} correctly', () => {
    const result = compile('<App><Card a={"}"}/></App>');
    expect(result.tree.nodes[1]?.props).toStrictEqual({ a: "}" });
    expect(result.issues).toEqual([]);
  });

  it("populates a best-effort index on compile-side issues", () => {
    const result = compile("<App></Grid><Card/></App>");
    expect(codes(result)).toEqual(["stray-close-tag"]);
    expect(typeof result.issues[0]?.index).toBe("number");
  });
});

describe("compileWireV2 full-spec-example gate (spec §2)", () => {
  const specWire = (points: string): string => `
<App name="Cash Overview">
  <Query id="revenue" tool="metrics.revenue"/>
  <Query id="payments" tool="payments.list" input={{ limit: 5 }}/>
  <Stack gap={16}>
    <PageHeader title="Cash Overview" subtitle="Live cash position"/>
    <Grid cols={3}>
      <LineChart title="Revenue" points={${points}}/>
      <DataTable rows={payments} columns={[{ key: "amount", label: "Amount" }]}/>
    </Grid>
  </Stack>
  <Island name="RevenueNote">export default function RevenueNote() { return <em>Cash is healthy.</em>; }</Island>
</App>
`;

  const expectSpecTree = (result: WireCompileResult): void => {
    expect(result.tree).toStrictEqual({
      formatVersion: VENDO_TREE_FORMAT_V2,
      root: "root",
      nodes: [
        { id: "root", component: "Stack", source: "prewired", children: ["stack-1"] },
        {
          id: "stack-1",
          component: "Stack",
          source: "prewired",
          props: { gap: 16 },
          children: ["pageheader-1", "grid-1"],
        },
        {
          id: "pageheader-1",
          component: "PageHeader",
          props: { title: "Cash Overview", subtitle: "Live cash position" },
        },
        {
          id: "grid-1",
          component: "Grid",
          source: "prewired",
          props: { cols: 3 },
          children: ["linechart-1", "datatable-1"],
        },
        {
          id: "linechart-1",
          component: "LineChart",
          props: { title: "Revenue", points: { $path: "/revenue" } },
        },
        {
          id: "datatable-1",
          component: "DataTable",
          props: { rows: { $path: "/payments" }, columns: [{ key: "amount", label: "Amount" }] },
        },
      ],
      queries: [
        { name: "revenue", tool: "metrics.revenue" },
        { name: "payments", tool: "payments.list", input: { limit: 5 } },
      ],
    });
    expect(result.components).toStrictEqual({
      RevenueNote: "export default function RevenueNote() { return <em>Cash is healthy.</em>; }",
    });
    expect(result.name).toBe("Cash Overview");
    expect(result.complete).toBe(true);
  };

  it("compiles the spec example (reshape pipe dropped) with zero issues", () => {
    const result = compile(specWire("revenue"));
    expectSpecTree(result);
    expect(result.issues).toEqual([]);
  });

  it("compiles the spec example WITH the pipe: reshape-unsupported is the sole issue", () => {
    const result = compile(specWire("revenue | asPoints(month, revenue)"));
    expectSpecTree(result);
    expect(codes(result)).toEqual(["reshape-unsupported"]);
  });
});
