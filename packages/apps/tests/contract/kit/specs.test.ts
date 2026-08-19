import { describe, expect, it } from "vitest";
import { validateProps } from "../../../src/contract/kit/schema.js";
import {
  KIT_CHILDLESS_NAMES,
  KIT_SHARED_PROP_NAMES,
  KIT_SLOT_PROPS,
  KIT_SPECS,
  kitPropClasses,
  kitSlotPath,
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
  // Button joined when `variant` was merged into the one tone vocabulary: `tone`
  // is the taught word on a button now, and `variant` is the deprecated alias the
  // renderer still maps onto the same three tones.
  tone: ["Text", "EnumBadge", "Badge", "Icon", "Sparkline", "Progress", "Stat", "Card", "Surface", "Callout", "Toast", "Button"],
  density: ["Stack", "Row", "Grid", "Surface", "Card", "DataTable", "CardList", "Stat"],
  // The containers that stretch, and only those: `grow` is `flexGrow` on the
  // block's own root, so a component that draws no container of its own would
  // take the prop and drop it.
  grow: ["Stack", "Row", "Grid", "Surface", "Card"],
  // The controls that IMPLEMENT each one, and none of the ones that do not —
  // these three shipped for months as props the Kit painted and no spec admitted.
  disabled: ["Input", "Textarea", "Select", "Combobox", "DatePicker", "DateRange", "Checkbox", "Switch", "Radio", "Slider", "SegmentedControl", "Button", "Form"],
  // Checkbox joined the day `Form` started checking its own element's validity:
  // before that a required checkbox was a prop the Kit set on the input and
  // Base UI's noValidate form ignored.
  required: ["Input", "Textarea", "Select", "DatePicker", "Checkbox"],
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
    // A Switch applies the moment it is flipped, so there is no submit for a
    // `required` to block — and `grow` on a value is a flex property on a span.
    expect(kitPropClasses("Switch")?.required).toBeUndefined();
    expect(kitPropClasses("Text")?.grow).toBeUndefined();
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

  // An identifier is a value with a FACE, not prose, and Text's code role is the
  // one place a screen says so now that `ValueFormat` has lost its `code` member
  // along with the rest of the container tokens.
  it("admits the code role on Text", () => {
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
   * invisibly, off a word the host copied across. `cell: (row) => <Text
   * text={(row.compute_cost / 100).toLocaleString(…)}/>` says the same thing in the
   * file, where a reader can see it.
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
      // A chart's FORMATTERS are per-row slots for the same reason its tooltip is:
      // the figure is the screen's own text, written once as a function of the row
      // and resolved once per row. A series' formatter arrives inside `series`,
      // exactly as a cell arrives inside `columns`.
      LineChart: {
        tooltip: { rows: "data" },
        series: { rows: "data", field: "format" },
        xFormat: { rows: "data" },
      },
      BarChart: { tooltip: { rows: "data" }, series: { rows: "data", field: "format" } },
      DonutChart: { tooltip: { rows: "data" }, format: { rows: "data" } },
    });
    // …and WHICH of them hold finished text rather than elements. `text` is what
    // `ui`'s slot-drift sweep probes with a string instead of an element, so a
    // formatter added without it is refused there rather than excused; the three
    // charts are the only slots in the Kit that hold a figure.
    const text = KIT_SPECS.flatMap((spec) => Object.entries(spec.slots ?? {})
      .filter(([, slot]) => slot.text === true)
      .map(([name, slot]) => `${spec.name}.${kitSlotPath(name, slot)}`));
    expect(text).toEqual([
      "LineChart.series[].format",
      "LineChart.xFormat",
      "BarChart.series[].format",
      "DonutChart.format",
    ]);
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

  /**
   * The capability props, pinned by NAME.
   *
   * Every one of these is a prop a model already wrote and the floor already
   * refused — a column's `header`, a `width`, a button's `icon`. Zod strips an
   * unknown key rather than failing it, so what admits a prop is its presence in
   * `kitPropClasses` (→ `wirePropNames` → the `components-exist` check), and a
   * capability that only reads well in a summary is a capability the gate rejects.
   */
  it("admits what a table column needs to survive a narrow frame", () => {
    const table = kitSpec("DataTable")!;
    expect(validateProps(table, {
      rows: [],
      fold: true,
      columns: [{ key: "client.name", header: "Client", width: 220, truncate: false, priority: 3 }],
    }).success).toBe(true);
    // …and the shapes stay typed: a width is a positive integer of pixels.
    expect(validateProps(table, { rows: [], columns: [{ key: "a", width: "wide" }] }).success).toBe(false);
    expect(kitPropClasses("DataTable")?.fold).toBe("config");
  });

  it("lets a multiple Select hold the whole selection", () => {
    // One string had nowhere to keep the second choice, so the control stayed
    // uncontrolled and the screen's handler read `e.target.value` off an array.
    const select = kitSpec("Select")!;
    expect(validateProps(select, { options: [], multiple: true, value: ["a", "b"] }).success).toBe(true);
    expect(validateProps(select, { options: [], value: "a" }).success).toBe(true);
  });

  it("admits the props that turn a dead control into an honest one", () => {
    expect(kitPropClasses("Button")?.icon).toBe("config");
    expect(kitPropClasses("Button")?.loading).toBe("config");
    expect(kitPropClasses("Checkbox")?.indeterminate).toBe("config");
    expect(kitPropClasses("CodeBlock")?.wrap).toBe("config");
    expect(kitPropClasses("CodeBlock")?.maxHeight).toBe("config");
    // A button names itself with children now, so the label stopped being the
    // only way to have a name.
    expect(kitSpec("Button")!.props.label?.required).toBe(false);
    for (const name of ["Text", "Button"]) expect(kitSpec(name)?.takesChildren, name).toBe(true);
  });

  it("gives a SplitPane one way to say how wide the first pane is", () => {
    const split = kitSpec("SplitPane")!;
    for (const size of ["40%", "18rem", 280, 0.4]) {
      expect(validateProps(split, { size }).success, String(size)).toBe(true);
    }
  });

  /** The three native controls RENDER an element, so the element's own
   *  vocabulary is theirs — `maxLength` on a textarea was refused by name while
   *  the identical prop went through on Input, whose engine was declared. */
  it("declares an engine for the controls that pass props to a DOM element", () => {
    for (const name of ["Textarea", "Select", "Checkbox"]) {
      expect(kitSpec(name)?.engine, name).toBeDefined();
      expect(validateProps(kitSpec(name)!, { options: [], maxLength: 280 }).success, name).toBe(true);
    }
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
