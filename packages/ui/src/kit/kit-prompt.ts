/**
 * kitPrompt() — the GENERATED model-facing prompt section (W2 §The Kit).
 * Rendered entirely from `KIT_SPECS`; hand-written component lists are dead.
 * W3/W4 wire this into engine.ts; here we only build + test the generator.
 */
import { KIT_SPECS } from "./registry.js";
import type { KitComponentSpec, PropClass } from "./schema.js";

export interface KitPromptOptions {
  /** Restrict output to these component names (e.g. an outline's section). */
  only?: string[];
  /** Omit the header preamble (the two laws) — default false. */
  omitPreamble?: boolean;
}

const PREAMBLE = [
  "# The Kit",
  "",
  "Build the app from these components — you only fill props; they sort, filter,",
  "paginate, and format themselves. Two laws:",
  "1. Every `data` prop must trace to a tool call. Hand-typed business data is",
  "   illegal — if no tool backs the ask, the `<Disclaimer>` is the legal move.",
  "2. Interactivity is action-gated: an `on*` prop NAMES a host tool; that is the",
  "   only way the UI mutates.",
  "",
  "Prop classes: **config** tunes behavior · **copy** is text you may write ·",
  "**data** must come from a tool. Money takes integer CENTS; dates take ISO or",
  "epoch; percent takes a ratio (0.42 → 42%). Invalid numbers/dates never render.",
].join("\n");

function classTag(cls: PropClass): string {
  return cls;
}

function renderSpec(spec: KitComponentSpec): string {
  const lines: string[] = [`## <${spec.name}>`, spec.summary, ""];
  const props = Object.entries(spec.props);
  if (props.length > 0) {
    lines.push("Props:");
    for (const [name, prop] of props) {
      const req = prop.required ? " (required)" : "";
      lines.push(`- \`${name}\` [${classTag(prop.cls)}]${req} — ${prop.doc}`);
    }
    lines.push("");
  }
  lines.push(spec.examples.length > 1 ? "Examples:" : "Example:");
  for (const ex of spec.examples) lines.push("  " + ex);
  return lines.join("\n");
}

const GROUP_ORDER = ["layout", "values", "data", "charts", "forms", "feedback"];
const GROUP_TITLE: Record<string, string> = {
  layout: "Layout",
  values: "Values (semantic — formatted for you)",
  data: "Data",
  charts: "Charts",
  forms: "Forms & actions",
  feedback: "Feedback & interactive",
};

/** Render the generation prompt section from the schemas. */
export function kitPrompt(options: KitPromptOptions = {}): string {
  const specs = options.only
    ? KIT_SPECS.filter((s) => options.only!.includes(s.name))
    : KIT_SPECS;

  const byGroup = new Map<string, KitComponentSpec[]>();
  for (const spec of specs) {
    const group = spec.group ?? "other";
    (byGroup.get(group) ?? byGroup.set(group, []).get(group)!).push(spec);
  }

  const sections: string[] = [];
  if (!options.omitPreamble) sections.push(PREAMBLE);

  const groups = [...byGroup.keys()].sort(
    (a, b) => (GROUP_ORDER.indexOf(a) + 1 || 99) - (GROUP_ORDER.indexOf(b) + 1 || 99),
  );
  for (const group of groups) {
    // A group heading only when we're rendering the full catalog (scoped output
    // reads better as a flat list of the requested components).
    if (!options.only) sections.push(`# ${GROUP_TITLE[group] ?? group}`);
    for (const spec of byGroup.get(group)!) sections.push(renderSpec(spec));
  }
  return sections.join("\n\n");
}
