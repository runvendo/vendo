import type { RunContext, ToolCall, ToolDescriptor, ToolOutcome } from "@vendoai/core";
import { describe, expect, it } from "vitest";
import { createGuard } from "../../src/guard.js";
import type { Judge, PolicyRule, VendoGuard } from "../../src/types.js";
import { createMemoryStore } from "../fixtures/memory-store.js";
import { alice, call, context, descriptor, FixtureTools } from "../fixtures/tools.js";

// ROUND 2 — independent re-check of the fixes on top of 3cf5916e. Every case
// below is written to run UNCHANGED on origin/main (3d85eb548) as well, so
// "regression" versus "pre-existing" is answered by the same file on both
// commits rather than by argument.

const write = descriptor("write");
const ungraded = descriptor("ungraded", { name: "host_ungraded" });
const read = descriptor("read");

/** A judge that refuses once the named tool is already on the trail. That IS
 *  the judge's contract — it decides on `recent` — so "which pass asks it" is
 *  exactly what decides whether the second call of a step can be caught. */
function judgeAfter(tool: string): Judge {
  return {
    async decide({ recent }) {
      const landed = recent.some((event) => event.kind === "tool-call" && event.tool === tool);
      return landed
        ? { action: "block", rationale: `${tool} already ran in this run` }
        : { action: "run", rationale: "clear" };
    },
  };
}

/** ONE harness tool call, exactly as `turn-tools.ts` spells it: preview, and if
 *  the preview did not park, dispatch. Both commits run this identically —
 *  `previewCheck` predates the reuse. */
function oneCall(
  guard: VendoGuard,
  bound: { execute: (c: ToolCall, ctx: RunContext) => Promise<ToolOutcome> },
  c: ToolCall,
  d: ToolDescriptor,
  ctx: RunContext,
) {
  return async (): Promise<ToolOutcome> => {
    const decision = guard.previewCheck === undefined
      ? await guard.check(c, d, ctx)
      : await guard.previewCheck(c, d, ctx);
    if (decision.action === "ask") return { status: "pending-approval", approvalId: decision.approval.id };
    return await bound.execute(c, ctx);
  };
}

describe("TASK 1 — can the judge still catch the second call of a step?", () => {
  it("SEQUENCED (preview A, preview B, dispatch A, dispatch B): the second write is blocked", async () => {
    const guard = createGuard({ store: createMemoryStore(), judge: judgeAfter(write.name) });
    const tools = new FixtureTools();
    const bound = guard.bind(tools);
    const a = call(write.name, { value: 1 }, "seq_a");
    const b = call(write.name, { value: 2 }, "seq_b");

    await guard.previewCheck!(a, write, context());
    await guard.previewCheck!(b, write, context());
    await expect(bound.execute(a, context())).resolves.toMatchObject({ status: "ok" });
    await expect(bound.execute(b, context())).resolves.toMatchObject({ status: "blocked" });
    expect(tools.executions).toHaveLength(1);
  });

  // KNOWN GAP, pre-existing and filed, not a regression of the preview reuse:
  // under true simultaneity B reads its verdict before A's row is on the trail,
  // so no invalidation can reach it. Verified by running this very test against
  // `origin/main`'s `guard.ts` (3d85eb548): both calls run there too, same
  // message. `it.fails` keeps the assertion verbatim and turns green into the
  // alarm — the day dispatch serializes per subject, this test demands attention.
  it.fails("SIMULTANEOUS (Promise.all over two whole tool calls): the second write is blocked", async () => {
    const guard = createGuard({ store: createMemoryStore(), judge: judgeAfter(write.name) });
    const tools = new FixtureTools();
    const bound = guard.bind(tools);
    const a = call(write.name, { value: 1 }, "par_a");
    const b = call(write.name, { value: 2 }, "par_b");

    await Promise.all([
      oneCall(guard, bound, a, write, context())(),
      oneCall(guard, bound, b, write, context())(),
    ]);
    // Whichever landed first, the judge's whole point is that the other one
    // does not also run.
    expect(tools.executions).toHaveLength(1);
  });
});

