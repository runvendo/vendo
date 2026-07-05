import { describe, expect, it } from "vitest";
import { isComponentNode, type ComponentNode } from "../ui";
import { VENDO_GENUI_VERSION, type GeneratedPayload, type GenNode } from "./format";
import { collectBindings, resolveGeneratedPayload } from "./resolve";

const payload = (
  root: string,
  nodes: GenNode[],
  data?: Record<string, unknown>,
): GeneratedPayload => ({ formatVersion: VENDO_GENUI_VERSION, root, nodes, data });

const asComponent = (node: ReturnType<typeof resolveGeneratedPayload>): ComponentNode => {
  if (!isComponentNode(node)) throw new Error("expected a ComponentNode");
  return node;
};

describe("resolveGeneratedPayload", () => {
  it("resolves a flat 3-node payload into a nested ComponentNode tree", () => {
    const tree = asComponent(
      resolveGeneratedPayload(
        payload("root", [
          { id: "root", component: "Stack", children: ["t1", "c1"] },
          { id: "t1", component: "Text", props: { value: "hi" } },
          { id: "c1", component: "Card", source: "host" },
        ]),
      ),
    );

    expect(tree).toMatchObject({
      id: "root",
      kind: "component",
      source: "prewired",
      name: "Stack",
      props: {},
    });
    expect(tree.children).toHaveLength(2);
    const [text, card] = tree.children!;
    expect(text).toEqual({
      id: "t1",
      kind: "component",
      source: "prewired",
      name: "Text",
      props: { value: "hi" },
    });
    expect(card).toEqual({
      id: "c1",
      kind: "component",
      source: "host",
      name: "Card",
      props: {},
    });
  });

  it("binds a $path prop to the value resolved from data", () => {
    const tree = asComponent(
      resolveGeneratedPayload(
        payload(
          "root",
          [{ id: "root", component: "Text", props: { title: { $path: "/acct/name" } } }],
          { acct: { name: "Checking" } },
        ),
      ),
    );
    expect(tree.props).toEqual({ title: "Checking" });
  });

  it("resolves a missing $path to undefined without throwing", () => {
    const tree = asComponent(
      resolveGeneratedPayload(
        payload(
          "root",
          [{ id: "root", component: "Text", props: { title: { $path: "/nope" } } }],
          { acct: { name: "Checking" } },
        ),
      ),
    );
    expect(tree.props).toEqual({ title: undefined });
  });

  it("passes a non-$path object prop (e.g. $state) through verbatim", () => {
    const stateProp = { $state: "acct" };
    const tree = asComponent(
      resolveGeneratedPayload(
        payload("root", [{ id: "root", component: "Text", props: { account: stateProp } }]),
      ),
    );
    expect((tree.props as Record<string, unknown>).account).toEqual({ $state: "acct" });
  });

  it("passes a literal prop through unchanged", () => {
    const tree = asComponent(
      resolveGeneratedPayload(
        payload("root", [
          { id: "root", component: "Text", props: { count: 7, label: "ok", on: true } },
        ]),
      ),
    );
    expect(tree.props).toEqual({ count: 7, label: "ok", on: true });
  });

  it("emits a Skeleton placeholder for a child id absent from nodes", () => {
    const tree = asComponent(
      resolveGeneratedPayload(
        payload("root", [{ id: "root", component: "Stack", children: ["ghost"] }]),
      ),
    );
    expect(tree.children).toEqual([
      { id: "ghost", kind: "component", source: "prewired", name: "Skeleton", props: {} },
    ]);
  });

  it("omits the children key for a leaf node", () => {
    const tree = asComponent(
      resolveGeneratedPayload(payload("root", [{ id: "root", component: "Text" }])),
    );
    expect("children" in tree).toBe(false);
  });

  it("resolves a cyclic payload finitely, breaking the cycle with a Skeleton", () => {
    const tree = asComponent(
      resolveGeneratedPayload(
        payload("a", [
          { id: "a", component: "Stack", children: ["b"] },
          { id: "b", component: "Stack", children: ["a"] },
        ]),
      ),
    );
    const b = asComponent(tree.children![0]);
    expect(b.id).toBe("b");
    const aAgain = asComponent(b.children![0]);
    expect(aAgain).toEqual({
      id: "a",
      kind: "component",
      source: "prewired",
      name: "Skeleton",
      props: {},
    });
  });

  it("resolves a shared (DAG) node into two independent subtrees", () => {
    const tree = asComponent(
      resolveGeneratedPayload(
        payload("root", [
          { id: "root", component: "Stack", children: ["x", "y"] },
          { id: "x", component: "Stack", children: ["shared"] },
          { id: "y", component: "Stack", children: ["shared"] },
          { id: "shared", component: "Text" },
        ]),
      ),
    );
    const x = asComponent(tree.children![0]);
    const y = asComponent(tree.children![1]);
    expect(asComponent(x.children![0]).name).toBe("Text");
    expect(asComponent(y.children![0]).name).toBe("Text");
  });

  it("emits a single Skeleton when root is not in the node map", () => {
    const tree = asComponent(
      resolveGeneratedPayload({
        formatVersion: VENDO_GENUI_VERSION,
        root: "missing",
        nodes: [{ id: "other", component: "Text" }],
      }),
    );
    expect(tree).toEqual({
      id: "missing",
      kind: "component",
      source: "prewired",
      name: "Skeleton",
      props: {},
    });
  });
});

