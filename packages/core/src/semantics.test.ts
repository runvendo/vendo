import { describe, expect, it } from "vitest";
import {
  describeShapeWithSemantics,
  inferFieldSemantic,
  semanticAtPointer,
  declaredMoneyUnit,
  semanticFormatToken,
  type ToolSemantics,
} from "./semantics.js";
import { type ShapeType } from "./shape.js";

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

describe("inferFieldSemantic", () => {
  it("classifies *Cents number fields as money in cents", () => {
    expect(inferFieldSemantic("amountCents", [285000, 90000])).toEqual({ kind: "money", unit: "cents" });
    expect(inferFieldSemantic("totalCents", [375000])).toEqual({ kind: "money", unit: "cents" });
  });

  it("classifies ISO strings as iso dates, ignoring nulls", () => {
    expect(inferFieldSemantic("dueDate", ["2026-08-01", "2026-07-21T17:00:00Z"])).toEqual({ kind: "date", format: "iso" });
    expect(inferFieldSemantic("paidAt", [null, "2026-07-01T09:00:00Z"])).toEqual({ kind: "date", format: "iso" });
  });

  it("classifies small lowercase vocabularies on enum-named fields, with humanized labels", () => {
    expect(inferFieldSemantic("status", ["overdue", "paid"])).toEqual({
      kind: "enum",
      labels: { overdue: "Overdue", paid: "Paid" },
    });
  });

  it("classifies id / *Id fields with the entity prefix", () => {
    expect(inferFieldSemantic("id", ["inv_1", "inv_2"])).toEqual({ kind: "id" });
    expect(inferFieldSemantic("clientId", ["cl_9", "cl_4"])).toEqual({ kind: "id", entity: "client" });
  });

  it("leaves plain fields plain (count is not money)", () => {
    expect(inferFieldSemantic("count", [2])).toEqual({ kind: "plain" });
  });

  it("classifies epoch-range numbers on date-named fields", () => {
    expect(inferFieldSemantic("updatedAt", [1786230000000])).toEqual({ kind: "date", format: "epoch" });
  });

  it("classifies ratio and whole percents by range", () => {
    expect(inferFieldSemantic("progressRatio", [0.42])).toEqual({ kind: "percent", scale: "ratio" });
    expect(inferFieldSemantic("utilizationPct", [62])).toEqual({ kind: "percent", scale: "0-100" });
  });

  it("classifies decimal amount fields as dollars, integer amount fields as cents", () => {
    expect(inferFieldSemantic("balance", [1234.56])).toEqual({ kind: "money", unit: "dollars" });
    expect(inferFieldSemantic("balance", [123456])).toEqual({ kind: "money", unit: "cents" });
  });

  it("never classifies bare *Total / total count fields as money (cubic P1: documentsTotal, clientsTotal, pagination total are counts)", () => {
    expect(inferFieldSemantic("documentsTotal", [55])).toEqual({ kind: "plain" });
    expect(inferFieldSemantic("clientsTotal", [12])).toEqual({ kind: "plain" });
    expect(inferFieldSemantic("total", [30])).toEqual({ kind: "plain" });
    // Money-token totals still classify.
    expect(inferFieldSemantic("totalAmount", [123456])).toEqual({ kind: "money", unit: "cents" });
    expect(inferFieldSemantic("totalCents", [123456])).toEqual({ kind: "money", unit: "cents" });
  });

  it("never classifies mixed-type or free-text fields", () => {
    expect(inferFieldSemantic("status", ["This invoice is very overdue indeed"])).toEqual({ kind: "plain" });
  });
});

describe("semanticAtPointer", () => {
  it("resolves JSON pointers, dropping numeric array segments", () => {
    expect(semanticAtPointer(invoiceSemantics, "/data/0/amountCents")).toEqual({ kind: "money", unit: "cents" });
    expect(semanticAtPointer(invoiceSemantics, "/totalCents")).toEqual({ kind: "money", unit: "cents" });
    expect(semanticAtPointer(invoiceSemantics, "/data/0/nope")).toBeUndefined();
  });
});

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

describe("semanticFormatToken", () => {
  it("maps semantics to Kit value-format tokens", () => {
    expect(semanticFormatToken({ kind: "money", unit: "cents" })).toBe("money");
    expect(semanticFormatToken({ kind: "date", format: "iso" })).toBe("date");
    expect(semanticFormatToken({ kind: "percent", scale: "ratio" })).toBe("percent");
    expect(semanticFormatToken({ kind: "id" })).toBeUndefined();
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
    for (const name of ["invoiceId", "count", "quantity", "recipient_name", "memo", "itemCount", "rate", "percent"]) {
      expect(declaredMoneyUnit(name, { type: "number" }), name).toBeUndefined();
    }
    // "cents" inside a sentence about something else is not a declaration.
    expect(declaredMoneyUnit("note", { description: "mentions cents" })).toBeUndefined();
  });
});
