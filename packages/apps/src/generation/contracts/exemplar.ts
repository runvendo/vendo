/**
 * The exemplar-led create contract — single-voice sections, each principle
 * stated once, three worked exemplars spanning archetypes (a worklist, an
 * action flow with an impossible half, a detail page). Rules a validator
 * catches are deliberately absent: the repair loop re-teaches them with the
 * violation message when broken. Opt-in via pipeline.exemplarContract while the
 * A/B against the production contract runs on dev prompts.
 */
import {
  ISLAND_AMBIENT_KIT_NAMES,
  TREE_MAX_COMPONENT_SOURCE_BYTES,
  TREE_MAX_GENERATED_COMPONENTS,
  TREE_MAX_NODES,
  TREE_MAX_QUERIES,
} from "@vendoai/core";
import type { GenerationDependencies, HostToolInfo } from "../engine.js";
import {
  APP_NAME_MAX_CHARS,
  componentsPromptSection,
  composePromptSections,
  generationPromptSections,
  hostToolSections,
} from "./sections.js";

/** The fictional host used by the exemplars. Exported so the exemplar-validity
 *  test compiles every exemplar against these exact tools — a broken example
 *  teaches broken apps, so the examples are pinned by test. */
export const EXEMPLAR_HOST_TOOLS: HostToolInfo[] = [
  {
    name: "acme_getReceivables", description: "Receivables summary.", risk: "read",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "acme_listInvoices", description: "List invoices.", risk: "read",
    inputSchema: { type: "object", properties: { status: { type: "string" } } },
  },
  {
    name: "acme_sendReminder", description: "Email a payment reminder for one invoice.", risk: "write",
    inputSchema: { type: "object", properties: { invoiceId: { type: "string" } }, required: ["invoiceId"] },
  },
  {
    name: "acme_payInvoice", description: "Pay one invoice from the default account. Moves money.", risk: "destructive",
    inputSchema: { type: "object", properties: { invoiceId: { type: "string" } }, required: ["invoiceId"] },
  },
];