describe("ATTACK — the write-invalidation covers only two of the four risk grades", () => {
  it("an UNGRADED call landing (use_service_tool's own grade) does not void the run's other verdicts", async () => {
    const guard = createGuard({ store: createMemoryStore(), judge: judgeAfter(ungraded.name) });
    const tools = new FixtureTools([ungraded, write]);
    const bound = guard.bind(tools);
    const first = call(ungraded.name, { value: 1 }, "ungraded_a");
    const second = call(write.name, { value: 2 }, "ungraded_b");

    await expect(guard.previewCheck!(first, ungraded, context())).resolves.toMatchObject({ action: "run" });
    await expect(guard.previewCheck!(second, write, context())).resolves.toMatchObject({ action: "run" });

    await expect(bound.execute(first, context())).resolves.toMatchObject({ status: "ok" });
    // The connector call is on the trail now. The judge refuses what follows it.
    await expect(bound.execute(second, context())).resolves.toMatchObject({ status: "blocked" });
    expect(tools.executions).toHaveLength(1);
  });

  it("a READ landing does not void the run's other verdicts", async () => {
    const guard = createGuard({ store: createMemoryStore(), judge: judgeAfter(read.name) });
    const tools = new FixtureTools([read, write]);
    const bound = guard.bind(tools);
    const first = call(read.name, { value: 1 }, "read_a");
    const second = call(write.name, { value: 2 }, "read_b");

    await guard.previewCheck!(first, read, context());
    await guard.previewCheck!(second, write, context());

    await expect(bound.execute(first, context())).resolves.toMatchObject({ status: "ok" });
    await expect(bound.execute(second, context())).resolves.toMatchObject({ status: "blocked" });
    expect(tools.executions).toHaveLength(1);
  });
});

describe("ATTACK — the write-invalidation is scoped to the run, the judge's trail is scoped to the SUBJECT", () => {
  it("a write landing in one session does not void the same person's other session's verdict", async () => {
    const guard = createGuard({ store: createMemoryStore(), judge: judgeAfter(write.name) });
    const tools = new FixtureTools();
    const bound = guard.bind(tools);
    const mine = context();
    const other = context({ sessionId: "session_other" });
    const a = call(write.name, { value: 1 }, "xsession_a");
    const b = call(write.name, { value: 2 }, "xsession_b");

    await guard.previewCheck!(a, write, mine);
    await guard.previewCheck!(b, write, other);

    await expect(bound.execute(a, mine)).resolves.toMatchObject({ status: "ok" });
    // `#queryAudit` filters by PRINCIPAL, not by run — the other session's judge
    // reads a trail that now holds this write, and refuses.
    await expect(bound.execute(b, other)).resolves.toMatchObject({ status: "blocked" });
    expect(tools.executions).toHaveLength(1);
  });
});

describe("ATTACK — the org re-check's consumed-approval carve-out", () => {
  it("an org BLOCK adopted while a tapped call sits previewed", async () => {
    let orgRules: PolicyRule[] = [];
    const guard = createGuard({
      store: createMemoryStore(),
      policy: { rules: [{ match: {}, action: "ask" }] },
      orgPolicy: async () => orgRules,
    });
    const tools = new FixtureTools();
    const bound = guard.bind(tools);
    const c = call(write.name, { value: 1 }, "org_carveout");

    const parked = await guard.previewCheck!(c, write, context());
    if (parked.action !== "ask") throw new Error("expected the preview to park");
    await guard.approvals.decide(parked.approval.id, { approve: true }, alice);
    // The tapped call is previewed again — a "run" carried by the consumed
    // approval, which is the shape the carve-out exempts.
    await expect(guard.previewCheck!(c, write, context()))
      .resolves.toMatchObject({ action: "run", decidedBy: "grant" });

    orgRules = [{ match: {}, action: "block", note: "org forbids this tool" }];
    // Same expectation main holds to: the consumed-approval carve-out in
    // `#checkWithMetadata` already skips `block`, so this documents the
    // BASELINE, not a demand.
    await expect(bound.execute(c, context())).resolves.toMatchObject({ status: "ok" });
  });
});

