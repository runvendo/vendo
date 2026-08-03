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

  it("refuses a MISLABELLED destructive tool: the second mechanical vote wins", async () => {
    const store = createMemoryStore();
    // Labelled `write`, but named like a deletion. Disagreement resolves against
    // the tool, so this must not run unattended either.
    const mislabelled = descriptor("write", { name: "maple_customer_delete" });
    await seedGrant(store, { descriptor: mislabelled, appId: "app_1", source: "automation" });
    const tools = new FixtureTools([mislabelled]);
    const bound = createGuard({ store }).bind(tools);

    const outcome = await bound.execute(call(mislabelled.name, { id: "cus_1" }), awayCtx());

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
  // out: `packages/apps/src/schedules.ts` fires genuine unattended work as
  // `{ venue: "app", presence: "away" }`, so a venue-keyed predicate would put
  // every scheduled app fn outside the law.
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

    expect(outcome).toEqual({ status: "blocked", reason: UNATTENDED_DESTRUCTIVE_REASON });
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
