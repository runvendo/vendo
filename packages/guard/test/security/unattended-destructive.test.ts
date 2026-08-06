import { UNATTENDED_DESTRUCTIVE_REASON, VENUES } from "@vendoai/core";
import { describe, expect, it } from "vitest";
import { createGuard } from "../../src/index.js";
import { createMemoryStore } from "../fixtures/memory-store.js";
import { alice, FixtureTools, call, context, descriptor, seedGrant } from "../fixtures/tools.js";

/**
 * THE LAW (design §12): destructive and external actions are never unattended.
 * Not with a limit, not with a condition, not with an admin override.
 *
 * `projectableForRun` (core) is the primary mechanism — the model is never even
 * offered the tool. These are the defence-in-depth tests: whatever the model was
 * shown, the guard refuses at the choke point.
 */
const awayCtx = () =>
  context({
    venue: "automation",
    presence: "away",
    appId: "app_1",
    trigger: { runId: "run_1", kind: "schedule" },
  });

describe("THE LAW: unattended destructive calls are refused at the guard", () => {
  it("refuses a destructive tool in an automation run and never reaches the registry", async () => {
    const store = createMemoryStore();
    const send = descriptor("destructive", { name: "maple_payments_send" });
    // A standing, app-bound automation grant — the strongest authority that
    // exists today. The law must beat it.
    await seedGrant(store, { descriptor: send, appId: "app_1", source: "automation" });
    const tools = new FixtureTools([send]);
    const bound = createGuard({ store }).bind(tools);

    const outcome = await bound.execute(call(send.name, { amount: 5000 }), awayCtx());

    expect(outcome).toEqual({ status: "blocked", reason: UNATTENDED_DESTRUCTIVE_REASON });
    expect(tools.executions).toHaveLength(0);
  });

  it("is not projected into an automation run at all", async () => {
    const store = createMemoryStore();
    const send = descriptor("destructive", { name: "maple_payments_send" });
    const list = descriptor("read", { name: "maple_invoices_list" });
    const bound = createGuard({ store }).bind(new FixtureTools([list, send]));

    // The registry the guard exposes for an unattended run omits it entirely.
    const projected = await bound.descriptors({ venue: "automation", presence: "away" });

    expect(projected.map((d) => d.name)).toEqual(["maple_invoices_list"]);
  });

  it("runs a dev-labelled READ whatever its name sounds like — the declared label is final", async () => {
    const store = createMemoryStore();
    // Two-vote grading is removed: no mechanical vote second-guesses the label
    // the dev shipped and reviewed. Named like a deletion, declared `read`, and
    // grant-authorized for this away run (05 §6 — an ungranted away call parks,
    // reads included), so it runs; the old vote refused exactly this call with
    // THE LAW's reason despite the same grant.
    const labelled = descriptor("read", { name: "maple_customer_delete" });
    await seedGrant(store, { descriptor: labelled, appId: "app_1", source: "automation" });
    const tools = new FixtureTools([labelled]);
    const bound = createGuard({ store }).bind(tools);

    const outcome = await bound.execute(call(labelled.name, { id: "cus_1" }), awayCtx());

    expect(outcome.status).toBe("ok");
    expect(tools.executions).toHaveLength(1);
  });

  it("withholds an UNGRADED tool from an unattended run by its declared label", async () => {
    const store = createMemoryStore();
    // Unlabeled means ungraded, and ungraded needs a person — an unattended run
    // has none, so a standing grant cannot authorize it either.
    const ungraded = descriptor("ungraded", { name: "maple_frobnicate_widget" });
    await seedGrant(store, { descriptor: ungraded, appId: "app_1", source: "automation" });
    const tools = new FixtureTools([ungraded]);
    const bound = createGuard({ store }).bind(tools);

    const outcome = await bound.execute(call(ungraded.name, { id: "w_1" }), awayCtx());

    expect(outcome).toEqual({ status: "blocked", reason: UNATTENDED_DESTRUCTIVE_REASON });
    expect(tools.executions).toHaveLength(0);
  });

  it("still lets an automation READ and WRITE — automations are not crippled", async () => {
    const store = createMemoryStore();
    const update = descriptor("write", { name: "maple_invoice_update" });
    await seedGrant(store, { descriptor: update, appId: "app_1", source: "automation" });
    const tools = new FixtureTools([update]);
    const bound = createGuard({ store }).bind(tools);

    const outcome = await bound.execute(call(update.name, { id: "inv_1" }), awayCtx());

    expect(outcome.status).toBe("ok");
    expect(tools.executions).toHaveLength(1);
  });

  it("allows the same destructive call when a person is present — a normal confirm", async () => {
    const store = createMemoryStore();
    const send = descriptor("destructive", { name: "maple_payments_send" });
    await seedGrant(store, { descriptor: send });
    const tools = new FixtureTools([send]);
    const bound = createGuard({ store }).bind(tools);

    const outcome = await bound.execute(
      call(send.name, { amount: 5000 }),
      context({ venue: "chat", presence: "present" }),
    );

    expect(outcome.status).toBe("ok");
    expect(tools.executions).toHaveLength(1);
  });

  it("PARKS rather than silently dropping, so prepare-then-human-sends still exists", async () => {
    // The law's replacement pattern is "the automation prepares, the human
    // sends". If an unattended destructive call reached the pipeline with no
    // authority at all, the honest answer is a card a person can tap — not a
    // refusal that leaves the work undone and unexplained. This is why the law
    // is enforced AFTER the decision pipeline, not before it.
    const store = createMemoryStore();
    const send = descriptor("destructive", { name: "maple_payments_send" });
    const bound = createGuard({ store }).bind(new FixtureTools([send]));

    const outcome = await bound.execute(call(send.name, { amount: 5000 }), awayCtx());

    expect(outcome.status).toBe("pending-approval");
  });

  it("PARKS the concurrent write-cap loser instead of law-blocking it (law flag is run-only)", async () => {
    // Two unattended writes to a withheld (destructive) tool fire concurrently
    // under a standing automation grant with a one-write budget. Each snapshots
    // the write count at 0 (< cap) and awaits its verdict as a "run" — so both
    // carry THE LAW's run-only refusal flag. The atomic re-check then hands the
    // single slot to whichever firing resumes first; the other is reclassified
    // to a BREAKER ASK. That reclassification is exactly the law's replacement
    // pattern (the automation prepares, a human sends), so the loser must PARK.
    //
    // Regression: if the law flag were left set when the run is reclassified as
    // a breaker ask, bind()'s law branch (which runs before its ask branch)
    // would BLOCK the loser instead of parking it — both firings would then
    // come back "blocked" and no approval card would ever appear.
    const store = createMemoryStore();
    const send = descriptor("destructive", { name: "maple_payments_send" });
    await seedGrant(store, { descriptor: send, appId: "app_1", source: "automation" });
    const tools = new FixtureTools([send]);
    const bound = createGuard({ store, breakers: { maxWritesPerRun: 1, maxCallsPerMinute: 100 } })
      .bind(tools);

    const [a, b] = await Promise.all([
      bound.execute(call(send.name, { amount: 5000 }, "cap_a"), awayCtx()),
      bound.execute(call(send.name, { amount: 5000 }, "cap_b"), awayCtx()),
    ]);

    // The slot winner is refused by THE LAW (an unattended destructive run); the
    // slot loser is parked for a person, not swept up in the same block.
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual(["blocked", "pending-approval"]);
    // Neither destructive call ever actually executes.
    expect(tools.executions).toHaveLength(0);
  });

  it("honours a human's approval of THIS exact call — attended irreversibility", async () => {
    // Once a person has seen the real amount and recipient and tapped approve,
    // executing is attended, not unattended. Refusing here would make the law
    // self-defeating: it would forbid the very path it prescribes.
    const store = createMemoryStore();
    const send = descriptor("destructive", { name: "maple_payments_send" });
    const tools = new FixtureTools([send]);
    const guard = createGuard({ store });
    const bound = guard.bind(tools);
    const args = { amount: 5000, to: "acct_9" };

    const parked = await bound.execute(call(send.name, args), awayCtx());
    expect(parked.status).toBe("pending-approval");
    const [pending] = await guard.approvals.pending(alice);
    await guard.approvals.decide(pending!.id, { approve: true }, alice);

    const replayed = await bound.execute(call(send.name, args), awayCtx());

    expect(replayed.status).toBe("ok");
    expect(tools.executions).toHaveLength(1);
  });

  // The predicate is PRESENCE, never the venue label (§12 clarification
  // 2026-07-31), and the venue list is derived from core's own `VENUES` so a
  // fifth venue is swept the moment it exists rather than quietly skipped.
  //
  // The AWAY sweep alone is not a lock — every away case already satisfies a
  // presence-only predicate, so `presence === "away" || venue === "<anything>"`
  // leaves it green. The PRESENT sweep is the one behavioural difference a venue
  // clause makes: the enable flow and the "allow this while you're away" card
  // both resolve a present human, and they ask about the very destructive tools
  // an ORed venue would hide from them.
  //
  // The away sweep also covers the real callers the venue label would have let
  // out: `packages/automations/src/engine.ts` fires genuine unattended work as
  // `{ venue: "automation", presence: "away" }` — including a machine app's own
  // `vendo.json` schedules, which `packages/apps/src/manifest-triggers.ts` folds
  // into document triggers that same engine fires — so a venue-keyed predicate
  // would put every scheduled firing outside the law.
  it.each(VENUES)("refuses an away destructive call in venue %s", async (venue) => {
    const store = createMemoryStore();
    const send = descriptor("destructive", { name: "maple_payments_send" });
    await seedGrant(store, { descriptor: send, appId: "app_1", source: "automation" });
    const tools = new FixtureTools([send]);
    const bound = createGuard({ store }).bind(tools);

    const outcome = await bound.execute(
      call(send.name, { amount: 5000 }),
      context({ venue, presence: "away", appId: "app_1" }),
    );

    // Rehearsal is the ONE venue that does not BLOCK an away destructive call —
    // it INTERCEPTS it. In venue=rehearsal every write/destructive call is
    // resolved at the guard's choke point to a simulated "would-ask" preview
    // card and never reaches the registry at all (guard.ts #execute; the
    // feature's own `rehearsal-venue.test.ts` proves the branch). So THE LAW's
    // SUBSTANTIVE guarantee — no real unattended destructive action ever
    // happens — is fully upheld here too: `tools.executions` stays empty below
    // for rehearsal exactly as for every running venue. Only the literal status
    // differs (a simulated preview, not `blocked`), because rehearsal exists to
    // PREVIEW a schedule, never to run it. The presence-only LAW is unchanged
    // for the four running venues; rehearsal runs nothing, so it cannot run an
    // unattended destructive action to begin with.
    if (venue === "rehearsal") {
      expect(outcome.status).toBe("ok");
      expect(outcome).toMatchObject({ output: { rehearsalSimulated: true } });
    } else {
      expect(outcome).toEqual({ status: "blocked", reason: UNATTENDED_DESTRUCTIVE_REASON });
    }
    // The substantive guarantee, asserted for EVERY venue including rehearsal:
    // the destructive tool is never actually executed.
    expect(tools.executions).toHaveLength(0);
  });

  it.each(VENUES)(
    "PROJECTS destructive tools to a present person in venue %s — a ceremony must see them",
    async (venue) => {
      const store = createMemoryStore();
      const send = descriptor("destructive", { name: "maple_payments_send" });
      const list = descriptor("read", { name: "maple_invoices_list" });
      const bound = createGuard({ store }).bind(new FixtureTools([list, send]));

      const projected = await bound.descriptors({ venue, presence: "present" });

      expect(projected.map((d) => d.name)).toEqual(["maple_invoices_list", "maple_payments_send"]);
    },
  );

  it("records the refusal in the audit trail, so a run history can explain itself", async () => {
    const store = createMemoryStore();
    const send = descriptor("destructive", { name: "maple_payments_send" });
    await seedGrant(store, { descriptor: send, appId: "app_1", source: "automation" });
    const guard = createGuard({ store });
    await guard.bind(new FixtureTools([send])).execute(call(send.name, { amount: 1 }), awayCtx());

    const { events } = await guard.audit.query({ principal: alice });
    expect(events.some((event) => event.outcome === "blocked" && event.tool === send.name)).toBe(true);
  });
});
