// @vitest-environment jsdom
/**
 * Wave-1 live proof E2c — the consent card and the 100× misread.
 *
 * Asking Maple to "send $47.50 to Acme Utilities for the July water bill"
 * produced a CRITICAL card whose amount row read `4750`. Everything else on it
 * was right: the tool title, the real recipient, the memo, "Runs as you". The one
 * number that decides how much money leaves reads as $4,750.
 *
 * The unit is not guessable from the value — it is DECLARED, in the host's own
 * input schema (`z.number().describe("Amount in integer cents")`), and these
 * cases pin that the card reads that declaration, formats from it, and says so
 * plainly when there is no declaration to read.
 */
import type { ApprovalRequest, JsonSchema } from "@vendoai/core";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VendoProvider, createVendoClient, type VendoClient } from "../../src/index.js";
import { ApprovalCard } from "../../src/chrome/index.js";
import { createWireServer } from "../wire-server.js";

let wire: Awaited<ReturnType<typeof createWireServer>>;
let client: VendoClient;

beforeEach(async () => {
  wire = await createWireServer();
  client = createVendoClient({ baseUrl: wire.url });
});

afterEach(async () => {
  cleanup();
  await wire.close();
});

/** The real Maple transfer, shaped as the guard mints it. */
function transfer(args: Record<string, unknown>, inputSchema: JsonSchema): ApprovalRequest {
  return {
    id: "apr_money",
    call: { id: "call_money", tool: "host_transferMoney", args: args as never },
    descriptor: {
      name: "host_transferMoney",
      title: "Send money",
      description: "Send money to a person from the user's checking account.",
      inputSchema,
      risk: "destructive",
    },
    inputPreview: "host_transferMoney …",
    ctx: { principal: { kind: "user", subject: "user_1" }, venue: "chat", presence: "present" },
    createdAt: "2026-07-31T12:00:00.000Z",
  } as ApprovalRequest;
}

/** ⚠️ TEST EDIT (M1 · Sentence): the card no longer has a field TABLE. Every
    real input still shows, always — the ones the question names are in the
    question, and the rest are the dot-separated notes on the one quiet line
    under it. The money rule this file exists for is unchanged; only where the
    formatted value lands moved. */
function cardOf(approval: ApprovalRequest): { question: string; notes: string[] } {
  const { container } = render(
    <VendoProvider client={client}>
      <ApprovalCard approval={approval} onDecide={() => undefined} />
    </VendoProvider>,
  );
  return {
    question: container.querySelector(".fl-approval-ask")!.textContent!,
    // One note per list item — the " · " between them is CSS punctuation, so
    // the items are also the exact set, with no split heuristic in the middle.
    notes: Array.from(container.querySelectorAll(".fl-approval-sub li")).map(li => li.textContent!),
  };
}

/** The card's own venue note, last on every ask in this file. */
const ASKED_HERE = "asked here in chat";
const IRREVERSIBLE = "This makes a change you can’t undo, as you.";

const CENTS_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    amount: { type: "integer", description: "Amount in integer cents" },
    recipient_name: { type: "string", description: "Who is being paid" },
    memo: { type: "string" },
  },
};

