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
  it("leads with the two laws, and drops them on request", () => {
    expect(kitPrompt()).toContain("# The Kit");
    expect(kitPrompt({ omitPreamble: true })).not.toContain("# The Kit");
  });

  // Money's `amount` used to be the required one here. It is optional now: a
  // value component in a cell slot takes its value from `field`, so demanding
  // `amount` would make the slot unwritable. DataTable's `rows` is the example
  // instead — a table with no rows is nothing at all.
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
    expect(preamble).toContain("Two adjectives.");
    // …and the preamble no longer claims them for components that drop them.
    expect(preamble).not.toContain("on every component");
    for (const name of ["DataTable", "Stat", "Card", "Divider"]) {
      const scoped = kitPrompt({ only: [name], omitPreamble: true });
      expect(scoped).not.toContain("- `tone`");
      expect(scoped).not.toContain("- `density`");
    }
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
});
