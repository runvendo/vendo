import type { VendoThreadProps } from "@vendoai/ui/chrome";

/** The card form of a thread suggestion (chrome does not re-export
 *  VendoSuggestionCard by name, so derive it from the prop). */
type SuggestionCard = Exclude<NonNullable<VendoThreadProps["suggestions"]>[number], string>;

/** demo-refresh Part 6 — the Maple scenario ladder, rendered as starter cards
 *  on the empty thread (overlay and full page). Tapping a card SENDS the
 *  prompt: generated UI → guarded host tool call → integration + automation →
 *  pin-to-home. */
export const mapleScenarios: SuggestionCard[] = [
  {
    title: "Where did my money go?",
    description: "A live breakdown of this month's spending",
    prompt: "Where did my money go this month? Build me a spending breakdown I can keep.",
  },
  {
    title: "Move money to savings",
    description: "Transfer $200 — you approve it first",
    prompt: "Move $200 from my checking account to savings.",
  },
  {
    title: "Email me a weekly summary",
    description: "A Friday spending digest via Gmail",
    prompt: "Every Friday, email me a summary of that week's spending.",
  },
  {
    title: "Build my money HQ",
    description: "Goals, spending, and upcoming bills in one view",
    prompt:
      "Build me a money HQ: goals progress, spending by category, upcoming bills, and account balances — something I can pin to my home screen.",
  },
  {
    title: "Alert me before I overdraft",
    description: "Emails you when checking dips below $2,000",
    prompt: "When my checking balance drops below $2,000, email me an alert.",
  },
];
