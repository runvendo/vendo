import type { VendoThreadProps } from "@vendoai/ui/chrome";

/** The card form of a thread suggestion (chrome does not re-export
 *  VendoSuggestionCard by name, so derive it from the prop). */
type SuggestionCard = Exclude<NonNullable<VendoThreadProps["suggestions"]>[number], string>;

/** demo-refresh Part 6 — the Cadence scenario ladder, rendered as starter
 *  cards on the empty thread (overlay and full page). Tapping a card SENDS
 *  the prompt: generated UI → per-send approval emails → calendar automation
 *  → pin-to-dashboard. NOTE: the spec drafts these around invoices, but Cadence
 *  exposes no billing tools — the ladder is re-grounded on what it actually
 *  tracks: client documents + deadlines. */
export const cadenceScenarios: SuggestionCard[] = [
  {
    title: "Who's behind on documents?",
    description: "Missing documents, aged and totaled by client",
    prompt: "Which clients are behind on documents? Build me an aging view I can keep.",
  },
  {
    title: "Chase the missing documents",
    description: "Drafts reminder emails — you approve each send",
    prompt:
      "Draft polite reminder emails to every client with missing documents. Ask me before sending each one.",
  },
  {
    title: "Monthly document review",
    description: "A recurring calendar block, set up for you",
    prompt: "Put a monthly document-review block on my calendar for the first Monday of each month.",
  },
  {
    title: "Build my practice dashboard",
    description: "Deadlines, outstanding documents, and client health",
    prompt:
      "Build me a practice dashboard: upcoming filing deadlines, outstanding documents by client, and my most at-risk clients — something I can pin.",
  },
];
