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
import { config, copy, data, type KitComponentSpec, type KitSlotSpec, type PropClass, type PropSpec } from "./schema.js";

// ---- shared zod fragments -------------------------------------------------
const rows = z.array(z.record(z.string(), z.unknown()));
/**
 * A CHART AXIS's format token — THE ONE EXCEPTION to the value tier's death.
 *
 * Every other displayed value in a screen passes through the model's own code, so
 * the model formats it there with `Intl` and the Kit only displays and themes it.
 * An axis tick is the one value that never does: the labels are computed
 * HOST-SIDE off a numeric scale, from numbers the screen holds no value of, so a
 * chart has to be TOLD what its figures mean rather than handed text. `duration`
 * belongs here for that same reason — an axis of build times ticks in seconds the
 * host reduces itself.
 */
const valueFormat = z.enum(["money", "date", "datetime", "time", "number", "duration", "text"]);
const align = z.enum(["start", "center", "end"]);
/** A series descriptor stays OPEN: what is written beside `key`, `label` and
 *  `color` is passed to that one series' engine element, so per-line colors are a
 *  property of the line rather than of the whole chart. `color` is DECLARED
 *  rather than left to the passthrough because the engine's own name for it
 *  differs per chart (`stroke`, `fill`) — undeclared, the obvious word reached
 *  the engine and meant nothing to it. */
const seriesInput = z.array(z.union([
  z.string(),
  z.object({
    key: z.string(),
    label: z.string().optional(),
    /** The word the model was already reaching for. `name` is the ENGINE's own
     *  spelling of a series' title, so it arrived, passed through, and then lost
     *  to the `label ?? key` default — a renamed series that kept its raw field
     *  name. The Kit reads it as `label` now and still owns what reaches the
     *  engine, exactly as it does for `color`. */
    name: z.string().optional(),
    color: z.string().optional(),
    /** THIS series' units, over the chart's. A chart of two series in different
     *  units (an amount and a count) has no one chart-level token that reads
     *  both. */
    format: valueFormat.optional(),
  }).passthrough(),
]));

/**
 * Raw tool output as choices — the ONE shape Select, Radio and Combobox share.
 *
 * Nothing reshapes on the way in, so the two things a choice needs to say about
 * itself are read off the item where they already sit: its own `disabled` greys
 * that one out, and its own `group` puts it under a heading. Two more `*Field`
 * props would have been two more names for the model to carry, and a screen that
 * builds this array can spell either word directly. A bare string or number
 * carries neither — that is the whole point of the shorthand.
 */
const options = z.array(z.union([z.string(), z.number(), z.record(z.string(), z.unknown())]));
const OPTIONS_DOC = "raw items, read through labelField/valueField; an item's own disabled greys that choice out and its own group heads a section";

/** The DESCRIPTIONS that mark a schema as something other than what it
 *  parses as. Exported because every reader of a Kit schema — the screen
 *  typings, the catalog's type printer — has to recognise the same strings,
 *  and a second copy of one is a marker that stops matching. */
export const SLOT_PROP_DESCRIPTION = "holds Kit elements";
export const ACTION_PROP_DESCRIPTION = "names a host tool";
export const ICON_NAME_DESCRIPTION = "lucide icon name in kebab-case";

/**
 * A SLOT — Kit elements written where a value would otherwise go.
 *
 * `z.unknown()` for the same reason `Accordion.items[].content` is: a slot
 * holds an ELEMENT, and no schema describes one. A slot is written in a screen's
 * JSX by hand, so it is code-only, exactly like `Tabs.tabs[].content` — and,
 * exactly like it, being optional is what keeps its component teachable at all
 * (`KIT_NON_SCREEN_NAMES`).
 *
 * Every slot may also be written as a FUNCTION that returns the element — the
 * natural React form, and for the per-row slots the recommended one: the screen
 * VM calls it and paints what it returns ({@link KIT_SLOT_PROPS}). A slot the Kit
 * paints once per ROW is called once for each — `cell: (row) => <Text
 * text={(row.amount_cents / 100).toLocaleString("en-US", { style: "currency",
 * currency: "USD" })}/>`, that row's own element with that row's own handlers —
 * and every other slot is called with no arguments at all, because it has no row
 * to be a function of.
 *
 * The DESCRIPTION is the marker a slot is known by: `z.unknown()` prints as
 * `any`, which types nothing at all, so the component screen's typings print a
 * described slot as an element type instead ({@link SLOT_PROP_DESCRIPTION}).
 */
const slot = z.unknown().describe(SLOT_PROP_DESCRIPTION);
/**
 * A field description, or the bare KEY that stands for one.
 *
 * `columns={["client", "amount"]}` is what a screen writes when it only wants
 * the fields named, and it is the shorthand `Select.options` has always taken
 * (a raw string is a choice). A string can only mean the key — `label` defaults
 * from it and the value prints as it stands — so there is no second reading to
 * be wrong about, and the components normalize it at their own boundary
 * (`ui` kit/row.ts `fieldItems`).
 */
const tableColumn = z.union([z.string(), z.object({
  /** Optional, because an ACTION column has no field: giving it a fake key
   *  makes its header click-to-sort and its values globally searchable, on data
   *  that is not there. A keyless column sorts, filters and searches on nothing. */
  key: z.string().optional(),
  label: z.string().optional(),
  /** The word the model writes anyway. It arrived, validated, and was then
   *  ignored for the humanized key — a labelled column reading as its raw field
   *  name. The prompt used to spend a sentence forbidding it; the column reads it
   *  as `label` instead. */
  header: z.string().optional(),
  align: align.optional(),
  /** Px. Also what gives a truncated cell an edge to ellipsize against. */
  width: z.number().int().positive().optional(),
  /** One line with an ellipsis, opt-in — every cell is one line already. */
  truncate: z.boolean().optional(),
  /** Which columns survive a narrow frame — and, declared at all, whether any
   *  give way rather than the frame scrolling to reach them. */
  priority: z.number().optional(),
  cell: slot.optional(),
})]);
const cardField = z.union([z.string(), z.object({
  key: z.string(),
  label: z.string().optional(),
  cell: slot.optional(),
})]);
const action = z.string().describe(ACTION_PROP_DESCRIPTION);
/**
 * A lucide icon NAME — any string to zod, the CLOSED set to the compiler.
 *
 * It parses as a string because the renderer must stay fail-soft: a name outside
 * lucide's set paints an empty span (`ui` kit/icon.tsx), never a crash, and a
 * stored app carrying one still renders. The DESCRIPTION is what the screen
 * typings print the closed set for ({@link ICON_NAME_DESCRIPTION}), so an
 * invented glyph is a compile error naming the prop instead of a silent gap — the
 * only warning there is, now that the catalog no longer spends ~575 tokens
 * teaching the 200-odd names on every generation.
 */
const iconName = z.string().describe(ICON_NAME_DESCRIPTION);
/** The one tone vocabulary. `info` is the status colour of a state in progress —
 *  "running", "pending review" — which used to reach for `accent` and paint the
 *  brand rather than a status. */
const toneWord = z.enum(["neutral", "accent", "info", "success", "warning", "danger"]);
/** The taught vocabulary plus the older spelling of `neutral`, which still parses
 *  because stored apps carry it. */
const tone = toneWord.or(z.enum(["default"]));
const density = z.enum(["comfortable", "compact"]);

/** The help line under a form control. A shared adjective AND a slot, because it
 *  takes either a word or Kit marks. */
const hint: KitSlotSpec = { doc: "the help line under the field, as elements instead of text" };

/** Every form control that takes a label, so the three field adjectives below
 *  land on all of them at once rather than on the four somebody remembered. */
const CONTROLS: readonly string[] = [
  "Input", "Textarea", "Select", "Combobox", "DatePicker", "DateRange",
  "Checkbox", "Switch", "Radio", "Slider", "SegmentedControl",
];

/**
 * THE ADJECTIVES — the props many components share, taught once in the prompt's
 * preamble rather than restated 31 times. Each carries the components that
 * actually READ it: on any other, the prop would validate and then be dropped
 * at render — the "valid component, nothing happens" class this floor refuses.
 *
 * The three field adjectives are here for the mirror of that reason. Every
 * control below IMPLEMENTS `disabled`, and most of them `hint`, and none of them
 * declared it — so a screen that greyed out a control while its tool was in
 * flight wrote a prop no spec admitted and no prompt taught. A prop the Kit
 * paints and the specs hide is the same silent breakage read backwards.
 */
