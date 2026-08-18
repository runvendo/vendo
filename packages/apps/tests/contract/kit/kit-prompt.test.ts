import { describe, expect, it } from "vitest";
import { kitPrompt } from "../../../src/contract/kit/kit-prompt.js";
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
    // DateTime carries two examples, Money one; the model reads the label.
    expect(kitPrompt({ only: ["DateTime"] })).toContain("Examples:");
    const money = kitPrompt({ only: ["Money"], omitPreamble: true });
    expect(money).toContain("Example:");
    expect(money).not.toContain("Examples:");
  });

  it("titles each group, in the reading order the model is taught", () => {
    const prompt = kitPrompt();
    const titles = [
      "# Layout",
      "# Values (semantic — formatted for you)",
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
    const scoped = kitPrompt({ only: ["Money", "DataTable"] });
    expect(scoped).toContain("## <Money>");
    expect(scoped).toContain("## <DataTable>");
    expect(scoped).not.toContain("# Values (semantic — formatted for you)");
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
   * either would promise a conversion no component performs.
   */
  it("teaches the one money rule, and no conversion anything performs for you", () => {
    const prompt = kitPrompt();
    expect(prompt).toContain("value={invoice.amount_cents / 100}");
    expect(prompt).toContain("converts nothing");
    expect(prompt).not.toContain('semantic:"money.cents"');
    expect(prompt).not.toContain("`*_cents` key is money in minor units");
  });

  /**
   * The idiom the whole rewrite turns on: a per-row slot is a FUNCTION of the row,
   * so the example writes `row.…` arithmetic where a `field=` binding used to
   * stand. Pinned over every example the prompt shows, because one left behind
   * teaches a screen the checks reject.
   */
  it("shows per-row slots as functions, and no `field=` binding anywhere", () => {
    const prompt = kitPrompt();
    expect(prompt).toContain("cell:(row) => <Money value={row.amount_cents / 100}/>");
    expect(prompt).toContain("rowActions={(row) =>");
    expect(prompt).not.toContain("field=");
  });

  // A prop the preamble forbade and the spec now declares is a prop taught two
  // ways at once.
  it("shows a Select paired with the screen state it reads", () => {
    const prompt = kitPrompt({ only: ["Select"] });
    expect(prompt).toContain("value={clientId}");
    expect(prompt).not.toContain("No `value` prop on Select");
  });
});
