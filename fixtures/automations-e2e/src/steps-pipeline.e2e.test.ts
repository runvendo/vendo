import { beforeEach, describe, expect, it } from "vitest";
import { automationDoc, createStack, ownerCtx, resetFixture } from "./harness.js";
import { ADA, enableAndApprove, fixtureInvoices, record } from "./support.js";

describe("deterministic steps pipelines", () => {
  beforeEach(resetFixture);

  it("lists then fans out over open invoices, sends each, and records ordered outcomes", async () => {
    const stack = await createStack();
    try {
      const appId = "app_steps_fanout";
      await stack.putApp(ADA.subject, automationDoc({
        id: appId,
        trigger: {
          on: { kind: "host-event", event: "billing.sweep" },
          run: {
            kind: "steps",
            steps: [
              { id: "list", tool: "host_invoices_list" },
              {
                id: "send",
                tool: "host_invoices_send",
                forEach: "$filter(steps.list.invoices, function($invoice) { $invoice.status = 'open' })",
                args: { id: "item.id" },
              },
            ],
          },
        },
      }));
      const ctx = ownerCtx(ADA.subject, appId);
      await enableAndApprove(stack, appId, ctx);

      const runIds = await stack.automations.emit("billing.sweep", { requestedBy: "e2e" }, ADA);
      expect(runIds).toHaveLength(1);
      const runId = runIds[0];
      if (!runId) throw new Error("emit did not return a run id");
      const run = await stack.automations.runs.get(runId, ctx);
      expect(run?.status).toBe("ok");
      expect(run?.steps.map(({ id, outcome }) => ({ id, outcome }))).toEqual([
        { id: "list", outcome: "ok" },
        { id: "send", outcome: "ok" },
        { id: "send", outcome: "ok" },
      ]);
      expect(run?.summary?.trim()).not.toBe("");

      const storedRows = await stack.sql<{ status: string; record: unknown }>(
        "SELECT status, record FROM vendo_runs WHERE id = $1",
        [runId],
      );
      expect(storedRows[0]?.status).toBe("ok");
      const stored = record(storedRows[0]?.record);
      const storedSteps = stored.steps;
      if (!Array.isArray(storedSteps)) throw new Error("Persisted RunRecord omitted steps[]");
      expect(storedSteps.map((step) => {
        const entry = record(step);
        return { id: entry.id, outcome: entry.outcome };
      })).toEqual([
        { id: "list", outcome: "ok" },
        { id: "send", outcome: "ok" },
        { id: "send", outcome: "ok" },
      ]);
      expect(typeof stored.summary).toBe("string");

      const invoices = await fixtureInvoices();
      expect(invoices.find(({ id }) => id === "inv_0002")?.status).toBe("open");
      expect(invoices.find(({ id }) => id === "inv_0005")?.status).toBe("open");
      expect(Number((await stack.sql<{ count: unknown }>(
        "SELECT COUNT(*)::int AS count FROM vendo_audit WHERE kind = 'run' AND app_id = $1",
        [appId],
      ))[0]?.count)).toBeGreaterThanOrEqual(2);
    } finally {
      await stack.close();
    }
  });

  it("resolves event arguments and cross-step outputs", async () => {
    const stack = await createStack();
    try {
      const appId = "app_steps_reference";
      await stack.putApp(ADA.subject, automationDoc({
        id: appId,
        trigger: {
          on: { kind: "host-event", event: "invoice.requested" },
          run: {
            kind: "steps",
            steps: [
              {
                id: "create",
                tool: "host_invoices_create",
                args: {
                  customerId: "event.customerId",
                  amountCents: "event.amountCents",
                  currency: "event.currency",
                  memo: "event.memo",
                },
              },
              { id: "get", tool: "host_invoices_get", args: { id: "steps.create.invoice.id" } },
            ],
          },
        },
      }));
      const ctx = ownerCtx(ADA.subject, appId);
      await enableAndApprove(stack, appId, ctx);
      const ids = await stack.automations.emit("invoice.requested", {
        customerId: "cus_ada",
        amountCents: 7777,
        currency: "USD",
        memo: "cross-step sentinel",
      }, ADA);
      const id = ids[0];
      if (!id) throw new Error("emit did not return a run id");
      expect(await stack.automations.runs.get(id, ctx)).toMatchObject({
        status: "ok",
        steps: [
          { id: "create", outcome: "ok" },
          { id: "get", outcome: "ok" },
        ],
      });
      expect((await fixtureInvoices()).find(({ memo }) => memo === "cross-step sentinel"))
        .toMatchObject({ id: "inv_9001", amountCents: 7777 });
    } finally {
      await stack.close();
    }
  });

  it("skips a false conditional without executing the tool", async () => {
    const stack = await createStack();
    try {
      const appId = "app_steps_skip";
      await stack.putApp(ADA.subject, automationDoc({
        id: appId,
        trigger: {
          on: { kind: "host-event", event: "invoice.maybe-update" },
          run: {
            kind: "steps",
            steps: [{
              id: "never",
              tool: "host_invoices_update",
              if: "false",
              args: { id: "'inv_0003'", memo: "'should not appear'" },
            }],
          },
        },
      }));
      const ctx = ownerCtx(ADA.subject, appId);
      await enableAndApprove(stack, appId, ctx);
      const ids = await stack.automations.emit("invoice.maybe-update", {}, ADA);
      const id = ids[0];
      if (!id) throw new Error("emit did not return a run id");
      const run = await stack.automations.runs.get(id, ctx);
      expect(run?.status).toBe("ok");
      expect(run?.steps.some((step) => step.id === "never")).toBe(false);
      expect((await fixtureInvoices()).find((invoice) => invoice.id === "inv_0003")?.memo).toBe("Technical notes");
    } finally {
      await stack.close();
    }
  });

  it("stops after the first hard failure", async () => {
    const stack = await createStack();
    try {
      const appId = "app_steps_failure";
      await stack.putApp(ADA.subject, automationDoc({
        id: appId,
        trigger: {
          on: { kind: "host-event", event: "invoice.fail" },
          run: {
            kind: "steps",
            steps: [
              { id: "missing", tool: "host_invoices_get", args: { id: "'inv_9999'" } },
              { id: "later", tool: "host_invoices_send", args: { id: "'inv_0003'" } },
            ],
          },
        },
      }));
      const ctx = ownerCtx(ADA.subject, appId);
      await enableAndApprove(stack, appId, ctx);
      const ids = await stack.automations.emit("invoice.fail", {}, ADA);
      const id = ids[0];
      if (!id) throw new Error("emit did not return a run id");
      const run = await stack.automations.runs.get(id, ctx);
      expect(run?.status).toBe("error");
      expect(run?.steps[0]).toMatchObject({ id: "missing", outcome: "error" });
      expect(run?.steps.some((step) => step.id === "later")).toBe(false);
      expect((await fixtureInvoices()).find((invoice) => invoice.id === "inv_0003")?.status).toBe("draft");
    } finally {
      await stack.close();
    }
  });

  it("fires once per due schedule window and collapses missed windows", async () => {
    let clock = new Date("2026-07-12T00:00:00.000Z");
    const stack = await createStack({ now: () => clock });
    try {
      const appId = "app_steps_schedule";
      await stack.putApp(ADA.subject, automationDoc({
        id: appId,
        trigger: {
          on: { kind: "schedule", every: "15m" },
          run: { kind: "steps", steps: [{ id: "list", tool: "host_invoices_list" }] },
        },
      }));
      await enableAndApprove(stack, appId, ownerCtx(ADA.subject, appId));

      clock = new Date("2026-07-12T00:20:00.000Z");
      expect(await stack.automations.tick(clock)).toHaveLength(1);
      clock = new Date("2026-07-12T00:40:00.000Z");
      expect(await stack.automations.tick(clock)).toHaveLength(1);
      clock = new Date("2026-07-12T01:25:00.000Z");
      expect(await stack.automations.tick(clock)).toHaveLength(1);
      expect(Number((await stack.sql<{ count: unknown }>(
        "SELECT COUNT(*)::int AS count FROM vendo_runs WHERE app_id = $1",
        [appId],
      ))[0]?.count)).toBe(3);
    } finally {
      await stack.close();
    }
  });

  it("executes only through the guard-bound registry and records a policy block", async () => {
    const stack = await createStack({
      policy: { rules: [{ match: { risk: "write" }, action: "block", note: "e2e guard choke point" }] },
    });
    try {
      const appId = "app_steps_policy";
      await stack.putApp(ADA.subject, automationDoc({
        id: appId,
        trigger: {
          on: { kind: "host-event", event: "invoice.policy" },
          run: {
            kind: "steps",
            steps: [{ id: "blocked", tool: "host_invoices_send", args: { id: "'inv_0003'" } }],
          },
        },
      }));
      const ctx = ownerCtx(ADA.subject, appId);
      await stack.automations.enable(appId, ctx);
      const ids = await stack.automations.emit("invoice.policy", {}, ADA);
      const id = ids[0];
      if (!id) throw new Error("emit did not return a run id");
      expect(await stack.automations.runs.get(id, ctx)).toMatchObject({
        status: "error",
        steps: [{ id: "blocked", outcome: "blocked" }],
      });
      expect((await fixtureInvoices()).find((invoice) => invoice.id === "inv_0003")?.status).toBe("draft");
    } finally {
      await stack.close();
    }
  });
});
