/**
 * The SLOTS — the places a Kit component takes an ELEMENT instead of a value.
 * One table declares them (`KitComponentSpec.slots`) and the nesting check
 * enforces it, so the two are pinned here TOGETHER: every slot the specs
 * declare is a slot the checker admits, and a key it does not declare is an
 * element the renderer would drop, refused by name.
 *
 * The `cell` slot is the one that already existed; the rest arrive with the
 * declaration, so this file measures the CHECK against the declaration rather
 * than restating a list the checker would then have to agree with.
 */
import { describe, expect, it } from "vitest";
import { VENDO_TREE_FORMAT } from "@vendoai/core";
import {
  KIT_SPECS,
  kitSlotPath,
  type KitSlotSpec,
  type Tree,
} from "../../src/contract/index.js";
import { catalogIssues, kitNestingIssues } from "../../src/server/checking/facts.js";

/** An element as the screen VM stamps one into a prop (vm-program.ts). */
const element = (component: string, over: Record<string, unknown> = {}): Record<string, unknown> =>
  ({ $element: true, component, props: {}, children: [], ...over });

/** The props that put a value at a slot's DECLARED path, built from the
 *  declaration itself: a nested slot sits in its prop's description objects, a
 *  top-level one is the prop. Placement is what these tests are about, so it is
 *  derived rather than written out per component. */
const propsAt = (name: string, slot: KitSlotSpec, value: unknown): Record<string, unknown> =>
  slot.at === undefined ? { [name]: value } : { [slot.at]: [{ [name]: value }] };

/** One Kit node's props, measured by the check the floor runs. */
const issuesFor = (component: string, props: Record<string, unknown>): string[] =>
  kitNestingIssues({
    formatVersion: VENDO_TREE_FORMAT,
    root: "n1",
    nodes: [{ id: "n1", component, source: "prewired", props: props as Tree["nodes"][0]["props"] }],
  }).map(({ where, message }) => `${where} ${message}`);