// Labels are the humanized form (#698, "labels prettified for reading"); the
// VALUE is what this file is about.
describe("the consent card's money rendering", () => {
  it("renders a host-declared cents amount as money, never as its raw integer", () => {
    const card = cardOf(transfer(
      { memo: "July water bill", amount: 4750, recipient_name: "Acme Utilities" },
      CENTS_SCHEMA,
    ));
    // The amount and the counterparty ARE the question; the memo is the one
    // input left, so it leads the quiet line. The WHOLE note set is pinned:
    // a `notes[0]` check could not see a second copy of a value further down.
    expect(card.question).toBe("Send $47.50 to Acme Utilities?");
    expect(card.notes).toEqual([
      "Memo: July water bill",
      "Sends now, as you",
      "Can’t be undone",
      ASKED_HERE,
    ]);
    // The exact misread the proof caught: 4750 must not survive anywhere on the
    // card.
    expect(screen.getByRole("article").textContent).not.toContain("4750");
  });

  it("reads a unit stated by the field's own name, with no schema description", () => {
    const card = cardOf(transfer(
      { amountCents: 4750 },
      { type: "object", properties: { amountCents: { type: "integer" } } },
    ));
    // No counterparty in the inputs, so nothing supports a synthesized
    // question — the amount rides the notes, formatted the same way.
    expect(card.notes).toEqual(["Amount cents: $47.50", IRREVERSIBLE, ASKED_HERE]);
  });

  it("renders a host-declared dollars amount as money too", () => {
    const card = cardOf(transfer(
      { amount: 47.5 },
      { type: "object", properties: { amount: { type: "number", description: "Amount in dollars" } } },
    ));
    expect(card.notes).toEqual(["Amount: $47.50", IRREVERSIBLE, ASKED_HERE]);
  });

  it("says the unit is unspecified rather than letting an undeclared amount read as dollars", () => {
    // The in-thread card synthesizes an EMPTY descriptor schema, so this is the
    // real state of a live surface, not a hypothetical.
    const card = cardOf(transfer({ amount: 4750 }, {}));
    expect(card.notes).toEqual(["Amount: 4750 (unit not specified)", IRREVERSIBLE, ASKED_HERE]);
    // …and an amount we cannot state honestly never reaches the question.
    expect(card.question).toBe("Send money?");
  });

  it("leaves every non-money value exactly as it was — no currency guessing", () => {
    const card = cardOf(transfer(
      { invoiceId: "inv_42", count: 4750, permanent: true, quantity: 2 },
      {
        type: "object",
        properties: {
          invoiceId: { type: "string" },
          count: { type: "integer" },
          permanent: { type: "boolean" },
          quantity: { type: "integer" },
        },
      },
    ));
    expect(card.notes).toEqual([
      "Invoice id: inv_42",
      "Count: 4750",
      // Not currency guessing, but not the literal either (used to pin "true").
      "Permanent: Yes",
      "Quantity: 2",
      IRREVERSIBLE,
      ASKED_HERE,
    ]);
  });

  /**
   * The honesty law, on the seam that broke it: the question consumed inputs by
   * their humanized LABEL, and `humanizeToolName` is many-to-one. Each case
   * below put a REAL input nowhere on the card, or the same amount on it twice.
   */
  describe("what the question consumes, it consumes by IDENTITY", () => {
    it("hides no sibling whose humanized label collides with a consumed key", () => {
      const card = cardOf(transfer(
        { amount: 4750, recipient_name: "Acme Utilities", recipientName: "Bob Smith" },
        CENTS_SCHEMA,
      ));
      expect(card.question).toBe("Send $47.50 to Acme Utilities?");
      // `recipientName` humanizes to "Recipient name" too, so the label-based
      // dedupe deleted Bob Smith from a card that was about to move money.
      expect(card.notes).toEqual([
        "Recipient name: Bob Smith",
        "Sends now, as you",
        "Can’t be undone",
        ASKED_HERE,
      ]);
    });

    it("keeps a top-level input the question never printed, when a DEEPER field supplied the amount", () => {
      // The amount in the question came out of a line item; the top-level
      // `amount` is a string the question never touched — and the label dedupe
      // ("Amount") deleted it anyway.
      const card = cardOf(transfer(
        {
          amount: "see the attached invoice",
          line_items: [{ amount: 4750 }],
          recipient: "Acme Utilities",
        },
        {
          type: "object",
          properties: {
            amount: { type: "string" },
            line_items: {
              type: "array",
              items: { type: "object", properties: { amount: { type: "integer", description: "Amount in integer cents" } } },
            },
            recipient: { type: "string" },
          },
        },
      ));
      // A nested amount owns no row of its own, so it earns no question — and
      // every input, including the one the old question overwrote, is in sight.
      expect(card.question).toBe("Send money?");
      expect(card.notes).toEqual([
        "Amount: see the attached invoice",
        "Line items: Amount: $47.50",
        "Recipient: Acme Utilities",
        IRREVERSIBLE,
        ASKED_HERE,
      ]);
    });

    it("prints a nested amount exactly ONCE", () => {
      const card = cardOf(transfer(
        { charge: { amount_cents: 1850 }, recipient_name: "Acme Utilities" },
        {},
      ));
      // It used to ask "Send $18.50 to Acme Utilities?" AND note "Charge:
      // Amount cents: $18.50" — the leaf key `amount_cents` matched no row.
      expect(card.question).toBe("Send money?");
      expect(card.notes).toEqual([
        "Charge: Amount cents: $18.50",
        "Recipient name: Acme Utilities",
        IRREVERSIBLE,
        ASKED_HERE,
      ]);
      expect(screen.getByRole("article").textContent!.split("$18.50")).toHaveLength(2);
    });

    it("asks with the host's OWN display for a value, never the raw one under it", () => {
      // `formatField` moved the recipient's display; the question interpolated
      // the raw account id and the row carrying "Maple Savings" was deduped
      // away, so the formatted name appeared nowhere on the card.
      const { container } = render(
        <VendoProvider
          client={client}
          tools={{ host_transferMoney: {
            formatField: (key, value) => key === "recipient_name" ? `Maple Savings (${String(value)})` : undefined,
          } }}
        >
          <ApprovalCard
            approval={transfer({ amount: 4750, recipient_name: "acct_8820" }, CENTS_SCHEMA)}
            onDecide={() => undefined}
          />
        </VendoProvider>,
      );
      expect(container.querySelector(".fl-approval-ask")!.textContent)
        .toBe("Send $47.50 to Maple Savings (acct_8820)?");
    });
  });
});
