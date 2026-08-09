import type { Guard, GuardDecision, RunContext, ToolCall, ToolDescriptor, ToolOutcome, ToolRegistry } from "@vendoai/core";
import { describe, expect, it } from "vitest";
import { guardedCall, previewApproval } from "../src/tool-bridge.js";
import { ctx } from "../src/test-doubles.test-util.js";

// genqa defect 1 (double-count): a caller previews with `previewApproval` and
// then, when it answers false, dispatches with `guardedCall` moments later for
// the SAME toolCallId. Before this fix both called `guard.check()` — a "run"
// verdict billed the write-budget/call-rate breakers TWICE for one logical
// call. `previewApproval` must prefer `guard.previewCheck` when the guard
// implements it, and never call `guard.check` itself in that case — the
// dispatching path (`guardedCall`, via the guard-bound registry) remains the
// ONLY caller of `check`.
function countingGuard(action: GuardDecision["action"]): Guard & { checkCalls: number; previewCalls: number } {
  const decision: GuardDecision = action === "run"
    ? { action: "run", decidedBy: "default" }
    : action === "block"
      ? { action: "block", reason: "blocked", decidedBy: "rule" }
      : {
          action: "ask",
          decidedBy: "rule",
          approval: {
            id: "apr_1",
            call: { id: "call_1", tool: "host_write", args: {} },
            descriptor: { name: "host_write", description: "", inputSchema: {}, risk: "write" },
            inputPreview: "{}",
            ctx: { principal: { kind: "user", subject: "u1" }, venue: "chat", presence: "present" },
            createdAt: new Date().toISOString(),
          },
        };
  return {
    checkCalls: 0,
    previewCalls: 0,
    async check(this: { checkCalls: number }) {
      this.checkCalls += 1;
      return decision;
    },
    async previewCheck(this: { previewCalls: number }) {
      this.previewCalls += 1;
      return decision;
    },
    async report() {},
    async directions() {
      return [];
    },
    onApprovalDecision() {
      return () => undefined;
    },
  } as unknown as Guard & { checkCalls: number; previewCalls: number };
}

function boundRegistryOver(guard: Guard, outcome: ToolOutcome): ToolRegistry {
  const descriptor: ToolDescriptor = {
    name: "host_write",
    description: "writes something",
    inputSchema: { type: "object" },
    risk: "write",
  };
  return {
    async descriptors() {
      return [descriptor];
    },
    // Mirrors guard.bind(actions).execute: the ONE place a real dispatch
    // re-enters the guard, exactly like server.ts's boundTools.
    async execute(call: ToolCall, runCtx: RunContext) {
      const decision = await guard.check(call, descriptor, runCtx);
      if (decision.action !== "run") {
        return { status: "pending-approval" as const, approvalId: decision.action === "ask" ? decision.approval.id : "apr_blocked" };
      }
      return outcome;
    },
  };
}

describe("previewApproval prefers previewCheck (genqa defect 1)", () => {
  it("a run verdict: previewCheck is called once (preview) and check is called once (dispatch) — never check twice", async () => {
    const guard = countingGuard("run");
    const registry = boundRegistryOver(guard, { status: "ok", output: { done: true } });
    const descriptor = await registry.descriptors().then((d) => d[0]!);
    const options = { registry, guard, ctx: ctx() };

    const needsApproval = await previewApproval(descriptor, options, {}, { toolCallId: "call_1" });
    expect(needsApproval).toBe(false);
    const outcome = await guardedCall(descriptor, options, {}, { toolCallId: "call_1" });

    expect(outcome).toMatchObject({ status: "ok" });
    expect(guard.previewCalls).toBe(1);
    expect(guard.checkCalls).toBe(1);
  });

  it("falls back to check() when the guard does not implement previewCheck (no regression)", async () => {
    const guard = countingGuard("run");
    delete (guard as { previewCheck?: unknown }).previewCheck;
    const registry = boundRegistryOver(guard, { status: "ok", output: { done: true } });
    const descriptor = await registry.descriptors().then((d) => d[0]!);
    const options = { registry, guard, ctx: ctx() };

    await previewApproval(descriptor, options, {}, { toolCallId: "call_1" });
    await guardedCall(descriptor, options, {}, { toolCallId: "call_1" });

    expect(guard.checkCalls).toBe(2);
  });
});
