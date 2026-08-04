/**
 * Wave-1 live proof E2c, ONE LEVEL DOWN.
 *
 * The top-level rows learned the money rule (`approval-money.test.tsx`): a
 * host-declared cents amount renders as money, an undeclared one says so. A
 * nested value skipped that seam entirely — `fieldRows` flattened objects with a
 * raw `leaf()`, so the same $18.50 charge inside an object printed as
 * "Amount cents: 1850" on Maple's live `host_createOrder` card. Same defect,
 * same card, one indentation deeper.
 *
 * The rule is the top level's rule, unchanged: DECLARED → formatted, undeclared
 * → said out loud, never a silent divide.
 */
import type { JsonSchema } from "@vendoai/core";
import { describe, expect, it } from "vitest";
import { fieldRows } from "../../src/chrome/field-rows.js";

const valueOf = (args: unknown, schema?: JsonSchema, meta?: Parameters<typeof fieldRows>[2]): string =>
  fieldRows(args, schema, meta)[0]!.value;

describe("nested money on a consent card", () => {
  it("formats a cents amount declared inside a nested object", () => {
    const value = valueOf(
      { charge: { amount_cents: 1850, descriptor: "DoorDash" } },
      {
        type: "object",
        properties: {
          charge: {
            type: "object",
            properties: {
              amount_cents: { type: "integer", description: "Amount in integer cents" },
              descriptor: { type: "string" },
            },
          },
        },
      },
    );
    expect(value).toBe("Amount cents: $18.50\nDescriptor: DoorDash");
    expect(value).not.toContain("1850");
  });

  it("formats a cents amount the field NAME declares, with no nested schema at all", () => {
    // The in-thread card synthesizes an empty descriptor schema, so this is the
    // real state of a live surface.
    expect(valueOf({ charge: { amountCents: 1850 } })).toBe("Amount cents: $18.50");
  });

  it("says the unit is unspecified for an undeclared nested amount, rather than dividing", () => {
    expect(valueOf({ charge: { amount: 1850 } })).toBe("Amount: 1850 (unit not specified)");
  });

  it("formats money inside an array of objects, item by item", () => {
    const value = valueOf(
      { lines: [{ amount_cents: 1850 }, { amount_cents: 725 }] },
      {
        type: "object",
        properties: {
          lines: {
            type: "array",
            items: { type: "object", properties: { amount_cents: { type: "integer" } } },
          },
        },
      },
    );
    expect(value).toBe("Amount cents: $18.50\nAmount cents: $7.25");
  });

  it("prefers the host's own field formatter at depth, exactly as at the top", () => {
    const value = valueOf(
      { charge: { amount_cents: 1850 } },
      undefined,
      { formatField: (key, raw) => key === "amount_cents" ? `${String(raw)} pence` : undefined },
    );
    expect(value).toBe("Amount cents: 1850 pence");
  });

  it("leaves every non-money nested value exactly as it was — no currency guessing", () => {
    // Conductor ruling 6 (final integration): the card-polish lane's Yes/No law
    // applies at EVERY depth, so the boolean reads as an answer here too. The
    // invariant this case exists for is untouched — an undeclared `2` is still
    // `2` (never guessed into $0.02) and the id is still verbatim.
    expect(valueOf({ order: { quantity: 2, permanent: true, id: "inv_42" } }))
      .toBe("Quantity: 2\nPermanent: Yes\nId: inv_42");
  });

  it("keeps the raw value one hover away, as the honesty contract requires", () => {
    const [row] = fieldRows({ charge: { amount_cents: 1850 } });
    expect(row!.raw).toBe("{\"amount_cents\":1850}");
  });
});
