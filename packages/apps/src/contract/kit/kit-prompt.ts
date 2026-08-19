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
  "paginate, and theme themselves.",
  "",
  "- Every `data` prop must trace to a tool call — a `useQuery` result.",
  "- Hand-typed business data is illegal; if no tool backs the ask, `<Disclaimer>`",
  "  is the legal move.",
  "",
  "## Prop classes",
  "",
  "- **config** tunes behavior · **copy** is text you may write · **data** must",
  "  come from a tool.",
  "",
  "## Formatting",
  "",
  "- YOU format every value, in your own code, with `Intl` — amounts, dates,",
  "  percentages, durations, counts: `(row.amount_cents / 100).toLocaleString(\"en-US\",",
  "  { style: \"currency\", currency: \"USD\" })`, `` `${pct}%` ``,",
  "  `new Date(row.due).toLocaleDateString(\"en-US\", { month: \"short\", day: \"numeric\" })`.",
  "  Use the currency the briefing names. Components never format — they display",
  "  and theme what you hand them, so a figure arrives as finished text.",
  "- Identifiers are mono: a sha, branch, id or code is `<Text variant=\"code\"/>`.",
  "",
  "## Two adjectives",
  "",
  "- **tone** (neutral | accent | info | success | warning | danger) on values,",
  "  badges, surfaces and buttons paints from the HOST's theme — the figure that is",
  "  bad news is `danger`, the one worth looking at is `accent`, and a state still",
  "  running is `info`. It is the word on a Button too: `variant` is the older",
  "  spelling of the same three (primary=accent, secondary=neutral, danger=danger).",
  "- **density** (comfortable | compact) on containers and data blocks tightens",
  "  everything inside; an operations screen is `compact`.",
  "",
  "## Rows, columns and layout",
  "",
  "- A per-row slot takes a FUNCTION of the row, and inside it you write that",
  "  row's own values — the formatting included:",
  "  `cell: (row) => <Text text={money(row.amount_cents)}/>`,",
  "  `rowActions={(row) => <Button label=\"Cancel\" onClick={() => tools.cancel_transfer({ id: row.id })}/>}`.",
  "  Define a `money`/`day` helper once at the top of the file and reuse it, rather",
  "  than spelling `toLocaleString` out in every cell.",
  "- A status-like enum column is an EnumBadge, never a bare word.",
  "- Where a field needs nothing said about it, write the bare KEY:",
  '  `columns={["client.name","amount"]}` is the same list of descriptions, and the',
  "  label comes from the key — the shorthand `Select.options` already takes.",
  "- Side by side stays side by side: Row and Grid WRAP as the frame narrows, so a",
  "  list beside the record it opens is a `<SplitPane>` — two panes, never wrapped,",
  "  each scrolling its own content, stacked only when the frame cannot hold both.",
  "- **grow** on a Stack, Row, Grid, Surface or Card takes the remaining space in",
  "  the container around it: `<Row><Stack grow>…</Stack><Button .../></Row>`.",
  "  There is no raw `<div style={{flex:1}}>` to reach for — the block that",
  "  stretches says so itself.",
  "- Every form control takes `disabled`, most take `required`, and a `hint`",
  "  line under the field; **style** takes inline CSS on any component's root,",
  "  yours winning over the theme's.",
].join("\n");

/**
 * The prompt's own examples, for the components whose canonical spec example is
 * written in an idiom the screen no longer has — a value component naming a
 * `field`, a slot holding an element — plus the few that spent characters
 * restating a shape the props above them already give.
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
  // Data off a `useQuery` result, never an inline call. The figure is FORMATTED in
  // the screen's own code — `money` here is the one-line helper the screen defines
  // once — and the component displays the finished text.
  Stat: ['<Stat label="Total overdue" value={money(overdue.total_cents)} tone="danger"><Sparkline data={overdue.trend}/></Stat>'],
  Avatar: ['<Row gap={6} align="center"><Avatar name={client.name}/><Text text={client.name}/></Row>'],
  // A per-row slot is a function of the row — the formatting, the arithmetic and
  // the control that a field binding could not hold.
  DataTable: ['<DataTable rows={invoices.data} sortBy="dueDate asc" columns={[{key:"client.name",label:"Client"},{key:"amount_cents",label:"Amount",align:"end",cell:(row) => <Text text={money(row.amount_cents)}/>},{key:"status",cell:(row) => <EnumBadge value={row.status} tones={{overdue:"danger"}}/>}]} rowActions={(row) => <Button label="Remind" onClick={() => tools.send_reminder({ id: row.id })}/>}/>'],
  TableRow: ['<TableRow key={row.id}><Text text={row.name}/><Text text={money(row.balance_cents)}/></TableRow>'],
  CardList: ['<CardList items={clients.data} titleField="name" badgeField="status" fields={[{key:"balance_cents",label:"Balance",cell:(item) => <Text text={money(item.balance_cents)}/>},{key:"plan"}]}/>'],
  KeyValue: ['<KeyValue record={invoice.data} items={[{key:"client.name",label:"Client"},{key:"amount_cents",label:"Amount",cell:(record) => <Text text={money(record.amount_cents)}/>}]} dividers/>'],
  // A chart reads its numbers BY KEY, so there is no cell to divide in: the `/ 100`
  // moves into the data prep. Both of these used to hand tool rows straight to
  // `format="money"`, and a screen that copied one rendered cents as dollars.
  LineChart: ['<LineChart data={revenue.data.map((r) => ({ ...r, amount: r.amount_cents / 100 }))} xKey="month" series={["amount"]} format="money"/>'],
  DonutChart: ['<DonutChart data={spend.data.map((r) => ({ ...r, amount: r.amount_cents / 100 }))} categoryKey="category" valueKey="amount" format="money"/>'],
  Timeline: ['<Timeline entries={payments.data} titleField="description" timeField="paidAt" timeAlign="end"/>'],
  CodeBlock: ['<CodeBlock language="json" code={webhook.data.payload}/>'],
  // Handlers are functions; every field is controlled.
  Button: ["<Button label=\"Cancel transfer\" tone=\"danger\" onClick={() => tools.cancel_transfer({ id: transfer.id })}/>"],
  Input: ['<Input label="Recipient" value={name} onChange={(e) => setName(e.target.value)}/>'],
  Textarea: ['<Textarea label="Note" rows={4} value={note} onChange={(e) => setNote(e.target.value)}/>'],
  Checkbox: ['<Checkbox label="Include paid" checked={paid} onChange={(e) => setPaid(e.target.checked)}/>'],
  DatePicker: ['<DatePicker label="Due date" value={due} onChange={(e) => setDue(e.target.value)}/>'],
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
  // Bare: a grid of tiles wraps on its own now, so the floor is not the lesson.
  Grid: ["<Grid><Stat .../><Stat .../><Stat .../><Stat .../></Grid>"],
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
  values: "Values (typography, pills and glyphs — you format the figure)",
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
