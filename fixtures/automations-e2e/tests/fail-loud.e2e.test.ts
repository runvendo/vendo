/** S2 — fail-loud consent, against the real stack (real store, real guard, real
 * host).
 *
 * A run that meets a permission nobody granted does NOT wait: it fails LOUDLY
 * at that step, the ask lands in the same capture the arming flow uses, and the
 * remedy is one tap — allow it, and run it again. Park and resume are gone, so
 * no approval, identity or intent is ever held open across an unbounded gap.
 *
 * (This file replaces park-resume.e2e.test.ts, which proved the parking
 * machinery this slice deletes.)
 */
import type { RunContext } from "@vendoai/core";
import { beforeEach, describe, expect, it } from "vitest";
import { createAutomation, createStack, ownerCtx, resetFixture, type Stack } from "../src/harness.js";
import { ADA, approve, fixtureInvoices, waitForRun } from "../src/support.js";

interface MissSetup {
  stack: Stack;
  automationId: string;
  ctx: RunContext;
  runId: string;
  approvalId: string;
  memo: string;
}

/**
 * An automation whose FIRST step is a granted write and whose second needs a
 * permission nobody has allowed. Firing it leaves the run failed at that second
 * step, with the ask pending.
 *
 * The missing step is `host_invoices_update` — a non-destructive write (PATCH) —
 * because THE LAW (design §12) refuses a destructive or external action in an
 * unattended run outright, so a standing grant could never make the re-run
 * succeed for one. The law's own refusal is proven in redteam/away-authority.
 */
async function createMiss(suffix: string): Promise<MissSetup> {
  const stack = await createStack();
  const memo = `loud-${suffix}`;
  const ctx = ownerCtx(ADA.subject);
  const record = await createAutomation(stack, {
    owner: ADA,
    when: { event: "invoice.loud" },
    task: {
      kind: "steps",
      steps: [
        // The effect that DOES land before the miss — a real host mutation,
        // which is what makes the re-run's ledger question meaningful.
        {
          id: "log",
          tool: "host_invoices_create",
          args: { customerId: "'cus_ada'", amountCents: "101", memo: `'${memo}'` },
        },
        { id: "sweep", tool: "host_invoices_update", args: { id: "event.id", memo: `'${memo}-swept'` } },
      ],
    },
    authoredBy: "chat",
    armed: false,
  }, ctx);
  const enabled = await stack.automations.enable(record.id, ctx);
  // Only the first step's permission is allowed: the second is the miss. Its
  // arming ask stays open — the person walked away mid-ceremony — which is
  // exactly the state that must not become two questions about one permission.
  await approve(stack, enabled.missing.filter((request) => request.call.tool === "host_invoices_create"));
  const runIds = await stack.automations.emit("invoice.loud", { id: "inv_0003" }, ADA);
  const runId = runIds[0];
  if (!runId) throw new Error("emit did not return a run id");
  const outstanding = (await stack.guard.approvals.pending(ADA))
    .filter((request) => request.call.tool === "host_invoices_update");
  if (outstanding.length === 0) throw new Error("the missing permission raised no ask at all");
  // The one a surface decides: the capture the engine says is outstanding.
  const captures = await stack.sql<{ id: string }>(
    "SELECT id FROM vendo_records WHERE collection = 'automations:captures'",
  );
  const approvalId = captures[0]?.id;
  if (approvalId === undefined) throw new Error("the missing permission captured no ask");
  return { stack, automationId: record.id, ctx, runId, approvalId, memo };
}

