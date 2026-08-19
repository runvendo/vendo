/**
 * THE FORMAT CONSTITUTION.
 *
 * The app format has mirrors — the contract, `@vendoai/core`'s pinned limits,
 * the manual the model reads (`skills/format-reference.ts`) and the public docs
 * page. Every one of them used to be maintained by hand, and they disagreed: the
 * manual promised "16 islands, 64 KB each" and never mentioned the 256 KB TOTAL
 * the validator also enforces, so a model that obeyed the manual could write a
 * megabyte of islands and watch the whole app fail to validate for a reason it
 * was never told about.
 *
 * The manual is no longer one of those mirrors for the byte budgets: a screen is
 * `app.tsx` now and has no byte budget, so what is asserted of the manual here is
 * that it quotes none. The public docs page dropped out for the same reason in
 * the Cloud restructure — `generated/apps` teaches `app.tsx`, which has no byte
 * budget to state. The budgets themselves still bind a stored component map
 * (`contract/component-map.ts`), so core and the contract still have to agree.
 *
 * This file is the one place a format number or a component name is written by
 * hand. Everything else derives, and this test fails the moment any mirror
 * drifts from another — a test, not a convention.
 */
import { describe, expect, it } from "vitest";
import {
  TREE_MAX_COMPONENT_SOURCE_BYTES as CORE_MAX_COMPONENT_SOURCE_BYTES,
  TREE_MAX_GENERATED_COMPONENTS as CORE_MAX_GENERATED_COMPONENTS,
  TREE_MAX_TOTAL_COMPONENT_BYTES as CORE_MAX_TOTAL_COMPONENT_BYTES,
} from "@vendoai/core";
import {
  catalogPrompt,
  KIT_COMPONENT_NAMES,
  KIT_NON_SCREEN_NAMES,
  KIT_SCREEN_COMPONENT_NAMES,
  KIT_SPECS,
  kitPrompt,
  kitSpec,
  TREE_MAX_COMPONENT_SOURCE_BYTES,
  TREE_MAX_GENERATED_COMPONENTS,
  TREE_MAX_TOTAL_COMPONENT_BYTES,
} from "../src/contract/index.js";
import { VENDO_FORMAT_REFERENCE } from "../src/server/skills/format-reference.js";

const KB = 1_024;

/** d4 — the three bundle budgets, stated once, here. Changing any of them is a
 *  format change, and it has to be made in this file first. */
const LIMITS = {
  generatedComponents: 16,
  componentSourceBytes: 64 * KB,
  totalComponentBytes: 256 * KB,
} as const;

/** The component vocabulary a generated app may name without a source map. */
const VOCABULARY = [
  "Accordion", "Avatar", "Badge", "BarChart", "Button", "Calendar", "Callout", "Card", "CardList", "Checkbox",
  "CodeBlock", "Combobox", "DataTable", "DatePicker", "DateRange", "Disclaimer", "Divider", "DonutChart",
  "EmptyState", "EnumBadge", "Form", "Grid", "Icon", "Input", "KeyValue", "LineChart", "Link", "Menu", "Modal",
  "Progress", "Radio", "Row", "SegmentedControl", "Select", "Sheet", "Slider",
  "Sparkline", "SplitPane", "Stack", "Stat", "Steps", "Surface", "Switch", "TableRow", "Tabs", "Text", "Textarea",
  "Timeline", "Toast",
  "Tooltip",
];

/** The four the value-formatting tier took with it. A screen formats its own
 *  figures now, so these are names the model must never be shown again. */
const DEAD_VALUE_COMPONENTS = ["DateTime", "Money", "Num", "Percent"] as const;

/** The three that print a figure the screen wrote for them. */
const CHARTS = ["LineChart", "BarChart", "DonutChart"] as const;

/** Every word the retired value tier could be TOLD. Not one of them may reach the
 *  model again: each was a promise that some component would interpret a number. */
const DEAD_FORMAT_TOKENS = ["money", "number", "duration", "datetime", "time"] as const;

describe("the three bundle limits have ONE definition", () => {
  it("core holds the values this file pins", () => {
    expect(CORE_MAX_GENERATED_COMPONENTS).toBe(LIMITS.generatedComponents);
    expect(CORE_MAX_COMPONENT_SOURCE_BYTES).toBe(LIMITS.componentSourceBytes);
    expect(CORE_MAX_TOTAL_COMPONENT_BYTES).toBe(LIMITS.totalComponentBytes);
  });

  it("the contract re-exports core's constants rather than re-declaring them", () => {
    expect(TREE_MAX_GENERATED_COMPONENTS).toBe(CORE_MAX_GENERATED_COMPONENTS);
    expect(TREE_MAX_COMPONENT_SOURCE_BYTES).toBe(CORE_MAX_COMPONENT_SOURCE_BYTES);
    expect(TREE_MAX_TOTAL_COMPONENT_BYTES).toBe(CORE_MAX_TOTAL_COMPONENT_BYTES);
  });
});

