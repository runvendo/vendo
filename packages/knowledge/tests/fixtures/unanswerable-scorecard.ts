import type { KnowledgeDoc } from "@vendoai/core";

/** SVQ-shaped item kinds. `no-source-empty` has zero lexical overlap with the
 *  corpus (the already-working refuse). `no-source-overlap` shares tokens with
 *  the corpus but the answer is not in it — the 7–10/34 leak class at
 *  default `weakScoreThreshold` 0. */
export type ScorecardKind =
  | "single-source"
  | "multi-source"
  | "no-source-empty"
  | "no-source-overlap";

export interface ScorecardItem {
  id: string;
  kind: ScorecardKind;
  query: string;
}

const doc = (
  id: string,
  title: string,
  text: string,
  kind: KnowledgeDoc["kind"] = "docs",
): KnowledgeDoc => ({
  id,
  kind,
  visibility: "public",
  title,
  text,
  source: `${id}.md`,
});

/** Small public host-docs corpus (payments product). Token inventory is
 *  deliberate: overlap-unanswerable queries share content words with these
 *  pages; empty-hit queries use tokens that never appear here. */
export const CORPUS: KnowledgeDoc[] = [
  doc(
    "docs#wires",
    "Wire transfers",
    [
      "# Wire transfers",
      "Maple caps outbound wire transfers at $25,000 per business day.",
      "Limits reset at midnight Eastern Time.",
      "Wires submitted after 4pm ET process the next business day.",
      "A wire cannot be cancelled once Maple has released it to the network.",
    ].join("\n"),
  ),
  doc(
    "docs#refunds",
    "Refund policy",
    [
      "# Refund policy",
      "Refunds are processed within five business days.",
      "A refund lands on the original payment method.",
      "Partial refunds are allowed when the original charge is still settling.",
    ].join("\n"),
  ),
  doc(
    "glossary#apy",
    "APY",
    "APY (annual percentage yield) is the effective annual rate of return accounting for compounding. Maple savings currently advertise 4.25% APY.",
    "glossary",
  ),
  doc(
    "docs#overdraft",
    "Overdraft protection",
    [
      "# Overdraft protection",
      "Maple covers overdrafts up to $200 for eligible checking accounts.",
      "A $15 fee applies per overdraft event.",
      "Overdraft protection is opt-in from Settings > Accounts.",
    ].join("\n"),
  ),
  doc(
    "docs#cards",
    "Debit card freeze",
    [
      "# Debit card freeze",
      "Freeze a lost debit card in Settings > Cards.",
      "A frozen card declines all new charges.",
      "Unfreeze instantly from the same screen.",
    ].join("\n"),
  ),
  doc(
    "docs#international",
    "International transfers",
    [
      "# International transfers",
      "Maple sends international transfers in 1-3 business days.",
      "The FX markup is 1.5% over the mid-market rate.",
      "SWIFT is used for USD, EUR, and GBP corridors.",
    ].join("\n"),
  ),
  doc(
    "docs#auth",
    "Two-factor authentication",
    [
      "# Two-factor authentication",
      "Maple requires 2FA for any wire over $5,000.",
      "SMS and authenticator apps are supported.",
      "Backup codes live under Settings > Security.",
    ].join("\n"),
  ),
  doc(
    "docs#accounts",
    "Account types",
    [
      "# Account types",
      "Maple offers checking (no interest, unlimited debit) and savings (4.25% APY, six withdrawals per month).",
      "Joint accounts need both owners present to close.",
    ].join("\n"),
  ),
];

/** Twenty-item eval: 8 single-source, 4 multi-source, 3 empty-hit no-source,
 *  5 overlap no-source. */
export const ITEMS: ScorecardItem[] = [
  { id: "S1", kind: "single-source", query: "What is Maple's daily outbound wire transfer limit?" },
  { id: "S2", kind: "single-source", query: "How long do refunds take to process?" },
  { id: "S3", kind: "single-source", query: "What does APY mean at Maple?" },
  { id: "S4", kind: "single-source", query: "What overdraft amount does Maple cover?" },
  { id: "S5", kind: "single-source", query: "How do I freeze a lost debit card?" },
  { id: "S6", kind: "single-source", query: "How long do international transfers take?" },
  { id: "S7", kind: "single-source", query: "When does Maple require 2FA for a wire?" },
  { id: "S8", kind: "single-source", query: "How many savings withdrawals does Maple allow per month?" },

  { id: "M1", kind: "multi-source", query: "Compare Maple's wire cutoff time with international transfer duration." },
  { id: "M2", kind: "multi-source", query: "What is the savings APY and the monthly withdrawal limit?" },
  { id: "M3", kind: "multi-source", query: "How do overdraft fees interact with refund timing?" },
  { id: "M4", kind: "multi-source", query: "Which Settings screens cover debit card freeze and 2FA backup codes?" },

  { id: "E1", kind: "no-source-empty", query: "quantum blockchain espresso" },
  { id: "E2", kind: "no-source-empty", query: "neolithic kiln glaze" },
  { id: "E3", kind: "no-source-empty", query: "zirconia ytterbium phosphor" },

  { id: "O1", kind: "no-source-overlap", query: "Can I wire money to a dissolved company?" },
  { id: "O2", kind: "no-source-overlap", query: "What is the cryptocurrency wire transfer limit?" },
  { id: "O3", kind: "no-source-overlap", query: "Do Maple refunds cover NFT purchases?" },
  { id: "O4", kind: "no-source-overlap", query: "What is the APY on Bitcoin savings?" },
  { id: "O5", kind: "no-source-overlap", query: "Can I freeze someone else's debit card remotely?" },
];
