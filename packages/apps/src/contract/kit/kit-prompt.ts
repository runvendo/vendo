/**
 * kitPrompt() — the GENERATED model-facing prompt section (W2 §The Kit).
 * Rendered entirely from `KIT_SPECS`; hand-written component lists are dead.
 * W3 wires this into the engine's wire contract (engine.ts).
 */
import { KIT_PREAMBLE_PROP_NAMES, KIT_SPECS, kitSlotPath } from "./specs.js";
import type { KitComponentSpec, PropClass } from "./schema.js";

export interface KitPromptOptions {
  /** Restrict output to these component names (e.g. an outline's section). */
  only?: string[];
  /** Omit the header preamble (the data law) — default false. */
  omitPreamble?: boolean;
}

export const PREAMBLE = [
  "# The Kit",
  "",
  "Build the app from these components — you only fill props; they sort, filter,",
  "paginate, and format themselves. Every `data` prop must trace to a tool call —",
  "a `useQuery` result. Hand-typed business data is illegal; if no tool backs the",
  "ask, `<Disclaimer>` is the legal move.",
  "",
  "Prop classes: **config** tunes behavior · **copy** is text you may write ·",
  "**data** must come from a tool. Dates take ISO or epoch. Invalid numbers and",
  "dates never render.",
  "",
  "Every component FORMATS what you hand it and converts nothing. `<Money>` and",
  "`format=\"money\"` take DOLLARS, so divide a `_cents` field by 100 where you",
  "prepare the data: `value={invoice.amount_cents / 100}`. Forget, and the screen",
  "is wrong by 100×. `<Percent>` prints the number it is given — `42.5` is",
  "\"42.5%\" — so a ratio is `* 100` where you read it, and nothing is rounded that",
  "you did not round.",
  "",
  "Identifiers are mono: a sha, branch, id or code is `<Text variant=\"code\"/>` or",
  "a `format:\"code\"` column or field.",
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
  "A per-row slot takes a FUNCTION of the row, and inside it you write that row's",
  "own values: `cell: (row) => <Money value={row.amount_cents / 100}/>`,",
  "`rowActions={(row) => <Button label=\"Cancel\" onClick={() => tools.cancel_transfer({ id: row.id })}/>}`.",
  "A status-like enum column is an EnumBadge, never a bare word. Where a field",
  'needs nothing said about it, write the bare KEY: `columns={["client.name","amount"]}`',
  "is the same list of descriptions, and the label comes from the key — the",
  "shorthand `Select.options` already takes.",
  "",
  "Side by side stays side by side. Row and Grid WRAP as the frame narrows, so a",
  "list beside the record it opens is a `<SplitPane>` — two panes, never wrapped,",
  "each scrolling its own content.",
].join("\n");

/**
 * The prompt's own examples, for the components whose canonical spec example is
 * written in an idiom the screen no longer has — a value component naming a
 * `field`, a slot holding an element, `<Money amount>` — plus the few that spent
 * characters restating a shape the props above them already give.
 *
 * The props are still rendered from `KIT_SPECS`, which is the half that must never
 * drift; an example is teaching prose, and a component absent from this map
 * renders its spec example unchanged — so a component added to the specs arrives
 * with its own example the day it is created.
 *
 * These belong in `specs.ts` beside the props they document, and go back the
 * moment its other consumers can take the new idiom; until then this map is the
 * one place to read what the model is actually shown.
 */
