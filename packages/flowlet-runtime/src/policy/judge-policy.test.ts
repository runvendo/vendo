import { describe, it, expect, vi } from "vitest";
import { MockLanguageModelV3 } from "ai/test";
import type { LanguageModelV3GenerateResult } from "@ai-sdk/provider";
import { judgePolicy } from "./judge-policy";
import { getEscalationReason, getEscalationSource } from "./escalation";
import type { ApprovalDecision, ApprovalPolicy, PolicyContext } from "./types";
import type { ToolDescriptor } from "../descriptor";

const ZERO_USAGE: LanguageModelV3GenerateResult["usage"] = {
  inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 0, text: 0, reasoning: 0 },
};

function mockReturning(text: string): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    doGenerate: async (): Promise<LanguageModelV3GenerateResult> => ({
      content: [{ type: "text", text }],
      finishReason: { unified: "stop", raw: undefined },
      usage: ZERO_USAGE,
      warnings: [],
    }),
  });
}

function mockThrowing(): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    doGenerate: async (): Promise<LanguageModelV3GenerateResult> => {
      throw new Error("judge model failure");
    },
  });
}

function spyMock(impl: () => string): { model: MockLanguageModelV3; spy: ReturnType<typeof vi.fn> } {
  const spy = vi.fn(impl);
  const model = new MockLanguageModelV3({
    doGenerate: async (): Promise<LanguageModelV3GenerateResult> => ({
      content: [{ type: "text", text: spy() }],
      finishReason: { unified: "stop", raw: undefined },
      usage: ZERO_USAGE,
      warnings: [],
    }),
  });
  return { model, spy };
}

const actDesc: ToolDescriptor = {
  name: "GMAIL_SEND_EMAIL", source: "composio", annotations: {}, hasExecute: true, kind: "function",
};
const readDesc: ToolDescriptor = {
  name: "get_x", source: "caller", annotations: { readOnlyHint: true }, hasExecute: true, kind: "function",
};
const criticalDesc: ToolDescriptor = {
  name: "transfer_money", source: "caller", annotations: { destructiveHint: true }, hasExecute: true, kind: "function",
};
const engineActDesc: ToolDescriptor = {
  name: "always_ask_before", source: "engine", annotations: { readOnlyHint: false, destructiveHint: false },
  hasExecute: true, kind: "function",
};

function fixed(decision: ApprovalDecision): ApprovalPolicy {
  return { evaluate: () => decision };
}

function ctxFor(
  descriptor: ToolDescriptor,
  overrides: Partial<PolicyContext> = {},
): PolicyContext {
  return {
    toolName: descriptor.name,
    input: { to: "acme@example.com" },
    descriptor,
    principal: { userId: "u1" },
    threadId: "th-1",
    request: { text: "email Jim that I'm running 15 late", messageId: "m1" },
    ...overrides,
  };
}

