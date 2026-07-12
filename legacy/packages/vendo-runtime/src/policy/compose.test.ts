import { describe, it, expect, vi } from "vitest";
import type { ApprovalPolicy, ApprovalDecision, PolicyContext } from "./types.js";
import { composePolicy } from "./compose.js";

/** Minimal fake context — cast is safe for pure policy logic tests. */
const fakeCtx = {
  toolName: "doSomething",
  input: {},
  descriptor: {} as PolicyContext["descriptor"],
  principal: { userId: "u1" },
} as PolicyContext;

/** Helper: build a synchronous stub policy that always returns a fixed decision. */
function stub(decision: ApprovalDecision): ApprovalPolicy {
  return { evaluate: () => decision };
}

/** Helper: build an async stub policy that resolves to a fixed decision. */
function asyncStub(decision: ApprovalDecision): ApprovalPolicy {
  return { evaluate: () => Promise.resolve(decision) };
}

describe("composePolicy", () => {
  it("returns 'allow' when all layers return 'allow'", async () => {
    const policy = composePolicy(stub("allow"), stub("allow"), stub("allow"));
    expect(await policy.evaluate(fakeCtx)).toBe("allow");
  });

  it("returns 'approve' when one layer returns 'approve' and the rest return 'allow'", async () => {
    const policy = composePolicy(stub("allow"), stub("approve"), stub("allow"));
    expect(await policy.evaluate(fakeCtx)).toBe("approve");
  });

  it("returns 'deny' when one layer returns 'deny' and others return 'allow' or 'approve'", async () => {
    const policy = composePolicy(stub("allow"), stub("approve"), stub("deny"));
    expect(await policy.evaluate(fakeCtx)).toBe("deny");
  });

  it("awaits async layers and combines their results correctly", async () => {
    const policy = composePolicy(
      asyncStub("allow"),
      asyncStub("approve"),
      asyncStub("allow"),
    );
    expect(await policy.evaluate(fakeCtx)).toBe("approve");
  });

  it("handles a mix of sync and async layers, taking the most restrictive decision", async () => {
    const policy = composePolicy(
      stub("allow"),
      asyncStub("deny"),
      stub("approve"),
    );
    expect(await policy.evaluate(fakeCtx)).toBe("deny");
  });

  it("returns 'allow' when zero policies are composed", async () => {
    const policy = composePolicy();
    expect(await policy.evaluate(fakeCtx)).toBe("allow");
  });

  it("onExecuted forwards the enforced decision to every layer that defines it and skips those that don't", async () => {
    const a = vi.fn();
    const b = vi.fn();
    const layerWithExec1: ApprovalPolicy = { evaluate: () => "allow", onExecuted: a };
    const layerNoExec: ApprovalPolicy = { evaluate: () => "allow" }; // no onExecuted
    const layerWithExec2: ApprovalPolicy = { evaluate: () => "allow", onExecuted: b };

    const policy = composePolicy(layerWithExec1, layerNoExec, layerWithExec2);
    await policy.onExecuted!(fakeCtx, "approve");

    expect(a).toHaveBeenCalledOnce();
    expect(a).toHaveBeenCalledWith(fakeCtx, "approve");
    expect(b).toHaveBeenCalledOnce();
    expect(b).toHaveBeenCalledWith(fakeCtx, "approve");
  });
});
