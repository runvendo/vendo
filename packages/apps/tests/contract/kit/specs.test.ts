import { describe, expect, it } from "vitest";
import { validateProps } from "../../../src/contract/kit/schema.js";
import {
  KIT_CHILDLESS_NAMES,
  KIT_SHARED_PROP_NAMES,
  KIT_SLOT_PROPS,
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
  tone: ["Text", "Money", "DateTime", "Percent", "Num", "EnumBadge", "Badge", "Icon", "Sparkline", "Progress", "Stat", "Card", "Surface", "Callout", "Toast"],
  density: ["Stack", "Row", "Grid", "Surface", "Card", "DataTable", "CardList", "Stat"],
  // The controls that IMPLEMENT each one, and none of the ones that do not —
  // these three shipped for months as props the Kit painted and no spec admitted.
  disabled: ["Input", "Textarea", "Select", "Combobox", "DatePicker", "DateRange", "Checkbox", "Switch", "Radio", "Slider", "SegmentedControl", "Button", "Form"],
  required: ["Input", "Textarea", "Select", "DatePicker"],
  hint: ["Input", "Textarea", "Select", "Combobox", "DatePicker", "DateRange", "Checkbox", "Switch", "Radio", "Slider"],
};

/** `hint` is words a person READS, so it is copy where the rest are config. */
const CLASSES: Record<string, string> = { hint: "copy" };

describe("the Kit specs", () => {
  it("carries each shared adjective on the components that read it, in its own class, and on no others", () => {
    expect(Object.keys(READERS)).toEqual([...KIT_SHARED_PROP_NAMES]);
    for (const spec of KIT_SPECS) {
      for (const [name, readers] of Object.entries(READERS)) {
        const reads = readers.includes(spec.name);
        expect(spec.props[name] !== undefined, `${spec.name}.${name}`).toBe(reads);
        if (reads) expect(kitPropClasses(spec.name)?.[name]).toBe(CLASSES[name] ?? "config");
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
    expect(kitPropClasses("Checkbox")?.required).toBeUndefined();
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
    const cell = { $element: true, component: "EnumBadge", props: { value: "open" } };
    expect(validateProps(table, { rows: [], columns: [{ key: "status", cell }] }).success).toBe(true);
    expect(validateProps(table, { rows: [], columns: [{ key: 1 }] }).success).toBe(false);
    const cards = kitSpec("CardList")!;
    expect(validateProps(cards, { items: [], fields: [{ key: "plan", cell }] }).success).toBe(true);
  });

  it("admits the props a screen needs to drop a year, read seconds, and name a unit", () => {
    // By NAME for the two config props: zod strips an unknown key rather than
    // failing it, so the allowed-prop set is what turns a prop the spec never
    // declared into a blocking error instead of a silent drop at render.
    expect(kitPropClasses("DateTime")?.compact).toBe("config");
    expect(kitPropClasses("Num")?.unit).toBe("config");
    expect(kitPropClasses("Stat")?.unit).toBe("config");
    // …and by VALUE for the format token, which is a declared enum.
    const stat = kitSpec("Stat")!;
    expect(validateProps(stat, { label: "Build time", value: 268, format: "duration" }).success).toBe(true);
    expect(validateProps(stat, { label: "Build time", value: 268, format: "fortnights" }).success).toBe(false);
    const table = kitSpec("DataTable")!;
    expect(validateProps(table, { rows: [], columns: [{ key: "duration_seconds", format: "duration" }] }).success)
      .toBe(true);
  });

  // An identifier is a value with a FACE, not prose: the column token and the
  // Text role are the two places a screen says so.
  it("admits the code format on a column and the code role on Text", () => {
    const table = kitSpec("DataTable")!;
    expect(validateProps(table, { rows: [], columns: [{ key: "commit", format: "code" }] }).success).toBe(true);
    const text = kitSpec("Text")!;
    expect(validateProps(text, { text: "9f2c1ab", variant: "code" }).success).toBe(true);
    expect(validateProps(text, { text: "9f2c1ab", variant: "monospace" }).success).toBe(false);
  });

  /**
   * EVERY slot may be written as a function returning its element, so this table
   * is the VM's whole lookup: a slot missing from it is a function prop that
   * crosses as a `$handler` and paints nothing.
   *
   * The per-row half is pinned by name because its function is the one that takes
   * arguments — and because the units a field is stored in are the screen's to
   * divide where it reads them, which is where the `semantic` token used to do it,
   * invisibly, off a word the host copied across. `<Money value={row.compute_cost /
   * 100}/>` says the same thing in the file, where a reader can see it.
   */
  it("names every slot by the prop that arrives, and which of them map over rows", () => {
    expect(KIT_SLOT_PROPS.DataTable).toEqual({
      columns: { rows: "rows", field: "cell" },
      rowActions: { rows: "rows" },
      toolbar: {},
      empty: {},
    });
    const perRow = Object.fromEntries(Object.entries(KIT_SLOT_PROPS)
      .map(([component, slots]) =>
        [component, Object.fromEntries(Object.entries(slots).filter(([, { rows }]) => rows !== undefined))] as const)
      .filter(([, slots]) => Object.keys(slots).length > 0));
    expect(perRow).toEqual({
      DataTable: { columns: { rows: "rows", field: "cell" }, rowActions: { rows: "rows" } },
      CardList: { fields: { rows: "items", field: "cell" } },
      KeyValue: { items: { rows: "record", field: "cell" } },
      Timeline: { cell: { rows: "entries" } },
      LineChart: { tooltip: { rows: "data" } },
      BarChart: { tooltip: { rows: "data" } },
      DonutChart: { tooltip: { rows: "data" } },
    });
    // Every prop it keys, and every rows prop it names, is a prop that component
    // really has — a slot on a prop nobody passes is a slot nothing paints.
    for (const [component, slots] of Object.entries(KIT_SLOT_PROPS)) {
      for (const [prop, { rows }] of Object.entries(slots)) {
        expect(kitSpec(component)?.props[prop], `${component}.${prop}`).toBeDefined();
        if (rows !== undefined) expect(kitSpec(component)?.props[rows], `${component}.${rows}`).toBeDefined();
      }
    }
    // The shared adjectives are folded in too: `hint` holds elements on every
    // control that takes one, so a function written there is a slot, not a handler.
    expect(KIT_SLOT_PROPS.Input?.hint).toEqual({});
  });


  // Naming no fields is "show me the record", not an error: a detail screen
  // that names none is asking for all of them.
  it("lets a KeyValue name no fields at all", () => {
    expect(validateProps(kitSpec("KeyValue")!, { record: { id: 1 } }).success).toBe(true);
  });

  // A field is CONTROLLED — the screen holds the choice so the rest of the
  // screen can read it. Without `value` the prop failed the checks, and a form
  // could not show anything about what was picked.
  it("lets a Select be controlled, like every other field", () => {
    const select = kitSpec("Select")!;
    expect(validateProps(select, { options: [], value: "bld_4192" }).success).toBe(true);
    expect(kitPropClasses("Select")?.value).toBe("config");
  });

  it("names the childless components", () => {
    // The renderer hands children to every node it renders, so "renders no
    // children" is a fact only the spec can state.
    expect(KIT_CHILDLESS_NAMES).toContain("LineChart");
    // DataTable stopped being one when a row became something the model may
    // paint: its children are <TableRow>s, and a TableRow's are its cells.
    for (const container of ["Stack", "Row", "Grid", "Surface", "Card", "Tabs", "Callout", "Form", "Stat", "DataTable", "TableRow"]) {
      expect(KIT_CHILDLESS_NAMES, container).not.toContain(container);
    }
  });
});
