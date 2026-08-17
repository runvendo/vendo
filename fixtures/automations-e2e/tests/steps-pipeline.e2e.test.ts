import { beforeEach, describe, expect, it } from "vitest";
import { createStack, ownerCtx, resetFixture } from "../src/harness.js";
import { ADA, enableAndApprove, fixtureInvoices, record, runCount } from "../src/support.js";

describe("deterministic steps pipelines", () => {
  beforeEach(resetFixture);

  // The subject here is the FAN-OUT machinery — forEach over a previous step's
  // output, one ordered step outcome per item, persisted and audited. It rides a
  // non-destructive write (PATCH `host_invoices_update`) because THE LAW
  // (design §12) never projects a destructive or external action into an
  // unattended run, so `host_invoices_send` could not reach the fan-out at all.
  // The law's own refusal is proven in park-resume.e2e.test.ts.
  it("lists then fans out over open invoices, updates each, and records ordered outcomes", async () => {
    const stack = await createStack();
    try {
      const ctx = ownerCtx(ADA.subject);
      const { id } = await stack.create({
        owner: ADA,
        when: { event: "billing.sweep" },
        task: {
          kind: "steps",
          steps: [
            { id: "list", tool: "host_invoices_list" },
            {
              id: "send",
              tool: "host_invoices_update",
              forEach: "$filter(steps.list.invoices, function($invoice) { $invoice.status = 'open' })",
              args: { id: "item.id", memo: "'swept'" },
            },
          ],
        },
        authoredBy: "chat",
      }, ctx);
      await enableAndApprove(stack, id, ctx);

      const runIds = await stack.automations.emit("billing.sweep", { requestedBy: "e2e" }, ADA);
      expect(runIds).toHaveLength(1);
      const runId = runIds[0];
      if (!runId) throw new Error("emit did not return a run id");
      const run = await stack.automations.runs.get(runId, ctx);
      expect(run?.status).toBe("ok");
      expect(run?.automationId).toBe(id);
      expect(run?.steps.map(({ id: step, outcome }) => ({ id: step, outcome }))).toEqual([
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

      // Each fanned-out item really executed against the host: both open
      // invoices carry the memo the step wrote. (Asserting only `status` would
      // now pass vacuously — `open` is what the forEach filtered ON.)
      const invoices = await fixtureInvoices();
      expect(invoices.find(({ id: invoice }) => invoice === "inv_0002")?.memo).toBe("swept");
      expect(invoices.find(({ id: invoice }) => invoice === "inv_0005")?.memo).toBe("swept");
      expect(await runCount(stack, id)).toBe(1);

      // Audit enrichment (ENG-264): every guard tool-call event from a
      // trigger-fired away run carries the trigger ref
      // { runId, kind, id, lineageId } into the persisted audit row's event
      // jsonb. `id` names the AUTOMATION now — the dimension the guard matches
      // an away grant on, since grants are keyed to `automation_id` — so the
      // trail says whose authority each call ran under, and `lineageId` names
      // the FIRING the effect ledger keys receipts on (this run is nobody's
      // re-run, so it is its own root).
      const triggered = await stack.sql<{
        trigger: { runId?: string; kind?: string; automationId?: string; lineageId?: string } | null;
      }>(
        "SELECT event->'trigger' AS trigger FROM vendo_audit "
        + "WHERE kind = 'tool-call' AND event->'trigger'->>'runId' = $1",
        [runId],
      );
      expect(triggered.length).toBeGreaterThanOrEqual(3);
      for (const row of triggered) {
        // Every audited call names the RECORD that fired it — the guard's own
        // away-grant key — not an app.
        expect(row.trigger).toEqual({ runId, kind: "host-event", automationId: id, lineageId: runId });
      }
    } finally {
      await stack.close();
    }
  });

  it("resolves event arguments and cross-step outputs", async () => {
    const stack = await createStack();
    try {
      const ctx = ownerCtx(ADA.subject);
      const { id } = await stack.create({
        owner: ADA,
        when: { event: "invoice.requested" },
        task: {
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
        authoredBy: "chat",
      }, ctx);
      await enableAndApprove(stack, id, ctx);

      const ids = await stack.automations.emit("invoice.requested", {
        customerId: "cus_ada",
        amountCents: 7777,
        currency: "USD",
        memo: "cross-step sentinel",
      }, ADA);
      const runId = ids[0];
      if (!runId) throw new Error("emit did not return a run id");
      expect(await stack.automations.runs.get(runId, ctx)).toMatchObject({
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
      const ctx = ownerCtx(ADA.subject);
      const { id } = await stack.create({
        owner: ADA,
        when: { event: "invoice.maybe-update" },
        task: {
          kind: "steps",
          steps: [{
            id: "never",
            tool: "host_invoices_update",
            if: "false",
            args: { id: "'inv_0003'", memo: "'should not appear'" },
          }],
        },
        authoredBy: "chat",
      }, ctx);
      await enableAndApprove(stack, id, ctx);

      const ids = await stack.automations.emit("invoice.maybe-update", {}, ADA);
      const runId = ids[0];
      if (!runId) throw new Error("emit did not return a run id");
      const run = await stack.automations.runs.get(runId, ctx);
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
      const ctx = ownerCtx(ADA.subject);
      const { id } = await stack.create({
        owner: ADA,
        when: { event: "invoice.fail" },
        task: {
          kind: "steps",
          steps: [
            { id: "missing", tool: "host_invoices_get", args: { id: "'inv_9999'" } },
            { id: "later", tool: "host_invoices_send", args: { id: "'inv_0003'" } },
          ],
        },
        authoredBy: "chat",
      }, ctx);
      await enableAndApprove(stack, id, ctx);

      const ids = await stack.automations.emit("invoice.fail", {}, ADA);
      const runId = ids[0];
      if (!runId) throw new Error("emit did not return a run id");
      const run = await stack.automations.runs.get(runId, ctx);
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
      const ctx = ownerCtx(ADA.subject);
      const { id } = await stack.create({
        owner: ADA,
        when: { every: "15m" },
        task: { kind: "steps", steps: [{ id: "list", tool: "host_invoices_list" }] },
        authoredBy: "chat",
      }, ctx);
      await enableAndApprove(stack, id, ctx);

      clock = new Date("2026-07-12T00:20:00.000Z");
      expect(await stack.automations.tick(clock)).toHaveLength(1);
      clock = new Date("2026-07-12T00:40:00.000Z");
      expect(await stack.automations.tick(clock)).toHaveLength(1);
      clock = new Date("2026-07-12T01:25:00.000Z");
      expect(await stack.automations.tick(clock)).toHaveLength(1);
      expect(await runCount(stack, id)).toBe(3);
    } finally {
      await stack.close();
    }
  });

  it("executes only through the guard-bound registry and records a policy block", async () => {
    const stack = await createStack({
      policy: { rules: [{ match: { risk: "write" }, action: "block", note: "e2e guard choke point" }] },
    });
    try {
      const ctx = ownerCtx(ADA.subject);
      const { id } = await stack.create({
        owner: ADA,
        when: { event: "invoice.policy" },
        // A declared WRITE, so the block rule above is what stops it — the send
        // tool is declared destructive now and would be refused by THE LAW
        // before any policy rule got a say.
        task: { kind: "steps", steps: [{ id: "blocked", tool: "host_invoices_update", args: { id: "'inv_0003'" } }] },
        authoredBy: "chat",
      }, ctx);
      // Armed without approving the capture: the policy is what refuses, not a
      // missing grant.
      await stack.automations.enable(id, ctx);

      const ids = await stack.automations.emit("invoice.policy", {}, ADA);
      const runId = ids[0];
      if (!runId) throw new Error("emit did not return a run id");
      expect(await stack.automations.runs.get(runId, ctx)).toMatchObject({
        status: "error",
        steps: [{ id: "blocked", outcome: "blocked" }],
      });
      expect((await fixtureInvoices()).find((invoice) => invoice.id === "inv_0003")?.status).toBe("draft");
    } finally {
      await stack.close();
    }
  });
});
