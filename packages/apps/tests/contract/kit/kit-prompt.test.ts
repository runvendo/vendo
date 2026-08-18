import { describe, expect, it } from "vitest";
import { kitPrompt, promptExamples } from "../../../src/contract/kit/kit-prompt.js";
import { KIT_SPECS } from "../../../src/contract/kit/specs.js";

/**
 * W2 §The Kit — the GENERATED model-facing prompt section. The generator was
 * hoisted from `@vendoai/ui` to core (see kit/index.js); `@vendoai/apps` renders
 * the COMPONENTS section of the generation contract from it
 * (generation/contracts/sections.ts). ui's registry test reaches this code
 * through a re-export shim, so the render contract itself was never pinned in
 * the package that owns it — these tests pin it here.
 */
describe("kitPrompt() — the generated model-facing Kit section", () => {
  it("leads with the data law, and drops it on request", () => {
    expect(kitPrompt()).toContain("# The Kit");
    expect(kitPrompt({ omitPreamble: true })).not.toContain("# The Kit");
  });

  // DataTable's `rows` is the example rather than a value component's own value:
  // a table with no rows is nothing at all.
  it("renders a prop as `name` [class] (required) — doc, and omits the marker when optional", () => {
    const prompt = kitPrompt({ only: ["DataTable"] });
    expect(prompt).toContain("- `rows` [data] (required) — rows from a tool call");
    expect(prompt).toContain("- `sortBy` [config] — initial sort");
  });

  // Each adjective is on the props of the components that READ it, so validation
  // and the screen typings admit it there — and it is taught ONCE, in the
  // preamble, because 31 restatements would cost a fifth of the catalog.
  it("teaches tone and density in the preamble and never in a component's prop list", () => {
    const preamble = kitPrompt();
    expect(preamble).toContain("## Two adjectives");
    // …and the preamble no longer claims them for components that drop them.
    expect(preamble).not.toContain("on every component");
    for (const name of ["DataTable", "Stat", "Card", "Divider"]) {
      const scoped = kitPrompt({ only: [name], omitPreamble: true });
      expect(scoped).not.toContain("- `tone`");
      expect(scoped).not.toContain("- `density`");
    }
  });

  // `disabled`, `required`, `hint` and `style` are shared props too — implemented
  // and typed across the form controls, filtered out of every prop list
  // (`KIT_PREAMBLE_PROP_NAMES`) — so the model must be taught they exist here,
  // same as tone/density/grow, or it never writes them.
  it("teaches disabled, required, hint and style in the preamble", () => {
    const preamble = kitPrompt();
    expect(preamble).toContain("`disabled`");
    expect(preamble).toContain("`required`");
    expect(preamble).toContain("`hint`");
    expect(preamble).toContain("**style**");
  });

  it("labels the example block for its count", () => {
    // Text carries two examples, Stat one; the model reads the label.
    expect(kitPrompt({ only: ["Text"] })).toContain("Examples:");
    const stat = kitPrompt({ only: ["Stat"], omitPreamble: true });
    expect(stat).toContain("Example:");
    expect(stat).not.toContain("Examples:");
  });

  it("titles each group, in the reading order the model is taught", () => {
    const prompt = kitPrompt();
    const titles = [
      "# Layout",
      "# Values (typography, pills and glyphs — you format the figure)",
      "# Data",
      "# Charts",
      "# Forms & actions",
      "# Feedback & interactive",
    ];
    const positions = titles.map((t) => prompt.indexOf(t));
    expect(positions, `missing group heading: ${titles.filter((t, i) => positions[i] === -1).join(", ")}`)
      .not.toContain(-1);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  it("drops the group headings when scoped — scoped output is a flat list", () => {
    const scoped = kitPrompt({ only: ["Text", "DataTable"] });
    expect(scoped).toContain("## <Text>");
    expect(scoped).toContain("## <DataTable>");
    expect(scoped).not.toContain("# Values (typography, pills and glyphs — you format the figure)");
    expect(scoped).not.toContain("# Data\n");
  });

  it("teaches every registered component and nothing that is not registered", () => {
    const prompt = kitPrompt();
    for (const spec of KIT_SPECS) expect(prompt, `missing <${spec.name}>`).toContain(`## <${spec.name}>`);
    const taught = [...prompt.matchAll(/^## <(\w+)>$/gm)].map((m) => m[1]);
    expect(taught.sort()).toEqual(KIT_SPECS.map((s) => s.name).sort());
  });

  /**
   * Where a field's units are settled: ONE instruction, at the read site. The
   * `semantic:` token that used to divide for you is gone with the dialect, and so
   * is the reader's old name rule ("a `*_cents` key is money in minor units") —
   * either would promise a conversion no component performs. The preamble's own
   * line is where the `money` helper the examples call gets its body, so the
   * division and the formatting are taught as one move.
   */
  it("teaches the one money rule, and no conversion anything performs for you", () => {
    const prompt = kitPrompt();
    expect(prompt).toContain("(row.amount_cents / 100).toLocaleString(");
    expect(prompt).toContain("converts nothing");
    expect(prompt).not.toContain('semantic:"money.cents"');
    expect(prompt).not.toContain("`*_cents` key is money in minor units");
  });

  /**
   * The class the DonutChart example used to TEACH, swept over every example the
   * catalog can show — the spec's own and the prompt's correction, because either
   * one is what some component shows.
   *
   * A chart reads its numbers BY KEY, so there is no per-row read to divide in; the
   * example handed tool rows straight to `format="money"`, and a benched screen
   * copied it faithfully and printed cents as dollars — $285,000 of housing spend —
   * while dividing correctly everywhere the Stat example was the model it followed.
   * An example is the strongest teaching in the prompt, so one that skips the
   * `/ 100` is a bug the catalog ships to every generation.
   *
   * The detector names only the places a figure is DISPLAYED as money — a currency
   * `toLocaleString`, a chart's axis token, a Calendar's amount field — so the
   * `money` helper is never what makes an example count as one, and an example that
   * hands a raw cents field to any of them fails.
   */
  it("divides in every example that formats money, so none teaches cents as dollars", () => {
    const shown = /format[=:]"money"|amountField=|style: "currency"/u;
    for (const spec of KIT_SPECS) {
      for (const example of [...spec.examples, ...promptExamples(spec)]) {
        if (!shown.test(example)) continue;
        // The division is written out, or it is the `money` helper — whose body the
        // preamble gives as exactly that division (see the money-rule test above).
        expect(example, `${spec.name} formats money with no /100`).toMatch(/\/ 100|money\(/u);
      }
    }
    // …and every `money(…)` is handed a MINOR-UNIT field, because a helper that
    // divides fed dollars is the same bug read backwards.
    for (const spec of KIT_SPECS) {
      for (const example of [...spec.examples, ...promptExamples(spec)]) {
        for (const [, argument] of example.matchAll(/money\(([^)]*)\)/gu)) {
          expect(argument, `${spec.name} hands money() a field that is not cents`).toMatch(/_[cC]ents$/u);
        }
      }
    }
  });

  // …and every chart SAYS which unit it plots, because the division cannot happen
  // at a read site the model can see — only in the data it hands over.
  it("names dollars on the chart props that take money", () => {
    for (const name of ["LineChart", "BarChart", "DonutChart"]) {
      expect(kitPrompt({ only: [name], omitPreamble: true }), name).toContain("DOLLARS");
    }
  });

  /**
   * The idiom the whole rewrite turns on: a per-row slot is a FUNCTION of the row,
   * so the example writes `row.…` arithmetic where a `field=` binding used to
   * stand. Pinned over every example the prompt shows, because one left behind
   * teaches a screen the checks reject.
   */
  it("shows per-row slots as functions, and no `field=` binding anywhere", () => {
    const prompt = kitPrompt();
    expect(prompt).toContain("cell:(row) => <Text text={money(row.amount_cents)}/>");
    expect(prompt).toContain("rowActions={(row) =>");
    expect(prompt).not.toContain("field=");
  });

  // A prop the preamble forbade and the spec now declares is a prop taught two
  // ways at once.
  it("shows a Select paired with the screen state it reads", () => {
    const prompt = kitPrompt({ only: ["Select"] });
    expect(prompt).toContain("value={planId}");
    expect(prompt).not.toContain("No `value` prop on Select");
  });
});