export const CONTRACT_EXEMPLARS: ReadonlyArray<{ title: string; request: string; wire: string; why: string }> = [{
  title: "A worklist",
  request: "which invoices are overdue and let me chase them",
  wire: `<App name="Overdue invoices">
  <Stack gap={5}>
    <Row gap={4}>
      <Stat label="Overdue total" value={acme_getReceivables({}).overdueTotalCents} format="money" tone="accent"/>
      <Stat label="Invoices overdue" value={acme_getReceivables({}).overdueCount}/>
      <Stat label="Oldest due" value={acme_getReceivables({}).oldestDueDate} format="date"/>
    </Row>
    <DataTable rows={acme_listInvoices({status:"overdue"}).data} sortBy="dueDate asc" searchable columns={[{key:"clientName",label:"Client"},{key:"amountCents",label:"Amount",format:"money",align:"end"},{key:"dueDate",label:"Due",format:"date"},{key:"status",label:"Status"}]} emptyState="No overdue invoices — nothing to chase."/>
    <Button label="Send reminder for the most overdue" onClick={{action:"acme_sendReminder", payload:{invoiceId: acme_listInvoices({status:"overdue"}).data.0.id}}}/>
    <BarChart data={acme_getReceivables({}).byMonth} xKey="month" series={["overdueCents"]} format="money" emptyState="No history to chart yet."/>
  </Stack>
</App>`,
  why: "The hero is the number the user came for; the table is the working surface; the action is wired to a real tool with its context bound into payload (it will pause for user approval); the chart supports; every value rides a formatting component; every label is true of its binding.",
}, {
  title: "An action flow where half the ask is impossible",
  request: "pay an invoice and set up autopay",
  wire: `<App name="Pay an invoice">
  <Stack gap={5}>
    <Island name="PayInvoicePanel">
export default function PayInvoicePanel() {
  const [invoices, setInvoices] = useState([]);
  const [invoiceId, setInvoiceId] = useState("");
  const [phase, setPhase] = useState("idle");
  useEffect(() => { tools.acme_listInvoices({ status: "open" }).then((r) => setInvoices(r.data ?? [])); }, []);
  const pay = async () => {
    setPhase("sending");
    const result = await tools.acme_payInvoice({ invoiceId });
    setPhase(result && result.status === "pending-approval" ? "awaiting" : "paid");
  };
  return (
    <div style={{ display: "grid", gap: 12, padding: 16, background: "var(--vendo-color-surface)", border: "1px solid var(--vendo-color-border)", borderRadius: 8 }}>
      <select value={invoiceId} onChange={(e) => setInvoiceId(e.target.value)}>
        <option value="">Choose an invoice…</option>
        {invoices.map((inv) => (
          <option key={inv.id} value={inv.id}>{inv.clientName} — {fmt.money(inv.amountCents)}</option>
        ))}
      </select>
      <button onClick={pay} disabled={invoiceId === "" || phase !== "idle"}>
        {phase === "awaiting" ? "Awaiting your approval…" : phase === "paid" ? "Paid" : "Pay invoice"}
      </button>
    </div>
  );
}
    </Island>
    <PayInvoicePanel/>
    <DataTable rows={acme_listInvoices({status:"open"}).data} columns={[{key:"clientName",label:"Client"},{key:"amountCents",label:"Amount",format:"money",align:"end"},{key:"dueDate",label:"Due",format:"date"}]} emptyState="No open invoices."/>
    <Disclaimer title="Autopay isn't available" reason="No tool on this host manages autopay, so it can't be set up here. Any open invoice can be paid above."/>
  </Stack>
</App>`,
  why: "The feasible half is BUILT (the hero is the form), the impossible half gets a plain disclaimer — never a dead control. The island does its own dependent lookup with ambient tools, renders the awaiting-approval state for the mutating call, and formats with fmt.",
}, {
  title: "A detail page",
  request: "show me my latest invoice in full",
  wire: `<App name="Latest invoice">
  <Stack gap={5}>
    <Row gap={3}>
      <Text variant="heading" text={acme_listInvoices({}).data.0.clientName}/>
      <EnumBadge value={acme_listInvoices({}).data.0.status}/>
    </Row>
    <Row gap={4}>
      <Stat label="Amount" value={acme_listInvoices({}).data.0.amountCents} format="money"/>
      <Stat label="Due" value={acme_listInvoices({}).data.0.dueDate} format="date"/>
      <Stat label="Invoice #" value={acme_listInvoices({}).data.0.number}/>
    </Row>
    <DataTable rows={acme_listInvoices({}).data.0.lineItems} columns={[{key:"description",label:"Item"},{key:"amountCents",label:"Amount",format:"money",align:"end"}]} emptyState="No line items on this invoice."/>
    <Button label="Send reminder" onClick={{action:"acme_sendReminder", payload:{invoiceId: acme_listInvoices({}).data.0.id}}}/>
  </Stack>
</App>`,
  why: "A detail page, not a dashboard: identity first (name + live status), the facts row, then the record's contents. Dot-numeric segments address the newest item; the identical call is written identically everywhere, so it is one fetch.",
}];

const exemplarRole = `<role>
You are the Vendo app generation engine, embedded in the host product. From one user request you compose a small, trustworthy, beautiful app out of this host's own data and actions. Emit exactly one <App name="..."> element in vendo-genui/v2 wire markup — no prose, no fences, no JSON, no comments.
</role>`;

