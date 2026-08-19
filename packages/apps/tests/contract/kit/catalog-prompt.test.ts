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
    expect(body({ only: ["Avatar"] })).toEqual([
      "### <Avatar>",
      kitSpec("Avatar")!.summary,
      "- data: `name!: string`",
      '- config: `size: "sm"|"md"|"lg"`',
      `- example: \`${promptExamples(kitSpec("Avatar")!)[0]}\``,
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
   * deliberately. A Button's `variant` is the enum this is measured on now that
   * the charts' axis tokens are gone: their `format` was the last format token in
   * the Kit, and it is a function the screen writes rather than a word it picks.
   */
  it("renders a prop's type from its own schema, enum values and all", () => {
    const variant = kitSpec("Button")!.props["variant"]!.schema as z.ZodEnum<[string, ...string[]]>;
    const fromSchema = variant.options.map((value) => JSON.stringify(value)).join("|");
    expect(entry("Button")).toContain(`\`variant: ${fromSchema}\``);
    expect(fromSchema).toBe('"primary"|"secondary"|"danger"');
  });

  /** A FORMATTER prints as `fn`, not as `element`: it is a function the model
   *  writes, and calling it an element would send it composing a component where a
   *  chart wants one finished string. The tokens it replaced printed as an enum. */
  it("offers a chart's formatter as a function, never as a token or an element", () => {
    expect(entry("DonutChart")).toContain("`format: fn`");
    expect(entry("LineChart")).toContain("`xFormat: fn`");
    expect(entry("DonutChart")).not.toContain('"money"');
  });

  /** The shapes a name cannot carry: an object gives its FIELD names (the worked
   *  example shows what goes in them), a handler is a function rather than the
   *  string its wire-era schema still parses, and a slot holds elements. */
  it("prints objects, handlers and slots compactly", () => {
    // The union is part of the shape: a column may be the bare KEY the preamble
    // teaches, or the described object — printing only one half would send the
    // model writing the other into a prop it thinks is illegal.
    expect(entry("DataTable")).toContain("`columns: (string|{key?, label?, header?, align?, width?, truncate?, priority?, cell?})[]`");
    expect(entry("Button")).toContain("`onClick: fn`");
    expect(entry("Surface")).toContain("`header: element`");
  });

  /** ONE example per component, last line of its entry — the half a prop list
   *  cannot give, and taken from the same place `kitPrompt` takes it, so the two
   *  prompts can never show the model different idioms. */
  it("carries exactly one worked example per component", () => {
    expect(body().filter((line) => line.startsWith("- example: "))).toHaveLength(KIT_SPECS.length);
    expect(body({ only: ["Avatar"] }).at(-1)).toBe(`- example: \`${promptExamples(kitSpec("Avatar")!)[0]}\``);
  });

  /**
   * A CHOICE A PERSON CAN TELL APART. `labelField` names ONE field, and the entry
   * used to forbid the alternative in the same breath it taught that — "no
   * reshaping" — so an ask for the plans with their prices beside them got a list
   * of bare names and the price nowhere on the screen at all.
   *
   * A native `<option>` shows TEXT (`ui` forms/select.tsx), so one string composed
   * in the same `.map` that prepared the rows is the whole fix, and no prop had to
   * be invented for it. What the entry has to carry is the composition, because a
   * model reads the example long before it reads the prose.
   */
  it("composes a Select label in data prep rather than forbidding it", () => {
    const select = entry("Select");
    expect(select).not.toContain("no reshaping");
    expect(select).toContain("options={plans.data.map(");
    expect(select).toContain('labelField="label"');
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
    expect(body({ host, only: ["Avatar"] }).filter((line) => line.startsWith("### <"))).toHaveLength(1);
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
   * THE BUDGET, re-measured 2026-08-18 after the value tier's death: 50 bricks
   * cost 25,629 characters (~6.4k tokens) under a 3,311-character preamble, for
   * 28,940 in all, against `kitPrompt`'s 38,785 for the same bricks as a section
   * apiece.
   *
   * The ceiling is 32,000, and the per-brick bound is the half that bites: at 520
   * characters a brick — heading, summary, props, slots AND example — the
   * 55-brick kit still fits (28,600 plus that preamble is 31,911), while a brick
   * that grew past 520 would break that promise long before the total noticed.
   *
   * Both numbers move DELIBERATELY, in a commit that says why. 490 → 500 → 510 was
   * CAPABILITY, twice: a table column that says `width`, `truncate`, `priority`
   * and `header`, a button with an `icon` and a `loading`, a line chart that
   * formats its x axis (`xFormat`), a donut that tones its own legend (`tones`), a
   * Card description that takes Kit marks, `info` in the tone vocabulary.
   *
   * 510 → 520 is not capability at all — it is SUBTRACTION landing on an average.
   * `Money`, `Percent`, `Num` and `DateTime` went with the value-formatting tier,
   * and a value component was the smallest entry the catalog had: one data prop, one
   * config prop and a one-line example apiece. Deleting the four cheapest bricks
   * takes more off the divisor than off the total, so the same catalog now reads
   * 512.6 characters a brick where it read under 510 with them in it. No brick grew;
   * the total FELL. The bound is re-derived the way it always was — the largest
   * average at which a 55-brick kit still clears 32,000 — and the ~7 characters of
   * slack per brick are the whole margin left, so the next capability pays for
   * itself in words cut.
   *
   * And the next capability DID: the charts' `format` tokens became the screen's
   * own per-row functions, which costs each chart a slot line the prop list cannot
   * carry (the arity is the teaching). 512.6 → 519.8, paid for by cutting the three
   * chart summaries back and by dropping from every new slot doc the `(row) =>`
   * fragment its worked example already shows. The bound did not move; 0.2
   * characters a brick is what is left of the margin.
   */
  it("stays under the section-per-brick catalog, with room for the 55-brick kit", () => {
    const prompt = catalogPrompt();
    expect(prompt.length).toBeLessThanOrEqual(32_000);
    expect(prompt.length).toBeLessThan(kitPrompt().length);
    expect(body().join("\n").length / KIT_SPECS.length).toBeLessThanOrEqual(520);
  });
});
