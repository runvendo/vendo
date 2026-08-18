import { describe, expect, it } from "vitest";
import { createGuard } from "../../src/guard.js";
import type { Judge } from "../../src/types.js";
import { createMemoryStore } from "../fixtures/memory-store.js";
import { FixtureTools, alice, call, context, descriptor } from "../fixtures/tools.js";

// Latency Lane A §1: `previewCheck` and the dispatch that follows it are ONE
// logical call, and the rules/grants/judge pipeline now runs once for it — the
// preview's verdict is what `bind().execute` dispatches on. Everything below
// pins the boundaries that reuse must NOT move: the freeze, the breakers, THE
// LAW's unattended gate, and the single-use human yes.

/** A judge that counts, so "the pipeline ran once" is observable rather than
 *  asserted. Every real evaluation reaches it: no rules, no grants. */
function countingJudge(action: "run" | "ask" | "block" = "run"): Judge & { decisions: number } {
  return {
    decisions: 0,
    async decide(this: { decisions: number }) {
      this.decisions += 1;
      return { action, rationale: "counted" };
    },
  } as Judge & { decisions: number };
}

const write = descriptor("write");

describe("the previewed verdict is the one the dispatch runs on", () => {
  it("evaluates the pipeline ONCE for a preview and the dispatch that follows it", async () => {
    const judge = countingJudge("run");
    const guard = createGuard({ store: createMemoryStore(), judge });
    const tools = new FixtureTools();
    const c = call(write.name, { value: 1 }, "call_once");

    await expect(guard.previewCheck!(c, write, context())).resolves.toMatchObject({ action: "run" });
    await expect(guard.bind(tools).execute(c, context())).resolves.toMatchObject({ status: "ok" });

    expect(judge.decisions).toBe(1);
    expect(tools.executions).toHaveLength(1);
  });

  it("still spends the write budget exactly once, so the run's budget is neither halved nor doubled", async () => {
    const guard = createGuard({
      store: createMemoryStore(),
      breakers: { maxWritesPerRun: 2, maxCallsPerMinute: 1000 },
      policy: { rules: [{ match: {}, action: "run" }] },
    });
    const tools = new FixtureTools();
    const bound = guard.bind(tools);
    const ctx = context({ trigger: { runId: "run_budget", kind: "schedule" } });

    for (const id of ["budget_1", "budget_2"]) {
      const c = call(write.name, { value: 1 }, id);
      await expect(guard.previewCheck!(c, write, ctx)).resolves.toMatchObject({ action: "run" });
      await expect(bound.execute(c, ctx)).resolves.toMatchObject({ status: "ok" });
    }
    // The third write is the first one over a budget of 2.
    const over = call(write.name, { value: 1 }, "budget_3");
    await expect(guard.previewCheck!(over, write, ctx)).resolves.toMatchObject({
      action: "ask",
      decidedBy: "breaker",
    });
  });

  it("is spent by ONE dispatch — a repeat of the same call is decided fresh", async () => {
    const judge = countingJudge("run");
    const guard = createGuard({ store: createMemoryStore(), judge });
    const bound = guard.bind(new FixtureTools());
    const c = call(write.name, { value: 1 }, "call_repeat");

    await guard.previewCheck!(c, write, context());
    await expect(bound.execute(c, context())).resolves.toMatchObject({ status: "ok" });
    expect(judge.decisions).toBe(1);

    // No second preview: the same id must NOT read the spent verdict.
    await expect(bound.execute(c, context())).resolves.toMatchObject({ status: "ok" });
    expect(judge.decisions).toBe(2);
  });

  it("never answers for a DIFFERENT call — same id, different arguments is decided fresh", async () => {
    const judge = countingJudge("run");
    const guard = createGuard({ store: createMemoryStore(), judge });
    const bound = guard.bind(new FixtureTools());

    await guard.previewCheck!(call(write.name, { value: 1 }, "call_bleed"), write, context());
    await expect(bound.execute(call(write.name, { value: 2 }, "call_bleed"), context()))
      .resolves.toMatchObject({ status: "ok" });

    expect(judge.decisions).toBe(2);
  });

  it("never answers for another SUBJECT's call", async () => {
    const judge = countingJudge("run");
    const guard = createGuard({ store: createMemoryStore(), judge });
    const bound = guard.bind(new FixtureTools());
    const c = call(write.name, { value: 1 }, "call_subject");

    await guard.previewCheck!(c, write, context());
    await expect(bound.execute(c, context({ principal: { kind: "user", subject: "user_bob" } })))
      .resolves.toMatchObject({ status: "ok" });

    expect(judge.decisions).toBe(2);
  });
});

