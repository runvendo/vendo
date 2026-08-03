import { describe, expect, it } from "vitest";
import { createGuard } from "../src/index.js";
import { createMemoryStore } from "./fixtures/memory-store.js";
import { FixtureTools, alice, bob, call, context, descriptor, seedGrant } from "./fixtures/tools.js";

/**
 * Risk-grading redesign D3 — `ungraded` is a first-class state that ASKS.
 *
 * This is a GUARD-LEVEL default, not an init-written policy rule: the whole
 * point is that a hand-wired server with no policy config at all still feels
 * the not-knowing, because that is exactly the install where nothing else
 * would. A host that wants these to run says so in writing.
 */
describe("ungraded asks by default (D3)", () => {
  it("asks for an ungraded tool on a guard with NO policy config at all", async () => {
    const guard = createGuard({ store: createMemoryStore() });
    const d = descriptor("ungraded", { name: "host_pay_invoice" });

    await expect(guard.check(call(d.name, { invoiceId: "inv_1" }), d, context())).resolves.toMatchObject({
      action: "ask",
      decidedBy: "default",
    });
  });

  it("still runs a graded write on that same policy-less guard — only the blank state asks", async () => {
    const guard = createGuard({ store: createMemoryStore() });
    const write = descriptor("write");

    await expect(guard.check(call(write.name), write, context())).resolves.toMatchObject({
      action: "run",
      decidedBy: "default",
    });
  });

  it("parks the call end to end rather than executing it", async () => {
    const d = descriptor("ungraded", { name: "host_pay_invoice" });
    const guard = createGuard({ store: createMemoryStore() });
    const tools = new FixtureTools([d]);
    const bound = guard.bind(tools);

    const outcome = await bound.execute(call(d.name, { invoiceId: "inv_1" }, "call_pay"), context());
    expect(outcome).toMatchObject({ status: "pending-approval" });
    expect(tools.executions).toHaveLength(0);
  });

  it("lets a host loosen it consciously, in writing, with a risk:ungraded rule", async () => {
    const guard = createGuard({
      store: createMemoryStore(),
      policy: { rules: [{ match: { risk: "ungraded" }, action: "run", note: "we accept this" }] },
    });
    const d = descriptor("ungraded", { name: "host_pay_invoice" });

    await expect(guard.check(call(d.name), d, context())).resolves.toMatchObject({
      action: "run",
      decidedBy: "rule",
    });
  });

  it("makes every preset treat ungraded exactly as it treats destructive", async () => {
    // The inversion this pins: with `ungraded` falling through to the guard's
    // ask-default, `readonly` — the one posture that BLOCKS a known write —
    // would have offered an approve button for a tool nobody has graded.
    const cases = [
      { preset: "cautious", expected: "ask" },
      { preset: "readonly", expected: "block" },
      { preset: "autopilot", expected: "run" },
    ] as const;
    for (const { preset, expected } of cases) {
      const guard = createGuard({ store: createMemoryStore(), policy: preset });
      const ungraded = descriptor("ungraded");
      const destructive = descriptor("destructive");
      const verdict = await guard.check(call(ungraded.name), ungraded, context());
      expect(verdict, `${preset} on ungraded`).toMatchObject({ action: expected, decidedBy: "rule" });
      // Stated as the rule it comes from: same posture as destructive, always.
      expect((await guard.check(call(destructive.name), destructive, context())).action)
        .toBe(verdict.action);
    }
  });

  it("spends the per-run write budget — an ungraded call is not a free call", async () => {
    const guard = createGuard({
      store: createMemoryStore(),
      // A host that opted into running ungraded still gets the budget.
      policy: { rules: [{ match: { risk: "ungraded" }, action: "run" }] },
      breakers: { maxWritesPerRun: 1, maxCallsPerMinute: 100 },
    });
    const ungraded = descriptor("ungraded");
    const read = descriptor("read");
    const run = context({ trigger: { runId: "run_budget", kind: "schedule" } });

    // Reads are free, as always.
    await expect(guard.check(call(read.name, {}, "r1"), read, run)).resolves.toMatchObject({ action: "run" });
    await expect(guard.check(call(ungraded.name, {}, "u1"), ungraded, run)).resolves.toMatchObject({ action: "run" });
    // The budget is spent: the second ungraded call trips the breaker.
    await expect(guard.check(call(ungraded.name, {}, "u2"), ungraded, run)).resolves.toMatchObject({
      action: "ask",
      decidedBy: "breaker",
    });
  });

  it("keeps a standing grant working for an ungraded tool the user already approved", async () => {
    const store = createMemoryStore();
    const d = descriptor("ungraded", { name: "host_pay_invoice" });
    await seedGrant(store, { descriptor: d });
    const guard = createGuard({ store });

    await expect(guard.check(call(d.name), d, context())).resolves.toMatchObject({
      action: "run",
      decidedBy: "grant",
    });
  });
});

