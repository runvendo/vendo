import { describe, expect, it } from "vitest";
import { validateAppDocument } from "../app-document.js";
import { componentMapError } from "../component-map.js";
import { VENDO_APP_FORMAT, VENDO_TREE_FORMAT_V2 } from "../formats.js";
import {
  TREE_MAX_COMPONENT_SOURCE_BYTES,
  TREE_MAX_GENERATED_COMPONENTS,
  TREE_MAX_NODES,
  TREE_MAX_QUERIES,
  TREE_MAX_TOTAL_COMPONENT_BYTES,
} from "../tree-limits.js";
import { validateTreeV2 } from "../tree-v2.js";
import { compileWireV2, type WireCompileOptions, type WireCompileResult } from "./compile.js";

/** D6 — every compiled tree must pass validateTreeV2, whatever the input
 *  (the §8 caps are enforced at compile, so even over-cap input compiles to
 *  a within-limits valid tree). */
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

describe("compileWireV2 partial input (D6)", () => {
  it("auto-closes unclosed elements at EOF with eof-unclosed and marks incomplete", () => {
    const result = compile("<App><Stack><Card/>");
    expect(result.tree.nodes).toStrictEqual([
      { id: "root", component: "Stack", source: "prewired", children: ["stack-1"] },
      { id: "stack-1", component: "Stack", source: "prewired", children: ["card-1"] },
      { id: "card-1", component: "Card", source: "prewired" },
    ]);
    expect(codes(result)).toEqual(["eof-unclosed", "eof-unclosed"]);
    expect(result.complete).toBe(false);
  });

  it("drops an element whose open tag is truncated at EOF with truncated-tag", () => {
    const result = compile('<App><Card title="x');
    expect(result.tree.nodes).toStrictEqual([
      { id: "root", component: "Stack", source: "prewired" },
    ]);
    expect(codes(result)).toContain("truncated-tag");
    expect(result.complete).toBe(false);
  });

  it("compiles a truncated App open tag to the empty tree, incomplete", () => {
    const result = compile('<App name="half');
    expect(result.tree).toStrictEqual(EMPTY_TREE);
    expect(codes(result)).toEqual(["truncated-tag"]);
    expect(result.complete).toBe(false);
  });

  it("records an unterminated skipped element as unclosed-skipped", () => {
    const result = compile("<App><div><Card/>");
    expect(result.tree.nodes).toStrictEqual([
      { id: "root", component: "Stack", source: "prewired" },
    ]);
    expect(codes(result)).toEqual(["unknown-element", "unclosed-skipped", "eof-unclosed"]);
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

  it("caps huge nesting at TREE_MAX_NODES and the tree stays valid", () => {
    const wire = "<App>" + "<Stack>".repeat(20_000);
    let result: WireCompileResult | undefined;
    expect(() => {
      result = compileWireV2(wire);
    }).not.toThrow();
    expect(result?.complete).toBe(false);
    expect(result?.tree.nodes.length).toBe(TREE_MAX_NODES);
    expect(validateTreeV2(result?.tree)).toEqual({ ok: true, tree: result?.tree });
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

  it("drops an unterminated island at EOF (unclosed-skipped) and marks incomplete", () => {
    const result = compile('<App><Island name="A">export default');
    expect(result.components).toStrictEqual({});
    expect(codes(result)).toContain("unclosed-skipped");
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

  it("passes expression-form on* attributes with valid fn: actions through untouched", () => {
    const result = compile('<App><Button onClick={{ action: "fn:do_thing", confirm: true }}/></App>');
    expect(result.tree.nodes[1]?.props).toStrictEqual({
      onClick: { action: "fn:do_thing", confirm: true },
    });
    expect(result.issues).toEqual([]);
  });

  it("drops an expression attribute carrying an invalid fn: action reference (D6 always-validates)", () => {
    const result = compile('<App><Button onClick={{ action: "fn:9bad" }} title="kept"/></App>');
    expect(result.tree.nodes[1]?.props).toStrictEqual({ title: "kept" });
    expect(codes(result)).toEqual(["invalid-action"]);
  });

  it("finds an invalid fn: action nested anywhere in an expression value", () => {
    const result = compile('<App><Card cfg={{ list: [{ deep: { action: "fn:" } }] }}/></App>');
    expect(result.tree.nodes[1]?.props).toBeUndefined();
    expect(codes(result)).toEqual(["invalid-action"]);
    expect(validateTreeV2(result.tree)).toEqual({ ok: true, tree: result.tree });
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

  it("records close-tag junk as malformed-close-tag but still closes", () => {
    const result = compile("<App><Card></Card junk></App>");
    expect(result.tree.nodes[1]).toStrictEqual({ id: "card-1", component: "Card", source: "prewired" });
    expect(codes(result)).toEqual(["malformed-close-tag"]);
    expect(result.complete).toBe(true);
  });

  it('parses the expression boundary a={"}"} correctly', () => {
    const result = compile('<App><Card a={"}"}/></App>');
    expect(result.tree.nodes[1]?.props).toStrictEqual({ a: "}" });
    expect(result.issues).toEqual([]);
  });

  it("populates an exact best-effort index on compile-side issues", () => {
    const result = compile("<App></Grid><Card/></App>");
    expect(codes(result)).toEqual(["stray-close-tag"]);
    // The cursor sits just past the close tag's ">" when the issue records:
    // "<App></Grid>" is 12 characters, so the index pins at 12.
    expect(result.issues[0]?.index).toBe(12);
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

  it("compiles the spec example WITH the pipe to a $reshape binding, zero issues (v2 spec §3)", () => {
    const result = compile(specWire("revenue | asPoints(month, revenue)"));
    expect(result.issues).toEqual([]);
    const chart = result.tree.nodes.find((node) => node.id === "linechart-1");
    expect(chart?.props?.points).toEqual({
      $path: "/revenue",
      $reshape: [{ op: "asPoints", args: ["month", "revenue"] }],
    });
    expect(result.complete).toBe(true);
  });
});

describe("compileWireV2 §8 limits", () => {
  it("stops creating nodes at TREE_MAX_NODES with a single node-limit issue", () => {
    const wire = "<App>" + "<Card/>".repeat(TREE_MAX_NODES + 100) + "</App>";
    const result = compile(wire);
    expect(result.tree.nodes).toHaveLength(TREE_MAX_NODES);
    expect(codes(result)).toEqual(["node-limit"]);
    expect(result.complete).toBe(true);
    // Children reference only nodes that exist in the emitted tree.
    const ids = new Set(result.tree.nodes.map((node) => node.id));
    for (const node of result.tree.nodes) {
      for (const child of node.children ?? []) expect(ids.has(child)).toBe(true);
    }
  });

  it("keeps parsing document structure beyond the node cap (close tags still balance)", () => {
    const depth = TREE_MAX_NODES + 50;
    const wire = "<App>" + "<Stack>".repeat(depth) + "</Stack>".repeat(depth) + "<Badge/></App>";
    const result = compile(wire);
    expect(result.tree.nodes).toHaveLength(TREE_MAX_NODES);
    expect(codes(result)).toEqual(["node-limit"]);
    expect(result.complete).toBe(true);
  });

  it("hoists only the first TREE_MAX_QUERIES queries with a single query-limit issue", () => {
    const declarations = Array.from(
      { length: TREE_MAX_QUERIES + 4 },
      (_, i) => `<Query id="q${i}" tool="t"/>`,
    ).join("");
    const result = compile(`<App>${declarations}</App>`);
    expect(result.tree.queries).toHaveLength(TREE_MAX_QUERIES);
    expect(result.tree.queries?.map((query) => query.name)).toEqual(
      Array.from({ length: TREE_MAX_QUERIES }, (_, i) => `q${i}`),
    );
    expect(codes(result)).toEqual(["query-limit"]);
  });

  it("pins dangling $path: a binding to an over-cap (dropped) query stays a valid $path binding", () => {
    // Same decision as dropped-duplicate names: the pre-scan name set may
    // contain over-cap names, so the binding compiles to { $path } and simply
    // renders as absent data. Wave-3 shape checking surfaces it.
    const declarations = Array.from(
      { length: TREE_MAX_QUERIES + 2 },
      (_, i) => `<Query id="q${i}" tool="t"/>`,
    ).join("");
    const result = compile(`<App>${declarations}<Card x={q${TREE_MAX_QUERIES + 1}}/></App>`);
    expect(result.tree.queries).toHaveLength(TREE_MAX_QUERIES);
    expect(result.tree.nodes[1]?.props).toStrictEqual({ x: { $path: `/q${TREE_MAX_QUERIES + 1}` } });
    expect(codes(result)).toEqual(["query-limit"]);
  });

  it("keeps only the first TREE_MAX_GENERATED_COMPONENTS islands with a single component-limit issue", () => {
    const islands = Array.from(
      { length: TREE_MAX_GENERATED_COMPONENTS + 3 },
      (_, i) => `<Island name="I${i}">src${i}</Island>`,
    ).join("");
    const result = compile(`<App>${islands}</App>`);
    expect(Object.keys(result.components)).toHaveLength(TREE_MAX_GENERATED_COMPONENTS);
    expect(result.components.I0).toBe("src0");
    expect(result.components[`I${TREE_MAX_GENERATED_COMPONENTS - 1}`]).toBeDefined();
    expect(result.components[`I${TREE_MAX_GENERATED_COMPONENTS}`]).toBeUndefined();
    expect(codes(result)).toEqual(["component-limit"]);
    expect(componentMapError(result.components)).toBeNull();
  });

  it("drops an island whose source exceeds TREE_MAX_COMPONENT_SOURCE_BYTES", () => {
    const big = "x".repeat(TREE_MAX_COMPONENT_SOURCE_BYTES + 1);
    const result = compile(`<App><Island name="Big">${big}</Island><Island name="Ok">small</Island></App>`);
    expect(result.components).toStrictEqual({ Ok: "small" });
    expect(codes(result)).toEqual(["component-size-limit"]);
    expect(componentMapError(result.components)).toBeNull();
  });

  it("measures island sources in UTF-8 bytes, not UTF-16 units", () => {
    // "€" is one UTF-16 code unit but three UTF-8 bytes, so this source is
    // under the cap in code units and over it in bytes.
    const big = "€".repeat(Math.ceil((TREE_MAX_COMPONENT_SOURCE_BYTES + 1) / 3));
    const result = compile(`<App><Island name="Wide">${big}</Island></App>`);
    expect(result.components).toStrictEqual({});
    expect(codes(result)).toEqual(["component-size-limit"]);
  });

  it("drops islands once the running total exceeds TREE_MAX_TOTAL_COMPONENT_BYTES", () => {
    const chunk = "y".repeat(60_000);
    const islands = Array.from({ length: 5 }, (_, i) => `<Island name="T${i}">${chunk}</Island>`).join("");
    const result = compile(`<App>${islands}</App>`);
    // 4 × 60000 = 240000 ≤ cap; the fifth would push the total to 300000.
    expect(Object.keys(result.components)).toEqual(["T0", "T1", "T2", "T3"]);
    expect(codes(result)).toEqual(["component-size-limit"]);
    const total = Object.values(result.components).reduce((sum, source) => sum + source.length, 0);
    expect(total).toBeLessThanOrEqual(TREE_MAX_TOTAL_COMPONENT_BYTES);
    expect(componentMapError(result.components)).toBeNull();
  });

  it("drops an ill-formed UTF-16 island source with malformed-island", () => {
    const result = compile('<App><Island name="Bad">export \uD800 default</Island></App>');
    expect(result.components).toStrictEqual({});
    expect(codes(result)).toEqual(["malformed-island"]);
  });

  it("caps the issue list at 256 plus one final issues-truncated marker", () => {
    const wire = "<App>" + "</Nope>".repeat(300) + "</App>";
    const result = compile(wire);
    expect(result.issues).toHaveLength(257);
    expect(result.issues.slice(0, 256).every((entry) => entry.code === "stray-close-tag")).toBe(true);
    expect(result.issues[256]?.code).toBe("issues-truncated");
    expect(result.complete).toBe(true);
  });
});

describe("compileWireV2 dangling-generated reconciliation", () => {
  /** A node pointing at a DROPPED island must not stay source:"generated" —
   *  the document validator requires a components entry for every generated
   *  node, so a dangling one turns a one-island problem into a whole-app
   *  save/render failure (Devin, PR #369). Dropped-island nodes degrade to
   *  sourceless (one contained unknown-component notice), like over-cap
   *  queries degrade to absent data. */
  const documentValidation = (result: WireCompileResult) => validateAppDocument({
    format: VENDO_APP_FORMAT,
    id: "app_wire_reconcile",
    name: "Reconcile",
    ui: "tree",
    tree: result.tree as unknown as Record<string, unknown>,
    ...(Object.keys(result.components).length === 0 ? {} : { components: result.components }),
  } as unknown as Parameters<typeof validateAppDocument>[0]);

  it("clears source on a node whose island was dropped for size", () => {
    const big = "x".repeat(TREE_MAX_COMPONENT_SOURCE_BYTES + 1);
    const result = compile(`<App><Huge/><Island name="Huge">${big}</Island></App>`);
    expect(result.components).toStrictEqual({});
    expect(result.tree.nodes.find(({ id }) => id === "huge-1")?.source).toBeUndefined();
    expect(documentValidation(result).ok).toBe(true);
  });

  it("clears source only on nodes whose islands fell past the count cap", () => {
    const islands = Array.from(
      { length: TREE_MAX_GENERATED_COMPONENTS + 1 },
      (_, i) => `<Island name="I${i}">src${i}</Island>`,
    ).join("");
    const over = TREE_MAX_GENERATED_COMPONENTS;
    const result = compile(`<App><I0/><I${over}/>${islands}</App>`);
    expect(result.tree.nodes.find(({ id }) => id === "i0-1")?.source).toBe("generated");
    expect(result.tree.nodes.find(({ id }) => id === `i${over}-1`)?.source).toBeUndefined();
    expect(documentValidation(result).ok).toBe(true);
  });

  it("clears source on a node whose island was dropped as malformed UTF-16", () => {
    const result = compile('<App><Bad/><Island name="Bad">export \uD800 default</Island></App>');
    expect(result.components).toStrictEqual({});
    expect(result.tree.nodes.find(({ id }) => id === "bad-1")?.source).toBeUndefined();
    expect(documentValidation(result).ok).toBe(true);
  });

  it("clears source on a truncated prefix whose island never arrived, then restores it at full parse", () => {
    const wire = '<App><Note/><Island name="Note">export default function Note() {}</Island></App>';
    const prefix = compileWireV2(wire.slice(0, wire.indexOf("<Island") + 10), undefined);
    expect(prefix.tree.nodes.find(({ id }) => id === "note-1")?.source).toBeUndefined();
    expect(documentValidation(prefix).ok).toBe(true);
    const full = compile(wire);
    expect(full.tree.nodes.find(({ id }) => id === "note-1")?.source).toBe("generated");
    expect(full.components.Note).toBe("export default function Note() {}");
  });
});

/** v2 spec §3 — the compile-time shape check: a binding to fields absent
 *  from the tool's response shape is a compile error routed to per-binding
 *  repair; unknown shapes stay defensive (Json). */
describe("compileWireV2 shape check (v2 spec §3)", () => {
  const revenueShape = {
    kind: "object" as const,
    fields: {
      rows: {
        kind: "array" as const,
        items: {
          kind: "object" as const,
          fields: { month: { kind: "string" as const }, revenue: { kind: "number" as const } },
        },
      },
      total: { kind: "number" as const },
    },
  };
  const shapes: WireCompileOptions = { toolShapes: { "metrics.revenue": revenueShape } };
  const chartWire = (points: string): string => `
<App name="Cash">
  <Query id="revenue" tool="metrics.revenue"/>
  <LineChart points={${points}}/>
</App>`;

  it("a valid binding with a valid reshape produces no errors", () => {
    const result = compile(chartWire("revenue.rows | asPoints(month, revenue)"), shapes);
    expect(result.issues).toEqual([]);
    expect(result.bindingErrors).toEqual([]);
  });

  it("the chart-bug class fails at compile: absent field ⇒ shape-mismatch + structured repair anchor", () => {
    const result = compile(chartWire("revenue.series"), shapes);
    expect(codes(result)).toEqual(["shape-mismatch"]);
    expect(result.bindingErrors).toEqual([{
      nodeId: "linechart-1",
      prop: "points",
      query: "revenue",
      tool: "metrics.revenue",
      path: "/revenue/series",
      message: expect.stringContaining("series"),
      missing: ["series"],
      available: ["rows", "total"],
    }]);
    // Shape errors are repairable, not structural: the parse itself completed.
    expect(result.complete).toBe(true);
  });

  it("a reshape referencing absent fields fails with missing/available for repair", () => {
    const result = compile(chartWire("revenue.rows | asPoints(period, revenue)"), shapes);
    expect(codes(result)).toEqual(["shape-mismatch"]);
    const error = result.bindingErrors[0];
    expect(error?.missing).toEqual(["period"]);
    expect(error?.available).toEqual(["month", "revenue"]);
    expect(error?.path).toBe("/revenue/rows");
  });

  it("a reshape op incompatible with the known shape fails (aggregate over a string field)", () => {
    const result = compile(chartWire("revenue.rows | sum(month)"), shapes);
    expect(codes(result)).toEqual(["shape-mismatch"]);
    expect(result.bindingErrors[0]?.message).toContain("month");
  });

  it("bindings nested inside arrays and objects are checked too", () => {
    const result = compile(chartWire("{ deep: [revenue.missing] }"), shapes);
    expect(codes(result)).toEqual(["shape-mismatch"]);
    expect(result.bindingErrors[0]?.prop).toBe("points");
  });

  it("unknown tools, json regions, and state bindings stay defensive: no errors", () => {
    const unknownTool = compile(`
<App>
  <Query id="p" tool="payments.list"/>
  <DataTable rows={p.items}/>
</App>`, shapes);
    expect(unknownTool.bindingErrors).toEqual([]);

    const jsonRegion = compile(chartWire("revenue.rows | pick(anything)"), {
      toolShapes: { "metrics.revenue": { kind: "json" } },
    });
    expect(jsonRegion.bindingErrors).toEqual([]);

    const stateBinding = compile("<App><Input value={state.draft}/></App>", shapes);
    expect(stateBinding.bindingErrors).toEqual([]);
  });

  it("without toolShapes the check is off: wave-2-compatible result with empty bindingErrors", () => {
    const result = compile(chartWire("revenue.series"));
    expect(result.issues).toEqual([]);
    expect(result.bindingErrors).toEqual([]);
  });

  it("a binding pointing past a scalar in a known shape is a mismatch", () => {
    const result = compile(chartWire("revenue.total.deeper"), shapes);
    expect(codes(result)).toEqual(["shape-mismatch"]);
  });
});

describe("compileWireV2 prewired option projection (v2 spec §3)", () => {
  const accountsShape = {
    kind: "object" as const,
    fields: {
      data: {
        kind: "array" as const,
        items: {
          kind: "object" as const,
          fields: { id: { kind: "string" as const }, name: { kind: "string" as const } },
        },
      },
    },
  };
  const shapes: WireCompileOptions = { toolShapes: { host_listAccounts: accountsShape } };
  const selectWire = (options: string): string => `
<App name="Transfer">
  <Query id="accts" tool="host_listAccounts"/>
  <Select options={${options}}/>
</App>`;

  it("an object array bound straight to Select options fails: needs asOptions projection", () => {
    const result = compile(selectWire("accts.data"), shapes);
    expect(codes(result)).toEqual(["shape-mismatch"]);
    const error = result.bindingErrors[0];
    expect(error?.nodeId).toBe("select-1");
    expect(error?.prop).toBe("options");
    expect(error?.message).toContain("asOptions");
    expect(error?.available).toEqual(["id", "name"]);
  });

  it("the same array projected with asOptions passes", () => {
    const result = compile(selectWire("accts.data | asOptions(id, name)"), shapes);
    expect(result.issues).toEqual([]);
    expect(result.bindingErrors).toEqual([]);
  });

  it("Tabs tabs bound to a raw object array is flagged the same way", () => {
    const result = compile(`
<App name="T">
  <Query id="accts" tool="host_listAccounts"/>
  <Tabs tabs={accts.data}/>
</App>`, shapes);
    expect(codes(result)).toEqual(["shape-mismatch"]);
    expect(result.bindingErrors[0]?.message).toContain("asOptions");
  });

  it("a literal options array with inline bindings is not flagged (already value/label shaped)", () => {
    const result = compile(`
<App name="T">
  <Query id="accts" tool="host_listAccounts"/>
  <Select options={[{ value: "a", label: "A" }]}/>
</App>`, shapes);
    expect(result.bindingErrors).toEqual([]);
  });

  it("Tabs need a label too: an object array with value but no label is flagged", () => {
    const valueOnly = {
      kind: "object" as const,
      fields: { data: { kind: "array" as const, items: { kind: "object" as const, fields: { value: { kind: "string" as const } } } } },
    };
    const result = compile(`
<App name="T">
  <Query id="q" tool="host_valueOnly"/>
  <Tabs tabs={q.data}/>
</App>`, { toolShapes: { host_valueOnly: valueOnly } });
    expect(codes(result)).toEqual(["shape-mismatch"]);
    expect(result.bindingErrors[0]?.message).toContain("label");
    // A Select tolerates the missing label (label is optional there).
    const select = compile(`
<App name="S">
  <Query id="q" tool="host_valueOnly"/>
  <Select options={q.data}/>
</App>`, { toolShapes: { host_valueOnly: valueOnly } });
    expect(select.bindingErrors).toEqual([]);
  });

  it("a json-region option binding stays defensive", () => {
    const result = compile(selectWire("accts.data"), {
      toolShapes: { host_listAccounts: { kind: "json" } },
    });
    expect(result.bindingErrors).toEqual([]);
  });
});

/** vendo-v2-cells — the raw-braces class: object shapes bound into display
 *  slots (Table cells, Text/Stat/Badge) render raw JSON; the shape check
 *  flags them and routes to template/scalar-field repair, mirroring the
 *  asOptions projection check. */
describe("compileWireV2 display-slot object check (raw-braces class)", () => {
  const deadlinesShape = {
    kind: "object" as const,
    fields: {
      data: {
        kind: "array" as const,
        items: {
          kind: "object" as const,
          fields: {
            client: { kind: "string" as const },
            dueDate: { kind: "string" as const },
            progress: {
              kind: "object" as const,
              fields: { received: { kind: "number" as const }, total: { kind: "number" as const } },
            },
            assignedTo: {
              kind: "object" as const,
              fields: { id: { kind: "string" as const }, name: { kind: "string" as const } },
            },
          },
        },
      },
      nearest: {
        kind: "object" as const,
        fields: { name: { kind: "string" as const }, dueDate: { kind: "string" as const } },
      },
    },
  };
  const shapes: WireCompileOptions = { toolShapes: { host_listDeadlines: deadlinesShape } };
  const tableWire = (attrs: string): string => `
<App name="Deadlines">
  <Query id="dl" tool="host_listDeadlines"/>
  <Table ${attrs}/>
</App>`;

  it("Table rows carrying object-valued columns fail: every displayed cell must be a scalar", () => {
    const result = compile(tableWire("rows={dl.data}"), shapes);
    expect(codes(result)).toEqual(["shape-mismatch"]);
    const error = result.bindingErrors[0];
    expect(error?.nodeId).toBe("table-1");
    expect(error?.prop).toBe("rows");
    expect(error?.message).toContain("progress");
    expect(error?.message).toContain("assignedTo");
    expect(error?.message).toContain("template");
    expect(error?.available).toEqual(["client", "dueDate", "progress", "assignedTo"]);
  });

  it("a literal columns list restricted to scalar keys passes; one naming an object field fails", () => {
    const scalarColumns = compile(tableWire('columns={["client", "dueDate"]} rows={dl.data}'), shapes);
    expect(scalarColumns.bindingErrors).toEqual([]);
    const objectColumn = compile(tableWire('columns={["client", {key: "progress"}]} rows={dl.data}'), shapes);
    expect(codes(objectColumn)).toEqual(["shape-mismatch"]);
    expect(objectColumn.bindingErrors[0]?.message).toContain("progress");
    expect(objectColumn.bindingErrors[0]?.message).not.toContain("assignedTo");
  });

  it("a BOUND (non-literal) columns value skips the cells check — the displayed set resolves at runtime", () => {
    const result = compile(tableWire("columns={dl.data} rows={dl.data}"), shapes);
    expect(result.bindingErrors).toEqual([]);
  });

  it("template projections clear the error", () => {
    const result = compile(tableWire(
      'rows={dl.data | template(progress, "{progress.received} of {progress.total}") | template(assignedTo, "{assignedTo.name}")}',
    ), shapes);
    expect(result.issues).toEqual([]);
    expect(result.bindingErrors).toEqual([]);
  });

  it("an object bound into Text text / Stat value / Badge label is flagged with template repair", () => {
    for (const element of ["Text text={dl.nearest}", "Stat label=\"Next\" value={dl.nearest}", "Badge label={dl.nearest}"]) {
      const result = compile(`
<App name="D">
  <Query id="dl" tool="host_listDeadlines"/>
  <${element}/>
</App>`, shapes);
      expect(codes(result)).toEqual(["shape-mismatch"]);
      expect(result.bindingErrors[0]?.message).toContain("template");
    }
  });

  it("scalar display bindings and projected scalars stay clean", () => {
    const result = compile(`
<App name="D">
  <Query id="dl" tool="host_listDeadlines"/>
  <Stat label="Next" value={dl.nearest.name}/>
  <Text text={dl.nearest | template("{name} — {dueDate}")}/>
  <Badge label={dl.data | count()}/>
</App>`, shapes);
    expect(result.issues).toEqual([]);
    expect(result.bindingErrors).toEqual([]);
  });

  it("json regions and unknown tools stay defensive for display slots", () => {
    const result = compile(tableWire("rows={dl.data}"), { toolShapes: { host_listDeadlines: { kind: "json" } } });
    expect(result.bindingErrors).toEqual([]);
  });
});

describe("compileWireV2 shape check pointer misses", () => {
  it("a non-index segment into an array and a pointer past a scalar report shaped messages", () => {
    const shapes: WireCompileOptions = {
      toolShapes: {
        t: {
          kind: "object",
          fields: {
            rows: { kind: "array", items: { kind: "object", fields: { n: { kind: "number" } } } },
            total: { kind: "number" },
          },
        },
      },
    };
    const wire = (binding: string): string => `<App><Query id="q" tool="t"/><Card v={${binding}}/></App>`;
    const nonIndex = compileWireV2(wire("q.rows.month"), shapes);
    expect(nonIndex.bindingErrors[0]?.message).toContain("indexes into an array");
    const pastScalar = compileWireV2(wire("q.total.deep"), shapes);
    expect(pastScalar.bindingErrors[0]?.message).toContain("goes past");
  });
});

describe("compileWireV2 comments", () => {
  it("skips HTML comments between elements and inside text", () => {
    const result = compile('<App name="C"><!-- Header --><Text text="hi"/><!-- KPI Row --><Card/></App>');
    expect(result.tree.nodes.map((node) => node.component)).toEqual(["Stack", "Text", "Card"]);
    expect(result.issues).toEqual([]);
    expect(result.complete).toBe(true);
  });

  it("treats an unterminated comment as truncation, not content", () => {
    const result = compileWireV2('<App name="C"><Text text="hi"/><!-- dangling', undefined);
    expect(result.tree.nodes.map((node) => node.component)).toEqual(["Stack", "Text"]);
    expect(result.complete).toBe(false);
  });
});

describe("compileWireV2 comments before declarations", () => {
  it("still pre-scans queries and islands declared after a comment (Devin, PR #381)", () => {
    const wire = [
      '<App name="C"><!-- data -->',
      '<Query id="metric" tool="host_metric"/>',
      "<!-- widgets --><Note/>",
      '<Card value={metric.total}/>',
      '<Island name="Note">export default function Note() { return <p>n</p>; }</Island></App>',
    ].join("");
    const result = compile(wire);
    expect(result.tree.queries).toEqual([{ name: "metric", tool: "host_metric" }]);
    expect(result.tree.nodes.find(({ id }) => id === "note-1")?.source).toBe("generated");
    expect(result.tree.nodes.find(({ id }) => id === "card-1")?.props).toEqual({ value: { $path: "/metric/total" } });
    expect(result.issues).toEqual([]);
    expect(result.complete).toBe(true);
  });
});