const SHARED_PROPS: ReadonlyArray<{
  name: string;
  spec: PropSpec;
  on: readonly string[];
  /** Set where the shared prop holds ELEMENTS, so it lands in the slot table of
   *  every component that takes it rather than the three somebody listed. */
  slot?: KitSlotSpec;
}> = [
  {
    name: "tone",
    spec: config(tone, "emphasis — neutral | accent | info | success | warning | danger; info is a state in progress"),
    on: ["Text", "EnumBadge", "Badge", "Icon", "Sparkline", "Progress", "Stat", "Card", "Surface", "Callout", "Toast", "Button"],
  },
  {
    name: "density",
    spec: config(density, "comfortable (default) or compact; set on a container it tightens everything inside"),
    on: ["Stack", "Row", "Grid", "Surface", "Card", "DataTable", "CardList", "Stat"],
  },
  {
    // Self-declaring, not parent-side: the container that GROWS is the one that
    // says so, which is the only form that survives being nested. Every raw
    // `<div style={{flex:1}}>` a screen wrote — seventeen of them counted — was
    // reaching for exactly this, and reached past the Kit to get it.
    name: "grow",
    spec: config(z.union([z.boolean(), z.number()]), "inside a Row, Grid or Stack, take the remaining space — the container that stretches says so itself, so a row never needs a raw flex div"),
    on: ["Stack", "Row", "Grid", "Surface", "Card"],
  },
  {
    name: "disabled",
    spec: config(z.boolean(), "greys the control out and stops it answering — how a control says 'not yet' instead of failing silently"),
    on: [...CONTROLS, "Button", "Form"],
  },
  {
    // Enforced for the native three now, not only for the Base UI controls that
    // register themselves with a Form: `Form` checks its own element's validity
    // before it calls `onSubmit` (`ui` forms/form.tsx), so a required Textarea,
    // Select or Checkbox stops a submit instead of decorating one.
    name: "required",
    spec: config(z.boolean(), "the form will not submit without it"),
    on: ["Input", "Textarea", "Select", "DatePicker", "Checkbox"],
  },
  {
    name: "hint",
    spec: copy(slot, "the help line under the field — a word, or Kit marks"),
    on: CONTROLS.filter((name) => name !== "SegmentedControl"),
    slot: hint,
  },
];

/** The shared adjectives' names, so `kitPrompt` can leave them out of every
 *  component's prop list and teach them once. */
export const KIT_SHARED_PROP_NAMES: readonly string[] = SHARED_PROPS.map(({ name }) => name);

/**
 * THE STYLE PROP — on every component, not just the ones that read it, because
 * every one of them merges it onto its own root. The theme is still the default
 * and still what an unstyled screen paints from; this is the escape hatch for
 * when the person asked for a particular look.
 */
const STYLE_PROP = "style";
const style = config(
  z.record(z.string(), z.union([z.string(), z.number()])),
  "inline CSS on the component's root; your values win over the theme's",
);

/** What the PREAMBLE teaches, so neither prompt spends a line on it per
 *  component: the shared adjectives, and `style`, which every component takes. */
export const KIT_PREAMBLE_PROP_NAMES: readonly string[] = [...KIT_SHARED_PROP_NAMES, STYLE_PROP];

/**
 * Who RENDERS a third-party engine, and which one — the fact `kitPrompt`, the
 * wire's allowed-prop set and the screen typings all read to let that engine's
 * own props through (`KitComponentSpec.engine`).
 */
const ENGINES: Readonly<Record<string, string>> = {
  BarChart: "recharts", DonutChart: "recharts", LineChart: "recharts", Sparkline: "recharts",
  Accordion: "Base UI", Combobox: "Base UI", DatePicker: "Base UI", DateRange: "Base UI",
  Form: "Base UI", Input: "Base UI", Menu: "Base UI", Modal: "Base UI", Progress: "Base UI",
  Radio: "Base UI", SegmentedControl: "Base UI", Sheet: "Base UI", Slider: "Base UI",
  Switch: "Base UI", Tabs: "Base UI", Toast: "Base UI", Tooltip: "Base UI",
  // The three that render a plain DOM control rather than a library one. Their
  // engine is the ELEMENT, and its vocabulary is as real as recharts': `maxLength`
  // on a textarea, `size` on a select, `name` on a checkbox all work, and every
  // one of them was refused by name while the identical prop went through on
  // Input. The trade is the same one every engine takes — the prop list opens, so
  // a misspelling reaches the DOM instead of a refusal.
  Textarea: "<textarea>", Select: "<select>", Checkbox: "<input>",
};