/**
 * Checker round 2, finding A — a no has to STAY no. A caller that re-issues a
 * stable call id (the apps runtime derives a query's id from app+tool+args, so
 * its refetch is byte-identical) would otherwise mint a fresh approval on every
 * retry: deny, reopen, new card, forever.
 */
describe("a denial answers the identical re-issue instead of re-parking", () => {
  const ungraded = descriptor("ungraded", { name: "host_pay_invoice" });
  const stable = () => call(ungraded.name, { invoiceId: "inv_1" }, "call_stable");

  it("blocks the re-issue, attributes it to the person, and mints no second card", async () => {
    const store = createMemoryStore();
    const guard = createGuard({ store });
    const tools = new FixtureTools([ungraded]);
    const bound = guard.bind(tools);

    const parked = await bound.execute(stable(), context());
    if (parked.status !== "pending-approval") throw new Error("expected the ungraded call to park");
    await guard.approvals.decide(parked.approvalId, { approve: false }, alice);

    await expect(guard.check(stable(), ungraded, context())).resolves.toMatchObject({
      action: "block",
      decidedBy: "denied",
    });
    expect(await bound.execute(stable(), context())).toMatchObject({ status: "blocked" });
    expect(await bound.execute(stable(), context())).toMatchObject({ status: "blocked" });
    expect(await guard.approvals.pending(alice)).toHaveLength(0);
    expect(tools.executions).toHaveLength(0);
  });

  it("keeps standing until the QUESTION changes — different inputs still get their own ask", async () => {
    const store = createMemoryStore();
    const guard = createGuard({ store });
    const bound = guard.bind(new FixtureTools([ungraded]));

    const parked = await bound.execute(stable(), context());
    if (parked.status !== "pending-approval") throw new Error("expected the ungraded call to park");
    await guard.approvals.decide(parked.approvalId, { approve: false }, alice);

    const other = call(ungraded.name, { invoiceId: "inv_2" }, "call_other");
    expect(await bound.execute(other, context())).toMatchObject({ status: "pending-approval" });
  });

  it("does not leak across subjects — Bob's call is never answered by Alice's no", async () => {
    const store = createMemoryStore();
    const guard = createGuard({ store });
    const bound = guard.bind(new FixtureTools([ungraded]));

    const parked = await bound.execute(stable(), context());
    if (parked.status !== "pending-approval") throw new Error("expected the ungraded call to park");
    await guard.approvals.decide(parked.approvalId, { approve: false }, alice);

    expect(await bound.execute(stable(), context({ principal: bob }))).toMatchObject({
      status: "pending-approval",
    });
  });
});

/**
 * Checker round 2, finding C — a DELIBERATE choice, pinned so it never becomes
 * an accident: an approved replay is scoped to the SUBJECT, not the session.
 * One person approving on their phone and seeing the result render on their
 * laptop is the same person answering the same question.
 */
