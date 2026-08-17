/** FLOW 2 — code-authored `agent.on(...)`, end to end.
 *
 * The seam, unmocked on both sides. PRODUCER: a real `agent()` whose real
 * `.on()` declarations are collected by the real `agentAutomations()` and
 * diffed by the real `reconcileAutomations()` — the same helper the vendo.json
 * fold-in uses. CONSUMER: the real create operation writes the plan, the real
 * `automations.list` reads it back, and the real `tick` fires it into a real
 * run row. Nothing on either leg is scripted, so the two halves are free to
 * disagree, which is the only way this test can fail for a real reason.
 *
 * Consent here is THE CODE. A redeploy re-runs the reconcile: a new declaration
 * creates, an edited one mints a NEW identity and disarms the old, one deleted
 * from the source is disarmed (never deleted — its run history survives), and a
 * person's own kill switch outlives every redeploy.
 */
import { agent, agentAutomations } from "@vendoai/agents";
import { declaredAutomationId, reconcileAutomations, toTriggerSource } from "@vendoai/core";
import type { AutomationRecord, DeclaredAutomation, Principal, RunContext } from "@vendoai/core";
import { beforeEach, describe, expect, it } from "vitest";
import { createStack, ownerCtx, resetFixture, type Stack } from "../src/harness.js";
import { ADA, approve, runCount } from "../src/support.js";

const LIST_TASK = "list the invoices and note what is overdue";

/** Arm state by id, so a list-order change never reads as a reconcile bug. */
const armedById = (records: readonly AutomationRecord[]): Record<string, boolean> =>
  Object.fromEntries(records.map(({ id, armed }) => [id, armed]));

/** The boot reconcile, exactly as a deployment runs it: collect what the code
 *  declared, diff it against what is stored for the SAME author with the real
 *  shared helper, and apply the plan through the engine's own applier. The
 *  applier is deliberately not `automations.disable` — that one stamps
 *  `disarmedBy: "user"`, and a redeploy impersonating a person's kill switch
 *  would make the switch unremovable by the next deploy. */
async function boot(
  stack: Stack,
  declared: readonly DeclaredAutomation[],
  owner: Principal,
  ctx: RunContext,
): Promise<AutomationRecord[]> {
  const stored = await stack.automations.list({ owner: owner.subject }, ctx);
  await stack.reconcile(reconcileAutomations(declared, stored, owner, "code"), ctx);
  return await stack.automations.list({ owner: owner.subject }, ctx);
}

