/**
 * The Kit specs (W2 §The Kit, hoisted to core in W3 so the generation engine
 * can consume them — apps → core is the only allowed edge). One
 * `KitComponentSpec` per component: zod schemas, prop classes
 * (config | copy | data), docs, and canonical examples. This is the SINGLE
 * source for `kitPrompt()` (the generated model-facing prompt), the wire
 * compiler's component-name resolution, the engine's prop-name validation,
 * and the law-1 data-prop check. The React implementations live in
 * `@vendoai/ui`'s `KIT_COMPONENTS`, keyed by these names (a ui drift test
 * pins the two in step).
 */
import { z } from "zod";
import { PREWIRED_COMPONENT_NAMES } from "../tree-limits.js";
import { config, copy, data, type KitComponentSpec, type PropClass } from "./schema.js";

// ---- shared zod fragments -------------------------------------------------
const rows = z.array(z.record(z.string(), z.unknown()));
const valueFormat = z.enum(["money", "date", "datetime", "time", "percent", "number", "text"]);
const align = z.enum(["start", "center", "end"]);
const seriesInput = z.array(z.union([z.string(), z.object({ key: z.string(), label: z.string().optional() })]));
const tableColumn = z.object({
  key: z.string(),
  label: z.string().optional(),
  format: valueFormat.optional(),
  align: align.optional(),
});
const cardField = z.object({ key: z.string(), label: z.string().optional(), format: valueFormat.optional() });
const action = z.string().describe("names a host tool");