// ---- specs ---------------------------------------------------------------
const BASE_SPECS: KitComponentSpec[] = [
  // Layout
  {
    name: "Stack",
    takesChildren: true,
    group: "layout",
    summary: "Vertical flow of children. The default container for a section.",
    props: { gap: config(z.number(), "pixels between children") },
    examples: ["<Stack gap={12}><Stat .../><DataTable .../></Stack>"],
  },
  {
    name: "Row",
    takesChildren: true,
    group: "layout",
    summary: "Horizontal flow; wraps by default. Use for a row of stats or buttons.",
    props: {
      gap: config(z.number(), "pixels between children"),
      align: config(z.enum(["start", "center", "end", "stretch"]), "cross-axis alignment"),
      justify: config(z.enum(["start", "center", "end", "between"]), "main-axis distribution"),
      wrap: config(z.boolean(), "false keeps the row on ONE line, whatever it costs in width"),
    },
    examples: ["<Row justify=\"between\"><Text .../><Button .../></Row>"],
  },
  {
    name: "Grid",
    group: "layout",
    summary: "Equal-width columns that WRAP to fit, so cells never clip — write it bare for a grid of tiles. A fixed count is kept at every width, which is what clips on a narrow screen, so name columns only where the layout genuinely needs one.",
    takesChildren: true,
    props: {
      columns: config(z.number().int().positive(), "a FIXED column count, kept however narrow the screen gets — for a layout that needs the count, not for tiles"),
      minChildWidth: config(z.number().int().positive(), "the floor cells wrap at, in px; 160 without you. Wins over columns"),
      gap: config(z.number(), "pixels between cells"),
    },
    examples: ["<Grid><Stat .../><Stat .../><Stat .../><Stat .../></Grid>"],
  },
  {
    name: "SplitPane",
    takesChildren: true,
    group: "layout",
    summary: "Two panes SIDE BY SIDE — the list beside the thing it opens. Row and Grid both wrap; this one never does, and each pane scrolls its own content instead of widening the other. On a frame too narrow to hold both it stacks them vertically rather than clipping the second.",
    props: {
      // The float still works, because stored screens carry it — but it is no
      // longer TAUGHT: one prop that meant px above 1 and a share below it was a
      // rule the model had to remember, and "40%" says the same thing out loud.
      size: config(z.union([z.number().positive(), z.string()]), 'the first pane\'s size, as a CSS length ("40%", "18rem") or a number of px; default 320. A bare number below 1 still reads as a share (0.4 → 40%) for stored screens — write "40%"'),
    },
    examples: ['<SplitPane size={280}><DataTable rows={tickets.data} columns={["subject","status"]}/><KeyValue record={open} items={["subject","status","opened"]}/></SplitPane>'],
  },
  {
    name: "Surface",
    takesChildren: true,
    group: "layout",
    summary: "A bordered, elevated container with an optional title.",
    props: {
      title: copy(z.string(), "container heading"),
      header: config(slot, "elements beside the title"),
      footer: config(slot, "the buttons under the content"),
    },
    examples: ["<Surface title=\"Overdue\"><DataTable .../></Surface>"],
  },
  {
    name: "Card",
    takesChildren: true,
    group: "layout",
    summary: "A titled content block with an optional one-line description. Use it to label a region; Surface is the plain bordered container.",
    props: {
      title: copy(z.string(), "card heading"),
      // A word, or Kit marks — the same pair `hint` takes, for the same reason: a
      // subheading is prose most of the time and a `branch·sha` pair some of the
      // time, and the mono face of an identifier is a thing only a Kit mark can
      // say. Written as a string it renders exactly as it always did.
      description: copy(slot, "one-line subheading under the title — a word, or Kit marks"),
      header: config(slot, "elements beside the title"),
      footer: config(slot, "the buttons under the content"),
    },
    examples: ['<Card title="Overdue" description="Worst first"><DataTable rows={invoices.data} columns={[{key:"client"}]}/></Card>'],
  },
  {
    name: "Divider",
    group: "layout",
    summary: "A horizontal rule between blocks. A label turns it into a section break.",
    props: { label: config(slot, "a word centred in the rule") },
    examples: ["<Divider/>"],
  },

  // Values. There is no value-FORMATTING tier any more: a figure is formatted in
  // the screen's own code with `Intl` and arrives here as text, so what is left in
  // this group is typography, the enum pill, and the glyph. A figure lives inside
  // the sentence that carries it, which is what `Text`'s children are for.
  {
    name: "Text",
    group: "values",
    takesChildren: true,
    summary: "Themed text. Use variant=heading for section titles. A figure you formatted goes INSIDE the sentence, as children, and takes this text's colour, so tone the sentence rather than the figure in it.",
    props: {
      // string | number, matching the implementation (`text: ReactNode`, which
      // renders a number verbatim). The spec said `string` only, which never
      // bit anyone while the legacy prewired Text shadowed this one with a
      // permissive `any` prop — retiring it (V4) made the over-tight schema
      // load-bearing and blocked the very common `<Text text={count}/>`.
      text: copy(z.union([z.string(), z.number()]), "the text to show; or nest the sentence as children"),
      variant: config(z.enum(["body", "heading", "caption", "label", "code"]), "text role"),
    },
    examples: [
      '<Text text="This month" variant="heading"/>',
      '<Text variant="caption" tone="danger">Overdue: {(overdue.total_cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" })} across {overdue.count} clients</Text>',
    ],
  },
  {
    name: "EnumBadge",
    group: "values",
    summary: "A status pill for an enum field. Humanizes the raw value (past_due → Past due) and tone-maps it.",
    props: {
      value: data(z.string().nullable(), "the raw enum value"),
      labels: config(z.record(z.string(), z.string()), "value → display label overrides"),
      tones: config(z.record(z.string(), toneWord), "value → tone overrides"),
    },
    examples: ['<EnumBadge value={invoice.status} tones={{ overdue: "danger", paid: "success" }}/>'],
  },
  {
    name: "Icon",
    group: "values",
    summary: "One lucide glyph, drawn in the surrounding text's color. Names are lucide's own kebab-case (arrow-up-right, credit-card, alert-triangle); a name outside that set renders nothing, so never invent one.",
    props: {
      name: config(iconName, ICON_NAME_DESCRIPTION, { required: true }),
      size: config(z.number().int().positive(), "edge length in px, default 16"),
      label: copy(z.string(), "screen-reader name; omit for a decorative glyph"),
    },
    examples: [
      '<Icon name="trending-up" size={20}/>',
      '<Row gap={6} align="center"><Icon name="credit-card"/><Text text="Payment method"/></Row>',
    ],
  },

  // Data
  {
    name: "DataTable",
    group: "data",
    summary: "The smart table. Sorts, filters, searches, paginates and resolves dot-path column keys — you pass rows and columns. A cell shows its value as it stands, so a figure is formatted where you prepare the rows or inside the column's `cell`, which is a function of the row and the home for any arithmetic or composition; a per-row CONTROL goes in `rowActions`, a function of the row too. A cell stays on ONE line and EVERY column renders, so a frame too narrow for all of them scrolls sideways — no column is ever dropped or squeezed. Cap a long-prose column with a `width` (140-200) and `truncate` and it ellipsizes with the whole text in its hover title, instead of making the table wide. `paginate` is a page SIZE, so omit it for no pagination rather than passing false.",
    takesChildren: true,
    props: {
      rows: data(rows, "rows from a tool call", { required: true }),
      columns: config(z.array(tableColumn), "column descriptions, or bare keys; key takes dot-paths (client.name); label (or header) is the heading; width is px; truncate clips that column to one line with an ellipsis and wants a width to bite against; priority opts the table into dropping columns on a frame too narrow for them, lowest first, and defaults to left-to-right; cell is a (row) => elements slot; key is optional on an action column"),
      fold: config(z.boolean(), "on a narrow frame, let the columns that do not fit give way and fold each into the first cell as an extra line — off by default, and so is giving way at all: the frame scrolls instead"),
      sortBy: config(z.string(), 'initial sort, e.g. "dueDate asc"'),
      limit: config(z.number().int().positive(), "hard cap on rows shown"),
      filterableBy: config(z.array(z.string()), "column keys to expose as filter dropdowns"),
      searchable: config(z.boolean(), "show a search box across all columns"),
      paginate: config(z.number().int().positive(), "page size (enables pagination)"),
      emptyState: copy(z.string(), "text when the query returns no rows"),
      empty: config(slot, "elements shown instead of that text"),
      caption: copy(z.string(), "table caption"),
      toolbar: config(slot, "elements beside the search and the filters"),
      rowActions: config(slot, "the controls at the end of every row"),
    },
    examples: [
      '<DataTable rows={invoices.list({status:"overdue"}).data.map((r) => ({ ...r, amount: (r.amount_cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" }), due: new Date(r.dueDate).toLocaleDateString("en-US", { month: "short", day: "numeric" }) }))} sortBy="dueDate asc" limit={20} columns={[{key:"client.name",label:"Client",cell:(row) => <Stack gap={2}><Text text={row.client.name}/><Text text={row.number} variant="caption"/></Stack>},{key:"amount",align:"end"},{key:"due",label:"Due"},{key:"status",label:"Status",cell:(row) => <EnumBadge value={row.status} tones={{overdue:"danger",paid:"success"}}/>}]} rowActions={(row) => <Button label="Remind" onClick={() => tools.send_reminder({ id: row.id })}/>} emptyState="No overdue invoices"/>',
    ],
  },
  {
    name: "TableRow",
    group: "data",
    summary: "ONE <DataTable> row you paint yourself. Only valid as a child of <DataTable>, one per record in `rows` order. Its children ARE its cells, one per column, in column order — several components in one cell go in a <Stack>. Reach for it when a whole row is bespoke; one column that is, is a `cell` function.",
    takesChildren: true,
    props: {},
    examples: [
      '<TableRow key={a.id}><Text text={a.name}/><Text text={(a.balance_cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" })}/><Button label="Cancel" onClick={() => tools.cancel_transfer({ id: a.id })}/></TableRow>',
    ],
  },
  {
    name: "CardList",
    group: "data",
    summary: "One branded card per record. Use when rows read better as cards than a table. A field takes a `cell` slot, as a table column does.",
    props: {
      items: data(rows, "items from a tool call", { required: true }),
      titleField: config(z.string(), "field for each card title"),
      badgeField: config(z.string(), "field rendered as a status pill"),
      fields: config(z.array(cardField), "label/value rows on each card, or bare keys; defaults to the item's own keys; a value shows as it stands, so format it in the data or in cell, which is a slot"),
      columns: config(z.number().int().positive(), "cards per row"),
      emptyState: copy(z.string(), "text when there are no items"),
      empty: config(slot, "elements shown instead of that text"),
      actions: config(slot, "the buttons above the cards"),
    },
    examples: ['<CardList items={clients.list({}).data.map((c) => ({ ...c, balance: (c.balance_cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" }) }))} titleField="name" badgeField="status" fields={[{key:"balance",label:"Balance"}]}/>'],
  },
  {
    name: "Calendar",
    group: "data",
    summary: "Items on a month grid — each on its own day with its label, figure and status. Use it when the question is which DAY, not which row. The month comes from the earliest item unless `month` names one.",
    props: {
      items: data(rows, "items from a tool call", { required: true }),
      dateField: config(z.string(), "field holding the day each item falls on"),
      titleField: config(z.string(), "field for each item's label"),
      amountField: config(z.string(), "field shown under each item's label, exactly as it stands — format the figure where you prepare the items"),
      statusField: config(z.string(), "field whose value labels and tones each item"),
      tones: config(z.record(z.string(), toneWord), "status value → tone overrides"),
      month: config(z.string(), "the month to lay out, as ISO yyyy-mm"),
    },
    examples: [
      '<Calendar items={bills.data.map((b) => ({ ...b, amount: (b.amount_cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" }) }))} dateField="due_date" titleField="name" amountField="amount" statusField="status" tones={{ paid: "success", missed: "danger" }}/>',
    ],
  },
  {
    name: "Stat",
    group: "data",
    summary: "A KPI/metric summary — the figure's typography, tone and trend caption. It shows the value AS GIVEN, so format it yourself and hand over the finished string. Kit components nested inside render under the number.",
    takesChildren: true,
    props: {
      label: copy(z.string(), "metric name", { required: true }),
      value: data(z.union([z.number(), z.string()]), "the figure, shown as it stands — format it with toLocaleString; a bare number renders grouped-as-written and Stat does the typography either way", { required: true }),
      unit: config(z.string(), 'a unit written after the value — "ms", "min", "h"'),
      trend: copy(z.string(), "delta caption, e.g. +12% MoM"),
      icon: config(slot, "a glyph beside the metric name"),
    },
    examples: ['<Stat label="Total overdue" value={(invoices.total({}).amountCents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" })} trend="+12% MoM" tone="danger"/>'],
  },
  {
    name: "Badge",
    group: "data",
    summary: "A small literal status label the model writes. For enum data fields use EnumBadge instead.",
    props: { label: copy(z.string(), "badge text") },
    examples: ['<Badge label="Beta" tone="accent"/>'],
  },
  {
    name: "KeyValue",
    group: "data",
    summary: "ONE record's fields as label/value rows — the detail a table row expands into. A field takes a `cell` slot, exactly as a table column does.",
    props: {
      record: data(z.record(z.string(), z.unknown()), "the record from a tool call", { required: true }),
      items: config(z.array(cardField), "the fields to show, or bare keys; defaults to the record's own keys; key supports dot-paths; a value shows as it stands, so format it in the data or in cell, which is a slot"),
      dividers: config(z.boolean(), "hairline rule between rows"),
    },
    examples: [
      '<KeyValue record={invoices.get({id}).data} items={[{key:"client.name",label:"Client"},{key:"dueDate",label:"Due",cell:(record) => <Text text={new Date(record.dueDate).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}/>},{key:"amount_cents",label:"Amount",cell:(record) => <Text text={(record.amount_cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" })}/>},{key:"status",cell:(record) => <EnumBadge value={record.status}/>}]} dividers/>',
    ],
  },
  {
    name: "Timeline",
    group: "data",
    summary: "A history down a spine: one dot-marked entry per record, in the order the tool returned them. An entry's body is EITHER a `titleField` or a `cell` of Kit components — never both; the cell paints and the title would be dropped.",
    // `cell` wins at render (`ui` timeline.tsx), so a screen that wrote both got
    // the body it composed and lost the title it asked for, with nothing said.
    exclusive: [{
      props: ["cell", "titleField"],
      fix: "A cell is the whole body, so keep `cell` and write the title INSIDE it (`cell: (entry) => <Stack gap={2}><Text text={entry.description}/>…</Stack>`), or drop `cell` and keep `titleField` for a plain one-line entry.",
    }],
    props: {
      entries: data(rows, "entries from a tool call", { required: true }),
      titleField: config(z.string(), "field for each entry's title"),
      timeField: config(z.string(), "field holding each entry's timestamp"),
      timeAlign: config(z.enum(["start", "end"]), "where the timestamp sits: start (default) or end"),
      cell: config(slot, "Kit elements rendered as each entry's body; the components inside name their field"),
      marker: config(slot, "a Kit element drawn in place of the dot"),
      emptyState: copy(z.string(), "text when there are no entries"),
      empty: config(slot, "elements shown instead of that text"),
    },
    examples: [
      '<Timeline entries={payments.list({}).data} titleField="description" timeField="paidAt" timeAlign="end"/>',
    ],
  },
  {
    name: "Avatar",
    group: "data",
    summary: "Initials in a tint derived from the name, so one person is one color everywhere. No image — the Kit fetches nothing. Adjacent avatars in a Row stack.",
    props: {
      name: data(z.string(), "the person or account name", { required: true }),
      size: config(z.enum(["sm", "md", "lg"]), "disc size, default md"),
    },
    examples: [
      '<Row gap={6} align="center"><Avatar name={client.name}/><Text text={client.name}/></Row>',
    ],
  },
  {
    name: "CodeBlock",
    group: "data",
    summary: "Monospaced code or a raw payload with a language chip. Shows the text exactly as it came — no highlighting, no copy button. Long lines scroll sideways unless `wrap` folds them; a long payload takes a `maxHeight` so it scrolls instead of growing the page.",
    props: {
      code: data(z.string(), "the code or payload to show", { required: true }),
      language: config(z.string(), "language label for the chip, e.g. json"),
      wrap: config(z.boolean(), "fold long lines instead of scrolling them sideways"),
      maxHeight: config(z.number().int().positive(), "px cap; past it the block scrolls rather than growing the page"),
    },
    examples: ['<CodeBlock language="json" code={webhooks.get({id}).data.payload}/>'],
  },

  // Charts (recharts internals; data props only; $NaN is unrenderable)
  //
  // THE ONE EXCEPTION to the value tier's death: a chart keeps its axis `format`
  // and `xFormat` tokens. Everywhere else in a screen the displayed value passes
  // through the model's own code, so the model formats it there with `Intl` and
  // hands over text. An axis tick never does — the labels are computed HOST-SIDE
  // off a numeric scale, from numbers the screen holds no value of — so the series
  // stay NUMERIC and the token is how the chart is told what they mean. Tooltips
  // and bar labels read the same token, which is why they are not hand-formatted
  // either.
  //
  // A chart also has no READ to divide at: it looks its numbers up BY KEY, so the
  // `/ 100` has to happen in the data prep. These examples used to hand tool rows
  // straight to `format="money"`, and a screen that copied one faithfully rendered
  // cents as dollars — $285,000 of housing spend. So each of these says DOLLARS
  // beside its own format token, and every example maps first.
  {
    name: "LineChart",
    group: "charts",
    summary: "A line/trend chart. Y-axis ticks and tooltips are formatted by the format token, the x axis by xFormat.",
    props: {
      data: data(rows, "rows to plot", { required: true }),
      xKey: config(z.string(), "category (x) field", { required: true }),
      series: config(seriesInput, "value series: bare keys, or {key,label,color,format}. `name` reads as the label too, and a series' own format reads its tooltip in that series' units", { required: true }),
      format: config(valueFormat, "y-axis + tooltip format; money plots DOLLARS — divide a cents field where you prepare the data"),
      // The category axis had no format token at all, so a trend over days
      // printed the raw stamp the host stored under every tick while the figures
      // beside it read in the host's own words.
      xFormat: config(valueFormat, 'x-axis tick + tooltip heading format — a stored date reads "Jul 30, 2026" instead of "2026-07-30"'),
      height: config(z.number().int().positive(), "chart height in px"),
      emptyState: copy(z.string(), "text when there is nothing to plot"),
      empty: config(slot, "elements shown instead of that text"),
      tooltip: config(slot, "elements for the hovered point"),
      legend: config(slot, "a series key under the chart"),
    },
    examples: ['<LineChart data={revenue.byMonth({}).data.map((r) => ({ ...r, amount: r.amount_cents / 100 }))} xKey="month" series={["amount"]} format="money"/>'],
  },
  {
    name: "BarChart",
    group: "charts",
    summary: "A bar chart. Every bar is LABELLED with its own value, so the figure is on the chart and not only on the axis. Set horizontal for ranked lists, stacked to combine series.",
    props: {
      data: data(rows, "rows to plot", { required: true }),
      xKey: config(z.string(), "category field", { required: true }),
      series: config(seriesInput, "value series: bare keys, or {key,label,color,format}. `name` reads as the label too, and a series' own format reads its bars and their labels", { required: true }),
      format: config(valueFormat, "axis + tooltip + bar-label format; money plots DOLLARS — divide a cents field where you prepare the data"),
      stacked: config(z.boolean(), "stack series into one bar"),
      horizontal: config(z.boolean(), "horizontal bars"),
      height: config(z.number().int().positive(), "chart height in px"),
      emptyState: copy(z.string(), "text when there is nothing to plot"),
      empty: config(slot, "elements shown instead of that text"),
      tooltip: config(slot, "elements for the hovered bar"),
      legend: config(slot, "a series key under the chart"),
    },
    examples: ['<BarChart data={sales.byRegion} xKey="region" series={["unitsSold"]} horizontal/>'],
  },
  {
    name: "DonutChart",
    group: "charts",
    summary: "A donut/pie of category shares. A zero KEEPS its place in the legend reading 0; an unrenderable value is dropped, and a negative one is refused outright — a share of a whole cannot be below zero. Every slice is named and valued in a legend under the ring, so set `format`. A category field of enum tokens reads there as EnumBadge's own pills; one spelled in words prints verbatim.",
    props: {
      data: data(rows, "rows to plot", { required: true }),
      categoryKey: config(z.string(), "slice-label field", { required: true }),
      valueKey: config(z.string(), "slice-value field — in DOLLARS where format is money, so divide a cents field where you prepare the data", { required: true }),
      format: config(valueFormat, "legend + tooltip format; money reads DOLLARS and converts nothing"),
      // Enum-ness is judged per FIELD, not per value: one pill beside one bare
      // word in the same ring is worse than either reading alone, and a name field
      // ("ACME Corp") must keep the data's own words — which is why the legend
      // humanizes a token field and nothing else.
      tones: config(z.record(z.string(), toneWord), "slice value → tone overrides, exactly as EnumBadge takes them"),
      donut: config(z.boolean(), "false renders a full pie"),
      legend: config(slot, "on by default; false hides it, elements replace it"),
      height: config(z.number().int().positive(), "chart height in px"),
      emptyState: copy(z.string(), "text when there is nothing to plot"),
      empty: config(slot, "elements shown instead of that text"),
      tooltip: config(slot, "elements for the hovered slice"),
    },
    examples: ['<DonutChart data={spend.byCategory({}).data.map((r) => ({ ...r, amount: r.amount_cents / 100 }))} categoryKey="category" valueKey="amount" format="money"/>'],
  },
  {
    name: "Sparkline",
    group: "charts",
    summary: "A compact inline trend. Pass a number list or rows with a valueKey.",
    props: {
      data: data(z.array(z.union([z.number(), z.record(z.string(), z.unknown())])), "numbers or rows"),
      valueKey: config(z.string(), "field to read when data holds objects"),
      height: config(z.number().int().positive(), "height in px"),
      emptyState: copy(z.string(), "text when there are fewer than two points to draw; default is a dash"),
    },
    examples: ["<Sparkline data={account.balanceHistory}/>"],
  },
  {
    name: "Progress",
    group: "charts",
    summary: "A progress bar from a ratio (0..1) or value/max. The bar stops at 100%; past the cap `showValue` still prints the true figure. Colour it with `tone` — it never changes on its own.",
    props: {
      value: data(z.number(), "ratio 0..1, or a raw value with max"),
      max: data(z.number(), "denominator when value is raw"),
      label: copy(slot, "caption — a word, or Kit marks"),
      showValue: config(z.boolean(), "show the percentage"),
    },
    examples: ["<Progress value={goal.saved} max={goal.target} label=\"Savings goal\" showValue/>"],
  },

  // Forms
  {
    name: "Input",
    group: "forms",
    summary: "A text field. Controlled: `value` plus an `onChange` function.",
    props: {
      label: copy(z.string(), "field label"),
      value: config(z.string(), "the current value (controlled)"),
      placeholder: copy(z.string(), "placeholder text"),
      type: config(z.enum(["text", "email", "number", "password", "search", "tel", "url"]), "input type"),
      error: copy(z.string(), "what is wrong with what was typed — the border turns danger and this replaces the hint"),
      prefix: config(slot, "a unit or glyph inside the field, before the text"),
      suffix: config(slot, "a unit or glyph inside the field, after the text"),
      onChange: config(action, "called on change"),
    },
    examples: ['<Input label="Find a client" onChange="host_search_clients"/>'],
  },
  {
    name: "Select",
    group: "forms",
    summary: "A dropdown over an array of tool output. Map objects with labelField/valueField; where a choice needs two fields — a plan's price beside its name — compose that one label in data prep. `multiple` selects several, and reports the whole selection as an array.",
    props: {
      options: data(options, OPTIONS_DOC, { required: true }),
      label: copy(z.string(), "field label"),
      labelField: config(z.string(), "object field for the visible label"),
      valueField: config(z.string(), "object field for the value"),
      // An array too, because `multiple` reports one: a multi-select handed a
      // single string had nowhere to hold the second choice, so it stayed
      // uncontrolled and the screen's handler read `e.target.value` off an array
      // and got undefined.
      value: config(z.union([z.string(), z.array(z.string())]), "the chosen value (controlled), paired with onChange; an array of them when multiple"),
      placeholder: copy(z.string(), "empty-choice text"),
      multiple: config(z.boolean(), "allow several values; the handler receives them as an array"),
      onChange: config(action, "called on change"),
    },
    // Controlled, like every other field: the screen holds the choice, so
    // everything else on the screen can read it. What the state STARTS as is
    // the screen's own business — an empty string until someone picks, a value
    // the ask named — and nothing here says.
    examples: ['<Select label="Plan" options={plans.data.map((p) => ({ ...p, label: `${p.name} — ${money(p.price_cents)}` }))} labelField="label" valueField="id" value={planId} onChange={(e) => setPlanId(e.target.value)}/>'],
  },
  {
    name: "DatePicker",
    group: "forms",
    summary: "A native date control (ISO yyyy-mm-dd).",
    props: {
      label: copy(z.string(), "field label"),
      value: config(z.string(), "the current ISO date (controlled)"),
      min: config(z.string(), "earliest date"),
      max: config(z.string(), "latest date"),
      onChange: config(action, "called on change"),
    },
    examples: ['<DatePicker label="Due date"/>'],
  },
  {
    name: "Textarea",
    group: "forms",
    summary: "A multiline text field.",
    props: {
      label: copy(z.string(), "field label"),
      value: config(z.string(), "the current value (controlled)"),
      placeholder: copy(z.string(), "placeholder text"),
      rows: config(z.number().int().positive(), "visible rows"),
      footer: config(slot, "a row under the box — a counter, a hint action"),
      onChange: config(action, "called on change"),
    },
    examples: ['<Textarea label="Note" rows={4}/>'],
  },
  {
    name: "Checkbox",
    group: "forms",
    summary: "A boolean toggle. Controlled: `checked` plus an `onChange` function; `indeterminate` is the header box over a partly-selected list.",
    props: {
      label: copy(z.string(), "field label"),
      checked: config(z.boolean(), "the current checked state (controlled)"),
      indeterminate: config(z.boolean(), "neither checked nor clear"),
      onChange: config(action, "called on toggle"),
    },
    examples: ['<Checkbox label="Include paid"/>'],
  },
  {
    name: "Switch",
    group: "forms",
    summary: "An instant on/off setting — it applies the moment it is flipped. A choice a Form submits is a Checkbox.",
    props: {
      label: copy(z.string(), "field label"),
      checked: config(z.boolean(), "the current state (controlled)"),
      onChange: config(action, "called on flip"),
    },
    examples: ['<Switch label="Notify me" checked={notify} onChange={(e) => setNotify(e.target.checked)}/>'],
  },
  {
    name: "Radio",
    group: "forms",
    summary: "One choice out of a few, all of them visible. Takes a RAW array of tool output through labelField/valueField, exactly as Select does; past about six options use Select.",
    props: {
      options: data(options, OPTIONS_DOC, { required: true }),
      label: copy(z.string(), "field label"),
      labelField: config(z.string(), "object field for the visible label"),
      valueField: config(z.string(), "object field for the value"),
      value: config(z.string(), "the selected value (controlled)"),
      onChange: config(action, "called on change"),
    },
    examples: ['<Radio label="Speed" options={plans.data} labelField="name" valueField="id" value={plan} onChange={(e) => setPlan(e.target.value)}/>'],
  },
  {
    name: "Slider",
    group: "forms",
    summary: "A number picked along a range, by dragging or by arrow key. Use it where the exact figure matters less than where it sits between two ends.",
    props: {
      label: copy(z.string(), "field label"),
      value: config(z.number(), "the current number (controlled)"),
      min: config(z.number(), "range start, default 0"),
      max: config(z.number(), "range end, default 100"),
      step: config(z.number().positive(), "granularity, default 1"),
      showValue: config(z.boolean(), "show the current number"),
      onChange: config(action, "called on change"),
    },
    examples: ['<Slider label="Budget" min={0} max={5000} step={50} showValue value={budget} onChange={(e) => setBudget(e.target.value)}/>'],
  },
  {
    name: "SegmentedControl",
    group: "forms",
    summary: "A few mutually exclusive choices as one bar — the filter switch that changes what is SHOWN. Radio is the form field; Tabs is for whole panels.",
    props: {
      items: config(
        z.array(z.union([
          z.string(),
          z.object({ value: z.string().optional(), label: z.string(), disabled: z.boolean().optional() }),
        ])),
        "segment labels, or {value,label} items",
        { required: true },
      ),
      value: config(z.string(), "the selected segment's value"),
      onChange: config(action, "called on change"),
    },
    examples: ['<SegmentedControl items={["Week","Month","Year"]} value={range} onChange={(e) => setRange(e.target.value)}/>'],
  },
  {
    name: "Combobox",
    group: "forms",
    summary: "A type-to-filter dropdown over a RAW array of tool output — Select's shape, for a list too long to scan.",
    props: {
      options: data(options, OPTIONS_DOC, { required: true }),
      label: copy(z.string(), "field label"),
      labelField: config(z.string(), "object field for the visible label"),
      valueField: config(z.string(), "object field for the value"),
      value: config(z.string(), "the selected value (controlled)"),
      placeholder: copy(z.string(), "empty-field text"),
      onChange: config(action, "called on change"),
    },
    examples: ['<Combobox label="Client" options={clients.data} labelField="name" valueField="id" value={clientId} onChange={(e) => setClientId(e.target.value)}/>'],
  },
  {
    name: "DateRange",
    group: "forms",
    summary: "A start and an end picked from one calendar. Reports `{start, end}` as ISO dates; one date is a DatePicker.",
    props: {
      label: copy(z.string(), "field label"),
      start: config(z.string(), "the current start, ISO yyyy-mm-dd"),
      end: config(z.string(), "the current end, ISO yyyy-mm-dd"),
      min: config(z.string(), "earliest selectable date"),
      max: config(z.string(), "latest selectable date"),
      placeholder: copy(z.string(), "text before a range is picked"),
      onChange: config(action, "called with {start, end} once both are picked"),
    },
    examples: ['<DateRange label="Period" start={from} end={to} onChange={(range) => setPeriod(range)}/>'],
  },
  {
    name: "Button",
    takesChildren: true,
    group: "forms",
    summary: "A button. `onClick` takes a function; calling a tool in it is the only way the UI changes anything, and the runtime routes that call through the guard + approval pipe. Its text is `label`, or the children — `<Button>Save</Button>` says the same thing.",
    props: {
      // No longer REQUIRED, because the children say it too: it was required to
      // stop a nameless button shipping, and `<Button>Save</Button>` is named.
      label: copy(z.string(), "button text; or write it as the children"),
      onClick: config(action, "called on click; call a tool in it"),
      // The older word for the same three tones, kept ACCEPTED and no longer
      // taught: `tone` is the Kit's one emphasis vocabulary now, and a screen that
      // mixes the two words must degrade rather than die. Stored screens carry
      // `variant` by the hundred, and the renderer reads it wherever no `tone` is
      // written (`ui` forms/button.tsx `VARIANT_TONE`).
      variant: config(z.enum(["primary", "secondary", "danger"]), "deprecated — the older spelling of tone: primary=accent, secondary=neutral, danger=danger"),
      icon: config(iconName, "a lucide glyph before the label, in kebab-case"),
      loading: config(z.boolean(), "the click is in flight: a spinner takes the icon's place and the button stops answering, so the tool cannot fire twice"),
    },
    examples: [
      '<Button label="Remind all" icon="send" onClick={() => tools.send_reminders({})}/>',
      '<Button label="Cancel transfer" tone="danger" loading={cancelling} onClick={() => tools.cancel_transfer({ id })}/>',
    ],
  },
  {
    name: "Link",
    takesChildren: true,
    group: "forms",
    summary: "Sends someone to a page of the host product. `to` NAMES a route the host registered — never a URL. A name the host did not register renders as muted, visibly inert text with nothing to press, so link only where the host said you may.",
    props: {
      to: config(z.string(), "the registered route's name", { required: true }),
      params: config(z.record(z.string(), z.string()), "values for the route path's :params"),
      label: copy(z.string(), "link text; or nest the content as children"),
    },
    examples: ['<Link to="account" params={{id: accounts.data[0].id}} label="View account"/>'],
  },
  {
    name: "Form",
    takesChildren: true,
    group: "forms",
    summary: "Groups fields with a submit action. `onSubmit` takes a function.",
    props: {
      onSubmit: config(action, "called on submit; call a tool in it"),
      submitLabel: copy(z.string(), "submit button text"),
      header: config(slot, "elements above the fields"),
      actions: config(slot, "buttons beside the submit"),
      footer: config(slot, "fine print under the actions"),
    },
    examples: ['<Form onSubmit={() => tools.create_client({ name })} submitLabel="Add client"><Input label="Name" value={name} onChange={(e) => setName(e.target.value)}/></Form>'],
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
    takesChildren: true,
    group: "feedback",
    summary: "Self-managing tabs. Name the tabs, then nest ONE child per tab in tab order — switching panels needs no handler and never leaves the page.",
    props: {
      tabs: config(
        z.array(z.union([
          z.string(),
          z.object({
            value: z.string().optional(),
            label: z.string(),
            disabled: z.boolean().optional(),
            // Code-only: a panel passed inline instead of as a child. Wire
            // trees cannot express an element in an attribute, so they nest
            // panels as children (the shape the plan skeleton emits).
            content: slot.optional(),
          }),
        ])),
        "tab labels, or {value,label} items",
        { required: true },
      ),
      value: config(z.string(), "the initially selected tab's value"),
      defaultIndex: config(z.number().int().nonnegative(), "initially selected tab, by position"),
      actions: config(slot, "elements at the end of the tab row"),
    },
    examples: ['<Tabs tabs={["Overview","Detail"]}><Stat label="Open" value={x.count}/><DataTable rows={x.data} columns={[{key:"client"}]}/></Tabs>'],
  },
  {
    name: "Callout",
    takesChildren: true,
    group: "feedback",
    summary: "A toned notice highlighting real information. For 'no tool' honesty use Disclaimer.",
    props: {
      title: copy(z.string(), "notice heading"),
    },
    examples: ['<Callout tone="warning" title="Heads up">Three invoices are overdue.</Callout>'],
  },
  {
    name: "Accordion",
    group: "feedback",
    summary: "Self-managing collapsible sections. Good for long apps.",
    props: {
      items: config(z.array(z.object({ label: z.string(), content: slot })), "sections", { required: true }),
      multiple: config(z.boolean(), "allow several open at once"),
      defaultOpen: config(z.array(z.number().int().nonnegative()), "which sections start open, by position"),
    },
    examples: ["<Accordion items={[{label:\"Terms\",content:<Text .../>}]}/>"],
  },
  {
    name: "Menu",
    group: "feedback",
    summary: "Actions behind one trigger, for the row of buttons that would not fit. Its entries are DATA — `items` plus one `onSelect` — and it renders nothing nested inside it.",
    // It USED to wrap each child in a menu entry with no handler attached, so a
    // menu written with nested <Button>s opened and did nothing at all: the one
    // shape a person cannot tell from a broken product. The children branch is
    // gone (`ui` menu.tsx), so this names what to write instead.
    childrenFix: 'A menu entry is data, not an element: write items={[{label:"Send reminder",value:"remind",icon:"send"},{label:"Void",value:"void"}]} with one onSelect={(e) => tools.invoice_action({ action: e.target.value })}.',
    props: {
      label: copy(z.string(), "the trigger's text", { required: true }),
      items: config(
        z.array(z.object({
          label: z.string(),
          value: z.string().optional(),
          icon: z.string().optional(),
          disabled: z.boolean().optional(),
        })),
        "the entries; value is what onSelect receives, icon is a lucide name",
      ),
      onSelect: config(action, "called with the chosen entry's value; call a tool in it"),
    },
    examples: ['<Menu label="Actions" items={[{label:"Send reminder",value:"remind",icon:"send"},{label:"Void",value:"void"}]} onSelect={(e) => tools.invoice_action({ id, action: e.target.value })}/>'],
  },
  {
    name: "Tooltip",
    takesChildren: true,
    group: "feedback",
    summary: "A hint on hover or focus for the one control nested inside it. For a notice that must be read without hovering, use Callout.",
    props: {
      label: copy(z.string(), "the hint, as plain text"),
      // Code-only, exactly like `Tabs.tabs[].content`: a slot holds an ELEMENT,
      // and a wire attribute cannot. Optional is what keeps Tooltip wire-usable.
      content: config(slot, "code-only: Kit elements rendered as the hint instead of label"),
    },
    examples: ['<Tooltip label="Sent 3 days ago"><Icon name="clock"/></Tooltip>'],
  },
  {
    name: "EmptyState",
    takesChildren: true,
    group: "feedback",
    summary: "The designed nothing-here for a whole region, with the action that fixes it nested inside. A component with its own emptyState prop (DataTable, CardList) already has one.",
    props: {
      icon: config(slot, "a lucide icon name in kebab-case, or a Kit mark"),
      title: copy(z.string(), "the headline", { required: true }),
      description: copy(z.string(), "one line of why it is empty, or what to do"),
    },
    examples: [
      '<EmptyState icon="inbox" title="No invoices yet" description="They show up here the moment one is issued."><Button label="New invoice" onClick="invoices.create"/></EmptyState>',
    ],
  },
  {
    name: "Steps",
    group: "feedback",
    summary: "A progress trail. `active` is the current step's index; everything before it reads as done, everything after as still to come.",
    props: {
      items: config(z.array(z.object({ label: z.string(), description: z.string().optional() })), "the steps in order", { required: true }),
      active: config(z.number().int().nonnegative(), "index of the current step, default 0"),
      orientation: config(z.enum(["horizontal", "vertical"]), "layout, default horizontal"),
      marker: config(slot, "a glyph in place of the numbered disc"),
    },
    examples: ['<Steps items={[{label:"Details"},{label:"Review"},{label:"Done"}]} active={1}/>'],
  },

  // Overlays — the bricks that paint outside the screen's own box.
  {
    name: "Modal",
    takesChildren: true,
    group: "overlays",
    summary: "A dialog over the screen for a decision that must be answered before anything else. `open` raises it, `onClose` names the tool that takes it down; focus, Esc and the page's scroll lock are handled for you.",
    props: {
      open: config(z.boolean(), "whether the dialog is up", { required: true }),
      // REQUIRED, because every way out of a controlled dialog runs through it:
      // the X, Esc and the backdrop all do nothing but call this. Without it a
      // generated screen can raise a modal that nothing can take down.
      onClose: config(action, "called when it asks to close — Esc, the backdrop, or the X", { required: true }),
      title: copy(z.string(), "the dialog's heading"),
      description: copy(z.string(), "one line under the heading"),
      size: config(z.enum(["small", "medium", "large"]), "width, default medium"),
      header: config(slot, "elements beside the title"),
      footer: config(slot, "the buttons under the content"),
    },
    examples: ['<Modal open={confirming} onClose={() => setConfirming(false)} title="Send reminders?" description="Three clients will be emailed."><Button label="Send" onClick={() => tools.send_reminders({})}/></Modal>'],
  },
  {
    name: "Sheet",
    takesChildren: true,
    group: "overlays",
    summary: "A dialog that slides in from an edge, for detail beside the screen rather than on top of it. Same open/close pair as Modal; `side` picks the edge.",
    props: {
      open: config(z.boolean(), "whether the sheet is out", { required: true }),
      // REQUIRED for the same reason Modal's is — see there.
      onClose: config(action, "called when it asks to close — Esc, the backdrop, or the X", { required: true }),
      title: copy(z.string(), "the sheet's heading"),
      description: copy(z.string(), "one line under the heading"),
      size: config(z.enum(["small", "medium", "large"]), "how far it comes out, default medium"),
      side: config(z.enum(["left", "right", "top", "bottom"]), "the edge it slides from, default right"),
      header: config(slot, "elements beside the title"),
      footer: config(slot, "the buttons under the content"),
    },
    examples: ['<Sheet open={viewing !== null} onClose={() => setViewing(null)} title="Invoice INV-204" side="right"><KeyValue record={invoice}/></Sheet>'],
  },
  {
    name: "Toast",
    group: "overlays",
    summary: "A transient notice in the corner, for something that already happened. It takes itself down after `duration`; `onClose` is how the screen learns it went.",
    props: {
      open: config(z.boolean(), "whether the notice is up", { required: true }),
      onClose: config(action, "called when it dismisses itself"),
      message: copy(z.string(), "the one line to show", { required: true }),
      duration: config(z.number().int().positive(), "ms on screen before it leaves, default 5000"),
    },
    examples: ['<Toast open={sent} onClose={() => setSent(false)} message="Reminders sent." tone="success"/>'],
  },
];

