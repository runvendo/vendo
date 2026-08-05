/**
 * The Maple (demo-bank) host fixture: catalog + tools loaded from
 * examples/demo-bank/.vendo/*.json (overrides.json merged, auth/demo/voice
 * plumbing filtered out — the cadence loader pattern), hand-written shape
 * cards mirroring examples/demo-bank/src/server/types.ts, the theme from
 * examples/demo-bank/.vendo/theme.json, and every cataloged tool gets a
 * deterministic canned-data executor so the rendered app's queries and
 * actions run at view time. All money is integer CENTS (the Maple law).
 * No Math.random, no Date.now() — same call, same data.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { VendoError, vendoThemeSchema, type NormalizedCatalog, type ShapeType } from "@vendoai/core";
import type { HostToolInfo } from "@vendoai/apps";
import type { HostFixture } from "../runner/types";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
const vendoDir = resolve(repoRoot, "examples/demo-bank/.vendo");

const loadMapleCatalog = (): NormalizedCatalog => {
  const raw = JSON.parse(readFileSync(resolve(vendoDir, "catalog.json"), "utf8")) as {
    entries: Array<{ name: string; description: string; propsSchema: unknown; examples?: string[] }>;
  };
  return raw.entries.map((entry) => ({
    name: entry.name,
    description: entry.description,
    propsJsonSchema: entry.propsSchema as NormalizedCatalog[number]["propsJsonSchema"],
    ...(entry.examples === undefined ? {} : { examples: entry.examples }),
  })) as NormalizedCatalog;
};

const loadMapleTools = (): HostToolInfo[] => {
  const raw = JSON.parse(readFileSync(resolve(vendoDir, "tools.json"), "utf8")) as {
    tools: Array<{ name: string; description: string; risk: string; inputSchema?: Record<string, unknown> }>;
  };
  // tools.json is what `vendo sync` writes; the live registry merges
  // overrides.json on top (disabled, risk, description). Mirror that here or
  // the fixture sees tools the deployment disabled.
  const { tools: overrides = {} } = JSON.parse(
    readFileSync(resolve(vendoDir, "overrides.json"), "utf8"),
  ) as { tools?: Record<string, { disabled?: boolean; risk?: string; description?: string }> };
  return raw.tools
    .filter(({ name }) => overrides[name]?.disabled !== true)
    .filter(({ name }) => !name.startsWith("host_auth") && !name.startsWith("host_demo") && !name.startsWith("host_voice"))
    .map(({ name, description, risk, inputSchema }) => ({
      name,
      description: overrides[name]?.description ?? description,
      risk: overrides[name]?.risk ?? risk,
      ...(inputSchema === undefined ? {} : { inputSchema }),
    }));
};

// ---------------------------------------------------------------------------
// Shape cards — mirror examples/demo-bank/src/server/types.ts: what runtime
// shape-sampling would derive from live responses.
// ---------------------------------------------------------------------------

const str: ShapeType = { kind: "string" };
const num: ShapeType = { kind: "number" };
const bool: ShapeType = { kind: "boolean" };
const arr = (items: ShapeType): ShapeType => ({ kind: "array", items });
const obj = (fields: Record<string, ShapeType>): ShapeType => ({ kind: "object", fields });

const account = obj({
  id: str, name: str, kind: str, mask: str, balance: num,
  accountNumber: str, sparkline: arr(num),
});
const transaction = obj({
  id: str, accountId: str, merchant: str, descriptor: str, amount: num,
  timestamp: str, category: str, status: str, method: str,
});
const paged = (items: ShapeType): ShapeType => obj({ data: arr(items), total: num });

export const mapleToolShapes: Record<string, ShapeType> = {
  host_getProfile: obj({ name: str, email: str, netWorth: num, accountCount: num, avatarInitials: str }),
  host_listAccounts: arr(account),
  host_getAccount: account,
  host_listTransactions: paged(transaction),
  host_listAccountTransactions: paged(transaction),
  host_getTransaction: transaction,
  host_listCards: arr(obj({
    id: str, accountId: str, type: str, network: str, mask: str,
    expMonth: num, expYear: num, frozen: bool, design: str,
  })),
  host_listCardTransactions: paged(transaction),
  host_getBudgets: arr(obj({ category: str, limit: num, spent: num })),
  host_listGoals: arr(obj({ id: str, name: str, target: num, saved: num, icon: str })),
  host_listPayees: arr(obj({ id: str, name: str, kind: str })),
  host_listScheduledPayments: arr(obj({
    id: str, payeeId: str, payeeName: str, amount: num, nextDate: str, cadence: str,
  })),
  host_getSpendingInsights: arr(obj({ category: str, amount: num })),
  host_getCashflowInsights: arr(obj({ label: str, in: num, out: num })),
  host_getRecurringInsights: arr(obj({
    id: str, merchant: str, amount: num, cadence: str, category: str, nextDate: str,
  })),
  host_listNotifications: arr(obj({
    id: str, kind: str, title: str, body: str, at: str, read: bool,
  })),
};

// ---------------------------------------------------------------------------
// Seed data — fixed constants mirroring examples/demo-bank/src/server/types.ts.
// ---------------------------------------------------------------------------

const NOW = "2026-07-20T17:00:00.000Z";

const profile = {
  name: "Avery Chen",
  email: "avery@maple.demo",
  netWorth: 5_490_715,
  accountCount: 3,
  avatarInitials: "AC",
};

const accounts = [
  { id: "acc_checking", name: "Everyday Checking", kind: "checking", mask: "4832", balance: 1_284_650, accountNumber: "****4832", sparkline: [1_212_400, 1_240_180, 1_198_320, 1_265_910, 1_284_650] },
  { id: "acc_savings", name: "High-Yield Savings", kind: "savings", mask: "9917", balance: 3_406_065, accountNumber: "****9917", sparkline: [3_180_000, 3_255_500, 3_310_020, 3_368_400, 3_406_065] },
  { id: "acc_credit", name: "Maple Rewards Card", kind: "credit", mask: "2201", balance: -128_940, accountNumber: "****2201", sparkline: [-98_200, -112_450, -104_310, -121_780, -128_940] },
];

const transactions = [
  { id: "txn_001", accountId: "acc_checking", merchant: "Blue Bottle Coffee", descriptor: "BLUEBOTTLE 41 SF", amount: -675, timestamp: "2026-07-19T15:24:00.000Z", category: "coffee", status: "posted", method: "card" },
  { id: "txn_002", accountId: "acc_checking", merchant: "Whole Foods", descriptor: "WHOLEFDS MKT 105", amount: -8_412, timestamp: "2026-07-18T22:10:00.000Z", category: "groceries", status: "posted", method: "card" },
  { id: "txn_003", accountId: "acc_checking", merchant: "Acme Payroll", descriptor: "ACME CORP PAYROLL", amount: 412_500, timestamp: "2026-07-15T12:00:00.000Z", category: "income", status: "posted", method: "ach" },
  { id: "txn_004", accountId: "acc_credit", merchant: "Netflix", descriptor: "NETFLIX.COM", amount: -1_549, timestamp: "2026-07-14T08:03:00.000Z", category: "subscriptions", status: "posted", method: "card" },
  { id: "txn_005", accountId: "acc_checking", merchant: "Lyft", descriptor: "LYFT *RIDE SUN 9PM", amount: -2_318, timestamp: "2026-07-13T04:12:00.000Z", category: "transport", status: "posted", method: "card" },
  { id: "txn_006", accountId: "acc_credit", merchant: "Sunset Thai", descriptor: "SUNSET THAI SF", amount: -4_260, timestamp: "2026-07-12T02:45:00.000Z", category: "dining", status: "posted", method: "card" },
  { id: "txn_007", accountId: "acc_savings", merchant: "Maple Transfer", descriptor: "TRANSFER FROM CHECKING", amount: 50_000, timestamp: "2026-07-11T16:00:00.000Z", category: "transfer", status: "posted", method: "internal" },
  { id: "txn_008", accountId: "acc_checking", merchant: "Patagonia", descriptor: "PATAGONIA SF", amount: -13_900, timestamp: "2026-07-09T19:31:00.000Z", category: "shopping", status: "pending", method: "card" },
];

const cards = [
  { id: "card_debit", accountId: "acc_checking", type: "debit", network: "visa", mask: "4832", expMonth: 9, expYear: 2028, frozen: false, design: "maple-classic" },
  { id: "card_credit", accountId: "acc_credit", type: "credit", network: "mastercard", mask: "2201", expMonth: 3, expYear: 2029, frozen: false, design: "maple-rewards" },
];

const budgets = [
  { category: "dining", limit: 40_000, spent: 31_260 },
  { category: "groceries", limit: 60_000, spent: 28_642 },
  { category: "coffee", limit: 8_000, spent: 6_925 },
  { category: "transport", limit: 15_000, spent: 9_318 },
  { category: "subscriptions", limit: 12_000, spent: 11_549 },
];

const goals = [
  { id: "goal_house", name: "House down payment", target: 8_000_000, saved: 3_406_065, icon: "home" },
  { id: "goal_japan", name: "Japan trip", target: 450_000, saved: 287_500, icon: "plane" },
  { id: "goal_emergency", name: "Emergency fund", target: 1_500_000, saved: 1_500_000, icon: "shield" },
];

const payees = [
  { id: "payee_alex", name: "Alex Rivera", kind: "person" },
  { id: "payee_landlord", name: "Golden Gate Properties", kind: "business" },
  { id: "payee_mom", name: "Mei Chen", kind: "person" },
];

const scheduledPayments = [
  { id: "sched_rent", payeeId: "payee_landlord", payeeName: "Golden Gate Properties", amount: 285_000, nextDate: "2026-08-01T07:00:00.000Z", cadence: "monthly" },
  { id: "sched_mom", payeeId: "payee_mom", payeeName: "Mei Chen", amount: 20_000, nextDate: "2026-08-05T07:00:00.000Z", cadence: "monthly" },
  { id: "sched_alex", payeeId: "payee_alex", payeeName: "Alex Rivera", amount: 7_500, nextDate: "2026-07-28T07:00:00.000Z", cadence: "weekly" },
];

const spendingInsights = [
  { category: "dining", amount: 31_260 },
  { category: "groceries", amount: 28_642 },
  { category: "subscriptions", amount: 11_549 },
  { category: "transport", amount: 9_318 },
  { category: "coffee", amount: 6_925 },
];

const cashflowInsights = [
  { label: "Feb", in: 825_000, out: 612_400 },
  { label: "Mar", in: 825_000, out: 688_130 },
  { label: "Apr", in: 837_500, out: 645_920 },
  { label: "May", in: 825_000, out: 701_450 },
  { label: "Jun", in: 862_500, out: 655_270 },
  { label: "Jul", in: 825_000, out: 471_980 },
];

const recurringInsights = [
  { id: "rec_netflix", merchant: "Netflix", amount: 1_549, cadence: "monthly", category: "subscriptions", nextDate: "2026-08-14T07:00:00.000Z" },
  { id: "rec_spotify", merchant: "Spotify", amount: 1_099, cadence: "monthly", category: "subscriptions", nextDate: "2026-08-03T07:00:00.000Z" },
  { id: "rec_gym", merchant: "Bay Club", amount: 18_900, cadence: "monthly", category: "subscriptions", nextDate: "2026-08-01T07:00:00.000Z" },
  { id: "rec_icloud", merchant: "Apple iCloud", amount: 299, cadence: "monthly", category: "subscriptions", nextDate: "2026-07-30T07:00:00.000Z" },
];

const notifications = [
  { id: "ntf_001", kind: "security", title: "New sign-in", body: "New sign-in from Safari on macOS.", at: "2026-07-19T09:12:00.000Z", read: false },
  { id: "ntf_002", kind: "budget", title: "Subscriptions at 96%", body: "You've used 96% of your subscriptions budget.", at: "2026-07-18T16:40:00.000Z", read: false },
  { id: "ntf_003", kind: "payment", title: "Rent scheduled", body: "Golden Gate Properties will be paid $2,850.00 on Aug 1.", at: "2026-07-16T14:05:00.000Z", read: true },
  { id: "ntf_004", kind: "deposit", title: "Payroll received", body: "Acme Corp deposited $4,125.00.", at: "2026-07-15T12:01:00.000Z", read: true },
];

// ---------------------------------------------------------------------------
// Executors
// ---------------------------------------------------------------------------

type Executor = (input: Record<string, unknown>) => unknown;

const page = <T,>(data: T[]): { data: T[]; total: number } => ({ data, total: data.length });

/** Canned-data id lookup: an unknown/missing id falls back to the first seed
 *  entity so a generated app can never dead-end a render on a made-up id. */