describe("resolveGeneratedPayload — depth bound (DoS)", () => {
  it("resolves a deep linear chain without throwing (depth-capped with a Skeleton)", () => {
    // A 1000-node linear chain would overflow an unbounded recursive resolver.
    const N = 1000;
    const nodes: GenNode[] = Array.from({ length: N }, (_, i) => ({
      id: `n${i}`,
      component: "Stack",
      children: i < N - 1 ? [`n${i + 1}`] : [],
    }));
    let tree!: ReturnType<typeof resolveGeneratedPayload>;
    expect(() => {
      tree = resolveGeneratedPayload(payload("n0", nodes));
    }).not.toThrow();
    // Walk to the deepest resolved node; beyond MAX_DEPTH it is a Skeleton.
    let depth = 0;
    let cur = asComponent(tree);
    while (cur.children && cur.children.length > 0) {
      cur = cur.children[0] as ComponentNode;
      depth++;
    }
    expect(cur.name).toBe("Skeleton");
    expect(depth).toBeLessThan(N); // capped before exhausting the chain
  });

  it("bounds a diamond-DAG payload (each child id listed twice) instead of exploding (2^depth)", () => {
    // n0..n26 where each nk.children = [n(k+1), n(k+1)]. Without an op budget this
    // expands into ~2^27 independent subtrees and OOM-crashes V8, despite being
    // only 27 nodes (under the node + depth caps). The total-op budget caps it.
    const N = 27;
    const nodes: GenNode[] = Array.from({ length: N }, (_, i) => ({
      id: `n${i}`,
      component: "Stack",
      children: i < N - 1 ? [`n${i + 1}`, `n${i + 1}`] : [],
    }));
    const start = Date.now();
    let tree!: ReturnType<typeof resolveGeneratedPayload>;
    expect(() => {
      tree = resolveGeneratedPayload(payload("n0", nodes));
    }).not.toThrow();
    // It must RETURN quickly (bounded work), not hang/OOM.
    expect(Date.now() - start).toBeLessThan(1000);
    expect(isComponentNode(tree)).toBe(true);
  });
});

it("preserves source: 'generated' on resolved nodes", () => {
  const tree = resolveGeneratedPayload({
    formatVersion: "vendo-genui/v1",
    root: "r",
    nodes: [{ id: "r", component: "Gauge", source: "generated" }],
    components: { Gauge: "export default 1" },
  });
  expect(tree.kind).toBe("component");
  if (tree.kind === "component") expect(tree.source).toBe("generated");
});

describe("collectBindings", () => {
  it("returns the $paths of a node's top-level bindings in prop order", () => {
    const node: GenNode = {
      id: "n",
      component: "Text",
      props: { a: { $path: "/one" }, b: "literal", c: { $path: "/two" }, d: { $state: "x" } },
    };
    expect(collectBindings(node)).toEqual(["/one", "/two"]);
  });

  it("returns [] for a node with no bindings", () => {
    expect(collectBindings({ id: "n", component: "Text", props: { a: 1 } })).toEqual([]);
    expect(collectBindings({ id: "n", component: "Text" })).toEqual([]);
  });
});