/**
 * THE SLOTS — every place the Kit takes an ELEMENT instead of a value, in one
 * table. The generated prompt teaches from it and the nesting check enforces
 * it: an element under a key that is NOT declared here is refused rather than
 * dropped at render, which is the silent-breakage class this floor exists for.
 * A slot's key is the last segment of where the element sits, so `columns[].cell`
 * and `marker` are the slots `cell` and `marker`.
 *
 * THE LAW: a slot is declared here only when the React component RENDERS it —
 * a `ReactNode` prop it actually paints (`@vendoai/ui`). Teaching a slot the Kit
 * does not implement is worse than teaching none: the prompt tells the model to
 * write it, every check passes it, and the renderer drops it in silence. That is
 * the same silent-breakage this table exists to refuse, arriving through the
 * table itself. `@vendoai/ui`'s `test/kit/slot-drift.test.tsx` puts a probe in
 * every slot declared here and fails unless it finds it in the DOM, so the two
 * move together at every merge.
 *
 * WHAT a slot holds is not declared: any Kit element may sit in any slot, the
 * way it may in normal React. Where each one BELONGS is the model's design
 * judgement, and the judge's to grade.
 */

/** The two a container draws, written once: every one of them sits beside a
 *  title and under the content, so restating the pair six times would be six
 *  chances for them to drift apart in the prompt. */
