/** The ledger you can actually read: one flat run list, filtered and paginated
 * newest-first, owner-scoped on every door, plus dryRun — a preview that
 * executes nothing, on the store or on the live host.
 */
import type { RunContext } from "@vendoai/core";
import { beforeEach, describe, expect, it } from "vitest";
import { createStack, ownerCtx, resetFixture, type Stack } from "../src/harness.js";
import { ADA, BOB, approve, enableAndApprove, fixtureInvoices, tableCount } from "../src/support.js";

/**
 * The standing automation grant a yes can no longer mint, written directly.
 *
 * `host_invoices_send` is destructive, so arming captures nothing for it — THE
 * LAW refuses a destructive away call whatever grant is held, and a card
 * promising one would promise what no firing honours. A PREVIEW still has to
 * say what a fully granted pipeline looks like, so the row is seeded here
 * through the guard's own mint, off the very descriptor `dryRun` hashes its
 * grant lookup against — a hand-built one would silently not match.
 */
async function grantStanding(
  stack: Stack,
  automationId: string,
  tool: string,
  ctx: RunContext,
): Promise<void> {
  const descriptor = (await stack.bound.descriptors(ctx)).find((entry) => entry.name === tool);
  if (descriptor === undefined) throw new Error(`${tool} is not bound`);
  // Optional on the `VendoGuard` seam, so feature-detected the way the engine
  // itself detects it — this stack composes the real guard, which has it.
  if (stack.guard.mintGrant === undefined) throw new Error("the composed guard offers no grant mint");
  await stack.guard.mintGrant({
    request: {
      id: `apr_seed_${tool}`,
      call: { id: `call_seed_${tool}`, tool, args: {} },
      descriptor,
      inputPreview: `Allow ${tool} while you're away`,
      ctx: { principal: ctx.principal, venue: "automation", presence: "present" },
      createdAt: new Date().toISOString(),
    },
    remember: { duration: "standing" },
    source: "automation",
    automationId,
  });
}

describe("run observability and dry-run", () => {
  beforeEach(resetFixture);

  it("filters and paginates newest-first while keeping get/list owner-scoped", async () => {
    let clock = new Date("2026-07-12T00:00:00.000Z");
    const stack = await createStack({ now: () => clock });
    try {
      const ctx = ownerCtx(ADA.subject);
      const created = await stack.create({
        owner: ADA,
        when: { event: "observe.fire" },
        task: { kind: "steps", steps: [{ id: "list", tool: "host_invoices_list" }] },
        authoredBy: "chat",
      }, ctx);
      await enableAndApprove(stack, created.id, ctx);

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
        const page = await stack.automations.runs.list({ automationId: created.id, status: "ok", cursor }, ctx);
        pageCount += 1;
        seen.push(...page.runs.map(({ id }) => id));
        cursor = page.cursor;
      } while (cursor !== undefined);
      expect(pageCount).toBeGreaterThan(1);
      expect(seen).toEqual([...emitted].reverse());
      expect(await stack.automations.runs.list({ automationId: created.id, status: "error" }, ctx))
        .toEqual({ runs: [] });
      const target = emitted[0];
      if (!target) throw new Error("No run was emitted");
      expect(await stack.automations.runs.get(target, ownerCtx(BOB.subject))).toBeNull();
      expect(await stack.automations.runs.list({ automationId: created.id }, ownerCtx(BOB.subject)))
        .toEqual({ runs: [] });
      await expect(stack.automations.runs.stop(target, ctx)).rejects.toMatchObject({ code: "conflict" });
    } finally {
      await stack.close();
    }
  });

  it("expands forEach plans and dry-runs without writing runs or approvals", async () => {
    const stack = await createStack();
    try {
      const ctx = ownerCtx(ADA.subject);
      const created = await stack.create({
        owner: ADA,
        when: { event: "observe.plan" },
        task: {
          kind: "steps",
          steps: [
            { id: "list", tool: "host_invoices_list" },
            { id: "send", tool: "host_invoices_send", forEach: "event.items", args: { id: "item.id" } },
          ],
        },
        authoredBy: "chat",
      }, ctx);
      const enabled = await stack.automations.enable(created.id, ctx);
      const runsBefore = await tableCount(stack, "vendo_runs");
      const approvalsBefore = await tableCount(stack, "vendo_approvals");

      const preGrant = await stack.automations.dryRun(created.id, ctx, {
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
      // …and the one arming never asked about, seeded (see `grantStanding`).
      await grantStanding(stack, created.id, "host_invoices_send", ctx);
      const postGrant = await stack.automations.dryRun(created.id, ctx, {
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

  it("plans a goal run across the whole bound surface and executes nothing", async () => {
    const stack = await createStack();
    try {
      const ctx = ownerCtx(ADA.subject);
      const created = await stack.create({
        owner: ADA,
        when: { event: "observe.agent" },
        task: { kind: "goal", prompt: "do the books" },
        authoredBy: "chat",
      }, ctx);
      const runsBefore = await tableCount(stack, "vendo_runs");
      const approvalsBefore = await tableCount(stack, "vendo_approvals");
      const invoicesBefore = (await fixtureInvoices()).length;

      const plan = await stack.automations.dryRun(created.id, ctx);
      // Without a model seat, a goal's capture previews every bound descriptor.
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
      const ctx = ownerCtx(ADA.subject);
      const created = await stack.create({
        owner: ADA,
        when: { event: "observe.mutate" },
        task: {
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
        authoredBy: "chat",
      }, ctx);
      await enableAndApprove(stack, created.id, ctx);
      // "even when granted" is the whole point of this preview, and the send is
      // the half arming no longer captures — so its grant is seeded (see
      // `grantStanding`) and the pipeline really is fully granted.
      await grantStanding(stack, created.id, "host_invoices_send", ctx);
      const runsBefore = await tableCount(stack, "vendo_runs");

      const plan = await stack.automations.dryRun(created.id, ctx, {});
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
