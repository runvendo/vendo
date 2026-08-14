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
/** Who READS each shared adjective — pinned here because the cost of getting it
 *  wrong is invisible: attached to a component that ignores it, the prop
 *  validates and the renderer drops it, which is the silent failure the whole
 *  prop-name gate exists to turn into a blocking error. */
const READERS: Record<string, readonly string[]> = {
  tone: ["Text", "Money", "DateTime", "Percent", "Num", "EnumBadge", "Badge", "Sparkline", "Progress", "Stat", "Card", "Surface", "Callout"],
  density: ["Stack", "Row", "Grid", "Surface", "Card", "DataTable", "CardList", "Stat"],
  field: ["Text", "Money", "DateTime", "Percent", "Num", "EnumBadge", "Badge", "Sparkline", "Progress"],
};

describe("the Kit specs", () => {
  it("carries each shared adjective on the components that read it, as config, and on no others", () => {
    expect(Object.keys(READERS)).toEqual([...KIT_SHARED_PROP_NAMES]);
    for (const spec of KIT_SPECS) {
      for (const [name, readers] of Object.entries(READERS)) {
        const reads = readers.includes(spec.name);
        expect(spec.props[name] !== undefined, `${spec.name}.${name}`).toBe(reads);
        if (reads) expect(kitPropClasses(spec.name)?.[name]).toBe("config");
      }
    }
  });

  it("leaves an adjective the component would only drop OUT of its allowed props", () => {
    // The refusal is by NAME, not by value: zod strips an unknown key rather
    // than failing it, so what turns `<DataTable tone="danger">` into a blocking
    // error is its absence from the allowed-prop set the floor reads
    // (`kitPropClasses` → wirePropNames → the `components-exist` check, pinned
    // end to end in tests/checking/floor.test.ts).
    expect(kitPropClasses("DataTable")?.tone).toBeUndefined();
    expect(kitPropClasses("Divider")?.density).toBeUndefined();
    expect(kitPropClasses("LineChart")?.field).toBeUndefined();
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
