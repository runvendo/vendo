import { describe, expect, it } from "vitest";
import { descriptorHash, duplicateToolTitles, type ToolDescriptor } from "./index.js";

const base: ToolDescriptor = {
  name: "maple_payments_send",
  description: "Send a payment",
  inputSchema: { type: "object", properties: { amount: { type: "number" } } },
  risk: "destructive",
};

describe("title joins the descriptorHash preimage (design §12)", () => {
  it("a retitle invalidates grants exactly like a rename", () => {
    const before = descriptorHash({ ...base, title: "Send a payment" });
    const after = descriptorHash({ ...base, title: "Send money to a recipient" });

    expect(after).not.toBe(before);
  });

  it("leaves an untitled descriptor's hash alone, so existing grants survive", () => {
    // `title` is optional and only enters the preimage when defined — the same
    // rule `critical` already follows. Every grant minted before titles existed
    // must keep matching, or this change would silently revoke the whole estate.
    expect(descriptorHash(base)).toBe(descriptorHash({ ...base, title: undefined }));
  });

  it("is still insensitive to key order once a title is present", () => {
    const one: ToolDescriptor = { ...base, title: "Send a payment" };
    const two: ToolDescriptor = {
      title: "Send a payment",
      risk: base.risk,
      inputSchema: base.inputSchema,
      description: base.description,
      name: base.name,
    };
    expect(descriptorHash(one)).toBe(descriptorHash(two));
  });
});

describe("duplicate tool titles are a boot error (design §12)", () => {
  it("names every title two or more tools would read identically under", () => {
    const found = duplicateToolTitles([
      { ...base, name: "maple_payments_send", title: "Send money" },
      { ...base, name: "maple_transfers_create", title: "Send money" },
      { ...base, name: "maple_invoices_list", title: "List invoices", risk: "read" },
    ]);

    expect(found).toEqual([{ title: "Send money", tools: ["maple_payments_send", "maple_transfers_create"] }]);
  });

  it("accepts distinct titles, and ignores tools that carry none", () => {
    expect(duplicateToolTitles([
      { ...base, name: "a", title: "Alpha" },
      { ...base, name: "b", title: "Beta" },
      { ...base, name: "c" },
      { ...base, name: "d" },
    ])).toEqual([]);
  });

  it("compares titles as a person reads them — case and surrounding space do not distinguish two actions", () => {
    const found = duplicateToolTitles([
      { ...base, name: "a", title: "Send money" },
      { ...base, name: "b", title: "  send MONEY " },
    ]);
    expect(found).toHaveLength(1);
  });
});