describe("the manual states no budget, because the artifact it teaches has none", () => {
  it("quotes no KB figure at all", () => {
    // The three limits above govern a stored component map
    // (`contract/component-map.ts`), and nothing generates one any more: the
    // artifact a model writes is `app.tsx`, which the save-time gauntlet
    // (`checking/component-screen.ts`) measures for compilation, types and one
    // real render — never for bytes. A KB sentence in this manual would teach a
    // budget nothing enforces on the file it is about, which is this file's own
    // failure mode pointed the other way.
    expect(VENDO_FORMAT_REFERENCE).not.toMatch(/\d+ KB/);
  });
});

describe("the component vocabulary is ONE list", () => {
  it("is the list this file pins", () => {
    expect([...KIT_COMPONENT_NAMES].sort()).toEqual(VOCABULARY);
  });

  it("derives from the specs — nothing recomputes it", () => {
    expect(KIT_COMPONENT_NAMES).toEqual(KIT_SPECS.map((spec) => spec.name));
  });

  it("derives the screen subset by subtraction — nothing lists it by hand", () => {
    expect(KIT_SCREEN_COMPONENT_NAMES).toEqual(
      KIT_COMPONENT_NAMES.filter((name) => !KIT_NON_SCREEN_NAMES.includes(name)),
    );
  });

  // Accordion was the one name withheld, for an `items[].content` slot holding an
  // ELEMENT — a thing no wire tree could express. A screen writes JSX, so it can,
  // and the check has admitted it all along (`screenCatalog` takes the WHOLE
  // Kit). What was left was a catalog filter hiding a component that renders:
  // the model was never offered the collapsible sections a long app asks for.
  it("withholds nothing from a screen — a JSX screen fills an element slot", () => {
    expect(KIT_SCREEN_COMPONENT_NAMES).toContain("Accordion");
    expect(catalogPrompt({ only: [...KIT_SCREEN_COMPONENT_NAMES], omitPreamble: true }))
      .toContain("### <Accordion>");
  });
});

/**
 * THE VALUE TIER IS GONE — and the two model-facing prompts are where that has to
 * be TRUE, not merely intended.
 *
 * A screen formats its own figures with `Intl` now, so a component that formats
 * one, and a `format` token that names a formatting for one, are both dead. What
 * makes them dangerous rather than merely stale is that the prompts are GENERATED:
 * a spec left behind, or a token put back into a column description, teaches the
 * model an idiom the checks refuse and the renderer drops — and every mirror
 * downstream (the screen typings, the wire's allowed-prop set) follows the specs
 * without complaint. The vocabulary above pins WHICH bricks exist; this pins what
 * the model is offered, which is the half a name list cannot state.
 *
 * There is NO exception any more. The charts were the last one — an axis tick is
 * computed host-side off a numeric scale, so a chart could not be handed text for
 * one — and the trade is settled the other way now: a chart is handed the screen's
 * text for every figure it PRINTS, and the tick it invents reads as the plotted
 * number with digit grouping and no claim about what that number means.
 */
describe("no value tier in the prompts, and no exception left", () => {
  it("names none of the four value components anywhere the model reads", () => {
    for (const [which, prompt] of [["kitPrompt", kitPrompt()], ["catalogPrompt", catalogPrompt()]] as const) {
      for (const name of DEAD_VALUE_COMPONENTS) {
        // The TAG, not the bare word: "Money in" is a fine label for a Stat, and
        // `amount_cents` prose may still say the word money.
        expect(prompt, `${which} still shows <${name}>`).not.toMatch(new RegExp(`<${name}[ />]`, "u"));
        expect(kitSpec(name), `${name} still has a spec`).toBeUndefined();
      }
    }
    // …and the law itself is stated, not merely implied by the absence.
    expect(kitPrompt()).toContain("YOU format every value");
  });

  it("offers no format TOKEN anywhere, to a chart or to anything else", () => {
    // Both prompts render from the specs, so a token put back into any spec would
    // reach the model here. Not one of the retired words may be offered as the
    // value of a `format`, on any component.
    for (const [which, prompt] of [["kitPrompt", kitPrompt()], ["catalogPrompt", catalogPrompt()]] as const) {
      for (const token of DEAD_FORMAT_TOKENS) {
        expect(prompt, `${which} still offers format="${token}"`)
          .not.toMatch(new RegExp(`format[=:] *"${token}"`, "u"));
      }
    }
    // A chart's formatter is offered as a FUNCTION instead — `fn` in the catalog,
    // and a worked `(row) =>` in the example under it.
    for (const name of CHARTS) {
      const entry = catalogPrompt({ only: [name], omitPreamble: true });
      expect(entry, name).toMatch(/`(x?[Ff]ormat)[!]?: fn`|format:\(row\) =>|format=\{\(row\) =>/u);
      expect(entry, name).toMatch(/\(row\) => /u);
    }
    expect(catalogPrompt({ only: ["LineChart"], omitPreamble: true })).toContain("`xFormat: fn`");
    // And nothing a CONTAINER holds takes one: a column, a card field and a
    // KeyValue item each show the string the screen prepared. The token used to
    // print as a `format?` field of the description object.
    for (const name of ["DataTable", "CardList", "KeyValue"]) {
      expect(catalogPrompt({ only: [name], omitPreamble: true }), name).not.toMatch(/format\?/u);
    }
  });
});
