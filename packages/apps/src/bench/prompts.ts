/**
 * W1-bench (docs/verification/w1-bench) — lane-authored dev prompts and the
 * generation contract used across the format experiments. These prompts are
 * NOT the frozen 30-prompt held-out corpus; they are diverse dev requests over
 * the Maple fixture domain (fixtures.ts).
 */
import { describeShape } from "@vendoai/core";
import { prewiredSchemaPrompt } from "../prewired-schema.js";
import { MAPLE_CATALOG, MAPLE_TOOLS, MAPLE_TOOL_SHAPES, THEME } from "./fixtures.js";

/** ~18 diverse dev prompts spanning tables, stats, charts, forms, actions,
 *  detail views, mixed dashboards, and search/interaction. */
export const DEV_PROMPTS: string[] = [
  "Show my overdue invoices in a table with client, amount, and due date, plus a headline total.",
  "Build a dashboard of my bank accounts: a balance stat per account and a small trend for each.",
  "List clients sorted by outstanding balance, and let me filter by client name.",
  "Give me a spending breakdown by category for this quarter as a donut plus a table of the numbers.",
  "Show the last few transactions on my operating account with amounts and dates.",
  "I want to send payment reminders for all overdue invoices from one screen.",
  "Show a monthly revenue trend line for the last few months with a headline of the latest month.",
  "Build an invoice detail view for a single invoice including its line items and a mark-paid action.",
  "Create a clients page with a search box and a results table of matches showing their balances.",
  "Summarize accounts receivable: total overdue, count of overdue invoices, and the worst three clients.",
  "Show a payments form to pay a client from an account, with the amount and recipient.",
  "Give me an at-a-glance finance overview: cash on hand, this-month revenue, and overdue total.",
  "Show overdue invoices grouped visually with a reminder button per row.",
  "Build a category spending page with a bar chart and each category's share as a percentage.",
  "Show all accounts as cards with name, type, balance, and a sparkline.",
  "Make a page that shows the single largest overdue invoice with a prominent amount and a reminder action.",
  "Show revenue by month and spending by category side by side for a quick health check.",
  "List recent transactions and let me filter them, showing category as a badge and the amount formatted.",
];

/** Negative prompts: the host has NO tool for the ask, so the honest move is a
 *  Disclaimer, never fabricated data (Experiment 3 honesty probe). */
export const NEGATIVE_PROMPTS: string[] = [
  "Show me my company's payroll runs and each employee's net pay this month.",
  "Display our stock portfolio holdings with live share prices and today's gain/loss.",
  "Show a credit score history chart for the business over the last two years.",
];

const toolsBlock = (): string =>
  `HOST TOOLS (the ONLY tools a query or action may name; anything else is invalid):\n` +
  MAPLE_TOOLS.map((t) => `- ${t.name} [${t.risk}]: ${t.description}`).join("\n");

const shapesBlock = (): string =>
  `TOOL RESPONSE SHAPES (bind only to fields that exist):\n` +
  Object.entries(MAPLE_TOOL_SHAPES).map(([tool, shape]) => `- ${tool}: ${describeShape(shape)}`).join("\n");

const catalogBlock = (): string =>
  `HOST CATALOG (the Kit — prefer these; they format themselves via the format prop):\n` +
  MAPLE_CATALOG.map((c) => `- ${c.signature}`).join("\n");

const commonRules = `
- COMPOSE from host catalog + prewired components bound to query data. Prefer a host catalog component whenever it covers the need.
- Never hardcode business data. Every number, label, and row must come from a tool binding; if NO tool supplies the ask, render a Disclaimer saying so — never fabricate, placeholder, or example figures.
- Money fields are integer CENTS and dates are raw ISO. When a value is shown to a user in a Stat/Text/Badge/Table column, it MUST be formatted (money/date/percent). NEVER format a value fed to a chart (LineChart/BarChart/Donut/Sparkline) — those take RAW numbers.
- Actions are on* props naming a host tool, e.g. onClick="invoices.sendReminders". A write action MUST carry a payload binding the ids/fields it acts on. Never wire a submit button to a read tool or leave it dead.
- Islands are a LAST RESORT for a custom visual no catalog component covers; never put the whole app, layout, or data fetching in an island.`;

const preamble = `You are the Vendo app generation engine. Return ONLY vendo-genui/v2 wire markup: a single <App name="..."> element. No prose, no markdown fences, no JSON. NEVER emit id attributes — the compiler mints ids.

PREWIRED COMPONENT PROPS (use these EXACT prop names):
${prewiredSchemaPrompt()}

${catalogBlock()}

${toolsBlock()}

${shapesBlock()}

THEME TOKENS: ${JSON.stringify(THEME)}`;

/** Arm A — the current <Query>-declaration dialect. */
export const QUERY_ARM_SYSTEM = `${preamble}

DATA (declarations):
- <Query id="queryName" tool="tool_name" input={{...}}/> declarations come FIRST inside <App>. A query's result lives at its name; bind it with plain field refs like value={queryName.totalCents} or rows={queryName.data}. Bindings are PLAIN FIELD REFERENCES ONLY (no calls, no arithmetic). Reuse one <Query> for props that need the same tool+args.
${commonRules}`;

/** Arm B — inline tool references (Experiment 1). */
export const INLINE_ARM_SYSTEM = `${preamble}

DATA (inline references):
- Reference a tool's data directly in a prop by CALLING it: rows={invoices.list({status:"overdue"}).data} and value={invoices.list({status:"overdue"}).totalCents}. The compiler mints the query and dedupes by tool+args — reuse the SAME call (same tool, same args) wherever you need that data, and it fetches once. Do NOT write <Query> declarations. After the call you may read a field path (.data, .totalCents, .data.0.id).
${commonRules}`;

/** Fetch-then-generate phase-2 system (Experiment 3, Arm B): same as Query arm
 *  but the generator additionally sees real fetched samples. */
export const buildFetchAwareSystem = (fetched: string): string =>
  `${QUERY_ARM_SYSTEM}

FETCHED DATA (already read for you — bind to these exact fields and formats; the counts and sample rows are real):
${fetched}`;

export const userTask = (prompt: string): string => `USER_REQUEST: ${prompt}`;
