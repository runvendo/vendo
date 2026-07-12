import { beforeEach, describe, expect, it } from "vitest";
import { automationDoc, createStack, ownerCtx, resetFixture } from "./harness.js";
import { ADA, BOB, approve } from "./support.js";

const surface = ["host_invoices_list", "host_invoices_send"];

const trigger = {
  on: { kind: "host-event" as const, event: "invoice.ready" },
  run: {
    kind: "steps" as const,
    steps: [
      { id: "list", tool: surface[0] ?? "host_invoices_list" },
      { id: "send", tool: surface[1] ?? "host_invoices_send", args: { id: "event.id" } },
    ],
  },
};

describe("enable capture", () => {
  beforeEach(resetFixture);

  it("arms immediately, captures pending approvals, mints app-bound grants, and never transfers them", async () => {
    const stack = await createStack();
    try {
      const firstId = "app_enable_first";
      await stack.putApp(ADA.subject, automationDoc({ id: firstId, trigger }));

      const enabled = await stack.automations.enable(firstId, ownerCtx(ADA.subject, firstId));
      expect(enabled.enabled).toBe(true);
      expect(enabled.missing.map((request) => request.call.tool).sort()).toEqual([...surface].sort());

      const approvals = await stack.sql<{
        id: string;
        subject: string;
        status: string;
        app_id: string | null;
        venue: string;
        presence: string;
      }>(
        `SELECT id, subject, status,
                request->'ctx'->>'appId' AS app_id,
                request->'ctx'->>'venue' AS venue,
                request->'ctx'->>'presence' AS presence
           FROM vendo_approvals
          WHERE subject = $1 AND status = 'pending'
          ORDER BY id`,
        [ADA.subject],
      );
      expect(approvals).toHaveLength(2);
      expect(approvals.map((row) => row.app_id)).toEqual([firstId, firstId]);
      // Capture approvals are minted FOR the automation (venue "automation")
      // while the user is present — the capture moment of 07 §3.
      expect(approvals.map((row) => [row.venue, row.presence])).toEqual([
        ["automation", "present"],
        ["automation", "present"],
      ]);
      expect((await stack.sql<{ enabled: boolean }>("SELECT enabled FROM vendo_apps WHERE id = $1", [firstId]))[0]?.enabled)
        .toBe(true);

      await approve(stack, enabled.missing);
      const grants = await stack.sql<{
        subject: string;
        tool: string;
        app_id: string | null;
        source: string;
        duration: string;
        scope: unknown;
      }>(
        `SELECT subject, tool, app_id, source, duration, scope
           FROM vendo_grants
          WHERE subject = $1 AND app_id = $2
          ORDER BY tool`,
        [ADA.subject, firstId],
      );
      expect(grants.map(({ subject, tool, app_id, source, duration }) => ({ subject, tool, app_id, source, duration })))
        .toEqual(surface.slice().sort().map((tool) => ({
          subject: ADA.subject,
          tool,
          app_id: firstId,
          source: "automation",
          duration: "standing",
        })));
      expect(grants.map((row) => row.scope)).toEqual([{ kind: "tool" }, { kind: "tool" }]);

      expect((await stack.automations.enable(firstId, ownerCtx(ADA.subject, firstId))).missing).toEqual([]);

      const secondId = "app_enable_second";
      await stack.putApp(ADA.subject, automationDoc({ id: secondId, trigger }));
      const second = await stack.automations.enable(secondId, ownerCtx(ADA.subject, secondId));
      expect(second.missing.map((request) => request.call.tool).sort()).toEqual([...surface].sort());
    } finally {
      await stack.close();
    }
  });

  it("does not mint a grant for a denied enable request", async () => {
    const stack = await createStack();
    try {
      const appId = "app_enable_denied";
      const deniedTool = "host_invoices_update";
      await stack.putApp(ADA.subject, automationDoc({
        id: appId,
        trigger: {
          on: { kind: "host-event", event: "invoice.change" },
          run: { kind: "steps", steps: [{ id: "update", tool: deniedTool, args: { id: "event.id" } }] },
        },
      }));
      const result = await stack.automations.enable(appId, ownerCtx(ADA.subject, appId));
      expect(result.missing).toHaveLength(1);
      const request = result.missing[0];
      if (!request) throw new Error("Enable omitted the denied tool approval");
      await stack.guard.approvals.decide(request.id, { approve: false }, ADA);
      expect(await stack.sql("SELECT id FROM vendo_grants WHERE subject = $1 AND app_id = $2 AND tool = $3", [
        ADA.subject,
        appId,
        deniedTool,
      ])).toEqual([]);
    } finally {
      await stack.close();
    }
  });

  it("lists trigger apps, reflects disable, and rejects non-owner enable without changing state", async () => {
    const stack = await createStack();
    try {
      const appId = "app_enable_owner";
      await stack.putApp(ADA.subject, automationDoc({ id: appId, trigger }));
      await expect(stack.automations.enable(appId, ownerCtx(BOB.subject, appId))).rejects.toBeInstanceOf(Error);
      expect((await stack.sql<{ enabled: boolean }>("SELECT enabled FROM vendo_apps WHERE id = $1", [appId]))[0]?.enabled)
        .toBe(false);

      await stack.automations.enable(appId, ownerCtx(ADA.subject, appId));
      expect((await stack.automations.list(ownerCtx(ADA.subject))).map(({ app, enabled }) => ({ id: app.id, enabled })))
        .toEqual([{ id: appId, enabled: true }]);
      expect(await stack.automations.list(ownerCtx(BOB.subject))).toEqual([]);

      await stack.automations.disable(appId, ownerCtx(ADA.subject, appId));
      expect((await stack.automations.list(ownerCtx(ADA.subject))).map(({ app, enabled }) => ({ id: app.id, enabled })))
        .toEqual([{ id: appId, enabled: false }]);
    } finally {
      await stack.close();
    }
  });
});