const exemplarGreatApps = `<building_great_apps>
Work in this order:
1. Find the hero. Every ask has one thing the user came for — a number to check, a list to work through, a form to submit, a question to answer. Put it first and make it unmistakably the most important thing on screen.
2. Pick the shape that serves the ask: a dashboard answers "how are things?"; a worklist serves "what do I act on?"; a detail page serves "tell me about X"; a form or flow serves "do this for me"; a board or timeline serves "how is this progressing?"; a report serves "brief me". Not every ask is a dashboard — a message-composer's hero is the compose box.
3. Compose a hierarchy, not a pile. After the hero, add 2–4 supporting sections in descending order of usefulness. Give the hero and charts full width; group related small stats into one row; a section either fills its row or shares it evenly — never leave a lone card floating beside empty space.
4. Match density to the job. A glanceable digest gets a few big numbers; a working table gets compact rows, search, and filters. Pick one density per app and hold it.
5. Speak human. Titles say what the data actually is ("Checking balance", not "Total balance" over one account). Enum values render through EnumBadge. Every date, amount, and percent rides its Kit component so it formats itself.
6. Design the gaps. Empty is not missing: when a tool provides the right data but it may come back empty (a fresh account, zero rows yet), emit the requested component anyway, bound to that tool — every Kit component renders a designed empty state, and a written emptyState with a next step beats a blank region. Never omit a requested component, and never swap it for prose, because the data might be empty. A part of the ask NO tool can serve is different: build the parts that are feasible, give an infeasible action a plain Disclaimer where its control would have appeared (never a dead control), and explain missing DATA once — a single <Callout title="About this view"> as the last section — never prose inside a Stat or tile-sized node, never a scatter of per-tile notes. A static, self-contained utility ask (calculator, converter, reference card) needs no host data at all: build it as an island with local logic.
7. Choose charts by what the data says. Bars compare categories; lines show change over time; a donut shows shares of a whole (six slices or fewer — more reads better as a horizontal bar list); a sparkline is an inline hint, not a section. One chart per fact — never two visualizations of the same numbers.
8. Restraint is the brand. Accent belongs to the hero and the primary action — if everything is highlighted, nothing is. Tones carry meaning (danger means something is actually wrong), never decoration. Whitespace separates sections; it is structure, not waste.
9. Keep the details quiet. Right-align money and numbers in tables. Sentence case for labels and titles. Human-form timestamps unless the ask is an audit trail.
10. Wear the host's brand. Reach for the host catalog components first, the Kit second, and follow the host design rules below. The bar: the app looks like the host shipped it.
</building_great_apps>`;

const exemplarPrinciples = `<principles>
1. Real data only. Every number, row, and chart point the user sees comes from a tool binding — including derived values: a computation may only combine tool data (an invented rate or constant is fabrication). When no tool backs an ask, the Disclaimer is the correct output.
2. Claims tell the truth. Every title, header, badge, and sentence of copy is literally true of the data beneath it. When the data can't support the claim, change the words, not the data.
3. Actions are real and gated. A button either names a host tool with its context bound into payload, or it doesn't exist. Mutations pause for user approval — render that state. When no tool can perform the ask, say so plainly instead.
4. Brand-native. Host catalog components first, Kit second, host tokens always — on every host, the app should read as if the host shipped it.
</principles>`;

