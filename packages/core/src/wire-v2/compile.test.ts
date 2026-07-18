import { describe, expect, it } from "vitest";
import { VENDO_TREE_FORMAT_V2 } from "../formats.js";
import { validateTreeV2 } from "../tree-v2.js";
import { compileWireV2, type WireCompileResult } from "./compile.js";

/** D6 — every compiled tree must pass validateTreeV2, whatever the input.
 *  (Shared gate: all tests below go through this helper unless the input
 *  deliberately exceeds the §8 caps, which Task 5 enforces at compile.) */
const compile = (wire: string): WireCompileResult => {
  const result = compileWireV2(wire);
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
        { id: "stack-1", component: "Stack", props: { gap: 16 }, children: ["pageheader-1", "grid-1"] },
        {
          id: "pageheader-1",
          component: "PageHeader",
          props: { title: "Cash Overview", subtitle: "Live cash position", compact: true },
        },
        { id: "grid-1", component: "Grid", props: { cols: 3 }, children: ["linechart-1", "linechart-2", "datatable-1"] },
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
    expect(selfClosing.tree.nodes[1]).toStrictEqual({ id: "card-1", component: "Card" });
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
    expect(result.tree.nodes[1]).toStrictEqual({ id: "card-1", component: "Card" });
    expect(codes(result)).toEqual(["malformed-attribute"]);
  });

  it("ignores wire-supplied id attributes with wire-id-ignored", () => {
    const result = compile('<App><Card id="mine" title="kept"/></App>');
    expect(result.tree.nodes[1]).toStrictEqual({
      id: "card-1",
      component: "Card",
      props: { title: "kept" },
    });
    expect(codes(result)).toEqual(["wire-id-ignored"]);
  });

  it("omits props entirely when a node has no attributes", () => {
    const result = compile("<App><Card/></App>");
    expect(result.tree.nodes[1]).toStrictEqual({ id: "card-1", component: "Card" });
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

  it("skips Query and Island entirely with unsupported-element-yet (Task 4)", () => {
    const result = compile(
      '<App><Query id="revenue" tool="metrics.revenue"/><Island name="Spark">export default x</Island><Card/></App>',
    );
    expect(result.tree.nodes.map((node) => node.id)).toEqual(["root", "card-1"]);
    expect(result.tree.queries).toBeUndefined();
    expect(result.components).toStrictEqual({});
    expect(codes(result)).toEqual(["unsupported-element-yet", "unsupported-element-yet"]);
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
      { id: "stack-1", component: "Stack", children: ["card-1"] },
      { id: "card-1", component: "Card" },
      { id: "badge-1", component: "Badge" },
    ]);
    expect(codes(result)).toEqual(["unclosed-element"]);
    expect(result.complete).toBe(true);
  });

  it("skips non-whitespace text children with text-unsupported-yet (Task 4)", () => {
    const result = compile("<App><Card>hello world</Card></App>");
    expect(result.tree.nodes[1]).toStrictEqual({ id: "card-1", component: "Card" });
    expect(codes(result)).toEqual(["text-unsupported-yet"]);
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
      { id: "stack-1", component: "Stack", children: ["card-1"] },
      { id: "card-1", component: "Card" },
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
