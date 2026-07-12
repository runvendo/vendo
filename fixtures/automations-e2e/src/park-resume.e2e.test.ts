import { descriptorHash, type PermissionGrant, type RunContext } from "@vendoai/core";
import { beforeEach, describe, expect, it } from "vitest";
import { automationDoc, createStack, ownerCtx, resetFixture, type Stack } from "./harness.js";
import { ADA, approve, fixtureInvoices, waitForRun } from "./support.js";

interface ParkedSetup {
  stack: Stack;
  appId: string;
  ctx: RunContext;
  runId: string;
  approvalId: string;
}

async function createParked(suffix: string): Promise<ParkedSetup> {
  const stack = await createStack();
  const appId = `app_park_${suffix}`;
  const ctx = ownerCtx(ADA.subject, appId);
  await stack.putApp(ADA.subject, automationDoc({
    id: appId,
    trigger: {
      on: { kind: "host-event", event: "invoice.park" },
      run: {
        kind: "steps",
        steps: [
          { id: "list", tool: "host_invoices_list" },
          { id: "send", tool: "host_invoices_send", args: { id: "event.id" } },
        ],
      },
    },
  }));
  const enabled = await stack.automations.enable(appId, ctx);
  await approve(stack, enabled.missing.filter((request) => request.call.tool === "host_invoices_list"));
  const runIds = await stack.automations.emit("invoice.park", { id: "inv_0003" }, ADA);
  const runId = runIds[0];
  if (!runId) throw new Error("emit did not return a run id");
  const pending = await stack.guard.approvals.pending(ADA);
  const parked = pending.find((request) =>
    request.call.tool === "host_invoices_send"
    && request.ctx.venue === "automation"
    && request.ctx.presence === "away"
    && request.ctx.appId === appId
  );
  if (!parked) throw new Error("Parked run did not create an away approval");
  return { stack, appId, ctx, runId, approvalId: parked.id };
}

describe("away run park and resume", () => {
  beforeEach(resetFixture);

  it("parks an ungranted write, resumes after approval, mints an app grant, and reuses it", async () => {
    const setup = await createParked("approve");
    try {
      expect(await setup.stack.automations.runs.get(setup.runId, setup.ctx)).toMatchObject({
        status: "pending-approval",
        steps: [
          { id: "list", outcome: "ok" },
          { id: "send", outcome: "pending-approval" },
        ],
      });
      expect((await setup.stack.sql<{ status: string }>(
        "SELECT status FROM vendo_runs WHERE id = $1",
        [setup.runId],
      ))[0]?.status).toBe("pending-approval");
      const approvalRows = await setup.stack.sql<{
        venue: string;
        presence: string;
        app_id: string | null;
      }>(
        `SELECT request->'ctx'->>'venue' AS venue,
                request->'ctx'->>'presence' AS presence,
                request->'ctx'->>'appId' AS app_id
           FROM vendo_approvals WHERE id = $1`,
        [setup.approvalId],
      );
      expect(approvalRows).toEqual([{ venue: "automation", presence: "away", app_id: setup.appId }]);

      await setup.stack.guard.approvals.decide(setup.approvalId, { approve: true }, ADA);
      expect((await waitForRun(setup.stack, setup.runId, setup.ctx, "ok")).status).toBe("ok");
      expect((await fixtureInvoices()).find(({ id }) => id === "inv_0003")?.status).toBe("open");
      expect(await setup.stack.sql(
        `SELECT subject, tool, app_id, source, duration
           FROM vendo_grants
          WHERE subject = $1 AND tool = 'host_invoices_send' AND app_id = $2`,
        [ADA.subject, setup.appId],
      )).toEqual([{
        subject: ADA.subject,
        tool: "host_invoices_send",
        app_id: setup.appId,
        source: "automation",
        duration: "standing",
      }]);

      const nextIds = await setup.stack.automations.emit("invoice.park", { id: "inv_0003" }, ADA);
      const nextId = nextIds[0];
      if (!nextId) throw new Error("second emit did not return a run id");
      expect(await setup.stack.automations.runs.get(nextId, setup.ctx)).toMatchObject({ status: "ok" });
    } finally {
      await setup.stack.close();
    }
  });

  it("ends the run in error after denial and does not perform the write", async () => {
    const setup = await createParked("deny");
    try {
      await setup.stack.guard.approvals.decide(setup.approvalId, { approve: false }, ADA);
      expect((await waitForRun(setup.stack, setup.runId, setup.ctx, "error")).status).toBe("error");
      expect((await fixtureInvoices()).find(({ id }) => id === "inv_0003")?.status).toBe("draft");
      expect(await setup.stack.sql(
        "SELECT id FROM vendo_grants WHERE subject = $1 AND tool = 'host_invoices_send' AND app_id = $2",
        [ADA.subject, setup.appId],
      )).toEqual([]);
    } finally {
      await setup.stack.close();
    }
  });

  it("stops a parked run and a later decision cannot revive it", async () => {
    const setup = await createParked("stop");
    try {
      await setup.stack.automations.runs.stop(setup.runId, setup.ctx);
      expect(await setup.stack.automations.runs.get(setup.runId, setup.ctx)).toMatchObject({ status: "stopped" });
      await setup.stack.guard.approvals.decide(setup.approvalId, { approve: true }, ADA);
      expect(await waitForRun(setup.stack, setup.runId, setup.ctx, "stopped")).toMatchObject({ status: "stopped" });
      expect((await fixtureInvoices()).find(({ id }) => id === "inv_0003")?.status).toBe("draft");
    } finally {
      await setup.stack.close();
    }
  });

  it("does not let a standing chat grant authorize an away app run", async () => {
    const stack = await createStack();
    try {
      const appId = "app_park_chat_grant";
      const ctx = ownerCtx(ADA.subject, appId);
      await stack.putApp(ADA.subject, automationDoc({
        id: appId,
        trigger: {
          on: { kind: "host-event", event: "invoice.chat-grant" },
          run: {
            kind: "steps",
            steps: [
              { id: "list", tool: "host_invoices_list" },
              { id: "send", tool: "host_invoices_send", args: { id: "event.id" } },
            ],
          },
        },
      }));
      const enabled = await stack.automations.enable(appId, ctx);
      await approve(stack, enabled.missing.filter((request) => request.call.tool === "host_invoices_list"));
      const descriptor = (await stack.bound.descriptors()).find(({ name }) => name === "host_invoices_send");
      if (!descriptor) throw new Error("Harness omitted host_invoices_send");
      const chatGrant: PermissionGrant = {
        id: "grt_chat_send",
        subject: ADA.subject,
        tool: descriptor.name,
        descriptorHash: descriptorHash(descriptor),
        scope: { kind: "tool" },
        duration: "standing",
        source: "chat",
        grantedAt: "2026-07-12T00:00:00.000Z",
      };
      await stack.store.records("vendo_grants").put({ id: chatGrant.id, data: chatGrant });

      const ids = await stack.automations.emit("invoice.chat-grant", { id: "inv_0003" }, ADA);
      const id = ids[0];
      if (!id) throw new Error("emit did not return a run id");
      expect(await stack.automations.runs.get(id, ctx)).toMatchObject({ status: "pending-approval" });
      const away = (await stack.guard.approvals.pending(ADA)).find((request) =>
        request.call.tool === "host_invoices_send"
        && request.ctx.presence === "away"
        && request.ctx.appId === appId
      );
      expect(away).toBeDefined();
      expect((await fixtureInvoices()).find(({ id: invoiceId }) => invoiceId === "inv_0003")?.status).toBe("draft");
    } finally {
      await stack.close();
    }
  });
});
