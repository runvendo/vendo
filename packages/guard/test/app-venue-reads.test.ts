import { describe, expect, it } from "vitest";
import { createGuard, vendoAutoJudge } from "../src/index.js";
import { createMemoryStore } from "./fixtures/memory-store.js";
import { asLanguageModel, scriptedJudgeModel, throwingJudgeModel } from "./fixtures/scripted-judge-model.js";
import { call, context, descriptor, FixtureTools } from "./fixtures/tools.js";

/**
 * Re-gate 2026-07-26 finding 2: reads invoked from the APP venue render UI —
 * query resolution and island tools consume the outcome at render time, and a
 * parked read query is never resumed (apps call.ts resumes only mutating
 * actions). An "ask" ruling on a present app-venue read is therefore a
 * permanently empty surface plus a dead approval card. The heuristic deciders
 * (judge, call-rate breaker) must never park such a read; deliberate postures
 * (policy rules, host policy code, confirmEach descriptors, the away downgrade)
 * keep their ask.
 */
describe("app-venue reads are never parked by heuristic deciders", () => {
  const appCtx = context({ venue: "app", appId: "app_1" });

  it("judge 'ask' on a present app-venue READ coerces to run", async () => {
    const guard = createGuard({
      store: createMemoryStore(),
      judge: vendoAutoJudge({
        model: asLanguageModel(scriptedJudgeModel({ action: "ask", rationale: "hesitant about this read" })),
      }),
    });
    const decision = await guard.check(call("host_read"), descriptor("read"), appCtx);
    expect(decision).toMatchObject({ action: "run", decidedBy: "judge" });
  });

  it("judge failure on a present app-venue READ runs instead of failing closed to ask", async () => {
    const guard = createGuard({
      store: createMemoryStore(),
      judge: vendoAutoJudge({ model: asLanguageModel(throwingJudgeModel("provider offline")) }),
    });
    const decision = await guard.check(call("host_read"), descriptor("read"), appCtx);
    expect(decision).toMatchObject({ action: "run", decidedBy: "judge" });
  });

  it("judge 'ask' on a MUTATING app-venue tool still parks (regression)", async () => {
    const guard = createGuard({
      store: createMemoryStore(),
      judge: vendoAutoJudge({
        model: asLanguageModel(scriptedJudgeModel(
          { action: "ask", rationale: "confirm this write" },
          { action: "ask", rationale: "confirm this destruction" },
        )),
      }),
    });
    await expect(
      guard.check(call("host_write"), descriptor("write"), appCtx),
    ).resolves.toMatchObject({ action: "ask", decidedBy: "judge" });
    await expect(
      guard.check(call("host_destructive"), descriptor("destructive"), appCtx),
    ).resolves.toMatchObject({ action: "ask", decidedBy: "judge" });
  });

  it("judge 'ask' on a chat-venue read still parks", async () => {
    const guard = createGuard({
      store: createMemoryStore(),
      judge: vendoAutoJudge({
        model: asLanguageModel(scriptedJudgeModel({ action: "ask", rationale: "confirm this read" })),
      }),
    });
    const decision = await guard.check(call("host_read"), descriptor("read"), context());
    expect(decision).toMatchObject({ action: "ask", decidedBy: "judge" });
  });

  it("judge 'block' on an app-venue read still blocks (run/block stay available)", async () => {
    const guard = createGuard({
      store: createMemoryStore(),
      judge: vendoAutoJudge({
        model: asLanguageModel(scriptedJudgeModel({ action: "block", rationale: "policy violation" })),
      }),
    });
    const decision = await guard.check(call("host_read"), descriptor("read"), appCtx);
    expect(decision).toMatchObject({ action: "block", decidedBy: "judge" });
  });

  it("call-rate breaker does not park present app-venue reads", async () => {
    const guard = createGuard({ store: createMemoryStore(), breakers: { maxCallsPerMinute: 1 } });
    const bound = guard.bind(new FixtureTools());
    await expect(bound.execute(call("host_read", {}, "call_1"), appCtx)).resolves.toMatchObject({ status: "ok" });
    // The second call in the window would trip the breaker; a read from the
    // app venue runs anyway (the call still counts toward the window).
    await expect(bound.execute(call("host_read", {}, "call_2"), appCtx)).resolves.toMatchObject({ status: "ok" });
  });

  it("call-rate breaker still parks app-venue WRITES and chat-venue reads (regression)", async () => {
    const store = createMemoryStore();
    const guard = createGuard({ store, breakers: { maxCallsPerMinute: 1 } });
    const bound = guard.bind(new FixtureTools());
    await expect(bound.execute(call("host_read", {}, "call_1"), appCtx)).resolves.toMatchObject({ status: "ok" });
    await expect(bound.execute(call("host_write", {}, "call_2"), appCtx)).resolves.toMatchObject({
      status: "pending-approval",
    });
    await expect(bound.execute(call("host_read", {}, "call_3"), context())).resolves.toMatchObject({
      status: "pending-approval",
    });
  });

  it("an explicit policy RULE asking on reads keeps its ask in the app venue (host-authored posture)", async () => {
    const guard = createGuard({
      store: createMemoryStore(),
      policy: { rules: [{ match: { risk: "read" }, action: "ask" }] },
    });
    const decision = await guard.check(call("host_read"), descriptor("read"), appCtx);
    expect(decision).toMatchObject({ action: "ask", decidedBy: "rule" });
  });

  it("a confirmEach read still asks in the app venue (05 §2: nothing suppresses confirmEach)", async () => {
    const guard = createGuard({ store: createMemoryStore() });
    const confirmEach = descriptor("read", { name: "host_confirm_each_read", confirmEach: true });
    const decision = await guard.check(call("host_confirm_each_read"), confirmEach, appCtx);
    expect(decision).toMatchObject({ action: "ask", decidedBy: "confirmEach" });
  });

  it("away app-venue reads still park (05 §6 downgrade unaffected)", async () => {
    const guard = createGuard({
      store: createMemoryStore(),
      judge: vendoAutoJudge({
        model: asLanguageModel(scriptedJudgeModel({ action: "run", rationale: "routine read" })),
      }),
    });
    const decision = await guard.check(
      call("host_read"),
      descriptor("read"),
      context({ venue: "app", appId: "app_1", presence: "away" }),
    );
    expect(decision).toMatchObject({ action: "ask", decidedBy: "default" });
  });
});
