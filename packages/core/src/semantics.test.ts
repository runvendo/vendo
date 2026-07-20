import { describe, expect, it } from "vitest";
import {
  describeShapeWithSemantics,
  inferToolSemantics,
  semanticAtPointer,
  semanticFormatToken,
  semanticsFileSchema,
  type FieldSemantic,
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

describe("inferToolSemantics", () => {
  const semantics = inferToolSemantics([invoiceRows]);

  it("classifies *Cents number fields as money in cents, at collapsed array paths", () => {
    expect(semantics["data.amountCents"]).toEqual({ kind: "money", unit: "cents" });
    expect(semantics["totalCents"]).toEqual({ kind: "money", unit: "cents" });
  });

  it("classifies ISO strings as iso dates", () => {
    expect(semantics["data.dueDate"]).toEqual({ kind: "date", format: "iso" });
    expect(semantics["data.paidAt"]).toEqual({ kind: "date", format: "iso" });
  });

  it("classifies small lowercase vocabularies on enum-named fields, with humanized labels", () => {
    expect(semantics["data.status"]).toEqual({
      kind: "enum",
      labels: { overdue: "Overdue", paid: "Paid" },
    });
  });

  it("classifies id / *Id fields with the entity prefix", () => {
    expect(semantics["data.id"]).toEqual({ kind: "id" });
    expect(semantics["data.clientId"]).toEqual({ kind: "id", entity: "client" });
  });

  it("omits plain fields (count is not money)", () => {
    expect(semantics["count"]).toBeUndefined();
  });

  it("classifies epoch-range numbers on date-named fields", () => {
    const inferred = inferToolSemantics([{ updatedAt: 1786230000000 }]);
    expect(inferred["updatedAt"]).toEqual({ kind: "date", format: "epoch" });
  });

  it("classifies ratio and whole percents by range", () => {
    expect(inferToolSemantics([{ progressRatio: 0.42 }])["progressRatio"]).toEqual({ kind: "percent", scale: "ratio" });
    expect(inferToolSemantics([{ utilizationPct: 62 }])["utilizationPct"]).toEqual({ kind: "percent", scale: "0-100" });
  });

  it("classifies decimal amount fields as dollars, integer amount fields as cents", () => {
    expect(inferToolSemantics([{ balance: 1234.56 }])["balance"]).toEqual({ kind: "money", unit: "dollars" });
    expect(inferToolSemantics([{ balance: 123456 }])["balance"]).toEqual({ kind: "money", unit: "cents" });
  });

  it("never classifies bare *Total / total count fields as money (cubic P1: documentsTotal, clientsTotal, pagination total are counts)", () => {
    const inferred = inferToolSemantics([{ documentsTotal: 55, clientsTotal: 12, total: 30 }]);
    expect(inferred["documentsTotal"]).toBeUndefined();
    expect(inferred["clientsTotal"]).toBeUndefined();
    expect(inferred["total"]).toBeUndefined();
    // Money-token totals still classify.
    expect(inferToolSemantics([{ totalAmount: 123456 }])["totalAmount"]).toEqual({ kind: "money", unit: "cents" });
    expect(inferToolSemantics([{ totalCents: 123456 }])["totalCents"]).toEqual({ kind: "money", unit: "cents" });
  });

  it("never classifies mixed-type or free-text fields", () => {
    const inferred = inferToolSemantics([{ status: "This invoice is very overdue indeed" }]);
    expect(inferred["status"]).toBeUndefined();
  });
});

describe("semanticAtPointer", () => {
  const semantics = inferToolSemantics([invoiceRows]);
  it("resolves JSON pointers, dropping numeric array segments", () => {
    expect(semanticAtPointer(semantics, "/data/0/amountCents")).toEqual({ kind: "money", unit: "cents" });
    expect(semanticAtPointer(semantics, "/totalCents")).toEqual({ kind: "money", unit: "cents" });
    expect(semanticAtPointer(semantics, "/data/0/nope")).toBeUndefined();
  });
});

describe("describeShapeWithSemantics", () => {
  it("annotates the compact shape card with field semantics", () => {
    const shape = deriveShape(invoiceRows);
    const semantics = inferToolSemantics([invoiceRows]);
    const card = describeShapeWithSemantics(shape, semantics);
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

describe("semanticsFileSchema", () => {
  it("accepts a full file and rejects a bad kind", () => {
    const file = {
      format: "vendo/semantics@1",
      tools: {
        host_list_invoices: {
          "data.amountCents": { kind: "money", unit: "cents" } satisfies FieldSemantic,
        },
      },
      domains: { has: ["invoices"], hasNot: ["payroll"] },
    };
    expect(semanticsFileSchema.parse(file).tools["host_list_invoices"]).toBeDefined();
    expect(() => semanticsFileSchema.parse({
      ...file,
      tools: { t: { f: { kind: "cash" } } },
    })).toThrow();
  });
});
