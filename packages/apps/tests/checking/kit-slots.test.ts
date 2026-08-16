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
  KIT_COMPONENT_NAMES,
  KIT_SLOT_CONTENT_NAMES,
  KIT_SPECS,
  type Tree,
} from "../../src/contract/index.js";
import { kitNestingIssues } from "../../src/server/checking/facts.js";

/** An element as the screen VM stamps one into a prop (vm-program.ts). */
const element = (component: string): Record<string, unknown> =>
  ({ $element: true, component, props: {}, children: [] });

/** One Kit node's props, measured by the check the floor runs. */
const issuesFor = (component: string, props: Record<string, unknown>): string[] =>
  kitNestingIssues({
    formatVersion: VENDO_TREE_FORMAT,
    root: "n1",
    nodes: [{ id: "n1", component, source: "prewired", props: props as Tree["nodes"][0]["props"] }],
  }).map(({ where, message }) => `${where} ${message}`);

describe("the Kit's slots", () => {
  it("admits, for every declared slot, what that slot declares", () => {
    for (const spec of KIT_SPECS) {
      for (const [name, slot] of Object.entries(spec.slots ?? {})) {
        const allowed = slot.content ?? KIT_SLOT_CONTENT_NAMES;
        const at = `${spec.name}.${name}`;
        // A vocabulary naming something the Kit does not have is a slot nothing
        // can legally fill.
        expect(allowed.filter((held) => !KIT_COMPONENT_NAMES.includes(held)), at).toEqual([]);
        expect(issuesFor(spec.name, { [name]: element(allowed[0]!) }), at).toEqual([]);
      }
    }
  });

  it("refuses an element where no slot was declared, naming the component and the key", () => {
    // A DataTable column takes a cell; the table itself takes no `header`, and
    // an element written there reaches nothing at all.
    const [message] = issuesFor("DataTable", { header: element("Text") });

    expect(message).toContain('node "n1" prop "header" holds <Text>, but "header" is not a slot');
    expect(message).toContain("the slots on <DataTable> are: cell");
    // …while a slot the Kit really renders admits its own vocabulary.
    expect(issuesFor("Timeline", { marker: element("Icon") })).toEqual([]);
  });

  it("says so when the component takes no element at all", () => {
    expect(issuesFor("Money", { amount: element("Text") })[0])
      .toContain("<Money> takes no element in its props");
  });

  it("keeps the read-only tier on a per-row slot, and takes the declared one beside it", () => {
    // The same table, the same row: what is painted for every row may not be
    // operated, and the actions written FOR the row may.
    const [cell] = issuesFor("DataTable", { columns: [{ key: "status", cell: element("Button") }] });

    expect(cell).toContain('prop "columns[0].cell" holds <Button> in a cell slot');
    expect(cell).toContain("a cell is read, never operated");
    expect(cell).toContain(`A cell may hold: ${KIT_SLOT_CONTENT_NAMES.join(", ")}`);
    // …the entry body a Timeline paints per entry takes that same tier…
    expect(issuesFor("Timeline", { cell: element("Button") })[0])
      .toContain("a cell is read, never operated");
    // …and the marker beside it takes the narrower one it declares.
    expect(issuesFor("Timeline", { marker: element("Button") })[0])
      .toContain("this slot may hold: Icon, Avatar, Badge, EnumBadge, Text");
  });

  it("lets an Accordion section hold a whole screen, and refuses a name the Kit has not got", () => {
    // `items[].content` is element-valued and was checked by nothing until the
    // slots landed. A section is a REGION, so what goes in it is the Kit.
    expect(issuesFor("Accordion", {
      items: [{ label: "Overdue", content: element("DataTable") }],
    })).toEqual([]);

    const [message] = issuesFor("Accordion", {
      items: [{ label: "Ghost", content: element("Hallucinated") }],
    });
    expect(message).toContain('prop "items[0].content" holds <Hallucinated> in a content slot');
  });
});