const header: KitSlotSpec = { doc: "elements along the top edge, beside the title" };
const footer: KitSlotSpec = { doc: "the buttons under the content" };
/** What a container paints in place of its `emptyState` TEXT — an EmptyState
 *  with the action that fixes it, where a sentence used to be. */
const empty = (nothing: string): KitSlotSpec => ({ doc: `what to show in place of emptyState when there are no ${nothing}` });
/** A chart's hovered point, on the cell contract: written once PER POINT and
 *  painted for whichever one is under the pointer. */
const tooltip: KitSlotSpec = { doc: "Kit value components composed for the hovered point, in place of the default tooltip — write it as (point) => elements", perRow: true, rows: "data" };

const SLOTS: Readonly<Record<string, Record<string, KitSlotSpec>>> = {
  // No `at` on any of these pairs: a container reads its header and footer as
  // props of its own, the way Timeline reads `marker`.
  Surface: { header, footer },
  Card: { header, footer, description: { doc: "the subheading under the title, as elements instead of text" } },
  Divider: { label: { doc: "a word centred in the rule" } },
  DataTable: {
    cell: { doc: "ONE row's cell, in place of the column's plain text — write it as (row) => elements", perRow: true, rows: "rows", at: "columns" },
    // Per-row and OPERABLE: written as a function of the row, so what it paints
    // has that row to act on and each row's control is its own.
    rowActions: { doc: "the controls at the end of EVERY row, acting on that row — write it as (row) => elements", perRow: true, rows: "rows" },
    toolbar: { doc: "elements in the controls row, beside the search and the filters" },
    empty: empty("rows"),
  },
  CardList: {
    cell: { doc: "ONE item's value, in place of the field's plain text — write it as (item) => elements", perRow: true, rows: "items", at: "fields" },
    actions: { doc: "the buttons above the cards" },
    empty: empty("items"),
  },
  KeyValue: { cell: { doc: "one field's value, in place of its plain text — write it as (record) => elements", perRow: true, rows: "record", at: "items" } },
  Timeline: {
    cell: { doc: "ONE entry's body — write it as (entry) => elements", perRow: true, rows: "entries" },
    marker: { doc: "a glyph drawn in place of the entry's dot" },
    empty: empty("entries"),
  },
  Stat: { icon: { doc: "a glyph beside the metric name" } },
  LineChart: { tooltip, legend: { doc: "a series key drawn under the chart" }, empty: empty("points to plot") },
  BarChart: { tooltip, legend: { doc: "a series key drawn under the chart" }, empty: empty("bars to plot") },
  DonutChart: { tooltip, legend: { doc: "false hides the built-in key under the ring; an element replaces it" }, empty: empty("slices to plot") },
  Progress: { label: { doc: "the caption over the bar, as elements instead of text" } },
  // No `hint` on any of these: it is a shared adjective now, so it lands on every
  // control that takes one (`SHARED_PROPS`) rather than the three listed here.
  Input: {
    prefix: { doc: "a unit or glyph inside the field, before the text" },
    suffix: { doc: "a unit or glyph inside the field, after the text" },
  },
  Textarea: { footer: { doc: "a row under the box — a counter, a hint action" } },
  Form: {
    header: { doc: "elements above the fields" },
    actions: { doc: "buttons beside the submit — a cancel, a secondary" },
    footer: { doc: "fine print under the actions" },
  },
  Tabs: {
    content: { doc: "ONE tab's panel, written inline instead of as a child", at: "tabs" },
    actions: { doc: "elements at the end of the tab row" },
  },
  Accordion: { content: { doc: "ONE section's body", at: "items" } },
  // No `at`: the hint is a prop of its own, not a field of one the Tooltip holds.
  Tooltip: { content: { doc: "Kit elements rendered as the hint instead of the label" } },
  EmptyState: { icon: { doc: "a Kit mark drawn in the disc instead of a lucide name" } },
  Steps: { marker: { doc: "a glyph drawn in place of the step's numbered disc" } },
  Modal: { header, footer },
  Sheet: { header, footer },
};

