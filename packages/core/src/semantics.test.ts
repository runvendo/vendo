import { describe, expect, it } from "vitest";
import {
  describeShapeWithSemantics,
  inferFieldSemantic,
  semanticAtPointer,
  semanticFormatToken,
  type ToolSemantics,
} from "./semantics.js";
import { deriveShape } from "./shape.js";

const invoiceRows = {
  data: [
    { id: "inv_1", clientId: "cl_9", amountCents: 285000, dueDate: "2026-08-01", status: "overdue", paidAt: null },
    { id: "inv_2", clientId: "cl_4", amountCents: 90000, dueDate: "2026-07-21T17:00:00Z", status: "paid", paidAt: "2026-07-01T09:00:00Z" },
  ],
  totalCents: 375000,
  count: 2,
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
    const shape = deriveShape(invoiceRows);
    const card = describeShapeWithSemantics(shape, invoiceSemantics);
    expect(card).toContain("amountCents: number:money.cents");
    expect(card).toContain("dueDate: string:date.iso");
    expect(card).toContain("status: string:enum(overdue|paid)");
    expect(card).toContain("id: string:id");
    expect(card).toContain("count: number");
  });

  it("matches describeShape exactly when no semantics apply", () => {
    const shape = deriveShape({ note: "x" });
    expect(describeShapeWithSemantics(shape, {})).toBe("{ note: string }");
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
