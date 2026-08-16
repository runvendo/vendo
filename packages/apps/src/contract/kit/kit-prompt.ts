/**
 * kitPrompt() — the GENERATED model-facing prompt section (W2 §The Kit).
 * Rendered entirely from `KIT_SPECS`; hand-written component lists are dead.
 * W3 wires this into the engine's wire contract (engine.ts).
 */
import { DISPLAY_TAG_NAMES } from "./display.js";
import { KIT_PREAMBLE_PROP_NAMES, KIT_SPECS, kitSlotPath } from "./specs.js";
import type { KitComponentSpec, PropClass } from "./schema.js";

export interface KitPromptOptions {
  /** Restrict output to these component names (e.g. an outline's section). */
  only?: string[];
  /** Omit the header preamble (the two laws) — default false. */
  omitPreamble?: boolean;
}

export const PREAMBLE = [
  "# The Kit",
  "",
  "Build the app from these components — you only fill props; they sort, filter,",
  "paginate, and format themselves. Two laws:",
  "1. Every `data` prop must trace to a tool call — a `useQuery` result. Hand-typed",
  "   business data is illegal; if no tool backs the ask, `<Disclaimer>` is the",
  "   legal move.",
  "2. An `on*` prop takes a FUNCTION, and calling a tool inside one is the only way",
  "   the UI changes anything: `onClick={() => tools.cancel_transfer({ id })}`.",
  "   Inputs are controlled: `value={x}` with `onChange={(e) => setX(e.target.value)}`.",
  "",
  "Prop classes: **config** tunes behavior · **copy** is text you may write ·",
  "**data** must come from a tool. Dates take ISO or epoch; percent takes a ratio",
  "(0.42 → 42%). Invalid numbers/dates never render.",
  "",
  "Money: formatters never convert units. `<Money>`, `format=\"money\"` and a",
  "`format:\"money\"` column all take an amount ALREADY in dollars, so divide a",
  "minor-unit field by 100 where you read it: `value={invoice.amount_cents / 100}`.",
  "",
  "Time and units, on the same rule. `format=\"duration\"` — a Stat, a column, a",
  "card or KeyValue field — reads a count of SECONDS: `268` → \"4m 28s\", so a",
  "minutes field is `* 60` where you read it. `unit` writes the word after a",
  "figure: `<Num value={svc.tail_latency_ms} unit=\"ms\"/>` → \"842 ms\". And",
  "`<DateTime compact/>` drops the year — \"Aug 7\", not \"Aug 7, 2026\".",
  "",
  "Two adjectives. **tone** (neutral | accent | success | warning | danger) on",
  "values, badges and surfaces paints from the HOST's theme — the figure that is",
  "bad news is `danger`, the one worth looking at is `accent`. **density**",
  "(comfortable | compact) on containers and data blocks tightens everything",
  "inside; an operations screen is `compact`.",
  "",
  "Leaving the theme. The theme is the DEFAULT and costs no props: set none and",
  "the app is brand-native. When the person asks for a particular look, every",
  "component takes `style` — inline CSS merged onto its root, your values winning",
  "— and a component that renders an engine (each one says which) takes that",
  "engine's own props too: `<Sparkline stroke=\"#FF3B30\"/>`, a recharts prop on one",
  "entry of a chart's `series`, a Base UI attribute on a control. An engine prop is the",
  "engine's, so it is passed through unchecked, must be a JSON value (a function",
  "there never arrives), and carries no compatibility promise — an engine upgrade",
  "may rename one, and an app that used it paints wrong until it is regenerated.",
  "So reach for the theme first and for these when the ask is specific.",
  "",
  "Cells are not sealed. A DataTable column and a CardList field each take a",
  "`cell` — Kit value components composed for ONE record — and a Stat takes them",
  "as children. Inside a cell a component names its field instead of taking a",
  'value: `cell:<EnumBadge field="status" tones={{overdue:"danger"}}/>`. A',
  "status-like enum column is an EnumBadge, never a bare word; an id or code rides",
  "under its name as a caption `Text` instead of costing a column. Only the value",
  "tier and Stack/Row go in a cell, and only containers take children — a Button",
  "in a cell, or anything nested in a chart, is REFUSED, not quietly dropped.",
  "",
  `Beside the Kit you have display-only HTML — \`${DISPLAY_TAG_NAMES.join("`, `")}\` —`,
  "taking children and an inline `style` and nothing else (no className, no id, no",
  "handlers). Arrange and typeset freely with them, off the host's own CSS",
  "variables (`var(--vendo-color-accent)`, `var(--vendo-density-content-gap)`) so",
  "the screen stays branded; a hard-coded color is yours, not the product's. There",
  "is no network here, so a style that fetches (`url(…)`) is dropped. Anything with",
  "BEHAVIOR — a table, a number, a date, a control — is still a Kit component.",
].join("\n");

/**
 * The prompt's own examples, for the components whose canonical spec example is
 * written in the RETIRED attribute style — a quoted tool name for a handler, an
 * inline tool call for data — plus the few that spent characters restating a shape
 * the props above them already give.
 *
 * A screen is a React component now, so those examples taught a shape nothing
 * compiles. The props are still rendered from `KIT_SPECS`, which is the half that
 * must never drift; an example is teaching prose, and a component absent from this
 * map renders its spec example unchanged — so a component added to the specs
 * arrives with its own example the day it is created.
 *
 * These belong in `specs.ts` beside the props they document, and go back the
 * moment its other consumers can take the new idiom; until then this map is the
 * one place to read what the model is actually shown.
 */
