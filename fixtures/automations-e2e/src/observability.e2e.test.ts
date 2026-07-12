import { beforeEach, describe, expect, it } from "vitest";
import { automationDoc, createStack, ownerCtx, resetFixture } from "./harness.js";
import { ADA, BOB, approve, enableAndApprove, fixtureInvoices, tableCount } from "./support.js";

describe("run observability and dry-run", () => {
  beforeEach(resetFixture);

  it("filters and paginates newest-first while keeping get/list owner-scoped", async () => {
    let clock = new Date("2026-07-12T00:00:00.000Z");
    const stack = await createStack({ now: () => clock });
    try {
      const appId = "app_observe_pages";
      const ctx = ownerCtx(ADA.subject, appId);
      await stack.putApp(ADA.subject, automationDoc({
        id: appId,
        trigger: {
          on: { kind: "host-event", event: "observe.fire" },
          run: { kind: "steps", steps: [{ id: "list", tool: "host_invoices_list" }] },
        },
      }));
      const enabled = await stack.automations.enable(appId, ctx);
      await approve(stack, enabled.missing);

      const emitted: string[] = [];
      for (let index = 0; index < 55; index += 1) {
        clock = new Date(Date.parse("2026-07-12T00:00:00.000Z") + index * 1_000);
        const ids = await stack.automations.emit("observe.fire", { index }, ADA);
        const id = ids[0];
        if (!id) throw new Error(`emit ${index} did not return a run id`);
        emitted.push(id);
      }

      const seen: string[] = [];
      let cursor: string | undefined;
      let pageCount = 0;
      do {
        const page = await stack.automations.runs.list({ appId, status: "ok", cursor }, ctx);
        pageCount += 1;
        seen.push(...page.runs.map(({ id }) => id));
        cursor = page.cursor;
      } while (cursor !== undefined);
      expect(pageCount).toBeGreaterThan(1);
      expect(seen).toEqual([...emitted].reverse());
      expect(await stack.automations.runs.list({ appId, status: "error" }, ctx)).toEqual({ runs: [] });

      const target = emitted[0];
      if (!target) throw new Error("No run was emitted");
      expect(await stack.automations.runs.get(target, ownerCtx(BOB.subject, appId))).toBeNull();
      expect(await stack.automations.runs.list({ appId }, ownerCtx(BOB.subject, appId))).toEqual({ runs: [] });
      await expect(stack.automations.runs.stop(target, ctx)).rejects.toMatchObject({ code: "conflict" });
    } finally {
      await stack.close();
    }
  });

  it("expands forEach plans and dry-runs without writing runs or approvals", async () => {
    const stack = await createStack();
    try {
      const appId = "app_observe_dry";
      const ctx = ownerCtx(ADA.subject, appId);
      await stack.putApp(ADA.subject, automationDoc({
        id: appId,
        trigger: {
          on: { kind: "host-event", event: "observe.plan" },
          run: {
            kind: "steps",
            steps: [
              { id: "list", tool: "host_invoices_list" },
              {
                id: "send",
                tool: "host_invoices_send",
                forEach: "event.items",
                args: { id: "item.id" },
              },
            ],
          },
        },
      }));
      const enabled = await stack.automations.enable(appId, ctx);
      const runsBefore = await tableCount(stack, "vendo_runs");
      const approvalsBefore = await tableCount(stack, "vendo_approvals");

      const preGrant = await stack.automations.dryRun(appId, ctx, {
        items: [{ id: "inv_0002" }, { id: "inv_0005" }],
      });
      expect(preGrant.steps.map(({ id, tool, wouldAsk }) => ({ id, tool, wouldAsk }))).toEqual([
        { id: "list", tool: "host_invoices_list", wouldAsk: true },
        { id: "send", tool: "host_invoices_send", wouldAsk: true },
        { id: "send", tool: "host_invoices_send", wouldAsk: true },
      ]);
      expect(preGrant.grantsMissing.slice().sort()).toEqual([
        "host_invoices_list",
        "host_invoices_send",
      ]);
      expect(await tableCount(stack, "vendo_runs")).toBe(runsBefore);
      expect(await tableCount(stack, "vendo_approvals")).toBe(approvalsBefore);

      await approve(stack, enabled.missing);
      const postGrant = await stack.automations.dryRun(appId, ctx, {
        items: [{ id: "inv_0002" }, { id: "inv_0005" }],
      });
      expect(postGrant.steps).toHaveLength(3);
      expect(postGrant.steps.every(({ wouldAsk }) => !wouldAsk)).toBe(true);
      expect(postGrant.grantsMissing).toEqual([]);
      expect(await tableCount(stack, "vendo_runs")).toBe(runsBefore);
      expect(await tableCount(stack, "vendo_approvals")).toBe(approvalsBefore);
    } finally {
      await stack.close();
    }
  });

  it("plans an agentic run across the whole bound surface and executes nothing", async () => {
    const stack = await createStack();
    try {
      const appId = "app_observe_agentic_dry";
      const ctx = ownerCtx(ADA.subject, appId);
      await stack.putApp(ADA.subject, automationDoc({
        id: appId,
        trigger: { on: { kind: "host-event", event: "observe.agent" }, run: { kind: "agentic", prompt: "do the books" } },
      }));
      const runsBefore = await tableCount(stack, "vendo_runs");
      const approvalsBefore = await tableCount(stack, "vendo_approvals");
      const invoicesBefore = (await fixtureInvoices()).length;

      const plan = await stack.automations.dryRun(appId, ctx);
      // Without a model seat, agentic capture previews every bound descriptor.
      expect(plan.steps.map(({ tool }) => tool).sort()).toEqual([
        "host_invoices_create", "host_invoices_get", "host_invoices_list",
        "host_invoices_send", "host_invoices_send_critical", "host_invoices_update",
      ]);
      expect(plan.steps.every(({ wouldAsk }) => wouldAsk)).toBe(true);
      // The critical tool always asks, so it is not a "missing grant".
      expect(plan.grantsMissing.slice().sort()).toEqual([
        "host_invoices_create", "host_invoices_get", "host_invoices_list",
        "host_invoices_send", "host_invoices_update",
      ]);
      expect(await tableCount(stack, "vendo_runs")).toBe(runsBefore);
      expect(await tableCount(stack, "vendo_approvals")).toBe(approvalsBefore);
      expect((await fixtureInvoices()).length).toBe(invoicesBefore);
    } finally {
      await stack.close();
    }
  });

  it("previews a mutating steps pipeline without touching host state, even when granted", async () => {
    const stack = await createStack();
    try {
      const appId = "app_observe_dry_sideeffect";
      const ctx = ownerCtx(ADA.subject, appId);
      await stack.putApp(ADA.subject, automationDoc({
        id: appId,
        trigger: {
          on: { kind: "host-event", event: "observe.mutate" },
          run: {
            kind: "steps",
            steps: [
              {
                id: "create",
                tool: "host_invoices_create",
                args: { customerId: "'cus_ada'", amountCents: "1", memo: "'dry-run-should-not-write'" },
              },
              { id: "send", tool: "host_invoices_send", args: { id: "'inv_0003'" } },
            ],
          },
        },
      }));
      await enableAndApprove(stack, appId, ctx);
      const runsBefore = await tableCount(stack, "vendo_runs");

      const plan = await stack.automations.dryRun(appId, ctx, {});
      expect(plan.steps.map(({ id, wouldAsk }) => ({ id, wouldAsk }))).toEqual([
        { id: "create", wouldAsk: false },
        { id: "send", wouldAsk: false },
      ]);
      // Nothing ran: no run row, no invoice created, inv_0003 still a draft.
      expect(await tableCount(stack, "vendo_runs")).toBe(runsBefore);
      expect((await fixtureInvoices()).some(({ memo }) => memo === "dry-run-should-not-write")).toBe(false);
      expect((await fixtureInvoices()).find(({ id }) => id === "inv_0003")?.status).toBe("draft");
    } finally {
      await stack.close();
    }
  });
});