const byId = <T extends { id: string }>(items: T[], id: unknown): T =>
  items.find((item) => item.id === id) ?? (items[0] as T);

const accountTransactions = (accountId: unknown) => {
  const scoped = transactions.filter((txn) => txn.accountId === accountId);
  return scoped.length > 0 ? scoped : transactions;
};

const executors: Record<string, Executor> = {
  host_getProfile: () => profile,
  host_listAccounts: () => accounts,
  host_getAccount: (input) => byId(accounts, input.id),
  host_listTransactions: () => page(transactions),
  host_listAccountTransactions: (input) => page(accountTransactions(input.id)),
  host_getTransaction: (input) => byId(transactions, input.id),
  host_listCards: () => cards,
  host_listCardTransactions: (input) => {
    const card = byId(cards, input.id);
    return page(accountTransactions(card.accountId));
  },
  host_getBudgets: () => budgets,
  host_listGoals: () => goals,
  host_listPayees: () => payees,
  host_listScheduledPayments: () => scheduledPayments,
  host_getSpendingInsights: () => spendingInsights,
  host_getCashflowInsights: () => cashflowInsights,
  host_getRecurringInsights: () => recurringInsights,
  host_listNotifications: () => notifications,
  // Mutations return the transaction the real Maple API appends — fixed
  // timestamp/id derivation keeps the fixture deterministic.
  host_transferMoney: (input) => {
    const amount = typeof input.amount === "number" ? Math.round(input.amount) : 0;
    if (amount <= 0) throw new VendoError("validation", "amount must be a positive number of cents");
    const recipient = typeof input.recipient_name === "string" ? input.recipient_name : "";
    if (recipient === "") throw new VendoError("validation", "recipient_name is required");
    return {
      id: `txn_transfer_${amount}`,
      accountId: "acc_checking",
      merchant: recipient,
      descriptor: typeof input.memo === "string" && input.memo !== "" ? `TRANSFER · ${input.memo}` : "TRANSFER",
      amount: -amount,
      timestamp: NOW,
      category: "transfer",
      status: "posted",
      method: "transfer",
    };
  },
  host_createOrder: (input) => {
    const body = (input.body ?? {}) as Record<string, unknown>;
    const amountCents = typeof body.amountCents === "number" ? Math.round(body.amountCents) : 0;
    if (amountCents <= 0) throw new VendoError("validation", "body.amountCents must be a positive number of cents");
    const merchant = typeof body.merchant === "string" && body.merchant !== "" ? body.merchant : "DoorDash";
    return {
      id: `txn_order_${amountCents}`,
      accountId: "acc_credit",
      merchant,
      descriptor: typeof body.descriptor === "string" && body.descriptor !== "" ? body.descriptor : merchant.toUpperCase(),
      amount: -amountCents,
      timestamp: NOW,
      category: "dining",
      status: "pending",
      method: "card",
    };
  },
};

export const mapleFixture: HostFixture = {
  name: "maple",
  catalog: loadMapleCatalog(),
  tools: loadMapleTools(),
  shapes: mapleToolShapes,
  theme: vendoThemeSchema.parse(JSON.parse(readFileSync(resolve(vendoDir, "theme.json"), "utf8"))),
  async execute(tool, input) {
    const executor = executors[tool];
    if (executor === undefined) throw new VendoError("not-found", `maple fixture has no tool "${tool}"`);
    return executor(input);
  },
};
