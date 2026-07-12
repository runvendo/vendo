import type { ApprovalId } from "@vendoai/core";
import { describe, expect, it } from "vitest";
import { createGuard } from "../../src/index.js";
import { createMemoryStore } from "../fixtures/memory-store.js";
import { FixtureTools, alice, bob, call, context } from "../fixtures/tools.js";

// Approvals are single-use and pinned to the exact call AND the exact context
// the user saw. They never replay across uses, across present→away, or across
// subjects.
describe("approval replay is single-use and context-pinned", () => {
  it("resumes an approved non-critical call once, then parks the identical replay", async () => {
    const store = createMemoryStore();
    const guard = createGuard({ store, policy: { rules: [{ match: {}, action: "ask" }] } });
    const tools = new FixtureTools();
    const bound = guard.bind(tools);
    const c = call("host_write", { amount: 5 }, "call_replay");

    const parked = await bound.execute(c, context());
    if (parked.status !== "pending-approval") throw new Error("expected the call to park");
    await guard.approvals.decide(parked.approvalId, { approve: true }, alice);

    await expect(bound.execute(c, context())).resolves.toMatchObject({ status: "ok" });
    expect(tools.executions).toHaveLength(1);
    // Replay of the exact same ToolCall is refused — the approval was consumed.
    await expect(bound.execute(c, context())).resolves.toMatchObject({ status: "pending-approval" });
    expect(tools.executions).toHaveLength(1);
  });

  it("a present-chat approval cannot satisfy the same logical call in an away app ctx", async () => {
    const store = createMemoryStore();
    const guard = createGuard({ store, policy: { rules: [{ match: {}, action: "ask" }] } });
    const tools = new FixtureTools();
    const bound = guard.bind(tools);
    const c = call("host_write", { amount: 5 }, "call_ctx");

    const parked = await bound.execute(c, context({ venue: "chat", presence: "present" }));
    if (parked.status !== "pending-approval") throw new Error("expected the call to park");
    await guard.approvals.decide(parked.approvalId, { approve: true }, alice);

    // Same subject + call id + args, but now away in an app: the present-context
    // approval must not authorize away execution.
    const awayCtx = context({
      venue: "automation",
      presence: "away",
      appId: "app_1",
      trigger: { runId: "run_ctx", kind: "host-event" },
    });
    await expect(bound.execute(c, awayCtx)).resolves.toMatchObject({ status: "pending-approval" });
    expect(tools.executions).toHaveLength(0);

    // The genuine present resume still runs exactly once.
    await expect(bound.execute(c, context({ venue: "chat", presence: "present" }))).resolves.toMatchObject({
      status: "ok",
    });
    expect(tools.executions).toHaveLength(1);
  });

  it("refuses a cross-subject decision (principal B cannot decide A's approval)", async () => {
    const store = createMemoryStore();
    const guard = createGuard({ store, policy: { rules: [{ match: {}, action: "ask" }] } });
    const bound = guard.bind(new FixtureTools());
    const parked = await bound.execute(call("host_write", { amount: 5 }, "call_cross"), context());
    if (parked.status !== "pending-approval") throw new Error("expected the call to park");

    await expect(
      guard.approvals.decide(parked.approvalId as ApprovalId, { approve: true }, bob),
    ).rejects.toMatchObject({ code: "not-found" });

    // Alice's approval is untouched and still pending.
    const pending = await guard.approvals.pending(alice);
    expect(pending.map((request) => request.id)).toContain(parked.approvalId);
  });
});
