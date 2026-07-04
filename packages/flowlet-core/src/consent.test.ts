import { describe, expect, it } from "vitest";
import { consentRequestSchema, consentResponseSchema } from "./consent";

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

  it("rejects a kind other than approval (v1-narrowed union)", () => {
    expect(() =>
      consentRequestSchema.parse({
        id: "call-1", kind: "fade-proposal", tier: "act",
        toolName: "x", inputPreview: "",
      }),
    ).toThrow();
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
