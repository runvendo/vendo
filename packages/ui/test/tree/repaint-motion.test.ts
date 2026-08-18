import { describe, expect, it } from "vitest";
import type { TreeNode } from "@vendoai/core";
import { SCREEN_TEXT_NODE } from "@vendoai/apps/contract";
import { diffPaints, type NodeMap } from "../../src/tree/repaint-motion.js";

const paint = (...nodes: TreeNode[]): NodeMap => new Map(nodes.map((node) => [node.id, node]));

const text = (id: string, value: string): TreeNode =>
  ({ id, component: SCREEN_TEXT_NODE, props: { text: value }, children: [] });

/** A keyed list of `<Row><text/></Row>` under `root.list`. */
const rows = (...labels: string[]): TreeNode[] => [
  { id: "root", component: "Stack", children: ["root.list"] },
  { id: "root.list", component: "Stack", children: labels.map((label) => `root.list.Row:${label}`) },
  ...labels.flatMap((label): TreeNode[] => [
    { id: `root.list.Row:${label}`, component: "Row", children: [`root.list.Row:${label}.0`] },
    text(`root.list.Row:${label}.0`, label),
  ]),
];

/** The same list written WITHOUT keys — ids are positions, so a mid-list
 *  removal renumbers everything below it. */
const unkeyedRows = (...labels: string[]): TreeNode[] => [
  { id: "root", component: "Stack", children: ["root.list"] },
  { id: "root.list", component: "Stack", children: labels.map((_, index) => `root.list.${index}`) },
  ...labels.flatMap((label, index): TreeNode[] => [
    { id: `root.list.${index}`, component: "Row", children: [`root.list.${index}.0`] },
    text(`root.list.${index}.0`, label),
  ]),
];

