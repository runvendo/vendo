import type { VendoRouteMap } from "@vendoai/apps/contract";

/**
 * WHERE MAPLE WILL SEND SOMEONE. The one registry both sides read: the server
 * hands it to `createVendo` so generated views know these pages exist, and
 * <VendoRoot> hands it to the provider so a `<Link to>` can resolve against it.
 *
 * Paths are written WITHOUT the basePath — `onNavigate` pushes them through
 * next/router, which prefixes `/maple` itself.
 */
export const mapleRoutes: VendoRouteMap = {
  home: { path: "/", description: "The dashboard: balances, recent activity, pinned apps." },
  accounts: { path: "/accounts", description: "Every account, with its balance." },
  account: { path: "/accounts/:id", description: "One account by id: its details and its transactions." },
  transactions: { path: "/transactions", description: "The full transaction ledger, filterable." },
  transaction: { path: "/transactions/:id", description: "One transaction by id, with its merchant and category." },
  cards: { path: "/cards", description: "Debit and credit cards, and their controls." },
  payments: { path: "/payments", description: "Send money and see scheduled payments." },
  insights: { path: "/insights", description: "Spending broken down by category and month." },
  activity: { path: "/activity", description: "Notifications and account activity." },
  settings: { path: "/settings", description: "Profile and preferences." },
};
