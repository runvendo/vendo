import { describe, expect, it } from "vitest";
import { createGuard } from "../../src/index.js";
import { createMemoryStore } from "../fixtures/memory-store.js";
import { FixtureTools, alice, call, context, descriptor, seedGrant } from "../fixtures/tools.js";

// 05 §6 / 07 §3: away runs hold only grants captured while present AND bound to
// the running app with source "automation". Chat-minted grants never authorize
// unattended execution, and app binding must match exactly.
describe("chat grants never authorize away runs (05 §6)", () => {
  const awayCtx = (appId = "app_1") =>
    context({
      venue: "automation",
      presence: "away",
      appId,
      trigger: { runId: "run_away", kind: "host-event" },
    });

  it("a present-minted chat grant does not authorize the away run of the same tool", async () => {
    const store = createMemoryStore();
    const d = descriptor("write", { name: "host_chatgrant" });
    const guard = createGuard({
      store,
      policy: { rules: [{ match: { tool: d.name }, action: "ask" }] },
    });
    const tools = new FixtureTools([d]);
    const bound = guard.bind(tools);

    // Mint a chat grant the honest way: park a present app call, approve with
    // remember. The minted grant is app-bound (app_1) but source "chat".
    const presentCtx = context({ venue: "app", presence: "present", appId: "app_1" });
    const parked = await bound.execute(call(d.name, { amount: 1 }, "call_mint"), presentCtx);
    if (parked.status !== "pending-approval") throw new Error("expected the present call to park");
    await guard.approvals.decide(
      parked.approvalId,
      { approve: true, remember: { scope: { kind: "tool" }, duration: "standing" } },
      alice,
    );
    const [minted] = await guard.grants.list(alice);
    expect(minted).toMatchObject({ appId: "app_1", source: "chat" });

    // Now away in the SAME app: the chat grant must not authorize — it parks.
    await expect(bound.execute(call(d.name, { amount: 1 }, "call_away"), awayCtx())).resolves.toMatchObject({
      status: "pending-approval",
    });
    // Nothing executed: the present mint parked (interactive), and the away call
    // parks because the chat-sourced grant carries no away authority.
    expect(tools.executions).toHaveLength(0);
  });

  it("an automation-source app-bound grant does authorize the away run", async () => {
    const store = createMemoryStore();
    const d = descriptor("write", { name: "host_autograent" });
    await seedGrant(store, { descriptor: d, appId: "app_1", source: "automation" });
    const guard = createGuard({ store });
    const tools = new FixtureTools([d]);
    const bound = guard.bind(tools);

    await expect(
      guard.check(call(d.name, { amount: 1 }, "call_ok"), d, awayCtx()),
    ).resolves.toMatchObject({ action: "run", decidedBy: "grant" });
    await expect(bound.execute(call(d.name, { amount: 1 }, "call_ok"), awayCtx())).resolves.toMatchObject({
      status: "ok",
    });
    expect(tools.executions).toHaveLength(1);
  });

  it("a standing chat grant bound to a different app parks the away run", async () => {
    const store = createMemoryStore();
    const d = descriptor("write", { name: "host_otherapp" });
    // Even were this source "automation", the appId mismatch alone must park it.
    await seedGrant(store, { descriptor: d, appId: "app_other", source: "chat" });
    const guard = createGuard({ store });
    const tools = new FixtureTools([d]);
    const bound = guard.bind(tools);

    await expect(
      guard.check(call(d.name, { amount: 1 }, "call_diff"), d, awayCtx("app_1")),
    ).resolves.toMatchObject({ action: "ask", decidedBy: "default" });
    await expect(bound.execute(call(d.name, { amount: 1 }, "call_diff"), awayCtx("app_1"))).resolves.toMatchObject({
      status: "pending-approval",
    });
    expect(tools.executions).toHaveLength(0);
  });
});