describe("diffPaints", () => {
  it("marks nothing when the repaint says the same thing", () => {
    expect(diffPaints(paint(...rows("a", "b")), paint(...rows("a", "b"))).marks.size).toBe(0);
  });

  it("marks an arriving keyed row, and only the row — not its cells", () => {
    const diff = diffPaints(paint(...rows("a", "b")), paint(...rows("a", "b", "c")));
    expect([...diff.marks]).toEqual([["root.list.Row:c", { kind: "enter" }]]);
  });

  it("marks a departing keyed row and remembers the slot it held", () => {
    const diff = diffPaints(paint(...rows("a", "b", "c")), paint(...rows("a", "c")));
    expect(diff.marks.get("root.list.Row:b")).toEqual({ kind: "exit" });
    expect(diff.exits).toEqual([{ parent: "root.list", index: 1, id: "root.list.Row:b" }]);
  });

  it("pulses the leaf that owns a changed value, never its container", () => {
    const restated = rows("a", "b").map((node) =>
      node.id === "root.list.Row:b.0" ? text(node.id, "b, restated") : node);
    const diff = diffPaints(paint(...rows("a", "b")), paint(...restated));
    // The row directly holds the run of text that changed, so the row is the
    // leaf that pulses — its list and the screen root stay still.
    expect(diff.marks.get("root.list.Row:b")).toEqual({ kind: "pulse", tick: null });
    expect(diff.marks.has("root.list")).toBe(false);
    expect(diff.marks.has("root")).toBe(false);
  });

  /** A Stat holding a NUMBER, which is the one leaf left with an in-between to
   *  roll through. */
  const stat = (value: number | string): TreeNode[] => [
    { id: "root", component: "Stack", children: ["root.Stat:total"] },
    { id: "root.Stat:total", component: "Stat", props: { label: "Total", value } },
  ];

  it("gives a numeric Stat a tick that renders its own in-between figures", () => {
    const mark = diffPaints(paint(...stat(100)), paint(...stat(250))).marks.get("root.Stat:total");
    expect(mark?.kind).toBe("pulse");
    const tick = mark?.kind === "pulse" ? mark.tick : null;
    expect(tick).toMatchObject({ from: 100, to: 250 });
    expect(tick?.render(100)).toBe("100");
    expect(tick?.render(175)).toBe("175");
    expect(tick?.render(250)).toBe("250");
  });

  /** THE ACCEPTED TRADE of the value tier's death: a screen formats its own
   *  figures, so the common Stat now holds already-formatted TEXT — and text has
   *  no in-between. It cuts to its new value under the pulse rather than rolling. */
  it("pulses a string-valued Stat without a tick — it cuts instead of rolling", () => {
    const mark = diffPaints(paint(...stat("$100.00")), paint(...stat("$250.00"))).marks.get("root.Stat:total");
    expect(mark).toEqual({ kind: "pulse", tick: null });
  });

  it("pulses a non-numeric leaf without a tick", () => {
    const badge = (value: string): TreeNode[] => [
      { id: "root", component: "Stack", children: ["root.EnumBadge:status"] },
      { id: "root.EnumBadge:status", component: "EnumBadge", props: { value } },
    ];
    expect(diffPaints(paint(...badge("pending")), paint(...badge("paid"))).marks.get("root.EnumBadge:status"))
      .toEqual({ kind: "pulse", tick: null });
  });

  it("trusts an unkeyed list when the arrival is at the end — nothing below shifted", () => {
    const diff = diffPaints(paint(...unkeyedRows("a", "b")), paint(...unkeyedRows("a", "b", "c")));
    expect([...diff.marks]).toEqual([["root.list.2", { kind: "enter" }]]);
  });

  it("animates NOTHING when an unkeyed list loses a row from the middle", () => {
    // Positional ids say "the last row left" while rows 1..n shifted up. The
    // wrong row would collapse, so the list swaps instantly instead.
    const diff = diffPaints(paint(...unkeyedRows("a", "b", "c")), paint(...unkeyedRows("a", "c")));
    expect(diff.marks.size).toBe(0);
    expect(diff.exits).toEqual([]);
  });

  it("keeps a keyed list animating next to a keyless header that also moved", () => {
    // The screen's own shape: a positional summary row above a keyed list. The
    // header's changing total must not cost the list its arrival.
    const withHeader = (total: string, ...labels: string[]): TreeNode[] => {
      const list = rows(...labels);
      return [
        { id: "root", component: "Stack", children: ["root.0", "root.list"] },
        { id: "root.0", component: "Text", props: { text: total } },
        ...list.filter((node) => node.id !== "root"),
      ];
    };
    const diff = diffPaints(paint(...withHeader("$2", "a", "b")), paint(...withHeader("$3", "a", "b", "c")));
    expect(diff.marks.get("root.list.Row:c")).toEqual({ kind: "enter" });
    expect(diff.marks.get("root.0")).toEqual({ kind: "pulse", tick: null });
  });

  it("does not pulse a control whose handler id merely got renumbered", () => {
    // Handler ids are minted against the node's POSITION, so every row below a
    // deleted one gets a new one. That is machinery, not a value that moved.
    const button = (handler: string): TreeNode[] => [
      { id: "root", component: "Stack", children: ["root.Button:cancel"] },
      { id: "root.Button:cancel", component: "Button", props: { label: "Cancel", onClick: { $handler: handler } } },
    ];
    expect(diffPaints(paint(...button("h3")), paint(...button("h7"))).marks.size).toBe(0);
  });

  it("stays quiet when a repaint replaces the view wholesale", () => {
    const before = paint(...rows(...Array.from({ length: 20 }, (_, i) => `a${i}`)));
    const after = paint(...rows(...Array.from({ length: 20 }, (_, i) => `b${i}`)));
    expect(diffPaints(before, after).marks.size).toBe(0);
  });

  it("ignores a root that is not shared between the paints", () => {
    const before = paint({ id: "root", component: "Stack", children: [] });
    const after = paint({ id: "other", component: "Stack", children: [] });
    expect(diffPaints(before, after).marks.size).toBe(0);
  });
});
