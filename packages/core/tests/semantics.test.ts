import { describe, expect, it } from "vitest";
import {
  declaredMoneyUnit,
  describeFieldSemantic,
  describeShapeWithSemantics,
  fieldSemanticSchema,
  SEMANTIC_TOKENS,
  type FieldSemantic,
  type ToolSemantics,
} from "../src/semantics.js";
import { type ShapeType } from "../src/shape.js";

/** The declared shape of the invoice response, written literally — the same
 *  structural form `shapeFromJsonSchema` produces from a host's own schema.
 *  `paidAt` is `json`: the host returns a date or null. */
const invoiceRows: ShapeType = {
  kind: "object",
  fields: {
    data: {
      kind: "array",
      items: {
        kind: "object",
        fields: {
          id: { kind: "string" },
          clientId: { kind: "string" },
          amountCents: { kind: "number" },
          dueDate: { kind: "string" },
          status: { kind: "string" },
          paidAt: { kind: "json" },
        },
      },
    },
    totalCents: { kind: "number" },
    count: { kind: "number" },
  },
};

/** Collapsed-path semantics for {@link invoiceRows} — array levels carry no
 *  numeric segment, so `data.amountCents` covers `/data/3/amountCents`. */
const invoiceSemantics: ToolSemantics = {
  "data.id": { kind: "id" },
  "data.clientId": { kind: "id", entity: "client" },
  "data.amountCents": { kind: "money", unit: "cents" },
  "data.dueDate": { kind: "date", format: "iso" },
  "data.paidAt": { kind: "date", format: "iso" },
  "data.status": { kind: "enum", labels: { overdue: "Overdue", paid: "Paid" } },
  totalCents: { kind: "money", unit: "cents" },
};

describe("describeShapeWithSemantics", () => {
  it("annotates the compact shape card with field semantics", () => {
    const card = describeShapeWithSemantics(invoiceRows, invoiceSemantics);
    expect(card).toContain("amountCents: number:money.cents");
    expect(card).toContain("dueDate: string:date.iso");
    expect(card).toContain("status: string:enum(overdue|paid)");
    expect(card).toContain("id: string:id");
    expect(card).toContain("count: number");
  });

  it("matches describeShape exactly when no semantics apply", () => {
    const shape: ShapeType = { kind: "object", fields: { note: { kind: "string" } } };
    expect(describeShapeWithSemantics(shape, {})).toBe("{ note: string }");
  });

  it("renders a schema enum when no semantic claims the path, and yields to one that does", () => {
    const shape: ShapeType = {
      kind: "object",
      fields: { status: { kind: "string", enum: ["paid", "void"] } },
    };
    expect(describeShapeWithSemantics(shape, { total: { kind: "money", unit: "cents" } }))
      .toBe('{ status: "paid" | "void" }');
    expect(describeShapeWithSemantics(shape, { status: { kind: "enum", labels: { paid: "Paid", void: "Void" } } }))
      .toBe("{ status: string:enum(paid|void) }");
  });
});

/**
 * `code` — the kind no shape can reach. A sha is 7 hex characters and a reader
 * could guess it, but `feat/timeline-brick` is a plain string by every
 * structural test there is, and only the host knows it is a ref.
 */
describe("the code semantic", () => {
  it("annotates a card, so a writer is SHOWN which fields are refs", () => {
    const shape: ShapeType = {
      kind: "object",
      fields: { branch: { kind: "string" }, message: { kind: "string" } },
    };
    expect(describeShapeWithSemantics(shape, { branch: { kind: "code" } }))
      .toBe("{ branch: string:code, message: string }");
  });

  it("parses, so a host may declare one in its own semantics file", () => {
    expect(fieldSemanticSchema.parse({ kind: "code" })).toEqual({ kind: "code" });
  });
});

/**
 * The card PRINTS these tokens and a Kit field ACCEPTS them (`@vendoai/ui`
 * kit/row.ts), which only works while the two lists are the same list. A kind
 * whose annotation is not a token is a thing a writer is shown and then refused
 * for copying.
 */
describe("SEMANTIC_TOKENS", () => {
  const fixed: FieldSemantic[] = [
    { kind: "money", unit: "cents" },
    { kind: "money", unit: "dollars" },
    { kind: "date", format: "iso" },
    { kind: "date", format: "epoch" },
    { kind: "percent", scale: "ratio" },
    { kind: "percent", scale: "0-100" },
    { kind: "code" },
    { kind: "id" },
  ];

  it("is exactly what the card prints for every kind that names one", () => {
    expect(fixed.map(describeFieldSemantic).sort()).toEqual([...SEMANTIC_TOKENS].sort());
  });

  // The two that carry a payload rather than naming a kind, and the one that
  // claims nothing — none of them is a token, and none of them is copyable.
  it("leaves out the kinds whose annotation is not a fixed word", () => {
    const open = [
      describeFieldSemantic({ kind: "enum", labels: { paid: "Paid" } }),
      describeFieldSemantic({ kind: "id", entity: "client" }),
      describeFieldSemantic({ kind: "money", unit: "cents", currency: "USD" }),
      describeFieldSemantic({ kind: "plain" }),
    ];
    for (const annotation of open) expect(SEMANTIC_TOKENS).not.toContain(annotation);
  });
});

describe("declaredMoneyUnit — what the HOST declared about an input field", () => {
  // Wave-1 live proof E2c: a $47.50 payment's consent card rendered
  // `amount 4750`, which reads as $4,750 — a 100× misread on the one surface
  // that gates irreversible money movement. The unit is not guessable from the
  // value; it is DECLARED, in the host's own input schema, and this is the
  // reader for that declaration. Never an inference from magnitude.
  it("reads the unit out of the host's property description", () => {
    expect(declaredMoneyUnit("amount", { type: "number", description: "Amount in integer cents" })).toBe("cents");
    expect(declaredMoneyUnit("amount", { type: "number", description: "Amount in minor units" })).toBe("cents");
    expect(declaredMoneyUnit("amount", { type: "number", description: "Amount in dollars" })).toBe("dollars");
  });

  it("reads a field whose NAME states the unit", () => {
    expect(declaredMoneyUnit("amountCents", { type: "integer" })).toBe("cents");
    expect(declaredMoneyUnit("total_cents", {})).toBe("cents");
    // No schema at all — the in-thread card synthesizes an empty descriptor.
    expect(declaredMoneyUnit("amountCents", undefined)).toBe("cents");
  });

  it("says UNKNOWN for a money-named field whose unit nobody declared", () => {
    // The honest answer, and the one the card must not render as dollars.
    expect(declaredMoneyUnit("amount", { type: "number" })).toBe("unknown");
    expect(declaredMoneyUnit("price", undefined)).toBe("unknown");
    // Contradictory metadata declares nothing (the `unitAnnotation` rule).
    expect(declaredMoneyUnit("amount", { description: "cents or dollars" })).toBe("unknown");
  });

  it("stays silent on fields that are not money — no currency guessing", () => {
    // A bare total is a COUNT: documentsTotal, clientsTotal and pagination
    // totals are not money. Only a money token (totalAmount) makes one.
    for (const name of [
      "invoiceId", "count", "quantity", "recipient_name", "memo", "itemCount", "rate", "percent",
      "documentsTotal", "clientsTotal", "total",
    ]) {
      expect(declaredMoneyUnit(name, { type: "number" }), name).toBeUndefined();
    }
    // "cents" inside a sentence about something else is not a declaration.
    expect(declaredMoneyUnit("note", { description: "mentions cents" })).toBeUndefined();
    expect(declaredMoneyUnit("totalAmount", { type: "integer" })).toBe("unknown");
  });
});