/** Where a slot's element sits, as ONE comparable string: `columns[].cell` for a
 *  field of a description object, `marker` for a slot that is a prop of its own.
 *  The prompt teaches this string and the nesting check matches on it, so the
 *  place a component READS and the place the floor admits are the same place. */
export const kitSlotPath = (name: string, slot: KitSlotSpec): string =>
  slot.at === undefined ? name : `${slot.at}[].${name}`;

/** Every spec, with each shared adjective folded into the components that read
 *  it — so validation, the wire's allowed-prop set and the screen typings admit
 *  it exactly where it lands, and refuse it where it would be dropped — and its
 *  slots, which the same consumers read. */
export const KIT_SPECS: KitComponentSpec[] = BASE_SPECS.map((spec) => {
  const shared = SHARED_PROPS.filter(({ on }) => on.includes(spec.name));
  const slots = { ...SLOTS[spec.name] };
  for (const adjective of shared) if (adjective.slot !== undefined) slots[adjective.name] = adjective.slot;
  return {
    ...spec,
    engine: ENGINES[spec.name],
    ...(Object.keys(slots).length === 0 ? {} : { slots }),
    props: {
      ...spec.props,
      [STYLE_PROP]: style,
      ...Object.fromEntries(shared.map(({ name, spec: prop }) => [name, prop])),
    },
  };
});

