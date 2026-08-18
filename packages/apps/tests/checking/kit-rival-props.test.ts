/**
 * TWO props for one job, and children where a component takes none — the two
 * silences a schema cannot reach.
 *
 * Every prop in both shapes below is individually valid, so `validateProps`
 * passes and the renderer paints: a `<Timeline>` handed a `cell` AND a
 * `titleField` shows the cell and drops the title, and a `<Menu>` handed nested
 * children used to open onto entries with no handler behind them. Both are the
 * "valid component, nothing happens" class, arriving through a pair rather than
 * through one bad value — so both are DECLARED in the specs
 * (`KitComponentSpec.exclusive`, `KitComponentSpec.childrenFix`) and refused by
 * `kitNestingIssues`, which is the wire floor's `kit-nesting` check and the
 * screen gauntlet's `nesting` stage at once.
 */
import { describe, expect, it } from "vitest";
import { VENDO_TREE_FORMAT } from "@vendoai/core";
import { KIT_SPECS, kitSpec, type Tree } from "../../src/contract/index.js";
import { kitNestingIssues } from "../../src/server/checking/facts.js";

type Node = Tree["nodes"][number];

/** An element as the screen VM stamps one into a prop (vm-program.ts). */
const element = (component: string, over: Record<string, unknown> = {}): Record<string, unknown> =>
  ({ $element: true, component, props: {}, children: [], ...over });

const messages = (over: Partial<Node> & { component: string }): string[] =>
  kitNestingIssues({
    formatVersion: VENDO_TREE_FORMAT,
    root: "n1",
    nodes: [{ id: "n1", source: "prewired", ...over } as Node],
  }).map(({ where, message }) => `${where} ${message}`);

describe("two props for one job", () => {
  it("refuses a Timeline given both a cell and a titleField, and names which to keep", () => {
    const [message] = messages({
      component: "Timeline",
      props: { entries: [], titleField: "description", cell: element("Text") } as Node["props"],
    });

    expect(message).toContain('node "n1" writes "cell" and "titleField" together on <Timeline>');
    expect(message).toContain("paints only one of them");
    // The repair, not just the collision: a model told only that the two clash
    // has no way to know the cell is the one that wins.
    expect(message).toContain("write the title INSIDE it");
  });

  it("says nothing about either prop on its own", () => {
    expect(messages({ component: "Timeline", props: { entries: [], titleField: "description" } as Node["props"] })).toEqual([]);
    expect(messages({ component: "Timeline", props: { entries: [], cell: element("Text") } as Node["props"] })).toEqual([]);
  });

  /** Swept from the declaration, so the next exclusive pair inherits the rule
   *  instead of having to remember it — and so a pair naming a prop the
   *  component has not got cannot ship as a refusal nothing can trigger. */
  it("refuses every declared pair, and only over props the component really has", () => {
    const declared = KIT_SPECS.filter((spec) => spec.exclusive !== undefined);
    expect(declared.length).toBeGreaterThan(0);
    for (const spec of declared) {
      for (const { props: rivals, fix } of spec.exclusive!) {
        expect(rivals.length, `${spec.name} pair`).toBeGreaterThan(1);
        expect(fix.length, `${spec.name} fix`).toBeGreaterThan(0);
        for (const name of rivals) {
          expect(spec.props[name], `${spec.name}.${name}`).toBeDefined();
        }
        const props = Object.fromEntries(rivals.map((name) => [name, "x"]));
        expect(messages({ component: spec.name, props: props as Node["props"] })[0], spec.name)
          .toContain(`together on <${spec.name}>`);
      }
    }
  });
});

describe("a Menu written with children", () => {
  it("names the bricks the rule is written against", () => {
    // The refusal below is the CHILDLESS one, so a Menu that starts rendering
    // children again must take this test with it rather than leave a message
    // describing a component that has moved on.
    expect(kitSpec("Menu")?.takesChildren).toBeUndefined();
    expect(kitSpec("Menu")?.childrenFix).toBeDefined();
  });

  it("refuses the children and names items + onSelect as the fix", () => {
    const [message] = messages({
      component: "Menu",
      props: { label: "Actions" } as Node["props"],
      children: ["b1"],
    });

    expect(message).toContain('node "n1" nests 1 node inside <Menu>');
    expect(message).toContain("that content never reaches the screen");
    // NOT the generic "give it what it showed through its own props" tail: the
    // entries are data plus one handler, and a menu that opened onto entries
    // with nothing behind them is what made that sentence useless.
    expect(message).toContain("A menu entry is data, not an element");
    expect(message).toContain("onSelect");
    expect(message).not.toContain("in a <Stack>");
  });

  it("leaves the data form alone", () => {
    expect(messages({
      component: "Menu",
      props: { label: "Actions", items: [{ label: "Void", value: "void" }], onSelect: "host_action" } as Node["props"],
    })).toEqual([]);
  });

  /** The generic tail is still what every other leaf gets — a component with no
   *  `childrenFix` must not silently lose its refusal to the new branch. */
  it("keeps the generic sentence for a leaf that declares no fix of its own", () => {
    const [message] = messages({ component: "LineChart", children: ["t1"] });
    expect(message).toContain("nests 1 node inside <LineChart>");
    expect(message).toContain("in a <Stack>");
  });
});
