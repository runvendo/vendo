import { describe, expect, it } from "vitest";
import { hostEventSchema } from "./event.js";

describe("hostEventSchema", () => {
  it("accepts a namespaced event with a payload schema", () => {
    expect(() =>
      hostEventSchema.parse({
        name: "invoice.paid",
        description: "An invoice was paid in full.",
        payloadSchema: { type: "object", properties: { invoiceId: { type: "string" } } },
      }),
    ).not.toThrow();
  });

  it("accepts an event without a payload schema", () => {
    expect(() =>
      hostEventSchema.parse({ name: "user.deactivated", description: "Account deactivated." }),
    ).not.toThrow();
  });

  it("rejects un-namespaced or malformed names", () => {
    expect(() => hostEventSchema.parse({ name: "paid", description: "x" })).toThrow();
    expect(() => hostEventSchema.parse({ name: "Invoice.Paid!", description: "x" })).toThrow();
  });
});
