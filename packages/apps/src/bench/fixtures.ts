/**
 * W1-bench (docs/verification/w1-bench) — a realistic single-host domain
 * ("Maple", a bank/AP host) used across all format experiments: cents money,
 * ISO dates, enum statuses, nested client objects, arrays, and read + write
 * tools. Shapes are DERIVED from representative sample rows (deriveShape), the
 * same path production uses (`vendo sync` sampling).
 *
 * NOT the frozen 30-prompt held-out corpus. These are lane-authored dev
 * fixtures for measurement only.
 */
import { deriveShape, type Json, type ShapeType } from "@vendoai/core";

export interface BenchTool {
  name: string;
  description: string;
  risk: "read" | "write";
  /** One representative response used to derive the shape and to feed the
   *  fetch-then-generate arm (Experiment 3). */
  sample: Json;
}

const cents = (n: number) => n;

export const MAPLE_TOOLS: BenchTool[] = [
  {
    name: "invoices.list",
    description: "List invoices, optionally filtered by status (draft|sent|overdue|paid).",
    risk: "read",
    sample: {
      data: [
        { id: "inv_1", client: { id: "cl_1", name: "Northwind Traders" }, amountCents: cents(285000), dueDate: "2026-07-02T00:00:00Z", status: "overdue" },
        { id: "inv_2", client: { id: "cl_2", name: "Contoso Ltd" }, amountCents: cents(142000), dueDate: "2026-07-11T00:00:00Z", status: "overdue" },
        { id: "inv_3", client: { id: "cl_3", name: "Fabrikam Inc" }, amountCents: cents(98000), dueDate: "2026-07-19T00:00:00Z", status: "sent" },
      ],
      totalCents: cents(525000),
      count: 3,
    },
  },
  {
    name: "invoices.get",
    description: "Fetch one invoice with its line items by id.",
    risk: "read",
    sample: {
      id: "inv_1",
      client: { id: "cl_1", name: "Northwind Traders", email: "ap@northwind.example" },
      amountCents: cents(285000),
      dueDate: "2026-07-02T00:00:00Z",
      status: "overdue",
      lineItems: [
        { description: "Consulting — June", amountCents: cents(180000) },
        { description: "Licenses", amountCents: cents(105000) },
      ],
    },
  },
  {
    name: "invoices.sendReminders",
    description: "Send a payment reminder for the given invoice ids. Mutation.",
    risk: "write",
    sample: { sent: 2, failed: 0 },
  },
  {
    name: "invoices.markPaid",
    description: "Mark an invoice paid by id. Mutation.",
    risk: "write",
    sample: { ok: true, id: "inv_1" },
  },
  {
    name: "clients.list",
    description: "List clients with balances and tier.",
    risk: "read",
    sample: {
      data: [
        { id: "cl_1", name: "Northwind Traders", balanceCents: cents(285000), email: "ap@northwind.example", tier: "gold" },
        { id: "cl_2", name: "Contoso Ltd", balanceCents: cents(142000), email: "ap@contoso.example", tier: "silver" },
      ],
    },
  },
  {
    name: "clients.search",
    description: "Search clients by name/email substring; returns matches.",
    risk: "read",
    sample: { data: [{ id: "cl_1", name: "Northwind Traders", balanceCents: cents(285000) }] },
  },
  {
    name: "accounts.list",
    description: "List bank accounts with balances, type, and a 12-point sparkline.",
    risk: "read",
    sample: {
      data: [
        { id: "ac_1", name: "Operating", balanceCents: cents(4820000), type: "checking", sparkline: [41, 43, 40, 45, 48, 47, 49, 46, 48, 50, 49, 48] },
        { id: "ac_2", name: "Reserve", balanceCents: cents(12500000), type: "savings", sparkline: [120, 121, 122, 123, 124, 124, 125, 125, 125, 125, 125, 125] },
      ],
    },
  },
  {
    name: "accounts.transactions",
    description: "Recent transactions, optionally for one account id.",
    risk: "read",
    sample: {
      data: [
        { id: "tx_1", description: "AWS", amountCents: cents(-120400), date: "2026-07-15T00:00:00Z", category: "software" },
        { id: "tx_2", description: "Client payment — Contoso", amountCents: cents(142000), date: "2026-07-14T00:00:00Z", category: "income" },
      ],
      count: 2,
    },
  },
  {
    name: "payments.create",
    description: "Create a payment from an account to a client. Mutation; needs accountId, amountCents, toClientId.",
    risk: "write",
    sample: { id: "pay_1", status: "pending" },
  },
  {
    name: "spending.byCategory",
    description: "Spending grouped by category for a period (month|quarter|year).",
    risk: "read",
    sample: {
      data: [
        { category: "software", amountCents: cents(482000), pct: 0.34 },
        { category: "payroll", amountCents: cents(690000), pct: 0.49 },
        { category: "travel", amountCents: cents(240000), pct: 0.17 },
      ],
      totalCents: cents(1412000),
    },
  },
  {
    name: "revenue.monthly",
    description: "Monthly revenue for the trailing 6 months.",
    risk: "read",
    sample: {
      data: [
        { month: "2026-02", revenueCents: cents(3200000) },
        { month: "2026-03", revenueCents: cents(3550000) },
        { month: "2026-04", revenueCents: cents(3410000) },
      ],
    },
  },
];

export const MAPLE_TOOL_SHAPES: Readonly<Record<string, ShapeType>> = Object.fromEntries(
  MAPLE_TOOLS.map((t) => [t.name, deriveShape(t.sample)]),
);

export const KNOWN_TOOL_NAMES: ReadonlySet<string> = new Set(MAPLE_TOOLS.map((t) => t.name));

/** The Kit host catalog surface (Wave-2 components), name + when-to-use + a
 *  compact prop signature — modeled on the spec's Kit inventory. */
export interface KitComponent {
  name: string;
  signature: string;
}

export const MAPLE_CATALOG: KitComponent[] = [
  { name: "DataTable", signature: `DataTable(rows: object[], columns: {key,label?,format?}[], sortBy?, limit?, filterableBy?: string[], emptyLabel?) — self sorts/filters/paginates; columns take dot-path keys and a format ("money"|"date"|"percent"|"number")` },
  { name: "Stat", signature: `Stat(label: string, value?, format?: "money"|"date"|"percent"|"number", trend?, tone?)` },
  { name: "CardList", signature: `CardList(items: object[], titleKey, subtitleKey?, valueKey?, valueFormat?)` },
  { name: "LineChart", signature: `LineChart(points: {label,value}[], label?) — data prop only; RAW numbers` },
  { name: "BarChart", signature: `BarChart(series: {label,value}[], label?)` },
  { name: "Donut", signature: `Donut(slices: {label,value}[], label?) — RAW numbers, never formatted` },
  { name: "Sparkline", signature: `Sparkline(values: number[])` },
  { name: "EnumBadge", signature: `EnumBadge(value: string, kind?) — renders a host enum as a branded badge` },
  { name: "Disclaimer", signature: `Disclaimer(text: string) — the legal move when NO host tool supplies the ask` },
];

export const CATALOG_COMPONENT_NAMES: ReadonlySet<string> = new Set(MAPLE_CATALOG.map((c) => c.name));

export const THEME = {
  colors: { background: "#FBFAF7", surface: "#FFFFFF", text: "#1A1A1A", accent: "#2B5CE6", danger: "#C0392B", border: "#E6E3DC" },
  fontFamily: "Inter, sans-serif",
};