describe("an approved replay crosses the same user's sessions on purpose", () => {
  it("lets a laptop session spend an approval the phone session parked — exactly once", async () => {
    const store = createMemoryStore();
    const guard = createGuard({ store });
    const ungraded = descriptor("ungraded", { name: "host_spending" });
    const tools = new FixtureTools([ungraded]);
    const bound = guard.bind(tools);
    const phone = context({ sessionId: "session_phone" });
    const laptop = context({ sessionId: "session_laptop" });
    const query = () => call(ungraded.name, { window: "30d" }, "call_q_stable");

    const parked = await bound.execute(query(), phone);
    if (parked.status !== "pending-approval") throw new Error("expected the query to park");
    await guard.approvals.decide(parked.approvalId, { approve: true }, alice);

    // The other session of the SAME person renders.
    expect(await bound.execute(query(), laptop)).toMatchObject({ status: "ok" });
    // Still single-use: the crossing spends the one approval, never multiplies it.
    expect(await bound.execute(query(), phone)).toMatchObject({ status: "pending-approval" });
    expect(tools.executions).toHaveLength(1);
  });

  it("never crosses to a DIFFERENT user, however identical the call", async () => {
    const store = createMemoryStore();
    const guard = createGuard({ store });
    const ungraded = descriptor("ungraded", { name: "host_spending" });
    const tools = new FixtureTools([ungraded]);
    const bound = guard.bind(tools);
    const query = () => call(ungraded.name, { window: "30d" }, "call_q_stable");

    const parked = await bound.execute(query(), context());
    if (parked.status !== "pending-approval") throw new Error("expected the query to park");
    await guard.approvals.decide(parked.approvalId, { approve: true }, alice);

    expect(await bound.execute(query(), context({ principal: bob }))).toMatchObject({
      status: "pending-approval",
    });
    expect(tools.executions).toHaveLength(0);
  });
});

/**
 * AC3 — the defect that started this (2026-07-31 Executor deep look):
 * `payInvoice` classified `write` and ran un-gated on installs that never ran
 * the AI judge. Both halves of its life are pinned here.
 */
describe("payInvoice, before and after the judge (AC3)", () => {
  const payCall = call("host_payInvoice", { invoiceId: "inv_1", amountCents: 250_000 }, "call_pay");

  it("un-judged: ungraded, so it asks instead of silently paying", async () => {
    const ungraded = descriptor("ungraded", { name: "host_payInvoice" });
    const guard = createGuard({ store: createMemoryStore() });
    const tools = new FixtureTools([ungraded]);
    const bound = guard.bind(tools);

    await expect(guard.check(payCall, ungraded, context())).resolves.toMatchObject({
      action: "ask",
      decidedBy: "default",
    });
    expect(await bound.execute(payCall, context())).toMatchObject({ status: "pending-approval" });
    expect(tools.executions).toHaveLength(0);
  });

  it("judged write + confirmEach: asks EVERY call, and the standing grant is never consulted", async () => {
    const store = createMemoryStore();
    // The judge's verdict: paying is a `write` (a fact about the action) that
    // needs a person present (governance) — the two axes are orthogonal.
    const judged = descriptor("write", { name: "host_payInvoice", confirmEach: true });
    // A standing tool grant that would authorize any ordinary write.
    const grant = await seedGrant(store, { descriptor: judged });
    const guard = createGuard({ store, policy: { rules: [{ match: { risk: "write" }, action: "run" }] } });
    const tools = new FixtureTools([judged]);
    const bound = guard.bind(tools);

    const first = await guard.check(payCall, judged, context());
    expect(first).toMatchObject({ action: "ask", decidedBy: "confirmEach" });
    // Never consulted: the decision is not attributed to the grant, and the
    // grant it would have matched is still sitting there unspent.
    expect(first).not.toHaveProperty("grantId");
    expect((await guard.grants.list(alice)).some((entry) => entry.id === grant.id)).toBe(true);

    // Approve once; the approved replay runs exactly that call, once.
    const parked = await bound.execute(payCall, context());
    if (parked.status !== "pending-approval") throw new Error("expected payInvoice to park");
    await guard.approvals.decide(parked.approvalId, { approve: true }, alice);
    expect(await bound.execute(payCall, context())).toMatchObject({ status: "ok" });

    // And the very next identical call asks again — every call, its own consent.
    expect(await bound.execute(payCall, context())).toMatchObject({ status: "pending-approval" });
    expect(tools.executions).toHaveLength(1);
  });
});