describe("what reuse may never move", () => {
  it("a freeze landing between the preview and the dispatch still blocks the call", async () => {
    const guard = createGuard({
      store: createMemoryStore(),
      policy: { rules: [{ match: {}, action: "run" }] },
    });
    const tools = new FixtureTools();
    const c = call(write.name, { value: 1 }, "call_frozen");

    await expect(guard.previewCheck!(c, write, context())).resolves.toMatchObject({ action: "run" });
    await guard.freeze("ops");

    await expect(guard.bind(tools).execute(c, context())).resolves.toMatchObject({ status: "blocked" });
    expect(tools.executions).toHaveLength(0);
  });

  it("a write budget exhausted between the preview and the dispatch parks the call", async () => {
    const guard = createGuard({
      store: createMemoryStore(),
      breakers: { maxWritesPerRun: 1, maxCallsPerMinute: 1000 },
      policy: { rules: [{ match: {}, action: "run" }] },
    });
    const tools = new FixtureTools();
    const ctx = context({ trigger: { runId: "run_raced_budget", kind: "schedule" } });
    const c = call(write.name, { value: 1 }, "call_raced");

    await expect(guard.previewCheck!(c, write, ctx)).resolves.toMatchObject({ action: "run" });
    // Another call spends the whole budget while this one sits previewed.
    await expect(guard.check(call(write.name, { value: 9 }, "call_other"), write, ctx))
      .resolves.toMatchObject({ action: "run" });

    await expect(guard.bind(tools).execute(c, ctx)).resolves.toMatchObject({
      status: "pending-approval",
    });
    expect(tools.executions).toHaveLength(0);
  });

  it("a policy that says block is still a block, audited once rather than twice", async () => {
    const guard = createGuard({
      store: createMemoryStore(),
      policy: { rules: [{ match: {}, action: "block", note: "no" }] },
    });
    const tools = new FixtureTools();
    const c = call(write.name, { value: 1 }, "call_blocked");

    await expect(guard.previewCheck!(c, write, context())).resolves.toMatchObject({ action: "block" });
    await expect(guard.bind(tools).execute(c, context())).resolves.toMatchObject({ status: "blocked" });

    expect(tools.executions).toHaveLength(0);
    const { events } = await guard.audit.query({ principal: alice });
    expect(events.filter((event) => event.kind === "policy-decision")).toHaveLength(1);
  });
});

describe("the human's yes is still single-use", () => {
  it("parks, honors the approval granted after the preview, and asks again for a second run", async () => {
    const guard = createGuard({
      store: createMemoryStore(),
      policy: { rules: [{ match: {}, action: "ask" }] },
    });
    const tools = new FixtureTools();
    const bound = guard.bind(tools);
    const c = call(write.name, { value: 1 }, "call_tap");

    const previewed = await guard.previewCheck!(c, write, context());
    if (previewed.action !== "ask") throw new Error("expected the preview to park");
    await guard.approvals.decide(previewed.approval.id, { approve: true }, alice);

    await expect(bound.execute(c, context())).resolves.toMatchObject({ status: "ok" });
    expect(tools.executions).toHaveLength(1);

    // The tap authorized ONE call. The next one asks again.
    await expect(bound.execute(c, context())).resolves.toMatchObject({ status: "pending-approval" });
    expect(tools.executions).toHaveLength(1);
  });

  it("a declined approval never runs the tool", async () => {
    const guard = createGuard({
      store: createMemoryStore(),
      policy: { rules: [{ match: {}, action: "ask" }] },
    });
    const tools = new FixtureTools();
    const c = call(write.name, { value: 1 }, "call_declined");

    const previewed = await guard.previewCheck!(c, write, context());
    if (previewed.action !== "ask") throw new Error("expected the preview to park");
    await guard.approvals.decide(previewed.approval.id, { approve: false }, alice);

    await expect(guard.bind(tools).execute(c, context())).resolves.toMatchObject({ status: "blocked" });
    expect(tools.executions).toHaveLength(0);
  });
});
