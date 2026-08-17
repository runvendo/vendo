/** 07 §2 host-event scoping and 07 §3 revocation:
 *  - emit fires only the EMITTING principal's automations, even when a second
 *    principal owns a record listening on the identical event name.
 *  - revoking a captured grant disarms nothing; the next away run simply fails
 *    LOUDLY and asks again (the guard binding, not a cached decision, gates the
 *    run).
 */
import type { CreateAutomationInput, Principal } from "@vendoai/core";
import { beforeEach, describe, expect, it } from "vitest";
import { createStack, ownerCtx, resetFixture } from "../src/harness.js";
import { ADA, BOB, enableAndApprove, fixtureInvoices, runCount } from "../src/support.js";

/** The same automation, twice over, differing only in who owns it. */
const sharedListener = (owner: Principal): CreateAutomationInput => ({
  owner,
  when: { event: "shared.event" },
  task: { kind: "steps", steps: [{ id: "list", tool: "host_invoices_list" }] },
  authoredBy: "chat",
});

describe("host-event scoping and grant revocation", () => {
  beforeEach(resetFixture);

  it("fires only the emitting principal's automation for a shared event name", async () => {
    const stack = await createStack();
    try {
      const adaCtx = ownerCtx(ADA.subject);
      const bobCtx = ownerCtx(BOB.subject);
      const ada = await stack.create(sharedListener(ADA), adaCtx);
      const bob = await stack.create(sharedListener(BOB), bobCtx);
      await enableAndApprove(stack, ada.id, adaCtx);
      await enableAndApprove(stack, bob.id, bobCtx);

      expect(await stack.automations.emit("shared.event", {}, ADA)).toHaveLength(1);

      // One event name, two owners, and the ledger names exactly one automation.
      const byAutomation = await stack.sql<{ automation_id: string; count: unknown }>(
        "SELECT automation_id, COUNT(*)::int AS count FROM vendo_runs GROUP BY automation_id",
      );
      expect(byAutomation.map(({ automation_id, count }) => ({ automation_id, count: Number(count) })))
        .toEqual([{ automation_id: ada.id, count: 1 }]);

      // Bob's identically-shaped automation only fires for Bob's own emit.
      expect(await stack.automations.emit("shared.event", {}, BOB)).toHaveLength(1);
      expect(await runCount(stack, bob.id)).toBe(1);
    } finally {
      await stack.close();
    }
  });

  // The subject here is REVOCATION being live — the next run asks again. It
  // rides a non-destructive write (PATCH `host_invoices_update`) because THE LAW
  // (design §12) refuses a destructive or external action in an unattended run
  // outright, so the "first run succeeds on its captured grant" premise this
  // scenario needs is only reachable for a legal write. The law's own refusal is
  // proven in redteam/away-authority.e2e.test.ts.
  it("fails the next run loud with needs-permission after its standing grant is revoked", async () => {
    const stack = await createStack();
    try {
      const ctx = ownerCtx(ADA.subject);
      const created = await stack.create({
        owner: ADA,
        when: { event: "invoice.autosend" },
        task: {
          kind: "steps",
          steps: [{ id: "send", tool: "host_invoices_update", args: { id: "event.id", memo: "'autoswept'" } }],
        },
        authoredBy: "chat",
      }, ctx);
      await enableAndApprove(stack, created.id, ctx);

      // First run: the captured grant authorizes the away write.
      const first = await stack.automations.emit("invoice.autosend", { id: "inv_0003" }, ADA);
      expect((await stack.automations.runs.get(first[0] ?? "", ctx))?.status).toBe("ok");
      expect((await fixtureInvoices()).find(({ id }) => id === "inv_0003")?.memo).toBe("autoswept");

      // Revoke the standing grant arming captured. It is keyed to the AUTOMATION:
      // there is no app to key it to any more.
      const [grant] = await stack.sql<{ id: string }>(
        "SELECT id FROM vendo_grants WHERE automation_id = $1 AND tool = $2",
        [created.id, "host_invoices_update"],
      );
      if (!grant) throw new Error("arming minted no grant for this automation");
      await stack.guard.grants.revoke(grant.id, ADA);

      // The next run FAILS LOUD — revocation disarmed nothing, the run just asks
      // again. It never executed the tool: the step outcome is the
      // pending-approval the guard returned in place of running it, and the run
      // itself is terminal with the permission it needed named on it.
      const second = await stack.automations.emit("invoice.autosend", { id: "inv_0003" }, ADA);
      const secondId = second[0];
      if (!secondId) throw new Error("second emit did not return a run id");
      const secondRun = await stack.automations.runs.get(secondId, ctx);
      expect(secondRun?.status).toBe("error");
      expect(secondRun?.error).toMatchObject({ code: "needs-permission", tool: "host_invoices_update" });
      expect(secondRun?.finishedAt).toBeTruthy();
      expect(secondRun?.steps.at(-1)).toMatchObject({ tool: "host_invoices_update", outcome: "pending-approval" });
      // The record is untouched by the revocation: still armed, still there.
      expect((await stack.automations.get(created.id, ctx))?.armed).toBe(true);

      const away = (await stack.guard.approvals.pending(ADA)).find((request) =>
        request.call.tool === "host_invoices_update" && request.ctx.presence === "away"
      );
      expect(away).toBeDefined();
      // With no arming ask left open for this permission, the miss captured the
      // live one itself — so the panel can offer Grant & re-run from the run row.
      const captures = await stack.sql<{ id: string; data: unknown }>(
        "SELECT id, data FROM vendo_records WHERE collection = 'automations:captures'",
      );
      expect(captures.map(({ id }) => id)).toEqual([away!.id]);
      expect(captures[0]?.data).toMatchObject({
        automationId: created.id,
        subject: ADA.subject,
        tool: "host_invoices_update",
      });
    } finally {
      await stack.close();
    }
  });
});
