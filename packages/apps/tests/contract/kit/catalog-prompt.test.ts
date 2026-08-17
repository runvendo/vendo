import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { catalogPrompt } from "../../../src/contract/kit/catalog-prompt.js";
import { KIT_ICON_NAMES } from "../../../src/contract/kit/icon-names.gen.js";
import { kitPrompt, promptExamples } from "../../../src/contract/kit/kit-prompt.js";
import { KIT_SPECS, kitSpec } from "../../../src/contract/kit/specs.js";

const body = (options: Parameters<typeof catalogPrompt>[0] = {}) =>
  catalogPrompt({ ...options, omitPreamble: true }).split("\n");

describe("catalogPrompt() — the whole catalog, one line per component", () => {
  // The FORMAT is pinned against the spec's own prose rather than a copy of it:
  // a summary reworded in specs.ts is not a regression here, a changed shape is.
  it("renders a component as name, summary, then typed props by class", () => {
    expect(body({ only: ["Money"] })[0]).toBe(
      `<Money> ${kitSpec("Money")!.summary} · data: amount: number · config: currency: string`,
    );
  });

  it("marks a required prop with `!` and leaves an optional one bare", () => {
    const line = body({ only: ["Stat"] })[0]!;
    expect(line).toContain("data: value!: number|string");
    expect(line).toContain("copy: label!: string, trend: string");
  });

  /**
   * THE TYPE IS THE SCHEMA'S. The owner's complaint this format answers was that
   * a prop name alone never says what may be written beside it — and a type
   * written by hand in the renderer would answer it for exactly as long as the
   * schema stood still.
   *
   * So the expectation is read off the zod enum itself: a printer that hand-wrote
   * a vocabulary would fail here the moment the two disagreed. The literal beside
   * it is what makes a CHANGED enum go red rather than silently re-render — the
   * catalog is the model's whole idea of this prop, so its vocabulary moves
   * deliberately.
   */
  it("renders a prop's type from its own schema, enum values and all", () => {
    const mode = kitSpec("DateTime")!.props["mode"]!.schema as z.ZodEnum<[string, ...string[]]>;
    const fromSchema = mode.options.map((value) => JSON.stringify(value)).join("|");
    expect(body({ only: ["DateTime"] })[0]).toContain(`config: mode: ${fromSchema}`);
    expect(fromSchema).toBe('"date"|"time"|"datetime"|"relative"');
  });

  /** The shapes a name cannot carry: an object gives its FIELD names (the worked
   *  example shows what goes in them), a handler is a function rather than the
   *  string its wire-era schema still parses, and a slot holds elements. */
  it("prints objects, handlers and slots compactly", () => {
    expect(body({ only: ["DataTable"] })[0]).toContain("columns: {key?, label?, format?, align?, cell?}[]");
    expect(body({ only: ["Button"] })[0]).toContain("onClick: fn");
    expect(body({ only: ["Surface"] })[0]).toContain("header: element");
  });

  /** ONE example per component, indented under its line — the half a prop list
   *  cannot give, and taken from the same place `kitPrompt` takes it, so the two
   *  prompts can never show the model different idioms. */
  it("carries exactly one worked example per component", () => {
    expect(body().filter((line) => line.startsWith("  "))).toHaveLength(KIT_SPECS.length);
    expect(body({ only: ["Money"] })[1]).toBe(`  ${promptExamples(kitSpec("Money")!)[0]}`);
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
    expect(catalogPrompt()).toContain("`!` marks a required one");
    expect(catalogPrompt({ omitPreamble: true })).not.toContain("# The Kit");
  });

  /**
   * THE BUDGET, re-measured 2026-08-17 when types and one worked example apiece
   * went back into the line: 53 bricks, 227 icon names and 53 examples cost
   * 29,214 characters (~8.1k tokens), against the 20,396 the same 53 bricks cost
   * as bare prop NAMES. That growth is the change — a name alone never said what
   * may be written beside it — and it is bought against `kitPrompt`'s
   * section-per-brick catalog, which costs 36,291 for the same bricks with no
   * icon names at all.
   *
   * The ceiling is 32,000, and the per-brick bound is the half that bites: at 440
   * characters a brick — its line AND its example — the 55-brick kit lands near
   * 30,600 and still fits, while a brick that grew past 440 would break that
   * promise long before the total noticed. Both numbers move DELIBERATELY, in a
   * commit that says why.
   */
  it("stays under the section-per-brick catalog, with room for the 55-brick kit", () => {
    const prompt = catalogPrompt();
    expect(prompt.length).toBeLessThanOrEqual(32_000);
    expect(prompt.length).toBeLessThan(kitPrompt().length);
    const lines = body().filter((line) => line.startsWith("<") || line.startsWith("  "));
    expect(lines.join("\n").length / KIT_SPECS.length).toBeLessThanOrEqual(440);
  });
});