// ---- specs ---------------------------------------------------------------
export const KIT_SPECS: KitComponentSpec[] = [
  // Layout
  {
    name: "Stack",
    group: "layout",
    summary: "Vertical flow of children. The default container for a section.",
    props: { gap: config(z.number(), "pixels between children") },
    examples: ["<Stack gap={12}><Stat .../><DataTable .../></Stack>"],
  },
  {
    name: "Row",
    group: "layout",
    summary: "Horizontal flow; wraps by default. Use for a row of stats or buttons.",
    props: {
      gap: config(z.number(), "pixels between children"),
      align: config(z.enum(["start", "center", "end", "stretch"]), "cross-axis alignment"),
      justify: config(z.enum(["start", "center", "end", "between"]), "main-axis distribution"),
    },
    examples: ["<Row justify=\"between\"><Text .../><Button .../></Row>"],
  },
  {
    name: "Grid",
    group: "layout",
    summary: "Equal-width columns. Use for a grid of cards or stats.",
    props: { columns: config(z.number().int().positive(), "column count"), gap: config(z.number(), "pixels between cells") },
    examples: ["<Grid columns={3}><Stat .../><Stat .../><Stat .../></Grid>"],
  },
  {
    name: "Surface",
    group: "layout",
    summary: "A bordered, elevated container with an optional title.",
    props: { title: copy(z.string(), "container heading") },
    examples: ["<Surface title=\"Overdue\"><DataTable .../></Surface>"],
  },
  {
    name: "Divider",
    group: "layout",
    summary: "A horizontal rule between blocks.",
    props: {},
    examples: ["<Divider/>"],
  },

  // Values (money takes CENTS; dates take ISO/epoch)
  {
    name: "Text",
    group: "values",
    summary: "Themed text. Use variant=heading for section titles.",
    props: {
      text: copy(z.string(), "the text to show", { required: true }),
      variant: config(z.enum(["body", "heading", "caption", "label"]), "text role"),
    },
    examples: ['<Text text="This month" variant="heading"/>'],
  },
  {
    name: "Money",
    group: "values",
    summary: "Currency from an integer number of CENTS. Never pass dollars.",
    props: {
      cents: data(z.number(), "amount in integer cents (minor units)", { required: true }),
      currency: config(z.string(), "ISO 4217 code, default USD"),
    },
    examples: ["<Money cents={overview.totalCents}/>"],
  },
  {
    name: "DateTime",
    group: "values",
    summary: "A date/time from an ISO string, epoch millis, or Date. Invalid input renders a dash, never 'Invalid Date'.",
    props: {
      value: data(z.union([z.string(), z.number()]), "ISO string or epoch millis", { required: true }),
      mode: config(z.enum(["date", "time", "datetime", "relative"]), "how to render"),
    },
    examples: ['<DateTime value={invoice.dueDate} mode="date"/>', '<DateTime value={event.at} mode="relative"/>'],
  },
  {
    name: "Percent",
    group: "values",
    summary: "A percentage from a ratio (0.42 → 42%). Pass whole=true for an already-whole percent.",
    props: {
      value: data(z.number(), "a ratio 0..1", { required: true }),
      fractionDigits: config(z.number().int().nonnegative(), "decimal places"),
      whole: config(z.boolean(), "value is already a whole percent"),
    },
    examples: ["<Percent value={goal.progressRatio}/>"],
  },
  {
    name: "Num",
    group: "values",
    summary: "A grouped number. Use notation=compact for large counts (1.5M).",
    props: {
      value: data(z.number(), "the number", { required: true }),
      notation: config(z.enum(["standard", "compact"]), "grouping style"),
      maximumFractionDigits: config(z.number().int().nonnegative(), "decimal places"),
    },
    examples: ['<Num value={metrics.count} notation="compact"/>'],
  },
  {
    name: "EnumBadge",
    group: "values",
    summary: "A status pill for an enum field. Humanizes the raw value (past_due → Past due) and tone-maps it.",
    props: {
      value: data(z.string().nullable(), "the raw enum value", { required: true }),
      labels: config(z.record(z.string(), z.string()), "value → display label overrides"),
      tones: config(z.record(z.string(), z.enum(["neutral", "accent", "success", "warning", "danger"])), "value → tone overrides"),
    },
    examples: ['<EnumBadge value={invoice.status} tones={{ overdue: "danger", paid: "success" }}/>'],
  },

  // Data
  {
    name: "DataTable",
    group: "data",
    summary: "The smart table. Sorts, filters, searches, paginates, resolves dot-path column keys, and formats each cell — you only pass rows and columns.",
    props: {
      rows: data(rows, "rows from a tool call", { required: true }),
      columns: config(z.array(tableColumn), "column descriptions; key supports dot-paths like client.name; format is a value tier token"),
      sortBy: config(z.string(), 'initial sort, e.g. "dueDate asc"'),
      limit: config(z.number().int().positive(), "hard cap on rows shown"),
      filterableBy: config(z.array(z.string()), "column keys to expose as filter dropdowns"),
      searchable: config(z.boolean(), "show a search box across all columns"),
      paginate: config(z.number().int().positive(), "page size (enables pagination)"),
      emptyState: copy(z.string(), "text when the query returns no rows"),
      caption: copy(z.string(), "table caption"),
    },
    examples: [
      '<DataTable rows={invoices.data} sortBy="dueDate asc" limit={20} filterableBy={["client.name"]} columns={[{key:"client.name",label:"Client"},{key:"amountCents",format:"money",align:"end"},{key:"dueDate",format:"date"}]} emptyState="No overdue invoices"/>',
    ],
  },
  {
    name: "CardList",
    group: "data",
    summary: "One branded card per record. Use when rows read better as cards than a table.",
    props: {
      items: data(rows, "items from a tool call", { required: true }),
      titleField: config(z.string(), "field for each card title"),
      badgeField: config(z.string(), "field rendered as a status pill"),
      fields: config(z.array(cardField), "label/value rows shown on each card"),
      columns: config(z.number().int().positive(), "cards per row"),
      emptyState: copy(z.string(), "text when there are no items"),
    },
    examples: ['<CardList items={clients.data} titleField="name" badgeField="status" fields={[{key:"balanceCents",label:"Balance",format:"money"}]}/>'],
  },
  {
    name: "Stat",
    group: "data",
    summary: "A KPI/metric summary. Formats its value (money takes cents) and shows an optional trend.",
    props: {
      label: copy(z.string(), "metric name", { required: true }),
      value: data(z.union([z.number(), z.string()]), "raw value", { required: true }),
      format: config(valueFormat, "value tier format"),
      trend: copy(z.string(), "delta caption, e.g. +12% MoM"),
      tone: config(z.enum(["default", "accent", "danger"]), "emphasis"),
    },
    examples: ['<Stat label="Total overdue" value={overview.totalCents} format="money" trend="+12% MoM"/>'],
  },
  {
    name: "Badge",
    group: "data",
    summary: "A small literal status label the model writes. For enum data fields use EnumBadge instead.",
    props: { label: copy(z.string(), "badge text", { required: true }), tone: config(z.enum(["neutral", "accent", "success", "warning", "danger"]), "color tone") },
    examples: ['<Badge label="Beta" tone="accent"/>'],
  },

  // Charts (recharts internals; data props only; $NaN is unrenderable)
  {
    name: "LineChart",
    group: "charts",
    summary: "A line/trend chart. Y-axis ticks and tooltips are formatted by the format token.",
    props: {
      data: data(rows, "rows to plot", { required: true }),
      xKey: config(z.string(), "category (x) field", { required: true }),
      series: config(seriesInput, "value series (keys or {key,label})", { required: true }),
      format: config(valueFormat, "y-axis + tooltip format"),
      height: config(z.number().int().positive(), "chart height in px"),
      emptyState: copy(z.string(), "text when there is nothing to plot"),
    },
    examples: ['<LineChart data={revenue.byMonth} xKey="month" series={["amountCents"]} format="money"/>'],
  },
  {
    name: "BarChart",
    group: "charts",
    summary: "A bar chart. Set horizontal for ranked lists, stacked to combine series.",
    props: {
      data: data(rows, "rows to plot", { required: true }),
      xKey: config(z.string(), "category field", { required: true }),
      series: config(seriesInput, "value series", { required: true }),
      format: config(valueFormat, "axis + tooltip format"),
      stacked: config(z.boolean(), "stack series into one bar"),
      horizontal: config(z.boolean(), "horizontal bars"),
      height: config(z.number().int().positive(), "chart height in px"),
      emptyState: copy(z.string(), "text when there is nothing to plot"),
    },
    examples: ['<BarChart data={sales.byRegion} xKey="region" series={["unitsSold"]} horizontal/>'],
  },
  {
    name: "DonutChart",
    group: "charts",
    summary: "A donut/pie of category shares. Zero and invalid slices are dropped.",
    props: {
      data: data(rows, "rows to plot", { required: true }),
      categoryKey: config(z.string(), "slice-label field", { required: true }),
      valueKey: config(z.string(), "slice-value field", { required: true }),
      format: config(valueFormat, "tooltip format"),
      donut: config(z.boolean(), "false renders a full pie"),
      height: config(z.number().int().positive(), "chart height in px"),
      emptyState: copy(z.string(), "text when there is nothing to plot"),
    },
    examples: ['<DonutChart data={spend.byCategory} categoryKey="category" valueKey="amountCents" format="money"/>'],
  },
  {
    name: "Sparkline",
    group: "charts",
    summary: "A compact inline trend. Pass a number list or rows with a valueKey.",
    props: {
      data: data(z.array(z.union([z.number(), z.record(z.string(), z.unknown())])), "numbers or rows", { required: true }),
      valueKey: config(z.string(), "field to read when data holds objects"),
      height: config(z.number().int().positive(), "height in px"),
    },
    examples: ["<Sparkline data={account.balanceHistory}/>"],
  },
  {
    name: "Progress",
    group: "charts",
    summary: "A progress bar from a ratio (0..1) or value/max. Clamps to 100%.",
    props: {
      value: data(z.number(), "ratio 0..1, or a raw value with max", { required: true }),
      max: data(z.number(), "denominator when value is raw"),
      label: copy(z.string(), "caption"),
      showValue: config(z.boolean(), "show the percentage"),
      tone: config(z.enum(["accent", "success", "danger"]), "fill color"),
    },
    examples: ["<Progress value={goal.saved} max={goal.target} label=\"Savings goal\" showValue/>"],
  },

  // Forms
  {
    name: "Input",
    group: "forms",
    summary: "A text field. onChange names a host tool or island handler.",
    props: {
      label: copy(z.string(), "field label"),
      value: data(z.string(), "initial value"),
      placeholder: copy(z.string(), "placeholder text"),
      type: config(z.enum(["text", "email", "number", "password", "search", "tel", "url"]), "input type"),
      onChange: config(action, "bound change handler"),
    },
    examples: ['<Input label="Find a client" onChange="host_search_clients"/>'],
  },
  {
    name: "Select",
    group: "forms",
    summary: "A dropdown over a RAW array of tool output. Map objects with labelField/valueField — no reshaping. multiple selects several.",
    props: {
      options: data(z.array(z.union([z.string(), z.number(), z.record(z.string(), z.unknown())])), "raw items", { required: true }),
      label: copy(z.string(), "field label"),
      labelField: config(z.string(), "object field for the visible label"),
      valueField: config(z.string(), "object field for the value"),
      placeholder: copy(z.string(), "empty-choice text"),
      multiple: config(z.boolean(), "allow several values"),
      onChange: config(action, "bound change handler"),
    },
    examples: ['<Select label="Client" options={clients.data} labelField="name" valueField="id"/>'],
  },
  {
    name: "DatePicker",
    group: "forms",
    summary: "A native date control (ISO yyyy-mm-dd).",
    props: {
      label: copy(z.string(), "field label"),
      value: data(z.string(), "ISO date"),
      min: config(z.string(), "earliest date"),
      max: config(z.string(), "latest date"),
      onChange: config(action, "bound change handler"),
    },
    examples: ['<DatePicker label="Due date"/>'],
  },
  {
    name: "Textarea",
    group: "forms",
    summary: "A multiline text field.",
    props: {
      label: copy(z.string(), "field label"),
      value: data(z.string(), "initial value"),
      placeholder: copy(z.string(), "placeholder text"),
      rows: config(z.number().int().positive(), "visible rows"),
      onChange: config(action, "bound change handler"),
    },
    examples: ['<Textarea label="Note" rows={4}/>'],
  },
  {
    name: "Checkbox",
    group: "forms",
    summary: "A boolean toggle. onChange receives the checked state.",
    props: {
      label: copy(z.string(), "field label"),
      checked: data(z.boolean(), "initial checked state"),
      onChange: config(action, "bound change handler"),
    },
    examples: ['<Checkbox label="Include paid"/>'],
  },
  {
    name: "Button",
    group: "forms",
    summary: "Action-gated button. onClick NAMES a host tool; the runtime routes it through the guard + approval pipe. This is the only way the UI mutates.",
    props: {
      label: copy(z.string(), "button text", { required: true }),
      onClick: config(action, "the host tool to run"),
      variant: config(z.enum(["primary", "secondary", "danger"]), "emphasis"),
      disabled: config(z.boolean(), "disabled state"),
    },
    examples: ['<Button label="Remind all" onClick="invoices.sendReminders"/>'],
  },
  {
    name: "Form",
    group: "forms",
    summary: "Groups fields with a submit action. onSubmit names a host tool.",
    props: {
      onSubmit: config(action, "the host tool to run on submit"),
      submitLabel: copy(z.string(), "submit button text"),
    },
    examples: ['<Form onSubmit="clients.create" submitLabel="Add client"><Input label="Name"/></Form>'],
  },
  {
    name: "Disclaimer",
    group: "forms",
    summary: "The legal move when NO tool backs the ask. State plainly why the data can't be shown — never invent it (law 1).",
    props: {
      reason: copy(z.string(), "why the ask can't be fulfilled with real data", { required: true }),
      title: copy(z.string(), "optional heading"),
    },
    examples: ['<Disclaimer reason="No tool exposes payroll data, so this can\'t be shown."/>'],
  },

  // Feedback / interactive
  {
    name: "Tabs",
    group: "feedback",
    summary: "Self-managing tabs. Give each tab a label and content; switching needs no handler.",
    props: {
      tabs: config(z.array(z.object({ label: z.string(), content: z.unknown(), disabled: z.boolean().optional() })), "tab definitions", { required: true }),
      defaultIndex: config(z.number().int().nonnegative(), "initially selected tab"),
    },
    examples: ["<Tabs tabs={[{label:\"Overview\",content:<Stat .../>},{label:\"Detail\",content:<DataTable .../>}]}/>"],
  },
  {
    name: "Callout",
    group: "feedback",
    summary: "A toned info/success/warning/danger notice highlighting real information. For 'no tool' honesty use Disclaimer.",
    props: {
      tone: config(z.enum(["info", "success", "warning", "danger"]), "notice tone"),
      title: copy(z.string(), "notice heading"),
    },
    examples: ['<Callout tone="warning" title="Heads up">Three invoices are overdue.</Callout>'],
  },
  {
    name: "Accordion",
    group: "feedback",
    summary: "Self-managing collapsible sections. Good for long apps.",
    props: {
      items: config(z.array(z.object({ label: z.string(), content: z.unknown() })), "sections", { required: true }),
      multiple: config(z.boolean(), "allow several open at once"),
    },
    examples: ["<Accordion items={[{label:\"Terms\",content:<Text .../>}]}/>"],
  },
];

