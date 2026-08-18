import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { catalogPrompt } from "../../../src/contract/kit/catalog-prompt.js";
import { KIT_ICON_NAMES } from "../../../src/contract/kit/icon-names.gen.js";
import { kitPrompt, promptExamples } from "../../../src/contract/kit/kit-prompt.js";
import { KIT_SPECS, kitSpec } from "../../../src/contract/kit/specs.js";

const body = (options: Parameters<typeof catalogPrompt>[0] = {}) =>
  catalogPrompt({ ...options, omitPreamble: true }).split("\n");

/** One component's whole entry, as the model reads it. */
const entry = (name: string, options: Parameters<typeof catalogPrompt>[0] = {}) =>
  body({ ...options, only: [name] }).join("\n");

describe("catalogPrompt() — the whole catalog, one entry per component", () => {
  // The FORMAT is pinned against the spec's own prose rather than a copy of it:
  // a summary reworded in specs.ts is not a regression here, a changed shape is.
  //
  // The whole entry, line for line: the run-on line this replaced (everything
  // separated by mid-dots, the example jammed underneath) is exactly what a
  // partial assertion would let back in.
  it("renders a component as a heading, its summary, then typed props by class", () => {
    expect(body({ only: ["Money"] })).toEqual([
      "### <Money>",
      kitSpec("Money")!.summary,
      "- data: `value: number`",
      "- config: `currency: string`",
      `- example: \`${promptExamples(kitSpec("Money")!)[0]}\``,
    ]);
  });

  it("marks a required prop with `!` and leaves an optional one bare", () => {
    const stat = entry("Stat");
    expect(stat).toContain("- data: `value!: number|string`");
    expect(stat).toContain("- copy: `label!: string`, `trend: string`");
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
    expect(entry("DateTime")).toContain(`\`mode: ${fromSchema}\``);
    expect(fromSchema).toBe('"date"|"time"|"datetime"|"relative"');
  });

  /** The shapes a name cannot carry: an object gives its FIELD names (the worked
   *  example shows what goes in them), a handler is a function rather than the
   *  string its wire-era schema still parses, and a slot holds elements. */
  it("prints objects, handlers and slots compactly", () => {
    // The union is part of the shape: a column may be the bare KEY the preamble
    // teaches, or the described object — printing only one half would send the
    // model writing the other into a prop it thinks is illegal.
    expect(entry("DataTable")).toContain("`columns: (string|{key?, label?, header?, format?, durationUnit?, durationSigned?, align?, width?, truncate?, priority?, cell?})[]`");
    expect(entry("Button")).toContain("`onClick: fn`");
    expect(entry("Surface")).toContain("`header: element`");
  });

  /** ONE example per component, last line of its entry — the half a prop list
   *  cannot give, and taken from the same place `kitPrompt` takes it, so the two
   *  prompts can never show the model different idioms. */
  it("carries exactly one worked example per component", () => {
    expect(body().filter((line) => line.startsWith("- example: "))).toHaveLength(KIT_SPECS.length);
    expect(body({ only: ["Money"] }).at(-1)).toBe(`- example: \`${promptExamples(kitSpec("Money")!)[0]}\``);
  });

  it("leads with the data props — law 1 is the one an entry must not bury", () => {
    const lines = body({ only: ["DataTable"] });
    const at = (prefix: string) => lines.findIndex((line) => line.startsWith(prefix));
    expect(at("- data: `rows!")).toBeGreaterThan(-1);
    expect(at("- data: `rows!")).toBeLessThan(at("- config:"));
    expect(at("- config:")).toBeLessThan(at("- copy:"));
  });

  // Each adjective sits on the props of the components that read it so validation
  // admits it there; the preamble teaches it once, and restating it in 39 entries
  // would undo the compression the format exists for.
  it("never spends a line on the shared adjectives", () => {
    for (const name of ["DataTable", "Stat", "Card", "Divider"]) {
      const props = body({ only: [name] }).filter((line) => /^- (data|config|copy):/.test(line)).join("\n");
      expect(props, name).not.toContain("tone");
      expect(props, name).not.toContain("density");
    }
  });

  it("carries every slot with its doc on its own line, and marks the per-row ones", () => {
    expect(entry("DataTable")).toContain(`- slot \`cell\` (per row): ${kitSpec("DataTable")!.slots!["cell"]!.doc}`);
    // A non-per-row slot carries its doc WITHOUT the marker — without this the
    // per-row half is unfalsifiable, since marking every slot would still pass.
    const timeline = entry("Timeline");
    expect(timeline).toContain(`- slot \`marker\`: ${kitSpec("Timeline")!.slots!["marker"]!.doc}`);
    expect(timeline).not.toContain("slot `marker` (per row)");
  });

  it("teaches every registered component, one entry each, and nothing else", () => {
    const taught = body()
      .filter((line) => line.startsWith("### <"))
      .map((line) => line.slice("### <".length, line.indexOf(">")));
    expect(taught).toEqual(KIT_SPECS.map((spec) => spec.name));
  });

  it("merges the host's own components into the one list, marked [host]", () => {
    const host = [{ name: "AccountCard", description: "A Maple account with its balance." }];
    const lines = body({ host });
    expect(lines).toContain("### <AccountCard> [host]");
    expect(lines).toContain("A Maple account with its balance.");
    // One list: the host entry sits among the Kit's entries, not under a heading.
    expect(lines.filter((line) => line.startsWith("### <"))).toHaveLength(KIT_SPECS.length + 1);
    // …and `only` scopes both halves the same way.
    expect(body({ host, only: ["Money"] }).filter((line) => line.startsWith("### <"))).toHaveLength(1);
    expect(entry("AccountCard", { host })).toBe(
      "### <AccountCard> [host]\nA Maple account with its balance.",
    );
  });

  /** The vocabulary is NOT here: 227 names cost ~575 tokens on every generation,
   *  and an invented name fails the checks loudly rather than painting wrong, so
   *  `<Icon>`'s own summary — kebab-case, three real names, never invent one — is
   *  the whole teaching a model needs. */
  it("never spends the catalog on the icon vocabulary", () => {
    const prompt = catalogPrompt();
    expect(prompt).not.toContain("Icon names —");
    expect(prompt).not.toContain(KIT_ICON_NAMES.join(" "));
    // …and the closed set is still enforced, which is why the list can go.
    expect(KIT_ICON_NAMES.length).toBeGreaterThan(180);
  });

  it("leads with the data law and the legend, and drops them on request", () => {
    expect(catalogPrompt()).toContain("# The Kit");
    expect(catalogPrompt()).toContain("`!` marks a required one");
    expect(catalogPrompt({ omitPreamble: true })).not.toContain("# The Kit");
  });

  /**
   * THE BUDGET, re-measured 2026-08-18 after the second capability pass: 54
   * bricks cost 27,247 characters (~6.8k tokens) under a 3,878-character
   * preamble, against `kitPrompt`'s 41,004 for the same bricks as a section
   * apiece.
   *
   * The ceiling is 32,000, and the per-brick bound is the half that bites: at 510
   * characters a brick — heading, summary, props, slots AND example — the
   * 55-brick kit still fits (28,050 plus that preamble is 31,928), while a brick
   * that grew past 510 would break that promise long before the total noticed.
   *
   * Both numbers move DELIBERATELY, in a commit that says why. 490 → 500 was
   * CAPABILITY — a table column that says `width`, `truncate`, `priority` and
   * `header`, a duration that says which unit it holds, a button with an `icon`
   * and a `loading`, a series with its own `format`. 500 → 510 is the same coin:
   * a line chart formats its x axis (`xFormat`), a donut tones its own legend
   * (`tones`), a figure keeps the zeros it was written with
   * (`minimumFractionDigits`), a Card's description takes Kit marks, and `info`
   * joined the tone vocabulary on every value, badge and surface that takes one.
   * Each is a word the model was already writing into a prop the floor refused,
   * and the compact type walked off each schema is what carries them — so the
   * growth is in the derived half, not in prose. The ~5 characters of slack per
   * brick are the whole margin left: the next capability pays for itself in words
   * cut, because a bound with no room is a bound everyone learns to raise.
   */
  it("stays under the section-per-brick catalog, with room for the 55-brick kit", () => {
    const prompt = catalogPrompt();
    expect(prompt.length).toBeLessThanOrEqual(32_000);
    expect(prompt.length).toBeLessThan(kitPrompt().length);
    expect(body().join("\n").length / KIT_SPECS.length).toBeLessThanOrEqual(510);
  });
});