describe("judgePolicy", () => {
  it("no model configured — pure identity on every tier/decision", async () => {
    const policy = judgePolicy(fixed("approve"), {});
    expect(await policy.evaluate(ctxFor(actDesc))).toBe("approve");
    expect(await judgePolicy(fixed("allow"), {}).evaluate(ctxFor(readDesc))).toBe("allow");
    expect(await judgePolicy(fixed("deny"), {}).evaluate(ctxFor(actDesc))).toBe("deny");
  });

  it("INVARIANT: never touches a deny, even with a model configured", async () => {
    const policy = judgePolicy(fixed("deny"), { model: mockReturning("match") });
    expect(await policy.evaluate(ctxFor(actDesc))).toBe("deny");
  });

  it("INVARIANT: never touches critical, even with a model configured", async () => {
    const policy = judgePolicy(fixed("approve"), { model: mockReturning("match") });
    expect(await policy.evaluate(ctxFor(criticalDesc))).toBe("approve");
  });

  it("read tier is never judged — model is not even called", async () => {
    const { model, spy } = spyMock(() => "escalate: whatever");
    const policy = judgePolicy(fixed("allow"), { model });
    expect(await policy.evaluate(ctxFor(readDesc))).toBe("allow");
    expect(spy).not.toHaveBeenCalled();
  });

  it("no threadId (an automation context) is never judged — inner decision passes through untouched", async () => {
    const { model, spy } = spyMock(() => "escalate: whatever");
    const policy = judgePolicy(fixed("allow"), { model });
    const ctx = ctxFor(actDesc, { threadId: undefined, request: undefined });
    expect(await policy.evaluate(ctx)).toBe("allow");
    expect(spy).not.toHaveBeenCalled();
  });

  it('"match" downgrades approve -> allow (Moment 2: asked-for action auto-executes)', async () => {
    const policy = judgePolicy(fixed("approve"), { model: mockReturning("match") });
    expect(await policy.evaluate(ctxFor(actDesc))).toBe("allow");
  });

  it('"match" leaves an already-"allow" decision as "allow"', async () => {
    const policy = judgePolicy(fixed("allow"), { model: mockReturning("match") });
    expect(await policy.evaluate(ctxFor(actDesc))).toBe("allow");
  });

  it('"escalate: <reason>" forces approve EVEN IF the inner (grant/fade) said "allow", and stamps the reason', async () => {
    const policy = judgePolicy(fixed("allow"), {
      model: mockReturning("escalate: this goes to someone you have never emailed"),
    });
    const ctx = ctxFor(actDesc);
    expect(await policy.evaluate(ctx)).toBe("approve");
    expect(getEscalationReason(ctx)).toBe("this goes to someone you have never emailed");
  });

  it('"escalate:" on an already-"approve" decision keeps it "approve" and still stamps the reason', async () => {
    const policy = judgePolicy(fixed("approve"), { model: mockReturning("escalate: unusual target") });
    const ctx = ctxFor(actDesc);
    expect(await policy.evaluate(ctx)).toBe("approve");
    expect(getEscalationReason(ctx)).toBe("unusual target");
  });

  it("ADVERSARIAL: injected instruction in a tainted tool result + mismatched intent -> escalate", async () => {
    // The model sees taintedSources non-empty and a mismatched request; a real
    // judge model would say escalate — this test drives that shape through a
    // scripted mock (the model's OWN reasoning isn't under test here, only
    // that judgePolicy plumbs provenance/counters into the prompt and honors
    // an escalate verdict).
    const policy = judgePolicy(fixed("allow"), {
      model: mockReturning("escalate: an email I read asked me to send your client list externally"),
    });
    const ctx = ctxFor(actDesc, {
      request: { text: "chase overdue invoices", messageId: "m1" },
      provenance: { taintedSources: ["GMAIL_FETCH_EMAILS"] },
    });
    expect(await policy.evaluate(ctx)).toBe("approve");
    expect(getEscalationReason(ctx)).toMatch(/client list/);
  });

  it("ADVERSARIAL: a plain user-asked action with no taint -> match -> allow", async () => {
    const policy = judgePolicy(fixed("approve"), { model: mockReturning("match") });
    const ctx = ctxFor(actDesc, {
      request: { text: "email Jim that I'm running 15 late", messageId: "m1" },
      provenance: { taintedSources: [] },
    });
    expect(await policy.evaluate(ctx)).toBe("allow");
  });

  it("ADVERSARIAL: a GRANTED call (inner already 'allow') with taint present still gets escalated", async () => {
    const policy = judgePolicy(fixed("allow"), {
      model: mockReturning("escalate: this grant is being used for something new"),
    });
    const ctx = ctxFor(actDesc, { provenance: { taintedSources: ["some_tool"] } });
    expect(await policy.evaluate(ctx)).toBe("approve");
  });

  it("model error: an already-'approve' decision is left alone (no escalate-on-error stamp)", async () => {
    const policy = judgePolicy(fixed("approve"), { model: mockThrowing() });
    const ctx = ctxFor(actDesc);
    expect(await policy.evaluate(ctx)).toBe("approve");
    expect(getEscalationReason(ctx)).toBeUndefined();
  });

  it("model error: an 'allow' WITH taint present is forced to approve (escalate-on-error bias)", async () => {
    const policy = judgePolicy(fixed("allow"), { model: mockThrowing() });
    const ctx = ctxFor(actDesc, { provenance: { taintedSources: ["some_tool"] } });
    expect(await policy.evaluate(ctx)).toBe("approve");
    expect(getEscalationReason(ctx)).toBeTruthy();
  });

  it("model error: an 'allow' with NO taint is left alone — a flaky judge must not manufacture friction", async () => {
    const policy = judgePolicy(fixed("allow"), { model: mockThrowing() });
    const ctx = ctxFor(actDesc, { provenance: { taintedSources: [] } });
    expect(await policy.evaluate(ctx)).toBe("allow");
  });

  it("unparseable model output is treated exactly like a model error (never denies, never crashes)", async () => {
    const policy = judgePolicy(fixed("allow"), { model: mockReturning("uh, sure I guess?") });
    expect(await policy.evaluate(ctxFor(actDesc, { provenance: { taintedSources: [] } }))).toBe("allow");
  });

  it("memoises by (threadId, toolName, input): needsApproval + execute's two evaluations of the SAME call invoke the model once", async () => {
    const { model, spy } = spyMock(() => "match");
    const policy = judgePolicy(fixed("approve"), { model });
    const ctx1 = ctxFor(actDesc); // simulates needsApproval's ctx
    const ctx2 = ctxFor(actDesc); // simulates execute's SEPARATE ctx, same call
    expect(await policy.evaluate(ctx1)).toBe("allow");
    expect(await policy.evaluate(ctx2)).toBe("allow");
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("a memo HIT still re-stamps the reason onto the fresh ctx (escalate verdict, second evaluation)", async () => {
    const { model } = spyMock(() => "escalate: memoised reason");
    const policy = judgePolicy(fixed("allow"), { model });
    const ctx1 = ctxFor(actDesc);
    const ctx2 = ctxFor(actDesc);
    await policy.evaluate(ctx1);
    await policy.evaluate(ctx2);
    expect(getEscalationReason(ctx2)).toBe("memoised reason");
  });

  it("memo is scoped per principal — the same thread+tool+input under a different user re-invokes the model", async () => {
    const { model, spy } = spyMock(() => "match");
    const policy = judgePolicy(fixed("approve"), { model });
    await policy.evaluate(ctxFor(actDesc));
    await policy.evaluate(ctxFor(actDesc, { principal: { userId: "someone-else" } }));
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("INVARIANT: an engine-source (control-plane) tool is exempt from the judge — model never invoked", async () => {
    const { model, spy } = spyMock(() => "escalate: whatever");
    const policy = judgePolicy(fixed("approve"), { model });
    const ctx = ctxFor(engineActDesc);
    expect(await policy.evaluate(ctx)).toBe("approve");
    expect(spy).not.toHaveBeenCalled();
    expect(getEscalationReason(ctx)).toBeUndefined();
  });

  describe("parser hardening (review follow-up: haiku's prose fails a strict one-line regex)", () => {
    it("parses a markdown-wrapped match verdict", async () => {
      const policy = judgePolicy(fixed("approve"), { model: mockReturning("**match**") });
      expect(await policy.evaluate(ctxFor(actDesc))).toBe("allow");
    });

    it("parses a verdict that follows a preamble line", async () => {
      const policy = judgePolicy(
        fixed("approve"),
        { model: mockReturning("Let me think about this for a second.\nmatch") },
      );
      expect(await policy.evaluate(ctxFor(actDesc))).toBe("allow");
    });

    it("parses a match verdict with trailing punctuation", async () => {
      const policy = judgePolicy(fixed("approve"), { model: mockReturning("match.") });
      expect(await policy.evaluate(ctxFor(actDesc))).toBe("allow");
    });

    it('parses a markdown-wrapped "escalate:" label and stamps the clean reason', async () => {
      const policy = judgePolicy(fixed("allow"), { model: mockReturning("**escalate:** unusual target") });
      const ctx = ctxFor(actDesc);
      expect(await policy.evaluate(ctx)).toBe("approve");
      expect(getEscalationReason(ctx)).toBe("unusual target");
      expect(getEscalationSource(ctx)).toBe("verdict");
    });

    it("genuinely ambiguous prose (no line is a bare verdict) still parses as undefined -> escalate-on-error", async () => {
      const policy = judgePolicy(fixed("allow"), {
        model: mockReturning("I think you might want to double check this one, but it could be fine either way."),
      });
      // No taint -> escalateOnError leaves an "allow" alone (existing, unrelated invariant).
      expect(await policy.evaluate(ctxFor(actDesc, { provenance: { taintedSources: [] } }))).toBe("allow");
      // With taint present, the SAME ambiguous prose forces approve via the error path.
      const ctx = ctxFor(actDesc, { provenance: { taintedSources: ["some_tool"] } });
      expect(await policy.evaluate(ctx)).toBe("approve");
      expect(getEscalationSource(ctx)).toBe("error");
    });
  });

  describe("escalation source tagging (review follow-up)", () => {
    it('a real "escalate" verdict stamps source "verdict"', async () => {
      const policy = judgePolicy(fixed("allow"), { model: mockReturning("escalate: unusual target") });
      const ctx = ctxFor(actDesc);
      await policy.evaluate(ctx);
      expect(getEscalationSource(ctx)).toBe("verdict");
    });

    it('a model error/unparseable output stamps source "error", never "verdict"', async () => {
      const policy = judgePolicy(fixed("allow"), { model: mockThrowing() });
      const ctx = ctxFor(actDesc, { provenance: { taintedSources: ["some_tool"] } });
      await policy.evaluate(ctx);
      expect(getEscalationSource(ctx)).toBe("error");
    });
  });

  it("propagates onExecuted to inner", async () => {
    const calls: string[] = [];
    const inner: ApprovalPolicy = { evaluate: () => "allow", onExecuted: async () => { calls.push("inner"); } };
    const policy = judgePolicy(inner, {});
    await policy.onExecuted!(ctxFor(actDesc), "allow");
    expect(calls).toEqual(["inner"]);
  });
});

describe("parseVerdict escalate bias (review follow-up)", () => {
  it("an escalate after a stray standalone match line wins — never reads as allow", async () => {
    const policy = judgePolicy(fixed("approve"), {
      model: mockReturning("match\nescalate: recipient not in the user's request"),
    });
    const ctx = ctxFor(actDesc);
    expect(await policy.evaluate(ctx)).toBe("approve");
    expect(getEscalationReason(ctx)).toMatch(/recipient not in the user's request/);
  });
});
