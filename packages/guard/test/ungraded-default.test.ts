import type { RecordQuery, StoreAdapter } from "@vendoai/core";
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
 * A no has to STAY no. A caller that re-issues a
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

  it("does NOT stand when housekeeping wrote it — the TTL sweep is not an answer", async () => {
    const store = createMemoryStore();
    const guard = createGuard({ store });
    const bound = guard.bind(new FixtureTools([ungraded]));

    const parked = await bound.execute(stable(), context());
    if (parked.status !== "pending-approval") throw new Error("expected the ungraded call to park");
    // An hour of inattention. The sweep denies the row to reap the queue; it is
    // not the user saying no, and must never brick the next ask.
    expect(await guard.sweepExpiredApprovals!(60 * 60_000, Date.now() + 61 * 60_000)).toBe(1);

    expect(await bound.execute(stable(), context())).toMatchObject({ status: "pending-approval" });
  });

  it("does NOT stand when the conversation walked away — abandonment is not an answer", async () => {
    const store = createMemoryStore();
    const guard = createGuard({ store });
    const bound = guard.bind(new FixtureTools([ungraded]));

    const parked = await bound.execute(stable(), context());
    if (parked.status !== "pending-approval") throw new Error("expected the ungraded call to park");
    await guard.abandonApprovals!([parked.approvalId], context());

    expect(await bound.execute(stable(), context())).toMatchObject({ status: "pending-approval" });
  });

  it("takes a human no back through approvals.revoke, and the next issue asks again", async () => {
    const store = createMemoryStore();
    const guard = createGuard({ store });
    const bound = guard.bind(new FixtureTools([ungraded]));

    const parked = await bound.execute(stable(), context());
    if (parked.status !== "pending-approval") throw new Error("expected the ungraded call to park");
    await guard.approvals.decide(parked.approvalId, { approve: false }, alice);
    expect(await bound.execute(stable(), context())).toMatchObject({ status: "blocked" });

    // The undo: a misclicked no on a frozen-descriptor ceremony is recoverable.
    await guard.approvals.revoke(parked.approvalId, alice);
    expect(await bound.execute(stable(), context())).toMatchObject({ status: "pending-approval" });
  });

  it("guards revoke like every approval read: foreign not-found, pending conflicts", async () => {
    const store = createMemoryStore();
    const guard = createGuard({ store });
    const bound = guard.bind(new FixtureTools([ungraded]));

    const parked = await bound.execute(stable(), context());
    if (parked.status !== "pending-approval") throw new Error("expected the ungraded call to park");
    // Nothing to take back yet — deny it instead.
    await expect(guard.approvals.revoke(parked.approvalId, alice)).rejects.toMatchObject({ code: "conflict" });
    await guard.approvals.decide(parked.approvalId, { approve: false }, alice);
    await expect(guard.approvals.revoke(parked.approvalId, bob)).rejects.toMatchObject({ code: "not-found" });
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
 * Parking never dedupes, so ONE stable call id can
 * hold an approved row and a denied row at once. The person's latest word has
 * to win, whichever order they arrive in.
 */
describe("the newest human decision on a call wins", () => {
  const ungraded = descriptor("ungraded", { name: "host_pay_invoice" });
  const stable = () => call(ungraded.name, { invoiceId: "inv_1" }, "call_stable");

  it("approve THEN deny: the stale yes is voided, not replayed after the no", async () => {
    const store = createMemoryStore();
    const guard = createGuard({ store });
    const tools = new FixtureTools([ungraded]);
    const bound = guard.bind(tools);

    // Two asks on the same call id — the second parks because the first is
    // still pending, exactly as it does today.
    const first = await bound.execute(stable(), context());
    if (first.status !== "pending-approval") throw new Error("expected a park");
    const second = await bound.execute(stable(), context());
    if (second.status !== "pending-approval") throw new Error("expected a second park");

    await guard.approvals.decide(first.approvalId, { approve: true }, alice);
    await guard.approvals.decide(second.approvalId, { approve: false }, alice);

    // Without the supersede, the older approval would run the very thing the
    // user just refused.
    expect(await bound.execute(stable(), context())).toMatchObject({ status: "blocked" });
    expect(tools.executions).toHaveLength(0);
  });

  it("deny THEN approve: the approval was minted after the no, so it wins", async () => {
    const store = createMemoryStore();
    const guard = createGuard({ store });
    const tools = new FixtureTools([ungraded]);
    const bound = guard.bind(tools);

    const first = await bound.execute(stable(), context());
    if (first.status !== "pending-approval") throw new Error("expected a park");
    const second = await bound.execute(stable(), context());
    if (second.status !== "pending-approval") throw new Error("expected a second park");

    await guard.approvals.decide(first.approvalId, { approve: false }, alice);
    await guard.approvals.decide(second.approvalId, { approve: true }, alice);

    // The yes came second and was never superseded, so the call runs once.
    expect(await bound.execute(stable(), context())).toMatchObject({ status: "ok" });
    expect(tools.executions).toHaveLength(1);
    // …and the standing no is back in charge for the next issue.
    expect(await bound.execute(stable(), context())).toMatchObject({ status: "blocked" });
  });
});

/**
 * A DELIBERATE choice, pinned so it never becomes
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

/**
 * Voiding and replaying a yes are the SAME
 * one-time transition. Both claim `consumed:<id>`, so exactly one of them can
 * happen: a take-back can never be erased by a replay that read the row before
 * it, and a replay can never spend a yes the person has taken back. Both
 * interleavings are pinned here, driven through a store that lets the test run
 * code at a chosen moment INSIDE a guard operation.
 */
describe("a void and a replay can never both win", () => {
  const ungraded = descriptor("ungraded", { name: "host_pay_invoice" });
  const stable = () => call(ungraded.name, { invoiceId: "inv_1" }, "call_stable");

  type Interleave =
    | { op: "list"; collection: string; query: RecordQuery }
    | { op: "put"; collection: string; record: { id: string; data: unknown } }
    | { op: "claim"; collection: string; record: { id: string; data: unknown } };

  /** Runs `hook` just AFTER each read and each won transition claim, and just
   *  BEFORE each write — so a test can land a second operation in the window
   *  where the first is holding a copy it has not written back yet, which is the
   *  only way to reproduce the orderings by hand. */
  function interleavedStore(
    base: StoreAdapter,
    hook: (event: Interleave) => Promise<void>,
  ): StoreAdapter {
    return {
      ...base,
      records(collection) {
        const records = base.records(collection);
        const atomic = records.atomic;
        return {
          ...records,
          async list(query = {}) {
            const page = await records.list(query);
            await hook({ op: "list", collection, query });
            return page;
          },
          async put(input) {
            await hook({ op: "put", collection, record: input });
            return records.put(input);
          },
          ...(atomic === undefined ? {} : {
            atomic: {
              ...atomic,
              async insertIfAbsent(input) {
                const receipt = await atomic.insertIfAbsent(input);
                await hook({ op: "claim", collection, record: input });
                return receipt;
              },
            },
          }),
        };
      },
    };
  }

  /** Wraps the store so ONE write fails — a store dying between two writes that
   *  the protocol assumes both land. `onPut` may also land other work first. */
  function faultyStore(
    base: StoreAdapter,
    onPut: (collection: string, id: string) => Promise<boolean> | boolean,
  ): StoreAdapter {
    return {
      ...base,
      records(collection) {
        const records = base.records(collection);
        return {
          ...records,
          async put(input) {
            if (await onPut(collection, input.id)) throw new Error("the store went away");
            return records.put(input);
          },
        };
      },
    };
  }

  /** A one-shot interleaving: fires once, and never re-enters from the work it
   *  triggers. */
  function once(): { arm(fn: () => Promise<void>): void; hook(when: (event: Interleave) => boolean): (event: Interleave) => Promise<void> } {
    let pending: (() => Promise<void>) | undefined;
    return {
      arm(fn) {
        pending = fn;
      },
      hook: (when) => async (event) => {
        if (pending === undefined || !when(event)) return;
        const run = pending;
        pending = undefined;
        await run();
      },
    };
  }

  it("refuses the replay when the no lands first: the voided yes is never spent", async () => {
    const gate = once();
    const store = interleavedStore(
      createMemoryStore(),
      // The moment the replay lookup reads the approved rows.
      gate.hook((event) => event.op === "list" && event.query?.refs?.["status"] === "approved"),
    );
    const guard = createGuard({ store });
    const tools = new FixtureTools([ungraded]);
    const bound = guard.bind(tools);

    const first = await bound.execute(stable(), context());
    const second = await bound.execute(stable(), context());
    if (first.status !== "pending-approval" || second.status !== "pending-approval") {
      throw new Error("expected two parks on the same call id");
    }
    await guard.approvals.decide(first.approvalId, { approve: true }, alice);

    // The person's no lands with the replay lookup already holding an un-voided
    // copy of the yes. Before this fix the replay's own write erased the void.
    gate.arm(async () => {
      await guard.approvals.decide(second.approvalId, { approve: false }, alice);
    });
    expect(await bound.execute(stable(), context())).toMatchObject({ status: "blocked" });
    expect(tools.executions).toHaveLength(0);
  });

  it("says the take-back came too late when the replay wins: the call ran, and the trail says so", async () => {
    const gate = once();
    const store = interleavedStore(
      createMemoryStore(),
      // The moment the replay has WON the transition and is marking the row.
      gate.hook((event) =>
        event.op === "put"
        && event.collection === "vendo_approvals"
        && (event.record.data as { consumedAt?: string }).consumedAt !== undefined),
    );
    const guard = createGuard({ store });
    const tools = new FixtureTools([ungraded]);
    const bound = guard.bind(tools);

    const first = await bound.execute(stable(), context());
    const second = await bound.execute(stable(), context());
    if (first.status !== "pending-approval" || second.status !== "pending-approval") {
      throw new Error("expected two parks on the same call id");
    }
    await guard.approvals.decide(first.approvalId, { approve: true }, alice);

    gate.arm(async () => {
      await guard.approvals.decide(second.approvalId, { approve: false }, alice);
    });
    // The yes was already spent, so the call runs — the honest outcome. What
    // must NOT happen is the no reading as if it stopped anything.
    expect(await bound.execute(stable(), context())).toMatchObject({ status: "ok" });
    expect(tools.executions).toHaveLength(1);
    const { events } = await guard.audit.query({ principal: alice });
    expect(events.some((event) =>
      (event.detail as { supersedeTooLate?: string } | undefined)?.supersedeTooLate === first.approvalId,
    )).toBe(true);

    // …and the no still stands for every later issue of the same call.
    expect(await bound.execute(stable(), context())).toMatchObject({ status: "blocked" });
    expect(tools.executions).toHaveLength(1);
  });

  it("cannot take back a yes the call already spent — revoke says so instead of reporting success", async () => {
    const guard = createGuard({ store: createMemoryStore() });
    const tools = new FixtureTools([ungraded]);
    const bound = guard.bind(tools);

    const parked = await bound.execute(stable(), context());
    if (parked.status !== "pending-approval") throw new Error("expected the ungraded call to park");
    await guard.approvals.decide(parked.approvalId, { approve: true }, alice);
    expect(await bound.execute(stable(), context())).toMatchObject({ status: "ok" });

    await expect(guard.approvals.revoke(parked.approvalId, alice)).rejects.toMatchObject({
      code: "conflict",
    });
    expect(tools.executions).toHaveLength(1);
  });

  it("takes a decision back exactly once — a second revoke adds no second audit line", async () => {
    const guard = createGuard({ store: createMemoryStore() });
    const bound = guard.bind(new FixtureTools([ungraded]));

    const parked = await bound.execute(stable(), context());
    if (parked.status !== "pending-approval") throw new Error("expected the ungraded call to park");
    await guard.approvals.decide(parked.approvalId, { approve: false }, alice);

    await guard.approvals.revoke(parked.approvalId, alice);
    await expect(guard.approvals.revoke(parked.approvalId, alice)).resolves.toBeUndefined();
    const { events } = await guard.audit.query({ principal: alice });
    expect(events.filter((event) =>
      (event.detail as { approvalRevoked?: string } | undefined)?.approvalRevoked === parked.approvalId,
    )).toHaveLength(1);
  });

  /**
   * The row can also be GONE. Subject erasure
   * (02-store §5) DELETEs approval rows, so a replay that treated a missing
   * row as "unchanged" would re-create an erased subject's approval and run
   * the tool as them.
   */
  it("never resurrects an approval erased mid-replay — no row, no run", async () => {
    const gate = once();
    const base = createMemoryStore();
    const store = interleavedStore(
      base,
      // The moment the replay has WON the transition, before it re-reads.
      gate.hook((event) => event.op === "claim" && event.record.id.startsWith("consumed:")),
    );
    const guard = createGuard({ store });
    const tools = new FixtureTools([ungraded]);
    const bound = guard.bind(tools);

    const parked = await bound.execute(stable(), context());
    if (parked.status !== "pending-approval") throw new Error("expected the ungraded call to park");
    await guard.approvals.decide(parked.approvalId, { approve: true }, alice);

    // The subject exercises their right to erasure in that window.
    gate.arm(async () => {
      await base.records("vendo_approvals").delete(parked.approvalId);
    });
    expect(await bound.execute(stable(), context())).toMatchObject({ status: "pending-approval" });
    expect(tools.executions).toHaveLength(0);
    expect(await base.records("vendo_approvals").get(parked.approvalId)).toBeNull();
  });

  /**
   * The receipt is durable BEFORE the row write, so
   * a take-back whose put failed leaves the receipt claimed and the row still
   * standing. The retry has to finish the job, not report it as already done.
   */
  it("re-asserts a take-back whose row write failed instead of calling it already done", async () => {
    let breakNextApprovalPut = false;
    const store = faultyStore(createMemoryStore(), (collection) => {
      if (collection !== "vendo_approvals" || !breakNextApprovalPut) return false;
      breakNextApprovalPut = false;
      return true;
    });
    const guard = createGuard({ store });
    const bound = guard.bind(new FixtureTools([ungraded]));

    const parked = await bound.execute(stable(), context());
    if (parked.status !== "pending-approval") throw new Error("expected the ungraded call to park");
    await guard.approvals.decide(parked.approvalId, { approve: false }, alice);
    expect(await bound.execute(stable(), context())).toMatchObject({ status: "blocked" });

    breakNextApprovalPut = true;
    await expect(guard.approvals.revoke(parked.approvalId, alice)).rejects.toThrow("the store went away");
    // The receipt landed, the marker did not: the retry must actually void it,
    // or the person's undo silently does nothing while the no keeps blocking.
    await guard.approvals.revoke(parked.approvalId, alice);
    expect(await bound.execute(stable(), context())).toMatchObject({ status: "pending-approval" });
  });

  /**
   * A batch's compensation restores each applied
   * member to its pre-decision state, which is right unless a concurrent actor
   * has since SPENT or voided that member: those transitions are single-use, so
   * re-opening the ask would advertise a decision nobody can make again.
   */
  it("does not re-open a batch member a concurrent spend already consumed", async () => {
    const base = createMemoryStore();
    let guard = createGuard({ store: base });
    let secondId: string | undefined;
    let firstId: string | undefined;
    const store = faultyStore(base, async (collection, id) => {
      if (collection !== "vendo_approvals" || id !== secondId) return false;
      // The set's first member is committed; something spends it right as the
      // second member's write dies.
      await guard.spendApproval!(firstId!, alice);
      return true;
    });
    guard = createGuard({ store });
    const bound = guard.bind(new FixtureTools([ungraded]));

    const one = await bound.execute(call(ungraded.name, { invoiceId: "inv_1" }, "call_one"), context());
    const two = await bound.execute(call(ungraded.name, { invoiceId: "inv_2" }, "call_two"), context());
    if (one.status !== "pending-approval" || two.status !== "pending-approval") {
      throw new Error("expected two parks");
    }
    // The batch commits in sorted id order, so the LAST id is the one that dies.
    [firstId, secondId] = [one.approvalId, two.approvalId].sort();

    await expect(guard.approvals.decide([one.approvalId, two.approvalId], { approve: true }, alice))
      .rejects.toThrow("the store went away");

    // The spent member keeps its marker and its decided status; the untouched
    // member is back to pending, exactly as all-or-none intends.
    expect((await base.records("vendo_approvals").get(firstId!))?.data).toMatchObject({
      status: "approved",
      consumedAt: expect.any(String),
    });
    expect((await base.records("vendo_approvals").get(secondId!))?.data).toMatchObject({
      status: "pending",
    });
  });

  /**
   * The automations engine spends a
   * yes by arming the standing grant it asked for instead of replaying a call, so
   * that spend contends on the same transition as `approvals.revoke`.
   */
  it("spends a yes for a grant-arming caller, and a take-back after it comes too late", async () => {
    const guard = createGuard({ store: createMemoryStore() });
    const bound = guard.bind(new FixtureTools([ungraded]));

    const parked = await bound.execute(stable(), context());
    if (parked.status !== "pending-approval") throw new Error("expected the ungraded call to park");
    await guard.approvals.decide(parked.approvalId, { approve: true }, alice);

    // Owner-scoped, and single-use like every other spend of the same yes.
    expect(await guard.spendApproval!(parked.approvalId, bob)).toBe("already-spent");
    expect(await guard.spendApproval!(parked.approvalId, alice)).toBe("spent");
    expect(await guard.spendApproval!(parked.approvalId, alice)).toBe("already-spent");
    await expect(guard.approvals.revoke(parked.approvalId, alice)).rejects.toMatchObject({
      code: "conflict",
    });
  });

  it("refuses to spend a yes the person took back first — the grant is never armed", async () => {
    const guard = createGuard({ store: createMemoryStore() });
    const tools = new FixtureTools([ungraded]);
    const bound = guard.bind(tools);

    const parked = await bound.execute(stable(), context());
    if (parked.status !== "pending-approval") throw new Error("expected the ungraded call to park");
    await guard.approvals.decide(parked.approvalId, { approve: true }, alice);
    await guard.approvals.revoke(parked.approvalId, alice);

    expect(await guard.spendApproval!(parked.approvalId, alice)).toBe("taken-back");
    // …and the replay is refused on the same marker.
    expect(await bound.execute(stable(), context())).toMatchObject({ status: "pending-approval" });
    expect(tools.executions).toHaveLength(0);
  });
});