const PROMPT_EXAMPLES: Readonly<Record<string, readonly string[]>> = {
  // Data off a `useQuery` result, never an inline call.
  Money: ["<Money amount={invoice.amount_cents / 100}/>"],
  Stat: ['<Stat label="Total overdue" value={overdue.total_cents / 100} format="money" tone="danger"><Sparkline data={overdue.trend}/></Stat>'],
  DataTable: [
    '<DataTable rows={invoices.data} sortBy="dueDate asc" columns={[{key:"client.name",label:"Client",cell:<Stack gap={2}><Text field="client.name"/><Text field="number" variant="caption"/></Stack>},{key:"amount",format:"money",align:"end"},{key:"dueDate",format:"date"},{key:"status",label:"Status",cell:<EnumBadge field="status" tones={{overdue:"danger",paid:"success"}}/>}]} emptyState="No overdue invoices"/>',
  ],
  CardList: ['<CardList items={clients.data} titleField="name" badgeField="status" fields={[{key:"balance",label:"Balance",format:"money"},{key:"plan",cell:<EnumBadge field="plan"/>}]}/>'],
  LineChart: ['<LineChart data={revenue.data} xKey="month" series={["amount"]} format="money"/>'],
  DonutChart: ['<DonutChart data={spend.data} categoryKey="category" valueKey="amount" format="money"/>'],
  // Handlers are functions; every field is controlled.
  Button: ["<Button label=\"Cancel transfer\" variant=\"danger\" onClick={() => tools.cancel_transfer({ id: transfer.id })}/>"],
  Input: ['<Input label="Recipient" value={name} onChange={(e) => setName(e.target.value)}/>'],
  Textarea: ['<Textarea label="Note" rows={4} value={note} onChange={(e) => setNote(e.target.value)}/>'],
  Checkbox: ['<Checkbox label="Include paid" checked={paid} onChange={(e) => setPaid(e.target.checked)}/>'],
  DatePicker: ['<DatePicker label="Due date" value={due} onChange={(e) => setDue(e.target.value)}/>'],
  // No `value` prop on Select — the spec has none, and a prop that does not exist
  // fails the checks — so this one shows the handler only.
  Select: ['<Select label="Client" options={clients.data} labelField="name" valueField="id" onChange={(e) => setClientId(e.target.value)}/>'],
  Form: ['<Form onSubmit={() => tools.create_client({ name })} submitLabel="Add client"><Input .../></Form>'],
  // Containers: the child shape is the teaching, not the child's own props.
  Card: ['<Card title="Overdue" description="Worst first"><DataTable .../></Card>'],
  Grid: ["<Grid minChildWidth={160}><Stat .../><Stat .../><Stat .../><Stat .../></Grid>"],
  Tabs: ['<Tabs tabs={["Overview","Detail"]}><Stat .../><DataTable .../></Tabs>'],
};

function classTag(cls: PropClass): string {
  return cls;
}

function renderSpec(spec: KitComponentSpec): string {
  const lines: string[] = [`## <${spec.name}>`, spec.summary, ""];
  // The shared adjectives sit in the props of every component that reads one, and
  // `style` on all fifty, so validation and the screen typings admit them there;
  // the preamble teaches them once, and restating them per component would spend
  // a fifth of the catalog.
  const props = Object.entries(spec.props).filter(([name]) => !KIT_PREAMBLE_PROP_NAMES.includes(name));
  if (props.length > 0) {
    lines.push("Props:");
    for (const [name, prop] of props) {
      const req = prop.required ? " (required)" : "";
      lines.push(`- \`${name}\` [${classTag(prop.cls)}]${req} — ${prop.doc}`);
    }
    // WHICH engine, beside the props, because the preamble can only say that some
    // components have one: without the name the model cannot know whose
    // vocabulary it is reaching for.
    if (spec.engine !== undefined) lines.push(`- plus any \`${spec.engine}\` prop, passed straight through`);
    lines.push("");
  }
  // The slots, from the same declaration the nesting check enforces: a place
  // that takes an ELEMENT is unguessable from a prop list, and one written where
  // no slot was declared is refused.
  const slots = Object.entries(spec.slots ?? {});
  if (slots.length > 0) {
    lines.push("Slots:");
    for (const [name, slot] of slots) {
      // The PATH, not the bare name: a component reads its slot at exactly one
      // place, so teaching `cell` where the table reads `columns[].cell` is
      // teaching a value the renderer drops.
      lines.push(`- \`${kitSlotPath(name, slot)}\` [slot]${slot.perRow === true ? " (per row)" : ""} — ${slot.doc}`);
    }
    lines.push("");
  }
  const examples = PROMPT_EXAMPLES[spec.name] ?? spec.examples;
  lines.push(examples.length > 1 ? "Examples:" : "Example:");
  for (const ex of examples) lines.push("  " + ex);
  return lines.join("\n");
}

const GROUP_ORDER = ["layout", "values", "data", "charts", "forms", "feedback", "overlays"];
const GROUP_TITLE: Record<string, string> = {
  layout: "Layout",
  values: "Values (semantic — formatted for you)",
  data: "Data",
  charts: "Charts",
  forms: "Forms & actions",
  feedback: "Feedback & interactive",
  overlays: "Overlays",
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
