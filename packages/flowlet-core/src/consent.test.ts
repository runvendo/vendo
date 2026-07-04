import { describe, expect, it } from "vitest";
import { consentRequestSchema, consentResponseSchema, parkedActionResolutionSchema } from "./consent";

describe("consent wire types", () => {
  it("accepts a v1 approval consent request", () => {
    const req = consentRequestSchema.parse({
      id: "call-1",
      kind: "approval",
      tier: "act",
      toolName: "GMAIL_SEND_EMAIL",
      inputPreview: "To: acme@example.com",
    });
    expect(req.tier).toBe("act");
  });

  it("rejects a kind other than approval or parked-action (discriminated union)", () => {
    expect(() =>
      consentRequestSchema.parse({
        id: "call-1", kind: "fade-proposal", tier: "act",
        toolName: "x", inputPreview: "",
      }),
    ).toThrow();
  });

  it("widens consentRequestSchema to a discriminated union — 'approval' still parses (regression)", () => {
    const req = consentRequestSchema.parse({
      id: "call-1", kind: "approval", tier: "act", toolName: "x", inputPreview: "",
    });
    expect(req.kind).toBe("approval");
  });

  it("accepts the new 'parked-action' kind", () => {
    const req = consentRequestSchema.parse({
      id: "parked-1", kind: "parked-action", tier: "critical", toolName: "GMAIL_SEND_EMAIL",
      inputPreview: "To: acme@example.com",
    });
    expect(req.kind).toBe("parked-action");
  });

  it("rejects extra fields (strict)", () => {
    expect(() =>
      consentRequestSchema.parse({
        id: "call-1", kind: "approval", tier: "act",
        toolName: "x", inputPreview: "", surprise: true,
      }),
    ).toThrow();
  });

  it("accepts a yes decision with a grant draft", () => {
    const res = consentResponseSchema.parse({
      id: "call-1",
      decision: "yes",
      grant: { tool: "GMAIL_SEND_EMAIL", scope: { kind: "tool" }, duration: "standing" },
    });
    expect(res.decision).toBe("yes");
  });

  it("accepts a subset decision with a toolCallId list", () => {
    const res = consentResponseSchema.parse({
      id: "call-1", decision: "subset", subset: ["call-1", "call-2"],
    });
    expect(res.subset).toEqual(["call-1", "call-2"]);
  });
});

describe("parkedActionResolutionSchema", () => {
  it("accepts a yes/no decision", () => {
    expect(parkedActionResolutionSchema.parse({ actionId: "parked-1", decision: "yes" }).decision).toBe("yes");
  });
  it("rejects an unknown decision value", () => {
    expect(() => parkedActionResolutionSchema.parse({ actionId: "parked-1", decision: "maybe" })).toThrow();
  });
  it("rejects extra fields (strict)", () => {
    expect(() => parkedActionResolutionSchema.parse({ actionId: "p", decision: "yes", surprise: true })).toThrow();
  });
});
