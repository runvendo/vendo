import { describe, expect, it } from "vitest";
import { manifestToolSchema } from "./tool";

const listInvoices = {
  name: "listInvoices",
  description: "List the user's invoices, newest first.",
  inputSchema: { type: "object", properties: { limit: { type: "number" } } },
  annotations: { mutating: false, dangerous: false },
  binding: { type: "http", method: "GET", path: "/api/invoices" },
};

describe("manifestToolSchema", () => {
  it("accepts a read-only http tool", () => {
    expect(() => manifestToolSchema.parse(listInvoices)).not.toThrow();
  });

  it("accepts a mutating+dangerous tool with a templated path", () => {
    expect(() =>
      manifestToolSchema.parse({
        ...listInvoices,
        name: "cancelInvoice",
        annotations: { mutating: true, dangerous: true, idempotent: true },
        binding: { type: "http", method: "POST", path: "/api/invoices/{id}/cancel" },
      }),
    ).not.toThrow();
  });

  it("requires annotations — no unsound defaults", () => {
    const { annotations: _a, ...rest } = listInvoices;
    expect(() => manifestToolSchema.parse(rest)).toThrow();
  });

  it("rejects unknown binding types and bad names", () => {
    expect(() =>
      manifestToolSchema.parse({ ...listInvoices, binding: { type: "grpc" } }),
    ).toThrow();
    expect(() => manifestToolSchema.parse({ ...listInvoices, name: "1bad name" })).toThrow();
  });
});