/**
 * EVERY SLOT, keyed by the prop that ARRIVES — the screen VM's copy of the slot
 * law.
 *
 * A slot takes the element, or the function that returns it, and the VM calls
 * whichever it was given (`genui/component/vm-program.ts` `emitSlot`). That is one
 * law at two arities: a slot the Kit paints once per row is called with `(row, i)`
 * and hands over a LIST of elements — which is why the rows have to be reachable
 * from the same props object, and why those entries say which prop holds them —
 * and every other slot is called with no arguments and emits the one element it
 * returns. Written as a function and NOT known here, a slot crosses the VM
 * boundary as a `$handler` door instead, so the component is handed a callback
 * where an element belongs and paints blank: this table is what keeps that from
 * happening, so it is derived from {@link KIT_SPECS} rather than from `SLOTS`,
 * where the shared adjectives' slots (`hint`) are not yet folded in.
 *
 * Two shapes, because a slot is either a prop of its own (`rowActions`) or a
 * field of the description objects one prop holds (`columns[].cell`) — the same
 * distinction `at` draws, read from the arriving prop's end.
 */
export interface KitSlotProp {
  /** The prop holding the rows the slot is painted once for. Absent means the Kit
   *  paints the slot ONCE, so its function takes no arguments. */
  rows?: string;
  /** The field of each description object that IS the slot, when the arriving
   *  prop is a list of descriptions rather than the slot itself. */
  field?: string;
}

