import { describe, expect, it } from "vitest";
import { validateProps } from "../../../src/contract/kit/schema.js";
import {
  KIT_CHILDLESS_NAMES,
  KIT_SHARED_PROP_NAMES,
  KIT_SLOT_CONTENT_NAMES,
  KIT_SPECS,
  kitPropClasses,
  kitSpec,
} from "../../../src/contract/kit/specs.js";

/**
 * The Kit's own contract — the half `kitPrompt` does NOT render. The adjectives
 * and the cell slot only work if every consumer sees them: the wire's
 * allowed-prop set (`kitPropClasses`), runtime validation (`validateProps`) and
 * the screen typings all read the specs, so a prop that lives only in the
 * preamble prose is a prop the model cannot use.
 */
describe("the Kit specs", () => {
  it("carries the shared adjectives on every component, as config", () => {
    for (const spec of KIT_SPECS) {
      for (const name of KIT_SHARED_PROP_NAMES) {
        expect(spec.props[name], `${spec.name}.${name}`).toBeDefined();
        expect(kitPropClasses(spec.name)?.[name]).toBe("config");
      }
    }
  });

  it("admits the whole tone vocabulary, and the two spellings stored apps carry", () => {
    const stat = kitSpec("Stat")!;
    for (const tone of ["neutral", "accent", "success", "warning", "danger", "default", "info"]) {
      expect(validateProps(stat, { label: "Open", value: 1, tone }).success, tone).toBe(true);
    }
    expect(validateProps(stat, { label: "Open", value: 1, tone: "chartreuse" }).success).toBe(false);
  });

  it("admits a density only from the host theme's own vocabulary", () => {
    const table = kitSpec("DataTable")!;
    expect(validateProps(table, { rows: [], density: "compact" }).success).toBe(true);
    expect(validateProps(table, { rows: [], density: "cramped" }).success).toBe(false);
  });

  // A slot holds an ELEMENT, so the schema cannot describe it — the same
  // `z.unknown()` Accordion's `content` uses. What IS pinned is that a column
  // may carry one at all, and that the rest of the column stays typed.
  it("lets a table column and a card field carry a cell slot", () => {
    const table = kitSpec("DataTable")!;
    const cell = { $element: true, component: "EnumBadge", props: { field: "status" } };
    expect(validateProps(table, { rows: [], columns: [{ key: "status", cell }] }).success).toBe(true);
    expect(validateProps(table, { rows: [], columns: [{ key: 1 }] }).success).toBe(false);
    const cards = kitSpec("CardList")!;
    expect(validateProps(cards, { items: [], fields: [{ key: "plan", cell }] }).success).toBe(true);
  });

  it("names the childless components and what a cell may hold", () => {
    // The renderer hands children to every node it renders, so "renders no
    // children" is a fact only the spec can state.
    expect(KIT_CHILDLESS_NAMES).toContain("LineChart");
    expect(KIT_CHILDLESS_NAMES).toContain("DataTable");
    for (const container of ["Stack", "Row", "Grid", "Surface", "Card", "Tabs", "Callout", "Form", "Stat"]) {
      expect(KIT_CHILDLESS_NAMES, container).not.toContain(container);
    }
    // A cell is read, never operated.
    expect(KIT_SLOT_CONTENT_NAMES).toContain("EnumBadge");
    expect(KIT_SLOT_CONTENT_NAMES).not.toContain("Button");
    expect(KIT_SLOT_CONTENT_NAMES).not.toContain("DataTable");
  });
});
