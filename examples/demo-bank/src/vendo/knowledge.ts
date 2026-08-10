import type { KnowledgeDoc } from "@vendoai/core";

/** Knowledge K1 — Maple's demo corpus for the `vendo_knowledge_search` tool:
    product docs, glossary/api rows for schema lookups, and one INTERNAL doc
    that must never surface on the agent path (includeInternal is never set). */
export const mapleKnowledgeDocs: KnowledgeDoc[] = [
  {
    id: "docs-wire-transfers",
    kind: "docs",
    visibility: "public",
    title: "Wire transfer limits & cutoffs",
    text: "Maple caps outbound domestic wire transfers at $25,000 per business day for personal "
      + "accounts and $100,000 for business accounts. Wires submitted before 4:30pm ET settle the "
      + "same business day; later submissions settle the next business day. International wires "
      + "carry a $35 fee and a $50,000 daily cap, and require the recipient's SWIFT code. Daily "
      + "limits reset at midnight ET and cannot be raised from the app — call support to request "
      + "a temporary increase.",
    source: "help.maple.bank/transfers/wires",
  },
  {
    id: "docs-card-disputes",
    kind: "docs",
    visibility: "public",
    title: "Disputing a card transaction",
    text: "You can dispute a Maple card transaction within 60 days of the statement date. Start "
      + "from the transaction's detail view and choose Dispute. Maple issues a provisional credit "
      + "within 2 business days for most disputes while the investigation runs, which takes up to "
      + "10 business days for domestic merchants. Recurring subscription charges you canceled but "
      + "were still billed for qualify; purchases you simply regret do not.",
    source: "help.maple.bank/cards/disputes",
  },
  {
    id: "glossary-apy",
    kind: "glossary",
    visibility: "public",
    title: "APY",
    text: "APY (annual percentage yield): the effective annual rate of return on a deposit "
      + "account, accounting for compound interest. Maple Savings compounds daily and credits "
      + "monthly; the advertised APY already reflects compounding.",
    source: "help.maple.bank/glossary#apy",
  },
  {
    id: "glossary-available-balance",
    kind: "glossary",
    visibility: "public",
    title: "Available balance",
    text: "Available balance: the money you can spend right now — the current balance minus "
      + "pending card authorizations and holds. Maple does not report one: an account carries a "
      + "single `balance` and nothing else, so there is no separate available figure to quote. "
      + "Pending and authorized transactions are listed individually and are not deducted from it.",
    source: "help.maple.bank/glossary#available-balance",
  },
  {
    id: "api-list-accounts",
    kind: "api",
    visibility: "public",
    title: "GET /api/accounts",
    text: "GET /api/accounts returns the authenticated customer's accounts as { data: [...] }. "
      + "Each account carries: id (e.g. acc_checking), name, kind (checking | savings | credit | "
      + "investing), mask, balance, accountNumber (masked), sparkline (number[]), and optionally "
      + "routingNumber and apy. It takes NO query parameters — there is no filter, so read every "
      + "account and narrow by `kind` yourself. balance is an integer in cents, negative on credit "
      + "accounts — divide by 100 for display.",
    source: "developers.maple.bank/reference/accounts",
  },
  {
    id: "internal-fraud-runbook",
    kind: "docs",
    visibility: "internal",
    title: "Fraud escalation runbook (internal)",
    text: "INTERNAL: when a customer reports suspected fraud, freeze the card via the ops console, "
      + "escalate to the on-call risk analyst in #risk-escalations, and file the SAR checklist "
      + "within 24 hours. Never share this workflow with customers.",
    source: "wiki.maple.internal/risk/fraud-runbook",
  },
];