/** All registered component names. */
export function kitComponentNames(): string[] {
  return KIT_SPECS.map((s) => s.name);
}

/** Look up a single spec by name. */
export function kitSpec(name: string): KitComponentSpec | undefined {
  return KIT_SPECS.find((s) => s.name === name);
}

/** Every Kit component name — the wire compiler resolves these as prewired
 *  (the ui renderer maps them to `KIT_COMPONENTS`). */
export const KIT_COMPONENT_NAMES: readonly string[] = KIT_SPECS.map((spec) => spec.name);

/** Kit components whose props cannot be expressed as wire attribute values
 *  (element-valued `content` slots). They stay renderable and usable inside
 *  islands, but the WIRE prompt must not teach them — the legacy prewired
 *  Tabs (string tabs + onChange) remains the tree-level tabs surface. */
export const KIT_WIRE_UNSAFE_NAMES: readonly string[] = ["Tabs", "Accordion"];

/** The Kit names the wire prompt teaches (see {@link KIT_WIRE_UNSAFE_NAMES}). */
export const KIT_WIRE_COMPONENT_NAMES: readonly string[] =
  KIT_COMPONENT_NAMES.filter((name) => !KIT_WIRE_UNSAFE_NAMES.includes(name));

/** The full component vocabulary a wire tree may name without a source map:
 *  the legacy prewired set plus the Kit. */
export const WIRE_COMPONENT_NAMES: readonly string[] = [
  ...PREWIRED_COMPONENT_NAMES,
  ...KIT_COMPONENT_NAMES.filter((name) => !(PREWIRED_COMPONENT_NAMES as readonly string[]).includes(name)),
];

/** Prop name → class for one Kit component (law-1 enforcement handle). */
export function kitPropClasses(name: string): Readonly<Record<string, PropClass>> | undefined {
  const spec = kitSpec(name);
  if (spec === undefined) return undefined;
  return Object.fromEntries(Object.entries(spec.props).map(([prop, { cls }]) => [prop, cls]));
}