export const KIT_SLOT_PROPS: Readonly<Record<string, Readonly<Record<string, KitSlotProp>>>> =
  Object.fromEntries(KIT_SPECS.flatMap((spec) => {
    const found: Array<[string, KitSlotProp]> = [];
    for (const [name, slot] of Object.entries(spec.slots ?? {})) {
      const rows = slot.perRow === true && slot.rows !== undefined ? { rows: slot.rows } : {};
      found.push(slot.at === undefined ? [name, rows] : [slot.at, { ...rows, field: name }]);
    }
    return found.length === 0 ? [] : [[spec.name, Object.fromEntries(found)]];
  }));

/**
 * THE component vocabulary — one list, derived from the specs, and the single
 * definition every other name here is a view of (the ui renderer maps them to
 * `KIT_COMPONENTS`). Nothing recomputes `KIT_SPECS.map(name)` a second time.
 */
export const KIT_COMPONENT_NAMES: readonly string[] = KIT_SPECS.map((spec) => spec.name);

/**
 * What may be nested where — the one rule the renderer cannot state.
 *
 * The tree renderer hands `children` to EVERY node it renders
 * (`packages/ui/src/tree/renderer.tsx` `builtinContent`), so a chart handed a
 * child has always rendered as nothing at all: the model wrote content, the
 * person got a blank, and no stage said a word. This list is what the checks
 * floor refuses on.
 */
export const KIT_CHILDLESS_NAMES: readonly string[] = KIT_SPECS
  .filter((spec) => spec.takesChildren !== true)
  .map((spec) => spec.name);

/** The same list, as the mutable array `@vendoai/ui`'s registry wants. */
export function kitComponentNames(): string[] {
  return [...KIT_COMPONENT_NAMES];
}

/** Look up a single spec by name. */
export function kitSpec(name: string): KitComponentSpec | undefined {
  return KIT_SPECS.find((s) => s.name === name);
}

/** Kit components a SCREEN's prompt must not teach — EMPTY, and the subtraction
 *  below is what keeps it derivable rather than listed by hand.
 *
 *  `Accordion` was the one name here, for an `items[].content` slot holding an
 *  ELEMENT, which only hand-written JSX can fill. Hand-written JSX is what a
 *  screen IS now, and the type check has admitted the whole Kit all along
 *  (`checking/screen-typings.ts` `screenCatalog`) — so the filter was hiding a
 *  component that renders, and the model was never offered the collapsible
 *  sections a long app asks for. */
export const KIT_NON_SCREEN_NAMES: readonly string[] = [];

/**
 * The Kit names a generated SCREEN may use. These are taught by `kitPrompt`,
 * typed into the screen's ambient `.d.ts`, and rendered from `KIT_COMPONENTS`.
 */
export const KIT_SCREEN_COMPONENT_NAMES: readonly string[] = KIT_COMPONENT_NAMES.filter((name) =>
  !KIT_NON_SCREEN_NAMES.includes(name));

/** Prop name → class for one Kit component (law-1 enforcement handle). */
export function kitPropClasses(name: string): Readonly<Record<string, PropClass>> | undefined {
  const spec = kitSpec(name);
  if (spec === undefined) return undefined;
  return Object.fromEntries(Object.entries(spec.props).map(([prop, { cls }]) => [prop, cls]));
}
