/**
 * catalogPrompt() — the WHOLE catalog as one line per component.
 *
 * `kitPrompt` spends a section on every brick (props with docs, slots with docs,
 * a worked example) and costs ~550 characters each. That is affordable at 39
 * bricks and not at 55, and it teaches the Kit and the host's own components in
 * two different places and two different shapes. This renders both as ONE list,
 * one line apiece: what the component is, its props by class, its slots — and
 * the icon vocabulary once at the end, which no prompt has ever carried, so the
 * model stops inventing glyph names.
 *
 * The compression is the examples and the per-prop docs. Prop NAMES, classes,
 * required markers and slot docs stay: a name the model spells wrong is a
 * dropped prop, and a slot is unguessable from a prop list. The preamble is
 * `kitPrompt`'s, unchanged — the two laws do not depend on the layout.
 */
import { KIT_ICON_NAMES } from "./icon-names.gen.js";
import { PREAMBLE } from "./kit-prompt.js";
import { KIT_SHARED_PROP_NAMES, KIT_SPECS } from "./specs.js";
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
  "then its slots. `!` marks a required prop. A line marked `[host]` is one of",
  "THIS host's own components — write it like any other, props as it describes.",
].join("\n");

/** data first: law 1 is the one a line must not bury. */
const CLASS_ORDER: readonly PropClass[] = ["data", "config", "copy"];

function catalogLine(spec: KitComponentSpec): string {
  const parts = [`<${spec.name}> ${spec.summary}`];
  for (const cls of CLASS_ORDER) {
    // The shared adjectives ride every component that reads one; the preamble
    // teaches them once, and 39 restatements would undo the compression.
    const names = Object.entries(spec.props)
      .filter(([name, prop]) => prop.cls === cls && !KIT_SHARED_PROP_NAMES.includes(name))
      .map(([name, prop]) => (prop.required === true ? `${name}!` : name));
    if (names.length > 0) parts.push(`${cls}: ${names.join(" ")}`);
  }
  for (const [name, slot] of Object.entries(spec.slots ?? {})) {
    parts.push(`slot ${name}${slot.perRow === true ? " (per row)" : ""}: ${slot.doc}`);
  }
  return parts.join(" · ");
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
