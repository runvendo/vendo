import { describe, expect, it } from "vitest";
import { fadeShapeSchema, fadeProposalResolutionSchema } from "./fade";
import { consentRequestSchema } from "./consent";

describe("fade wire contract", () => {
  it("accepts a constrained fade shape", () => {
    const shape = fadeShapeSchema.parse({ kind: "constrained", path: "to", op: "matches", value: "*@acme.co" });
    expect(shape.kind).toBe("constrained");
  });
  it("accepts the tool-wide fallback shape", () => {
    expect(fadeShapeSchema.parse({ kind: "tool" }).kind).toBe("tool");
  });
  it("rejects op values a fade shape never uses (lte/gte)", () => {
    expect(() => fadeShapeSchema.parse({ kind: "constrained", path: "amount", op: "lte", value: 5 })).toThrow();
  });
  it("parses a fade-proposal resolution", () => {
    const r = fadeProposalResolutionSchema.parse({ proposalId: "p-1", accept: true });
    expect(r.accept).toBe(true);
  });
  it("rejects extra fields (strict)", () => {
    expect(() => fadeProposalResolutionSchema.parse({ proposalId: "p", accept: true, extra: 1 })).toThrow();
  });
  it("ConsentRequest admits kind 'fade-proposal'", () => {
    const req = consentRequestSchema.parse({
      id: "p-1", kind: "fade-proposal", tier: "act",
      toolName: "GMAIL_SEND_EMAIL", inputPreview: "reminder emails to your clients",
    });
    expect(req.kind).toBe("fade-proposal");
  });
});
