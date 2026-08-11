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

  it("renders a prop as `name` [class] (required) — doc, and omits the marker when optional", () => {
    const prompt = kitPrompt({ only: ["Money"] });
    expect(prompt).toContain("- `cents` [data] (required) — amount in integer cents (minor units)");
    expect(prompt).toContain("- `currency` [config] — ISO 4217 code, default USD");
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
