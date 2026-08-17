/**
 * catalogPrompt() — the WHOLE catalog as one line per component, plus that
 * component's one worked example under it.
 *
 * `kitPrompt` spends a section on every brick (props with docs, slots with docs,
 * a worked example) and costs ~680 characters each. That is affordable at 39
 * bricks and not at 55, and it teaches the Kit and the host's own components in
 * two different places and two different shapes. This renders both as ONE list:
 * what the component is, its props by class WITH THEIR TYPES, its slots, one
 * example — and the icon vocabulary once at the end, which no prompt has ever
 * carried, so the model stops inventing glyph names.
 *
 * The compression is the per-prop docs and the second example. What a prop takes
 * is not compressible: a name alone says nothing about whether `mode` wants a
 * word from a closed list, a number or a function, and the model that guesses
 * wrong writes a prop the validator drops. So every prop carries a COMPACT type
 * walked off its own zod schema ({@link typeText}), and the one example shows
 * the shape filled in. Both are derived, so neither can drift from the specs.
 *
 * The preamble is `kitPrompt`'s, unchanged — the two laws do not depend on the
 * layout.
 */
import type { ZodTypeAny } from "zod";
import { zodShape } from "./zod-shape.js";
import { KIT_ICON_NAMES } from "./icon-names.gen.js";
import { PREAMBLE, promptExamples } from "./kit-prompt.js";
import {
  ACTION_PROP_DESCRIPTION,
  KIT_PREAMBLE_PROP_NAMES,
  KIT_SPECS,
  SLOT_PROP_DESCRIPTION,
} from "./specs.js";
import type { KitComponentSpec, PropClass } from "./schema.js";
import type { CatalogSummaryEntry } from "../briefing.js";

export interface CatalogPromptOptions {
  /** Restrict output to these component names (e.g. an outline's section). */
  only?: string[];
  /** This host's own components, from the briefing pack's one-line reduction. */
  host?: readonly CatalogSummaryEntry[];
  /** Omit the header preamble (the two laws) — default false. */
  omitPreamble?: boolean;
}

/** How to read a line. The classes themselves are taught in `PREAMBLE`. */
const LEGEND = [
  "",
  "One line per component: `<Name>` what it is, then its props grouped by class,",
  "then its slots, then ONE worked example indented under it. A prop reads",
  "`name: type` and `!` marks a required one; `fn` is a function you write and",
  "`element` is Kit elements. A line marked `[host]` is one of THIS host's own",
  "components — write it like any other, props as it describes.",
].join("\n");

/** data first: law 1 is the one a line must not bury. */
const CLASS_ORDER: readonly PropClass[] = ["data", "config", "copy"];

/**
 * A prop's type, COMPACT, walked off its own zod schema — nothing here is
 * hand-written, so a schema that changes changes the prompt in the same commit.
 * The Kit's zod vocabulary is closed (it is our own schema file), so a direct
 * walker beats a converter dependency, exactly as in `checking/screen-typings.ts`.
 *
 * Compact is the whole point: this text rides EVERY generation, so an object
 * gives its field NAMES (`{key, label?, format?}`) rather than their types, and
 * the worked example under the line shows what actually goes in them. The two
 * schemas that are not what they parse as are named by their description — an
 * `on*` prop is a function the screen writes, a slot holds elements — and
 * anything outside the vocabulary degrades to `any` rather than to a lie.
 */
const typeText = (schema: ZodTypeAny | undefined): string => {
  const shape = zodShape(schema);
  switch (shape.kind) {
    case "string":
      return schema?.description === ACTION_PROP_DESCRIPTION ? "fn" : "string";
    case "number": return "number";
    case "boolean": return "boolean";
    case "unknown":
    case "any":
      return schema?.description === SLOT_PROP_DESCRIPTION ? "element" : "any";
    case "enum":
      return (shape.values ?? []).map((value) => JSON.stringify(value)).join("|");
    case "union":
      return (shape.options ?? []).map((option) => typeText(option)).join("|");
    case "array": {
      const item = typeText(shape.inner);
      return item.includes("|") ? `(${item})[]` : `${item}[]`;
    }
    case "record":
      return `{[key]: ${typeText(shape.valueType)}}`;
    case "object": {
      const fields = Object.entries(shape.shape ?? {}).map(([name, field]) =>
        `${name}${zodShape(field).kind === "optional" ? "?" : ""}`);
      return `{${fields.join(", ")}}`;
    }
    case "nullable":
      return `${typeText(shape.inner)}|null`;
    case "optional":
      return typeText(shape.inner);
    default: return "any";
  }
};

function catalogLine(spec: KitComponentSpec): string {
  const parts = [`<${spec.name}> ${spec.summary}`];
  for (const cls of CLASS_ORDER) {
    // The shared adjectives ride every component that reads one and `style` rides
    // all of them; the preamble teaches both, and 39 restatements would undo the
    // compression.
    const props = Object.entries(spec.props)
      .filter(([name, prop]) => prop.cls === cls && !KIT_PREAMBLE_PROP_NAMES.includes(name))
      .map(([name, prop]) => `${name}${prop.required === true ? "!" : ""}: ${typeText(prop.schema)}`);
    if (props.length > 0) parts.push(`${cls}: ${props.join(", ")}`);
  }
  // The engine's NAME, which the preamble cannot supply: it can say that some
  // components pass props through, not whose vocabulary each one speaks.
  if (spec.engine !== undefined) parts.push(`plus any ${spec.engine} prop`);
  for (const [name, slot] of Object.entries(spec.slots ?? {})) {
    parts.push(`slot ${name}${slot.perRow === true ? " (per row)" : ""}: ${slot.doc}`);
  }
  // ONE example, indented under the line. A prop list says what MAY be written
  // and never what a filled-in component looks like; the second example a spec
  // carries mostly repeats the first's lesson, and this text rides every
  // generation, so the catalog buys one apiece and no more.
  const example = promptExamples(spec)[0];
  const line = parts.join(" · ");
  return example === undefined ? line : `${line}\n  ${example}`;
}

const hostLine = (entry: CatalogSummaryEntry): string => `<${entry.name}> [host] ${entry.description}`;

const ICONS = `Icon names — \`<Icon name>\` and every \`icon\` prop take one of these and nothing else:\n${KIT_ICON_NAMES.join(" ")}`;

/** Render the whole catalog — Kit then host — from the schemas. */
export function catalogPrompt(options: CatalogPromptOptions = {}): string {
  const wanted = (name: string): boolean => options.only === undefined || options.only.includes(name);
  const lines = [
    ...KIT_SPECS.filter((spec) => wanted(spec.name)).map(catalogLine),
    ...(options.host ?? []).filter((entry) => wanted(entry.name)).map(hostLine),
  ];
  const sections = options.omitPreamble === true ? [] : [PREAMBLE + LEGEND];
  sections.push(lines.join("\n"), ICONS);
  return sections.join("\n\n");
}