const PROMPT_EXAMPLES: Readonly<Record<string, readonly string[]>> = {
  // Data off a `useQuery` result, never an inline call. The value the component
  // shows is already in the units it formats.
  Money: ["<Money value={invoice.amount_cents / 100}/>"],
  Percent: ["<Percent value={(goal.saved / goal.target) * 100}/>"],
  Stat: ['<Stat label="Total overdue" value={overdue.total_cents / 100} format="money" tone="danger"><Sparkline data={overdue.trend}/></Stat>'],
  Avatar: ['<Row gap={6} align="center"><Avatar name={client.name}/><Text text={client.name}/></Row>'],
  // A per-row slot is a function of the row — the arithmetic and the control that
  // a field binding could not hold.
  DataTable: ['<DataTable rows={invoices.data} sortBy="dueDate asc" columns={[{key:"client.name",label:"Client"},{key:"amount_cents",label:"Amount",align:"end",cell:(row) => <Money value={row.amount_cents / 100}/>},{key:"status",cell:(row) => <EnumBadge value={row.status} tones={{overdue:"danger"}}/>}]} rowActions={(row) => <Button label="Remind" onClick={() => tools.send_reminder({ id: row.id })}/>}/>'],
  TableRow: ['<TableRow key={row.id}><Text text={row.name}/><Money value={row.balance_cents / 100}/></TableRow>'],
  CardList: ['<CardList items={clients.data} titleField="name" badgeField="status" fields={[{key:"balance_cents",label:"Balance",cell:(item) => <Money value={item.balance_cents / 100}/>},{key:"plan"}]}/>'],
  KeyValue: ['<KeyValue record={invoice.data} items={[{key:"client.name",label:"Client"},{key:"amount_cents",label:"Amount",cell:(record) => <Money value={record.amount_cents / 100}/>}]} dividers/>'],
  LineChart: ['<LineChart data={revenue.data} xKey="month" series={["amount"]} format="money"/>'],
  DonutChart: ['<DonutChart data={spend.data} categoryKey="category" valueKey="amount" format="money"/>'],
  Timeline: ['<Timeline entries={payments.data} titleField="description" timeField="paidAt" timeAlign="end"/>'],
  CodeBlock: ['<CodeBlock language="json" code={webhook.data.payload}/>'],
  // Handlers are functions; every field is controlled.
  Button: ["<Button label=\"Cancel transfer\" variant=\"danger\" onClick={() => tools.cancel_transfer({ id: transfer.id })}/>"],
  Input: ['<Input label="Recipient" value={name} onChange={(e) => setName(e.target.value)}/>'],
  Textarea: ['<Textarea label="Note" rows={4} value={note} onChange={(e) => setNote(e.target.value)}/>'],
  Checkbox: ['<Checkbox label="Include paid" checked={paid} onChange={(e) => setPaid(e.target.checked)}/>'],
  DatePicker: ['<DatePicker label="Due date" value={due} onChange={(e) => setDue(e.target.value)}/>'],
  Select: ['<Select label="Client" options={clients.data} labelField="name" valueField="id" value={clientId} onChange={(e) => setClientId(e.target.value)}/>'],
  Form: ['<Form onSubmit={() => tools.create_client({ name })} submitLabel="Add client" disabled={!name.trim()}><Input .../></Form>'],
  EmptyState: ['<EmptyState icon="inbox" title="No invoices yet" description="They show up here the moment one is issued."><Button label="New invoice" onClick={() => tools.create_invoice({})}/></EmptyState>'],
  // The overlays: `open` is state the screen holds, and `onClose` is the setter
  // that takes it down. The Modal puts its action LAST in `footer`, which is where
  // the chapter sends it.
  Modal: ['<Modal open={confirming} onClose={() => setConfirming(false)} title="Send reminders?" description="Three clients will be emailed." footer={<Button label="Send" onClick={() => tools.send_reminders({})}/>}/>'],
  Sheet: ['<Sheet open={viewing} onClose={() => setViewing(false)} title="Invoice INV-204" side="right"><KeyValue record={invoice.data} items={["client.name","status"]}/></Sheet>'],
  Toast: ['<Toast open={sent} onClose={() => setSent(false)} message="Reminders sent." tone="success"/>'],
  // Containers: the child shape is the teaching, not the child's own props.
  Card: ['<Card title="Overdue" description="Worst first"><DataTable .../></Card>'],
  Grid: ["<Grid minChildWidth={160}><Stat .../><Stat .../><Stat .../><Stat .../></Grid>"],
  Tabs: ['<Tabs tabs={["Overview","Detail"]}><Stat .../><DataTable .../></Tabs>'],
};

/** What the model is SHOWN for a component: the corrected example where one
 *  exists, the spec's own otherwise. Both prompts read this, so neither can show
 *  an idiom the other has retired. */
export const promptExamples = (spec: KitComponentSpec): readonly string[] =>
  PROMPT_EXAMPLES[spec.name] ?? spec.examples;

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
  const examples = promptExamples(spec);
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
