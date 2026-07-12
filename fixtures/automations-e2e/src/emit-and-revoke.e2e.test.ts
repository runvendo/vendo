/** 07 §2 host-event scoping and 07 §3 revocation:
 *  - emit fires only the EMITTING principal's automations, even when a second
 *    principal has an enabled automation on the identical event name.
 *  - revoking a captured grant disarms nothing; the next away run simply parks
 *    pending-approval (the guard binding, not a cached decision, gates the run).
 */
import { beforeEach, describe, expect, it } from "vitest";
import { automationDoc, createStack, ownerCtx, resetFixture } from "./harness.js";
import { ADA, BOB, enableAndApprove, fixtureInvoices } from "./support.js";

const listTrigger = {
  on: { kind: "host-event" as const, event: "shared.event" },
  run: { kind: "steps" as const, steps: [{ id: "list", tool: "host_invoices_list" }] },
};

describe("host-event scoping and grant revocation", () => {
  beforeEach(resetFixture);

  it("fires only the emitting principal's automation for a shared event name", async () => {
    const stack = await createStack();
    try {
      const adaApp = "app_shared_ada";
      const bobApp = "app_shared_bob";
      await stack.putApp(ADA.subject, automationDoc({ id: adaApp, trigger: listTrigger }));
      await stack.putApp(BOB.subject, automationDoc({ id: bobApp, trigger: listTrigger }));
      await enableAndApprove(stack, adaApp, ownerCtx(ADA.subject, adaApp));
      await enableAndApprove(stack, bobApp, ownerCtx(BOB.subject, bobApp));

      const adaRuns = await stack.automations.emit("shared.event", {}, ADA);
      expect(adaRuns).toHaveLength(1);

      const byApp = await stack.sql<{ app_id: string; count: unknown }>(
        "SELECT app_id, COUNT(*)::int AS count FROM vendo_runs GROUP BY app_id ORDER BY app_id",
      );
      expect(byApp.map(({ app_id, count }) => ({ app_id, count: Number(count) })))
        .toEqual([{ app_id: adaApp, count: 1 }]);

      // Bob's identically-named automation only fires for Bob's own emit.
      const bobRuns = await stack.automations.emit("shared.event", {}, BOB);
      expect(bobRuns).toHaveLength(1);
      expect(Number((await stack.sql<{ count: unknown }>(
        "SELECT COUNT(*)::int AS count FROM vendo_runs WHERE app_id = $1",
        [bobApp],
      ))[0]?.count)).toBe(1);
    } finally {
      await stack.close();
    }
  });

  it("parks the next run after its standing grant is revoked", async () => {
    const stack = await createStack();
    try {
      const appId = "app_revoke_park";
      const ctx = ownerCtx(ADA.subject, appId);
      await stack.putApp(ADA.subject, automationDoc({
        id: appId,
        trigger: {
          on: { kind: "host-event", event: "invoice.autosend" },
          run: { kind: "steps", steps: [{ id: "send", tool: "host_invoices_send", args: { id: "event.id" } }] },
        },
      }));
      await enableAndApprove(stack, appId, ctx);

      // First run: the captured grant authorizes the away send.
      const first = await stack.automations.emit("invoice.autosend", { id: "inv_0003" }, ADA);
      expect((await stack.automations.runs.get(first[0] ?? "", ctx))?.status).toBe("ok");
      expect((await fixtureInvoices()).find(({ id }) => id === "inv_0003")?.status).toBe("open");

      // Revoke the standing automation grant.
      const grants = await stack.guard.grants.list(ADA);
      const grant = grants.find((entry) => entry.appId === appId && entry.tool === "host_invoices_send");
      if (!grant) throw new Error("automation grant not found");
      await stack.guard.grants.revoke(grant.id, ADA);
      expect((await stack.sql<{ revoked_at: unknown }>(
        "SELECT revoked_at FROM vendo_grants WHERE id = $1",
        [grant.id],
      ))[0]?.revoked_at).toBeTruthy();

      // Next run parks — revocation disarmed nothing, the run just asks again.
      // A parked run never executed the tool: the send outcome is the
      // pending-approval the guard returned in place of running it.
      const second = await stack.automations.emit("invoice.autosend", { id: "inv_0003" }, ADA);
      const secondId = second[0];
      if (!secondId) throw new Error("second emit did not return a run id");
      const secondRun = await stack.automations.runs.get(secondId, ctx);
      expect(secondRun?.status).toBe("pending-approval");
      expect(secondRun?.steps.at(-1)).toMatchObject({ tool: "host_invoices_send", outcome: "pending-approval" });
      const away = (await stack.guard.approvals.pending(ADA)).find((request) =>
        request.call.tool === "host_invoices_send"
        && request.ctx.presence === "away"
        && request.ctx.appId === appId
      );
      expect(away).toBeDefined();
    } finally {
      await stack.close();
    }
  });
});