describe("the Kit's slots", () => {
  /** THE CLASS, swept from the table: a component reads its slot at exactly one
   *  place, so the floor must admit it there and refuse it everywhere else. A
   *  checker that takes an element the component never looks at is the same
   *  silent drop as a catalog that teaches a slot the Kit does not paint. */
  it("reads every slot at its declared path, and refuses the same name off it", () => {
    for (const spec of KIT_SPECS) {
      for (const [name, slot] of Object.entries(spec.slots ?? {})) {
        const at = `${spec.name}.${kitSlotPath(name, slot)}`;
        const held = element("Text");
        expect(issuesFor(spec.name, propsAt(name, slot, held)), at).toEqual([]);
        // The generic wrong place, derived from the declaration: a slot read out
        // of its prop's items is not read as a bare prop of the same name.
        if (slot.at !== undefined) {
          expect(issuesFor(spec.name, { [name]: held })[0], at).toContain(`"${name}" is not a slot`);
        }
      }
    }
  });

  it("refuses an element where no slot was declared, naming the component and the key", () => {
    // A DataTable column takes a cell; the table itself takes no `header`, and
    // an element written there reaches nothing at all.
    const [message] = issuesFor("DataTable", { header: element("Text") });

    expect(message).toContain('node "n1" prop "header" holds <Text>, but "header" is not a slot');
    // The message names WHERE the real slot is read, not just its bare name —
    // a model told "cell" would write it on a row.
    expect(message).toContain("the slots on <DataTable> are: columns[].cell");
    // …while a slot the Kit really renders admits an element.
    expect(issuesFor("Timeline", { marker: element("Icon") })).toEqual([]);
  });

  it("refuses a slot's own name at a path the component never reads", () => {
    // DataTable renders `columns[].cell` and nothing else. A `cell` field on a
    // ROW is a value it never looks at — and matching the bare key at any depth
    // admitted it as if it were the column's, so the floor passed an element
    // the table drops.
    const [message] = issuesFor("DataTable", {
      rows: [{ id: "r1", cell: element("Badge") }],
      columns: [{ key: "id" }],
    });

    expect(message).toContain('prop "rows[0].cell" holds <Badge>');
    expect(message).toContain('"rows[].cell" is not a slot');
    expect(message).toContain("the slots on <DataTable> are: columns[].cell");
    // The declared path still passes, so this narrows placement and nothing else.
    expect(issuesFor("DataTable", { rows: [], columns: [{ key: "id", cell: element("Badge") }] })).toEqual([]);
  });

  it("measures a component in a slot against its OWN contract", () => {
    // What sits in a slot is a component in its own right. Unmeasured, both of
    // these passed clean while the renderer dropped the descendant: an element in
    // a prop <Stack> has no slot for, and children under a component that
    // renders none.
    const [header] = issuesFor("Accordion", {
      items: [{ label: "Status", content: element("Stack", { props: { header: element("Text") } }) }],
    });
    expect(header).toContain('prop "items[0].content.header" holds <Text>');
    expect(header).toContain("<Stack> takes no element in its props");

    const [childless] = issuesFor("Accordion", {
      items: [{ label: "Rows", content: element("LineChart", { children: [element("Text")] }) }],
    });
    expect(childless).toContain('prop "items[0].content" nests 1 node inside <LineChart>');
    expect(childless).toContain("renders nothing nested inside it");

    // …and a legal component in the same slot still passes, contract and all.
    expect(issuesFor("Accordion", {
      items: [{ label: "Rows", content: element("Timeline", { props: { marker: element("Icon") } }) }],
    })).toEqual([]);
  });

  it("says so when the component takes no element at all", () => {
    expect(issuesFor("Badge", { label: element("Text") })[0])
      .toContain("<Badge> takes no element in its props");
  });

  /** WHAT goes in a slot is design, not bookkeeping: every one of these used to
   *  be refused by a per-slot vocabulary, and every one of them renders. Where a
   *  component belongs is the model's judgement and the judge's to grade. */
  it("takes any Kit component in any slot, the way normal React does", () => {
    expect(issuesFor("DataTable", { columns: [{ key: "status", cell: element("Button") }] })).toEqual([]);
    expect(issuesFor("DataTable", { rows: [], rowActions: [element("Badge")] })).toEqual([]);
    expect(issuesFor("Timeline", { cell: element("Button") })).toEqual([]);
    expect(issuesFor("Timeline", { marker: element("Progress") })).toEqual([]);
  });

  it("lets an Accordion section hold a whole screen, and refuses a name the Kit has not got", () => {
    // `items[].content` is element-valued and was checked by nothing until the
    // slots landed. A section is a place, so what goes in it is the Kit.
    expect(issuesFor("Accordion", {
      items: [{ label: "Overdue", content: element("DataTable") }],
    })).toEqual([]);

    // A NAME nothing implements is the one thing a slot still refuses: the
    // renderer resolves the Kit and the display bricks and paints nothing else.
    const [message] = issuesFor("Accordion", {
      items: [{ label: "Ghost", content: element("Hallucinated") }],
    });
    expect(message).toContain('prop "items[0].content" holds <Hallucinated>');
    expect(message).toContain("no Kit component or display tag has that name");
    // …and a display brick in the same slot passes, because the renderer paints one.
    expect(issuesFor("Accordion", {
      items: [{ label: "Note", content: element("blockquote") }],
    })).toEqual([]);
  });

  /**
   * THE OTHER HALF OF THE SAME LAW: a slot the catalog teaches must be a slot
   * the floor lets you WRITE.
   *
   * `kit-nesting` governs WHERE an element may be written, and passes silently on
   * a prop it does not recognise — the refusal by NAME comes from `components-exist`,
   * which reads `wirePropNames` off `spec.props` and nothing else. So a slot
   * declared only in `SLOTS` is taught by `kitPrompt`, admitted by the nesting
   * check, and then blocked by name at the floor: the model is told to write
   * something the gate rejects. `Modal.header`, `Modal.footer`, `Sheet.header`
   * and `Sheet.footer` shipped in exactly that state.
   *
   * Swept from the table rather than listed, so the next slot added inherits
   * the rule instead of having to remember it.
   */
  it("lets every declared slot be WRITTEN, not just teach that it exists", async () => {
    for (const spec of KIT_SPECS) {
      for (const [name, slot] of Object.entries(spec.slots ?? {})) {
        const at = `${spec.name}.${kitSlotPath(name, slot)}`;
        const held = element("Text");
        const issues = await catalogIssues({
          formatVersion: VENDO_TREE_FORMAT,
          root: "n1",
          nodes: [{
            id: "n1",
            component: spec.name,
            source: "prewired",
            props: propsAt(name, slot, held) as Tree["nodes"][0]["props"],
          }],
        }, undefined, []);

        expect(issues.map((issue) => issue.message).filter((message) => message.includes("unknown prop")), at)
          .toEqual([]);
      }
    }
  });
});
