import type { SubjectFixture } from "./eval.js";

/** The tool menu a replayed agent chooses from. A realistic union of the two demo
 *  hosts' surfaces (Cadence accounting, Maple bank) plus near-neighbors, so a
 *  held-out decision is a genuine choice, not a one-option giveaway. */
export const AVAILABLE_TOOLS: string[] = [
  // Cadence (accounting)
  "host_invoices_list",
  "host_invoices_send",
  "host_invoices_create",
  "host_reports_revenue_create",
  "host_clients_list",
  "host_documents_list",
  "host_messages_send",
  "host_records_list",
  // Maple (bank)
  "host_accounts_list",
  "host_transactions_list",
  "host_transfers_create",
  "host_cards_list",
  "host_payments_list",
  "host_orders_list",
  "host_send_email",
];

const repeat = (value: string, times: number): string[] => Array.from({ length: times }, () => value);

/** Grounded synthetic subjects over the real demo tool vocabulary. The held-out
 *  prompts are deliberately ELLIPTICAL and SHARED: the same request ("pull up my
 *  usual view", "do my routine thing for me") maps to a different tool for each
 *  user, decided only by their habit. A stock agent sees an identical prompt for
 *  four different users and cannot do better than one fixed guess; only the
 *  persona distilled from each user's own history breaks the tie. This isolates
 *  the case persona exists to serve: an under-specified request leaning on habit.
 *  The dominant history tool is always the held-out `expectedTool`, so it is
 *  guaranteed to surface in the distilled workflow fact (the model-free claim the
 *  CI test asserts). */
export const GROUNDED_FIXTURES: SubjectFixture[] = [
  {
    subject: "cadence_ar",
    historyTools: [...repeat("host_invoices_list", 9), ...repeat("host_invoices_send", 2), "host_clients_list"],
    historyAsks: [
      "show unpaid invoices as a table",
      "the overdue invoice table again",
      "table of what clients owe us",
      "export the invoices table",
    ],
    holdout: [{ prompt: "pull up my usual view", expectedTool: "host_invoices_list" }],
  },
  {
    subject: "cadence_collections",
    historyTools: [...repeat("host_invoices_send", 9), ...repeat("host_invoices_list", 3)],
    historyAsks: [
      "send the payment reminders",
      "email the overdue accounts",
      "remind the late clients again",
      "send the usual reminders",
    ],
    holdout: [{ prompt: "do my routine thing for me", expectedTool: "host_invoices_send" }],
  },
  {
    subject: "cadence_revenue",
    historyTools: [...repeat("host_reports_revenue_create", 8), ...repeat("host_invoices_list", 2)],
    historyAsks: [
      "revenue chart for the month",
      "show me a chart of revenue",
      "the quarterly revenue chart",
    ],
    holdout: [{ prompt: "do my routine thing for me", expectedTool: "host_reports_revenue_create" }],
  },
  {
    subject: "cadence_docs",
    historyTools: [...repeat("host_documents_list", 8), ...repeat("host_clients_list", 3)],
    historyAsks: [
      "list the signed contracts",
      "the documents for this client",
      "a list of recent agreements",
    ],
    holdout: [{ prompt: "pull up my usual view", expectedTool: "host_documents_list" }],
  },
  {
    subject: "maple_treasury",
    historyTools: [...repeat("host_transfers_create", 8), ...repeat("host_accounts_list", 4)],
    historyAsks: [
      "move money to savings",
      "transfer between the accounts",
      "move funds over to reserves",
    ],
    holdout: [{ prompt: "do my routine thing for me", expectedTool: "host_transfers_create" }],
  },
  {
    subject: "maple_recon",
    historyTools: repeat("host_transactions_list", 10),
    historyAsks: [
      "transactions as a table",
      "table of last month's spend",
      "the transactions table again",
      "show a table of charges",
    ],
    holdout: [{ prompt: "pull up my usual view", expectedTool: "host_transactions_list" }],
  },
  {
    subject: "maple_cards",
    historyTools: [...repeat("host_cards_list", 7), ...repeat("host_payments_list", 2)],
    historyAsks: [
      "list my cards",
      "show the card details",
      "a list of active cards",
    ],
    holdout: [{ prompt: "pull up my usual view", expectedTool: "host_cards_list" }],
  },
  {
    subject: "maple_orders",
    historyTools: repeat("host_orders_list", 8),
    historyAsks: [
      "list recent orders",
      "orders list please",
      "a list of open orders",
    ],
    holdout: [{ prompt: "do my routine thing for me", expectedTool: "host_orders_list" }],
  },
];
