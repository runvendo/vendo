import { describe, expect, it } from "vitest";
import { compiledRuleSchema } from "./compiled-rules";

describe("compiled rule contract", () => {
  it("accepts an always_ask rule with a constraint", () => {
    const rule = compiledRuleSchema.parse({
      id: "r-1", tenantId: "t1", subject: "u1", kind: "always_ask",
      toolPattern: "sendClientMessage",
      constraint: { path: "clientId", op: "eq", value: "acme" },
      plainText: "emailing anyone at Acme",
      createdAt: "2026-07-04T00:00:00Z",
    });
    expect(rule.kind).toBe("always_ask");
  });

  it("accepts a glob toolPattern with no constraint", () => {
    const rule = compiledRuleSchema.parse({
      id: "r-2", tenantId: "t1", subject: "u1", kind: "always_ask",
      toolPattern: "GMAIL_*", plainText: "sending any Gmail message",
      createdAt: "2026-07-04T00:00:00Z",
    });
    expect(rule.constraint).toBeUndefined();
  });

  it("rejects a kind other than always_ask (v1 is tighten-only)", () => {
    expect(() =>
      compiledRuleSchema.parse({
        id: "r-3", tenantId: "t1", subject: "u1", kind: "deny",
        toolPattern: "x", plainText: "x", createdAt: "now",
      }),
    ).toThrow();
  });

  it("rejects extra fields (strict)", () => {
    expect(() =>
      compiledRuleSchema.parse({
        id: "r-4", tenantId: "t1", subject: "u1", kind: "always_ask",
        toolPattern: "x", plainText: "x", createdAt: "now", surprise: true,
      }),
    ).toThrow();
  });
});