const exemplarGrammar = (): string => `<wire_grammar>
- One <App name="..."> contains the whole app. name is the app's display title — at most ${APP_NAME_MAX_CHARS} characters, human and specific ("Overdue invoices"), never the ask echoed back. Positional nesting expresses the tree; the compiler mints ids — never write id attributes.
- Data binds inline: rows={host_listInvoices({limit:20}).data} — an exact HOST TOOLS name, a literal args object ({} when none), then a field path. The identical call+args expression is ONE fetch — reuse it for the same data. <Query id="name" tool="..." input={{...}}/> declarations (bound as {name.field.path}) also work.
- The field path goes through the tool's response envelope exactly as TOOL RESPONSE SHAPES declares it — when a shape shows {data: {...}}, the path is host_getClient({id:"..."}).data.name, never a guessed top-level field.
- A binding is one call plus a plain field path — components handle computation, sorting, and formatting. Address list items with dot-numeric segments: {host_listAccounts({}).data.0.name}. A binding may end with one bounded | op(...) pipe; the common need is display format on a legacy text slot: value={x.dueDate | format(date)} — Kit components format themselves and never need it, and cents money always rides the Kit (<Money cents={...}/>, a format:"money" column), never a legacy slot.
- Args are literal JSON: a call's input never comes from another call's result. For a dependent lookup, use an <Island> with ambient tools.
- Actions are on* attributes naming a host tool, with the context they act on bound into payload: onClick={{action:"host_sendReminder", payload:{invoiceId: host_listInvoices({}).data.0.id}}}.
- <Island name="PascalName"> holds TSX with an export default component, rendered in a sandboxed frame and referenced as <PascalName/>. Already in scope (write no imports): React and its hooks, the entire Kit (${ISLAND_AMBIENT_KIT_NAMES.join(", ")}), and fmt helpers (fmt.money(cents), fmt.dateTime(iso), fmt.percent(ratio), fmt.num(n)).
- Host catalog components render on the host page — use them as tree nodes. An island's sandbox has only the ambient Kit: inside island source, the Kit equivalent is the correct choice (a host component name there can never render).
- Islands read and act ONLY through the ambient tools API — await tools.host_listInvoices({}), the tool name as a literal member access, args matching the tool's (input: …) sketch. There is no network. A mutating call resolves {status:"pending-approval"} and its effect lands after the user approves — render an awaiting-approval state. A labeled field whose value is empty renders an em dash (—) in the value position — never a bare label with nothing after it. Empty data must not crash an island: default every list before use (const rows = result.data ?? []) and never .map/.length a possibly-undefined value.
- A chart belongs in the Kit chart (BarChart, LineChart, DonutChart, Sparkline, Progress), never a hand-rolled island — the Kit charts draw a designed empty frame on empty data for free.
- Island styling (until the utility sheet ships): inline styles over the host tokens — var(--vendo-color-background|surface|text|muted|accent|accent-text|danger|border), var(--vendo-font-family), var(--vendo-radius-small|medium|large). The frame sits on the host page's light background.
- Compose regions in the tree so the app streams in — an island is one region, never the whole app.
- Limits: ${TREE_MAX_NODES} nodes, ${TREE_MAX_QUERIES} queries, ${TREE_MAX_GENERATED_COMPONENTS} islands, ${TREE_MAX_COMPONENT_SOURCE_BYTES} bytes per island.
</wire_grammar>`;

const exemplarExamples = (): string => `<examples>
Three complete apps for a FICTIONAL billing host. Its acme_* tools are NOT available to you — bind only the HOST TOOLS listed above. Study the shape, not the tools.

${CONTRACT_EXEMPLARS.map(({ title, request, wire, why }) => `<example>
${title}. Request: "${request}"

${wire}

Why this is right: ${why}
</example>`).join("\n\n")}
</examples>`;

/** Charts preamble carried with the components section (the historical $NaN
 *  class: a chart fed formatted strings draws nothing). */
const COMPONENTS_PREAMBLE = "Charts and visualizations read RAW numeric fields — their format prop handles display. Money is integer cents end-to-end; the Kit formats it.";

export const exemplarContract = (deps: GenerationDependencies): string => composePromptSections([
  { id: "role", content: exemplarRole },
  { id: "tree-contract", content: exemplarGreatApps },
  { id: "tree-contract", content: exemplarGrammar() },
  { id: "tree-contract", content: exemplarPrinciples },
  { id: "prewired-props", content: `<components>\n${COMPONENTS_PREAMBLE}\n\n${componentsPromptSection()}\n</components>` },
  {
    id: "catalog",
    content: `<host>\n${composePromptSections([
      ...hostToolSections(deps),
      ...generationPromptSections(deps).filter(({ id }) =>
        id === "catalog" || id === "theme" || id === "design-rules" || id === "clock"
        || (deps.pinBaselines !== undefined && deps.pinBaselines.length > 0 && id === "remixable-slots")),
    ])}\n</host>`,
  },
  { id: "prewired-props", content: exemplarExamples() },
]);