describe("code-authored automations (agent.on)", () => {
  beforeEach(resetFixture);

  it("declares at module load, reconciles at boot, and the deployment's own tick fires it", async () => {
    let clock = new Date("2026-08-03T07:00:00.000Z");
    const stack = await createStack({ now: () => clock });
    try {
      const ctx = ownerCtx(ADA.subject);
      const support = agent({ name: "support", store: stack.store });
      // Every declaration shape the sheet ships, declared the way a host's
      // module body declares them.
      support.on("0 9 * * 1", LIST_TASK, { id: "weekly-review" });
      support.on({ event: "invoice.overdue" }, "chase the customer");

      // `.on()` returns void and touches no store: before boot, nothing exists.
      expect(await stack.automations.list({}, ctx)).toEqual([]);

      const declared = agentAutomations(support);
      expect(declared.map(({ id }) => id)).toEqual(["weekly-review", undefined]);

      const records = await boot(stack, declared, ADA, ctx);
      // The un-named declaration takes a CONTENT identity, so a redeploy of the
      // same source finds the same record instead of minting a second one.
      const chaser = declaredAutomationId(declared[1]!, toTriggerSource(declared[1]!.when));
      expect(records.map(({ id, authoredBy, agent: name, armed }) =>
        ({ id, authoredBy, agent: name, armed })).sort((left, right) => left.id.localeCompare(right.id)))
        .toEqual([
          { id: chaser, authoredBy: "code", agent: "support", armed: true },
          { id: "atm_weekly-review", authoredBy: "code", agent: "support", armed: true },
        ].sort((left, right) => left.id.localeCompare(right.id)));

      // The record's steps-less goal task is the words the code wrote.
      const weekly = records.find(({ id }) => id === "atm_weekly-review");
      expect(weekly?.task).toEqual({ kind: "goal", prompt: LIST_TASK });
      expect(weekly?.when).toEqual({ kind: "schedule", cron: "0 9 * * 1" });

      // Consent is the code, but the AUTHORITY is still the owner's: the goal
      // run needs its grants like any other, so arming captures them.
      await approve(stack, (await stack.automations.enable("atm_weekly-review", ctx)).missing);

      // FIRES: the same tick every other automation rides. Monday 09:00 UTC.
      clock = new Date("2026-08-03T09:00:30.000Z");
      const fired = await stack.automations.tick(clock);
      expect(fired).toHaveLength(1);
      const run = await stack.automations.runs.get(fired[0]!, ctx);
      expect(run?.automationId).toBe("atm_weekly-review");
      expect(run?.agent).toBe("support");

      // Idempotent: a second tick in the same window claims nothing.
      expect(await stack.automations.tick(clock)).toEqual([]);
      expect(await runCount(stack, "atm_weekly-review")).toBe(1);
    } finally {
      await stack.close();
    }
  });

  it("mints a new identity for an edited declaration and disarms the one it replaced", async () => {
    const stack = await createStack();
    try {
      const ctx = ownerCtx(ADA.subject);
      const first = agent({ name: "support", store: stack.store });
      first.on("0 2 * * *", "rebuild the digest");
      const before = await boot(stack, agentAutomations(first), ADA, ctx);
      expect(before).toHaveLength(1);
      const originalId = before[0]!.id;

      // The REDEPLOY: the same declaration site, different words. A default
      // identity is hash(when + task), so editing either is a new automation.
      const second = agent({ name: "support", store: stack.store });
      second.on("0 2 * * *", "rebuild the digest and email it");
      const after = await boot(stack, agentAutomations(second), ADA, ctx);

      expect(after).toHaveLength(2);
      // The superseded identity is disarmed, never deleted — its run history
      // survives — and the edited words arrived as a NEW record, armed.
      expect(after.find(({ id }) => id === originalId)?.armed).toBe(false);
      const replacement = after.find(({ id }) => id !== originalId);
      expect(replacement?.armed).toBe(true);
      expect(replacement?.task).toEqual({ kind: "goal", prompt: "rebuild the digest and email it" });
    } finally {
      await stack.close();
    }
  });

  it("disarms a declaration deleted from the source and never re-arms a manual kill switch", async () => {
    const stack = await createStack();
    try {
      const ctx = ownerCtx(ADA.subject);
      const first = agent({ name: "support", store: stack.store });
      first.on("0 2 * * *", "rebuild the digest", { id: "nightly-digest" });
      first.on("0 6 * * *", "refresh credit scores", { id: "credit-refresh" });
      expect(await boot(stack, agentAutomations(first), ADA, ctx)).toHaveLength(2);

      // A PERSON turns one off. This decision is not the code's to overrule.
      await stack.automations.disable("atm_nightly-digest", ctx);
      expect((await stack.automations.get("atm_nightly-digest", ctx))?.disarmedBy).toBe("user");

      // The redeploy still declares BOTH, and drops nothing…
      const second = agent({ name: "support", store: stack.store });
      second.on("0 2 * * *", "rebuild the digest", { id: "nightly-digest" });
      second.on("0 6 * * *", "refresh credit scores", { id: "credit-refresh" });
      const survived = await boot(stack, agentAutomations(second), ADA, ctx);
      // …and the kill switch survives it, which is the whole guarantee.
      expect(armedById(survived))
        .toEqual({ "atm_nightly-digest": false, "atm_credit-refresh": true });

      // Now the source drops `credit-refresh`. Consent WAS the code; the code no
      // longer says it, so it is disarmed.
      const third = agent({ name: "support", store: stack.store });
      third.on("0 2 * * *", "rebuild the digest", { id: "nightly-digest" });
      const pruned = await boot(stack, agentAutomations(third), ADA, ctx);
      expect(armedById(pruned))
        .toEqual({ "atm_nightly-digest": false, "atm_credit-refresh": false });
    } finally {
      await stack.close();
    }
  });

  it("leaves a chat-authored record alone: a code reconcile only ever diffs its own author", async () => {
    const stack = await createStack();
    try {
      const ctx = ownerCtx(ADA.subject);
      const chatOwned = await stack.create({
        owner: ADA,
        when: { event: "invoice.paid" },
        task: { kind: "steps", steps: [{ id: "list", tool: "host_invoices_list" }] },
        authoredBy: "chat",
      }, ctx);

      const support = agent({ name: "support", store: stack.store });
      support.on("0 2 * * *", "rebuild the digest", { id: "nightly-digest" });
      await boot(stack, agentAutomations(support), ADA, ctx);

      // The chat record is untouched — not disarmed, not superseded, not
      // rewritten. A user's automation is not the deployment's to reconcile.
      expect(await stack.automations.get(chatOwned.id, ctx))
        .toMatchObject({ id: chatOwned.id, authoredBy: "chat", armed: true });
    } finally {
      await stack.close();
    }
  });

  it("refuses a schedule that is not one, at declaration, before the process serves anything", async () => {
    const stack = await createStack();
    try {
      const support = agent({ name: "support", store: stack.store });
      // Synchronous, at the declaration site — not at boot, and not at fire.
      expect(() => support.on("every monday", "summarize the week"))
        .toThrow(expect.objectContaining({ code: "validation" }));
      expect(agentAutomations(support)).toEqual([]);
    } finally {
      await stack.close();
    }
  });
});