describe("CONTROL — the four fixes, attacked again", () => {
  it("F4: a freeze between the preview and the dispatch leaves the tap unspent", async () => {
    const guard = createGuard({
      store: createMemoryStore(),
      policy: { rules: [{ match: {}, action: "ask" }] },
    });
    const tools = new FixtureTools();
    const bound = guard.bind(tools);
    const c = call(write.name, { value: 1 }, "f4_recheck");

    const parked = await guard.previewCheck!(c, write, context());
    if (parked.action !== "ask") throw new Error("expected the preview to park");
    await guard.approvals.decide(parked.approval.id, { approve: true }, alice);
    await guard.previewCheck!(c, write, context());

    await guard.freeze("ops");
    await expect(bound.execute(c, context())).resolves.toMatchObject({ status: "blocked" });
    await guard.unfreeze("ops");
    await expect(bound.execute(c, context())).resolves.toMatchObject({ status: "ok" });
    expect(tools.executions).toHaveLength(1);
  });

  it("F4: a freeze between the preview and the dispatch spends no write budget either", async () => {
    const guard = createGuard({
      store: createMemoryStore(),
      breakers: { maxWritesPerRun: 1, maxCallsPerMinute: 1000 },
      policy: { rules: [{ match: {}, action: "run" }] },
    });
    const tools = new FixtureTools();
    const bound = guard.bind(tools);
    const ctx = context({ trigger: { runId: "run_f4_budget", kind: "schedule" } });
    const blocked = call(write.name, { value: 1 }, "f4_budget_a");
    const later = call(write.name, { value: 2 }, "f4_budget_b");

    await guard.previewCheck!(blocked, write, ctx);
    await guard.freeze("ops");
    await expect(bound.execute(blocked, ctx)).resolves.toMatchObject({ status: "blocked" });
    await guard.unfreeze("ops");

    // The frozen call ran nothing, so the run's one write is still unspent.
    await expect(guard.previewCheck!(later, write, ctx)).resolves.toMatchObject({ action: "run" });
    await expect(bound.execute(later, ctx)).resolves.toMatchObject({ status: "ok" });
    expect(tools.executions).toHaveLength(1);
  });

  it("F4: THE LAW refusing after the commit still burns no tap (the replay is exempt from it)", async () => {
    // An unattended run whose call was tapped by a person: the replay carve-out
    // in `bind()` exempts it, so the claim taken in `#commitPreviewed` is never
    // followed by a refusal. Identical on both commits — the point is that the
    // reorder did not open a "claimed then refused" path.
    const guard = createGuard({
      store: createMemoryStore(),
      policy: { rules: [{ match: {}, action: "ask" }] },
    });
    const tool = descriptor("destructive", { name: "host_law_replay" });
    const tools = new FixtureTools([tool]);
    const bound = guard.bind(tools);
    const ctx = context({
      venue: "automation",
      presence: "away",
      trigger: { runId: "run_law", kind: "schedule", automationId: "atm_1" },
    });
    const c = call(tool.name, { value: 1 }, "law_replay");

    const parked = await guard.previewCheck!(c, tool, ctx);
    if (parked.action !== "ask") throw new Error("expected the preview to park");
    await guard.approvals.decide(parked.approval.id, { approve: true }, alice);
    await guard.previewCheck!(c, tool, ctx);

    await expect(bound.execute(c, ctx)).resolves.toMatchObject({ status: "ok" });
    expect(tools.executions).toHaveLength(1);
  });

  it("F1: an org ASK adopted between the preview and the dispatch parks a rule-authorized run", async () => {
    let orgRules: PolicyRule[] = [];
    const guard = createGuard({
      store: createMemoryStore(),
      policy: { rules: [{ match: {}, action: "run" }] },
      orgPolicy: async () => orgRules,
    });
    const tools = new FixtureTools();
    const c = call(write.name, { value: 1 }, "f1_ask");

    await guard.previewCheck!(c, write, context());
    orgRules = [{ match: {}, action: "ask" }];

    await expect(guard.bind(tools).execute(c, context())).resolves.toMatchObject({
      status: "pending-approval",
    });
    expect(tools.executions).toHaveLength(0);
  });

  it("F1: an org rule that does NOT outrank the verdict leaves the reuse alone", async () => {
    const judge: Judge & { decisions: number } = {
      decisions: 0,
      async decide(this: { decisions: number }) {
        this.decisions += 1;
        return { action: "run", rationale: "counted" };
      },
    } as Judge & { decisions: number };
    const guard = createGuard({
      store: createMemoryStore(),
      judge,
      orgPolicy: async () => [{ match: { risk: "read" }, action: "block" }],
    });
    const c = call(write.name, { value: 1 }, "f1_nomatch");

    await guard.previewCheck!(c, write, context());
    await expect(guard.bind(new FixtureTools()).execute(c, context())).resolves.toMatchObject({
      status: "ok",
    });
    expect(judge.decisions).toBe(1);
  });

  it("F3: a grade that moves the OTHER way (destructive → read) also voids the verdict", async () => {
    let resolutions = 0;
    const tool = descriptor("write", { name: "host_movable" });
    const guard = createGuard({
      store: createMemoryStore(),
      policy: { rules: [{ match: {}, action: "run" }] },
      resolveRisk: async () => {
        resolutions += 1;
        return resolutions === 1 ? "destructive" : "read";
      },
    });
    const tools = new FixtureTools([tool]);
    const c = call(tool.name, { value: 1 }, "f3_reverse");

    await guard.previewCheck!(c, tool, context());
    await expect(guard.bind(tools).execute(c, context())).resolves.toMatchObject({ status: "ok" });
    // Three resolutions means the dispatch re-resolved (2) and then decided
    // fresh (3) — the stale grade never spoke for the call.
    expect(resolutions).toBe(3);
  });
});
