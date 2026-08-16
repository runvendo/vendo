import { describe, expect, it } from "vitest";
import { catalogPrompt } from "../../../src/contract/kit/catalog-prompt.js";
import { KIT_ICON_NAMES } from "../../../src/contract/kit/icon-names.gen.js";
import { KIT_SPECS, kitSpec } from "../../../src/contract/kit/specs.js";

const body = (options: Parameters<typeof catalogPrompt>[0] = {}) =>
  catalogPrompt({ ...options, omitPreamble: true }).split("\n");

describe("catalogPrompt() — the whole catalog, one line per component", () => {
  // The FORMAT is pinned against the spec's own prose rather than a copy of it:
  // a summary reworded in specs.ts is not a regression here, a changed shape is.
  it("renders a component as name, summary, then props by class", () => {
    expect(body({ only: ["Money"] })[0]).toBe(
      `<Money> ${kitSpec("Money")!.summary} · data: amount · config: currency`,
    );
  });

  it("marks a required prop with `!` and leaves an optional one bare", () => {
    const line = body({ only: ["Stat"] })[0]!;
    expect(line).toContain("data: value!");
    expect(line).toContain("copy: label! trend");
  });

  it("leads with the data props — law 1 is the one a line must not bury", () => {
    const line = body({ only: ["DataTable"] })[0]!;
    expect(line.indexOf("data: rows!")).toBeLessThan(line.indexOf("config:"));
    expect(line.indexOf("config:")).toBeLessThan(line.indexOf("copy:"));
  });

  // Each adjective sits on the props of the components that read it so validation
  // admits it there; the preamble teaches it once, and restating it on 39 lines
  // would undo the compression the format exists for.
  it("never spends a line on the shared adjectives", () => {
    for (const name of ["DataTable", "Stat", "Card", "Divider"]) {
      const line = body({ only: [name] })[0]!;
      expect(line, name).not.toContain("tone");
      expect(line, name).not.toContain("density");
    }
  });

  it("carries every slot with its doc, and marks the per-row ones", () => {
    const line = body({ only: ["DataTable"] })[0]!;
    expect(line).toContain(`slot cell (per row): ${kitSpec("DataTable")!.slots!["cell"]!.doc}`);
    // A non-per-row slot carries its doc WITHOUT the marker — without this the
    // per-row half is unfalsifiable, since marking every slot would still pass.
    const timeline = body({ only: ["Timeline"] })[0]!;
    expect(timeline).toContain(`slot marker: ${kitSpec("Timeline")!.slots!["marker"]!.doc}`);
    expect(timeline).not.toContain("slot marker (per row)");
  });

  it("teaches every registered component, one line each, and nothing else", () => {
    const lines = body();
    const taught = lines.filter((line) => line.startsWith("<")).map((line) => line.slice(1, line.indexOf(">")));
    expect(taught).toEqual(KIT_SPECS.map((spec) => spec.name));
  });

  it("merges the host's own components into the one list, marked [host]", () => {
    const host = [{ name: "AccountCard", description: "A Maple account with its balance." }];
    const lines = body({ host });
    expect(lines).toContain("<AccountCard> [host] A Maple account with its balance.");
    // One list: the host entry sits among the Kit's lines, not under a heading.
    expect(lines.filter((line) => line.startsWith("<"))).toHaveLength(KIT_SPECS.length + 1);
    // …and `only` scopes both halves the same way.
    expect(body({ host, only: ["Money"] }).filter((line) => line.startsWith("<"))).toHaveLength(1);
    expect(body({ host, only: ["AccountCard"] })[0]).toBe(
      "<AccountCard> [host] A Maple account with its balance.",
    );
  });

  it("lists the icon vocabulary once, so the model stops inventing glyph names", () => {
    const prompt = catalogPrompt();
    expect(prompt).toContain("Icon names — `<Icon name>`");
    for (const name of ["credit-card", "alert-triangle", "arrow-up-right"]) {
      expect(prompt, name).toContain(name);
    }
    expect(KIT_ICON_NAMES.length).toBeGreaterThan(180);
  });

  it("leads with the two laws and the legend, and drops them on request", () => {
    expect(catalogPrompt()).toContain("# The Kit");
    expect(catalogPrompt()).toContain("`!` marks a required prop");
    expect(catalogPrompt({ omitPreamble: true })).not.toContain("# The Kit");
  });

  /**
   * THE BUDGET. Measured 2026-08-15 on this base: the prompt this replaces —
   * `componentsPromptSection()`, a `kitPrompt` section per brick — costs 20,819
   * characters (~5.8k tokens) for 38 bricks and carries no icon names at all.
   * This renders 39 bricks AND 227 icon names in 13,313 (~3.7k tokens), because
   * a line drops the worked example and the per-prop docs.
   *
   * The ceiling is that measured 20,819: the whole catalog plus icons may not
   * cost more than the catalog alone used to. The per-brick bound is the half
   * that bites — at 230 characters a brick, the 55-brick kit lands near 17,000
   * and still fits, and a line that grows past 300 would break that promise
   * long before the total ceiling noticed.
   */
  it("costs less than the prompt it replaces, with room for the 55-brick kit", () => {
    const prompt = catalogPrompt();
    expect(prompt.length).toBeLessThanOrEqual(20_819);
    const lines = body().filter((line) => line.startsWith("<"));
    expect(lines.join("\n").length / lines.length).toBeLessThanOrEqual(300);
  });
});
