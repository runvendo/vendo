import { describe, expect, it } from "vitest";
import { getEscalationReason, getEscalationSource, setEscalationReason } from "./escalation";
import type { PolicyContext } from "./types";

function ctxFor(toolName: string): PolicyContext {
  return {
    toolName,
    input: {},
    descriptor: { name: toolName, source: "caller", annotations: {}, hasExecute: true, kind: "function" },
    principal: { userId: "u1" },
  };
}

describe("escalation reason side channel", () => {
  it("returns undefined for a ctx nothing stamped", () => {
    expect(getEscalationReason(ctxFor("a"))).toBeUndefined();
  });

  it("round-trips a reason stamped on a specific ctx instance", () => {
    const ctx = ctxFor("send_email");
    setEscalationReason(ctx, "this follows content I read from outside");
    expect(getEscalationReason(ctx)).toBe("this follows content I read from outside");
  });

  it("is keyed by OBJECT IDENTITY, not tool name — a structurally identical ctx is unaffected", () => {
    const ctx1 = ctxFor("send_email");
    const ctx2 = ctxFor("send_email");
    setEscalationReason(ctx1, "reason for ctx1 only");
    expect(getEscalationReason(ctx2)).toBeUndefined();
  });

  it("caps a runaway model-authored reason at 200 chars AT THE STAMP SITE", () => {
    const ctx = ctxFor("send_email");
    setEscalationReason(ctx, "x".repeat(5000));
    expect(getEscalationReason(ctx)).toHaveLength(200);
  });

  it("collapses all whitespace/newlines to single spaces so every consumer gets one line", () => {
    const ctx = ctxFor("send_email");
    setEscalationReason(ctx, "  line one\n\nline\ttwo   spaced\r\nend  ");
    expect(getEscalationReason(ctx)).toBe("line one line two spaced end");
  });

  describe("source tag (review follow-up: distinguish a real judge verdict from escalate-on-error)", () => {
    it("defaults to source \"verdict\" when omitted", () => {
      const ctx = ctxFor("send_email");
      setEscalationReason(ctx, "a reason");
      expect(getEscalationSource(ctx)).toBe("verdict");
    });

    it("round-trips an explicit \"error\" source alongside the reason", () => {
      const ctx = ctxFor("send_email");
      setEscalationReason(ctx, "model failed", "error");
      expect(getEscalationReason(ctx)).toBe("model failed");
      expect(getEscalationSource(ctx)).toBe("error");
    });

    it("returns undefined for a ctx nothing stamped", () => {
      expect(getEscalationSource(ctxFor("a"))).toBeUndefined();
    });
  });
});
