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
    notes: container.querySelector(".fl-approval-sub")!.textContent!.split(" · "),
  };
}

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
    // input left, so it leads the quiet line.
    expect(card.question).toBe("Send $47.50 to Acme Utilities?");
    expect(card.notes[0]).toBe("Memo: July water bill");
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
    expect(card.notes[0]).toBe("Amount cents: $47.50");
  });

  it("renders a host-declared dollars amount as money too", () => {
    const card = cardOf(transfer(
      { amount: 47.5 },
      { type: "object", properties: { amount: { type: "number", description: "Amount in dollars" } } },
    ));
    expect(card.notes[0]).toBe("Amount: $47.50");
  });

  it("says the unit is unspecified rather than letting an undeclared amount read as dollars", () => {
    // The in-thread card synthesizes an EMPTY descriptor schema, so this is the
    // real state of a live surface, not a hypothetical.
    const card = cardOf(transfer({ amount: 4750 }, {}));
    expect(card.notes[0]).toBe("Amount: 4750 (unit not specified)");
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
    expect(card.notes.slice(0, 4)).toEqual([
      "Invoice id: inv_42",
      "Count: 4750",
      // Not currency guessing, but not the literal either (used to pin "true").
      "Permanent: Yes",
      "Quantity: 2",
    ]);
  });
});
