/**
 * The paint, flattened into addressable nodes — the half a renderer holds onto.
 *
 * Two properties carry the whole feature and both are asserted here rather than
 * described: an id is the STRUCTURAL PATH (so a keyed row keeps its id, and with
 * it its React key, across a repaint that inserts a row above it), and the flat
 * form is TOTAL (every node in, every node out, text runs included, `children`
 * unambiguously a list of ids).
 */
import { describe, expect, it } from "vitest";
import {
  flattenTree,
  SCREEN_TEXT_NODE,
  type NestedNode,
} from "../../../../src/contract/genui/component/index.js";

const node = (
  component: string,
  props: Record<string, unknown> = {},
  children: Array<NestedNode | string> = [],
  key?: string,
): NestedNode => ({ component, props, children, ...(key === undefined ? {} : { key }) });

/** A screen with two keyed rows, each carrying a button of its own. */
const rows = (...ids: string[]): NestedNode =>
  node("Stack", { gap: 12 }, [
    node("Text", { text: "Pending" }),
    ...ids.map((id) => node("Card", { title: id }, [
      node("Button", { label: "Cancel", onClick: { $handler: `h_${id}` } }),
    ], id)),
  ]);

describe("flattenTree", () => {
  it("names every node by the walk that produced it, keys where the screen wrote them", () => {
    const flat = flattenTree(rows("tr_1", "tr_2"));

    expect(flat.root).toBe("root");
    expect(Object.keys(flat.nodes).sort()).toEqual([
      "root",
      "root.0",
      "root.Card:tr_1",
      "root.Card:tr_1.0",
      "root.Card:tr_2",
      "root.Card:tr_2.0",
    ]);
    // The id reads as the path, and `children` is a list of ids — never a mix of
    // ids and inline nodes, which is what lets a renderer address one node.
    expect(flat.nodes.root?.children).toEqual(["root.0", "root.Card:tr_1", "root.Card:tr_2"]);
    expect(flat.nodes["root.Card:tr_1"]?.props).toEqual({ title: "tr_1" });
    expect(flat.nodes["root.Card:tr_1.0"]?.props.onClick).toEqual({ $handler: "h_tr_1" });
    // Every node carries its own id, so a caller holding one node still knows
    // which node it is holding.
    for (const [id, entry] of Object.entries(flat.nodes)) expect(entry.id).toBe(id);
  });

  it("is total: a text run becomes a node of its own, with its text in props", () => {
    const flat = flattenTree(node("Card", { title: "t" }, ["plain text ", "42", node("Text", { text: "x" })]));

    expect(flat.nodes.root?.children).toEqual(["root.0", "root.1", "root.2"]);
    expect(flat.nodes["root.0"]).toEqual({
      id: "root.0",
      component: SCREEN_TEXT_NODE,
      props: { text: "plain text " },
      children: [],
    });
    expect(flat.nodes["root.1"]?.props).toEqual({ text: "42" });
    expect(flat.nodes["root.2"]?.component).toBe("Text");
  });

  it("keeps a keyed row's id when a row is inserted ABOVE it — the whole point of the path", () => {
    const before = flattenTree(rows("tr_1", "tr_2"));
    const after = flattenTree(rows("tr_0", "tr_1", "tr_2"));

    // A counter-derived id would have renamed both surviving rows (and their
    // buttons) here, and the renderer would have remounted them — losing an open
    // menu, a focused input, a scroll position.
    for (const id of ["root.Card:tr_1", "root.Card:tr_1.0", "root.Card:tr_2", "root.Card:tr_2.0"]) {
      expect(after.nodes[id]).toEqual(before.nodes[id]);
    }
    expect(after.nodes["root.Card:tr_0.0"]?.props.onClick).toEqual({ $handler: "h_tr_0" });
  });

  it("renumbers KEYLESS siblings after an inserted one — the caveat a key exists to avoid", () => {
    const without = flattenTree(node("Stack", {}, [node("Text", { text: "rows" }), node("Button", { label: "add" })]));
    const withBanner = flattenTree(node("Stack", {}, [
      node("Callout", { title: "error" }),
      node("Text", { text: "rows" }),
      node("Button", { label: "add" }),
    ]));

    expect(without.nodes["root.0"]?.component).toBe("Text");
    // The banner took position 0, so every keyless sibling below it moved — the
    // documented cost of writing a conditional sibling without a key.
    expect(withBanner.nodes["root.0"]?.component).toBe("Callout");
    expect(withBanner.nodes["root.1"]?.component).toBe("Text");
  });

  it("gives two siblings that claim the SAME key a node each, at the cost of stability", () => {
    const flat = flattenTree(node("Stack", {}, [
      node("Card", { title: "first" }, [], "dupe"),
      node("Card", { title: "second" }, [], "dupe"),
      node("Card", { title: "third" }, [], "dupe"),
    ]));

    // React warns about a duplicate key; the flattener must not silently drop the
    // second node on top of the first.
    expect(flat.nodes["root.Card:dupe"]?.props.title).toBe("first");
    expect(flat.nodes["root.Card:dupe~2"]?.props.title).toBe("second");
    expect(flat.nodes["root.Card:dupe~3"]?.props.title).toBe("third");
    expect(flat.nodes.root?.children).toEqual(["root.Card:dupe", "root.Card:dupe~2", "root.Card:dupe~3"]);
  });

  it("reads two lists that reuse a key apart, because the component name rides along", () => {
    const flat = flattenTree(node("Stack", {}, [
      node("Card", { title: "invoice 1" }, [], "1"),
      node("Text", { text: "client 1" }, [], "1"),
    ]));

    expect(Object.keys(flat.nodes).sort()).toEqual(["root", "root.Card:1", "root.Text:1"]);
  });

  it("is pure and deterministic: same paint in, same ids out, input untouched", () => {
    const paint = rows("tr_1", "tr_2");
    const frozen = JSON.stringify(paint);

    expect(flattenTree(paint)).toEqual(flattenTree(paint));
    expect(JSON.stringify(paint)).toBe(frozen);
    // The props object travels by reference — the renderer reads it, nobody
    // rewrites it — so a copy would be dead weight, but it must be the SAME data.
    expect(flattenTree(paint).nodes["root.Card:tr_1"]?.props).toEqual(paint.children[1] !== undefined
      && typeof paint.children[1] !== "string" ? paint.children[1].props : undefined);
  });
});