describe("fail-loud consent and Grant & re-run", () => {
  beforeEach(resetFixture);

  it("fails the run at the missing permission, names it, captures the ask, and parks nothing", async () => {
    const setup = await createMiss("fail");
    try {
      const run = await setup.stack.automations.runs.get(setup.runId, setup.ctx);
      expect(run).toMatchObject({
        automationId: setup.automationId,
        status: "error",
        error: { code: "needs-permission", tool: "host_invoices_update" },
        steps: [
          { id: "log", outcome: "ok" },
          { id: "sweep", outcome: "pending-approval" },
        ],
      });
      // What the person reads names neither the tool nor the machinery (§16 law 3);
      // the tool rides `error` for the surface and the developer rail.
      expect(run?.summary).not.toContain("host_invoices_update");
      expect(run?.summary).toMatch(/run this again/i);
      expect(run?.finishedAt).toBeTruthy();

      // Terminal in the STORE too, and with no waiting status left in the schema.
      expect((await setup.stack.sql<{ status: string }>(
        "SELECT status FROM vendo_runs WHERE id = $1",
        [setup.runId],
      ))[0]?.status).toBe("error");

      // The ask is a CAPTURE — the same row arming writes — so the one decision
      // path both doors share mints the standing grant. ONE row, not two: the
      // arming ask nobody answered is the same question, about the same record.
      const captures = await setup.stack.sql<{ id: string; data: unknown }>(
        "SELECT id, data FROM vendo_records WHERE collection = 'automations:captures'",
      );
      expect(captures.map(({ id }) => id)).toEqual([setup.approvalId]);
      expect(captures[0]?.data).toMatchObject({
        automationId: setup.automationId,
        subject: ADA.subject,
        tool: "host_invoices_update",
      });

      // Nothing was parked, and nothing claimed a resume.
      expect(await setup.stack.sql(
        "SELECT id FROM vendo_records WHERE collection IN ('automations:parked', 'automations:resume-claims')",
      )).toEqual([]);

      // The write BEFORE the miss landed exactly once; the one after it never ran.
      const invoices = await fixtureInvoices();
      expect(invoices.filter(({ memo }) => memo === setup.memo)).toHaveLength(1);
      expect(invoices.find(({ id }) => id === "inv_0003")?.memo).not.toBe(`${setup.memo}-swept`);
    } finally {
      await setup.stack.close();
    }
  });

  it("mints the standing grant on approval, re-runs to success, and the next firing is clean", async () => {
    const setup = await createMiss("grant");
    try {
      await setup.stack.guard.approvals.decide(setup.approvalId, { approve: true }, ADA);

      // One standing grant, keyed to the RECORD — the thing this automation will
      // hold from now on, and nothing wider.
      expect(await setup.stack.sql(
        `SELECT subject, tool, automation_id, source, duration
           FROM vendo_grants
          WHERE subject = $1 AND tool = 'host_invoices_update'`,
        [ADA.subject],
      )).toEqual([{
        subject: ADA.subject,
        tool: "host_invoices_update",
        automation_id: setup.automationId,
        source: "automation",
        duration: "standing",
      }]);
      // The capture is settled, so nothing keeps asking…
      expect(await setup.stack.sql(
        "SELECT id FROM vendo_records WHERE collection = 'automations:captures'",
      )).toEqual([]);
      // …and the failed run is STILL failed: a decision runs nothing.
      expect((await setup.stack.automations.runs.get(setup.runId, setup.ctx))?.status).toBe("error");

      // Grant & re-run: a FRESH run of the same automation on the same event.
      const rerunId = await setup.stack.automations.runs.rerun(setup.runId, setup.ctx);
      expect(rerunId).not.toBe(setup.runId);
      const rerun = await waitForRun(setup.stack, rerunId, setup.ctx, "ok");
      expect(rerun).toMatchObject({
        automationId: setup.automationId,
        status: "ok",
        steps: [{ id: "log", outcome: "ok" }, { id: "sweep", outcome: "ok" }],
      });
      // The work the run existed to do actually happened, on live data.
      expect((await fixtureInvoices()).find(({ id }) => id === "inv_0003")?.memo)
        .toBe(`${setup.memo}-swept`);
      // The whole point of "fail loudly and run it again": the re-run does the
      // work that was MISSED without repeating the work that already LANDED. The
      // `log` step's invoice was created by the failed run, so exactly one exists
      // — the guard replayed its receipt instead of creating a second.
      //
      // Two things make that receipt findable, and both are per FIRING rather
      // than per run: the re-run inherits the failed run's effect LINEAGE (the
      // ledger's run component), and the step's call id is derived from that
      // lineage plus the step's own id, so the same step of the same firing is
      // the same effect however many times it is re-run and in whatever process.
      expect((await fixtureInvoices()).filter(({ memo }) => memo === setup.memo)).toHaveLength(1);

      // The grant is STANDING: the next scheduled firing needs no person at all.
      const nextIds = await setup.stack.automations.emit("invoice.loud", { id: "inv_0004" }, ADA);
      const nextId = nextIds[0];
      if (!nextId) throw new Error("second emit did not return a run id");
      expect((await waitForRun(setup.stack, nextId, setup.ctx, "ok")).status).toBe("ok");
      // Nobody was asked anything for that firing: no new capture at all.
      expect(await setup.stack.sql(
        "SELECT id FROM vendo_records WHERE collection = 'automations:captures'",
      )).toEqual([]);
      expect((await fixtureInvoices()).find(({ id }) => id === "inv_0004")?.memo)
        .toBe(`${setup.memo}-swept`);
    } finally {
      await setup.stack.close();
    }
  });

  it("leaves the run failed and mints nothing when the ask is denied", async () => {
    const setup = await createMiss("deny");
    try {
      await setup.stack.guard.approvals.decide(setup.approvalId, { approve: false }, ADA);

      const run = await setup.stack.automations.runs.get(setup.runId, setup.ctx);
      expect(run).toMatchObject({ status: "error", error: { code: "needs-permission" } });
      expect(await setup.stack.sql(
        "SELECT id FROM vendo_grants WHERE subject = $1 AND tool = 'host_invoices_update' AND automation_id = $2",
        [ADA.subject, setup.automationId],
      )).toEqual([]);
      // The decided ask is gone from the capture table, so nothing keeps asking.
      expect(await setup.stack.sql(
        "SELECT id FROM vendo_records WHERE collection = 'automations:captures'",
      )).toEqual([]);
      // …and the write it was refused never happened.
      expect((await fixtureInvoices()).find(({ id }) => id === "inv_0003")?.memo)
        .not.toBe(`${setup.memo}-swept`);
    } finally {
      await setup.stack.close();
    }
  });

  it("refuses a re-run for anyone who does not own the automation", async () => {
    const setup = await createMiss("gate");
    try {
      await expect(setup.stack.automations.runs.rerun(setup.runId, ownerCtx("user_bob")))
        .rejects.toMatchObject({ code: "not-found" });
    } finally {
      await setup.stack.close();
    }
  });
});
