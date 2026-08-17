/** Suite 3 — away runs hold only automation-bound automation grants (05 §6 / 07 §3).
 *
 * An unattended (presence "away") run is authorized ONLY by a grant whose
 * source is "automation" AND whose automation is the one firing. An automation
 * is a first-class record now, so that binding is to the RECORD, not to an app:
 * a present chat grant never reaches across; a revoked grant is honored at run
 * time; and a CRITICAL (confirm-each) away call never executes unattended at
 * all — every firing asks again, and a run that has to ask FAILS LOUDLY (S2: no
 * parking, no resumption, so no approval can be replayed into an away run).
 */
import { beforeEach, describe, expect, it } from "vitest";
import { UNATTENDED_DESTRUCTIVE_REASON } from "@vendoai/core";
import type { AutomationRecord, RunContext } from "@vendoai/core";
import {
  ADA,
  createStack,
  ownerCtx,
  resetFixture,
  serviceToolCalls,
  type Stack,
} from "../src/harness.js";
import { approve, enableAndApprove, fixtureInvoices, runCount, waitForRun } from "../src/support.js";

describe("away runs hold only automation-bound automation grants", () => {
  beforeEach(resetFixture);

  it("does not let a present chat grant authorize an away automation run", async () => {
    // A chat-venue-only ask rule lets ADA mint a real STANDING chat grant via
    // the approval path, while leaving away/automation runs on the default
    // posture so their parking is purely the 05 §6 away-downgrade.
    const stack = await createStack({
      policy: { rules: [{ match: { tool: "host_invoices_send", venue: "chat" }, action: "ask" }] },
    });
    try {
      const ctx = ownerCtx(ADA.subject);
      const parked = await stack.bound.execute(
        { id: "call_chat_grant", tool: "host_invoices_send", args: { id: "inv_0003" } },
        ctx,
      );
      expect(parked.status).toBe("pending-approval");
      const chatApproval = (await stack.guard.approvals.pending(ADA)).find(
        (entry) => entry.call.tool === "host_invoices_send",
      );
      await stack.guard.approvals.decide(
        chatApproval!.id,
        { approve: true, remember: { scope: { kind: "tool" }, duration: "standing" } },
        ADA,
      );
      const chatGrant = (await stack.guard.grants.list(ADA)).find(
        (grant) => grant.tool === "host_invoices_send",
      );
      expect(chatGrant?.source).toBe("chat");
      expect(chatGrant?.automationId).toBeUndefined();

      // An automation that uses the same tool — enabled but its capture NOT approved.
      const automation = await stack.create({
        owner: ADA,
        when: { event: "chatgrant.away" },
        task: {
          kind: "steps",
          steps: [{ id: "send", tool: "host_invoices_send", args: { id: "event.id" } }],
        },
        authoredBy: "chat",
      }, ctx);
      await stack.automations.enable(automation.id, ctx);

      const [runId] = await stack.automations.emit("chatgrant.away", { id: "inv_0003" }, ADA);
      const run = await stack.automations.runs.get(runId!, ctx);
      // The chat grant does not reach an away run, so the run has to ask — and a
      // run that has to ask fails LOUDLY, naming what it needed.
      expect(run?.status).toBe("error");
      expect(run?.error).toMatchObject({ code: "needs-permission", tool: "host_invoices_send" });
      const awayApproval = (await stack.guard.approvals.pending(ADA)).find(
        (entry) =>
          entry.call.tool === "host_invoices_send"
          && entry.ctx.presence === "away"
          && entry.ctx.trigger?.automationId === automation.id,
      );
      expect(awayApproval).toBeDefined();
      // The chat grant did NOT send anything away.
      expect((await fixtureInvoices()).find((invoice) => invoice.id === "inv_0003")?.status).toBe("draft");

      // Positive control: an automation-bound grant DOES authorize an away
      // WRITE. It cannot be `host_invoices_send` — THE LAW (design §12) refuses a
      // destructive or external action unattended no matter which grant is held,
      // so a send here would prove the run was stopped by the law rather than by
      // the 05 §6 grant rule this suite is about. A non-destructive write
      // (PATCH host_invoices_update) isolates the grant rule.
      const ok = await stack.create({
        owner: ADA,
        when: { event: "chatgrant.away.ok" },
        task: {
          kind: "steps",
          steps: [{ id: "send", tool: "host_invoices_update", args: { id: "event.id", memo: "'away-ok'" } }],
        },
        authoredBy: "chat",
      }, ctx);
      await enableAndApprove(stack, ok.id, ctx);
      const [okRunId] = await stack.automations.emit("chatgrant.away.ok", { id: "inv_0006" }, ADA);
      expect((await waitForRun(stack, okRunId!, ctx, "ok")).status).toBe("ok");
      expect((await fixtureInvoices()).find((invoice) => invoice.id === "inv_0006")?.memo).toBe("away-ok");
    } finally {
      await stack.close();
    }
  });

  // Revocation is the subject here, so the run must be one an automation may
  // legally complete unattended: THE LAW (design §12) would stop a send before
  // revocation could be shown to matter. Hence the non-destructive write.
  it("fails loud once an automation-bound grant is revoked", async () => {
    const stack = await createStack();
    try {
      const ctx = ownerCtx(ADA.subject);
      const automation = await stack.create({
        owner: ADA,
        when: { event: "revoke.away" },
        task: {
          kind: "steps",
          steps: [
            { id: "list", tool: "host_invoices_list" },
            { id: "send", tool: "host_invoices_update", args: { id: "event.id", memo: "'revoke-leg'" } },
          ],
        },
        authoredBy: "chat",
      }, ctx);
      await enableAndApprove(stack, automation.id, ctx);

      // One away run succeeds with the freshly minted automation-bound grants.
      const [firstRun] = await stack.automations.emit("revoke.away", { id: "inv_0003" }, ADA);
      expect((await waitForRun(stack, firstRun!, ctx, "ok")).status).toBe("ok");
      expect((await fixtureInvoices()).find((invoice) => invoice.id === "inv_0003")?.memo).toBe("revoke-leg");

      // Revoke the write grant; the next away run fails loud at that step.
      const sendGrant = (await stack.guard.grants.list(ADA)).find(
        (grant) => grant.tool === "host_invoices_update" && grant.automationId === automation.id,
      );
      expect(sendGrant).toBeDefined();
      await stack.guard.grants.revoke(sendGrant!.id, ADA);

      const [secondRun] = await stack.automations.emit("revoke.away", { id: "inv_0006" }, ADA);
      const run = await stack.automations.runs.get(secondRun!, ctx);
      expect(run?.status).toBe("error");
      expect(run?.error).toMatchObject({ code: "needs-permission", tool: "host_invoices_update" });
      // The read before it still ran: an automation is stopped short, not crippled.
      expect(run?.steps.map((step) => step.outcome)).toEqual(["ok", "pending-approval"]);
      const askedAgain = (await stack.guard.approvals.pending(ADA)).find(
        (entry) =>
          entry.call.tool === "host_invoices_update"
          && entry.ctx.presence === "away"
          && entry.ctx.trigger?.automationId === automation.id,
      );
      expect(askedAgain).toBeDefined();
      // inv_0006 was never touched by the revoked run.
      expect((await fixtureInvoices()).find((invoice) => invoice.id === "inv_0006")?.memo).not.toBe("revoke-leg");
    } finally {
      await stack.close();
    }
  });

  /**
   * A CRITICAL (confirm-each) call in an away run fails loud every time, and the
   * send never happens — not once, and certainly not twice.
   *
   * This used to read "executes once, replay parks": the parked run REPLAYED the
   * exact approved call, and the guard let that one dispatch through
   * (`sameParkedCall` matches an approval to a call by its call ID). S2 deletes
   * parking, so there is no replay door left — and a re-run is a fresh run whose
   * calls carry fresh ids, which that same function refuses. The consequence is
   * deliberate and worth stating plainly: a call that requires a person present
   * cannot be completed while nobody is, which is what confirm-each means.
   */
  it("never executes a critical away call — every firing fails loud and nothing is sent", async () => {
    const stack = await createStack();
    try {
      const ctx = ownerCtx(ADA.subject);
      const automation = await stack.create({
        owner: ADA,
        when: { event: "critical.replay" },
        task: {
          kind: "steps",
          steps: [{ id: "send", tool: "host_invoices_send_critical", args: { id: "event.id" } }],
        },
        authoredBy: "chat",
      }, ctx);
      // Even a standing automation-bound grant cannot suppress a critical ask.
      await enableAndApprove(stack, automation.id, ctx);

      const [firstRun] = await stack.automations.emit("critical.replay", { id: "inv_0003" }, ADA);
      const firstFailed = await stack.automations.runs.get(firstRun!, ctx);
      expect(firstFailed?.status).toBe("error");
      expect(firstFailed?.error).toMatchObject({
        code: "needs-permission",
        tool: "host_invoices_send_critical",
      });
      const approval = (await stack.guard.approvals.pending(ADA)).find(
        (entry) =>
          entry.call.tool === "host_invoices_send_critical"
          && entry.ctx.trigger?.automationId === automation.id,
      );
      expect(approval).toBeDefined();

      // Approving it settles the ask — and runs NOTHING: the failed run stays
      // failed, and the invoice is untouched.
      await stack.guard.approvals.decide(approval!.id, { approve: true }, ADA);
      expect((await stack.automations.runs.get(firstRun!, ctx))?.status).toBe("error");
      expect((await fixtureInvoices()).find((invoice) => invoice.id === "inv_0003")?.status).toBe("draft");

      // Even the re-run — the remedy for every other missing permission — cannot
      // complete a confirm-each call: it is a fresh call, so it asks again.
      const rerunId = await stack.automations.runs.rerun(firstRun!, ctx);
      const rerun = await waitForRun(stack, rerunId, ctx, "error");
      expect(rerun.error).toMatchObject({ code: "needs-permission" });
      expect((await fixtureInvoices()).find((invoice) => invoice.id === "inv_0003")?.status).toBe("draft");

      // A second, identical firing fails loud again — and the send has now been
      // attempted three times without ever happening once.
      const [secondRun] = await stack.automations.emit("critical.replay", { id: "inv_0006" }, ADA);
      const secondFailed = await stack.automations.runs.get(secondRun!, ctx);
      expect(secondFailed?.status).toBe("error");
      expect((await fixtureInvoices()).find((invoice) => invoice.id === "inv_0006")?.status).toBe("draft");
      // Three run rows, all this one automation's, and not one send.
      expect(await runCount(stack, automation.id)).toBe(3);
    } finally {
      await stack.close();
    }
  });
});

/** Connector discovery (design 2026-08-03) put a third-party catalog behind ONE
 * tool name, `use_service_tool`, whose descriptor is therefore `ungraded`. The
 * authority an away run holds over it is a grant on the SERVICE ACTION, and
 * these three pin what that grant does and does not buy.
 */
describe("away runs reach a connector only through a granted service action", () => {
  beforeEach(resetFixture);

  const serviceAutomation = (
    stack: Stack,
    event: string,
    steps: Array<{ id: string; slug: string }>,
    ctx: RunContext,
  ): Promise<AutomationRecord> => stack.create({
    owner: ADA,
    when: { event },
    task: {
      kind: "steps",
      // Step args are JSONata: a declared slug is a string literal.
      steps: steps.map((step) => ({ id: step.id, tool: "use_service_tool", args: { slug: `'${step.slug}'` } })),
    },
    authoredBy: "chat",
  }, ctx);

  it("runs the granted service action unattended, and the audit row names the toolkit", async () => {
    const stack = await createStack({ serviceTools: true });
    try {
      const ctx = ownerCtx(ADA.subject);
      const automation = await serviceAutomation(
        stack,
        "service.away.ok",
        [{ id: "fetch", slug: "GMAIL_FETCH_EMAILS" }],
        ctx,
      );
      await enableAndApprove(stack, automation.id, ctx);

      const [runId] = await stack.automations.emit("service.away.ok", {}, ADA);
      const run = await waitForRun(stack, runId!, ctx, "ok");
      expect(run.steps.map((step) => [step.tool, step.outcome])).toEqual([["use_service_tool", "ok"]]);
      expect(serviceToolCalls.map((entry) => entry.slug)).toEqual(["GMAIL_FETCH_EMAILS"]);

      // Nothing about the audit changed: it is the ordinary tool-call row, on
      // the ordinary guarded path, with the toolkit that ran it named.
      const audit = await stack.sql<{ outcome: string | null; toolkit: string | null }>(
        `SELECT event->>'outcome' AS outcome,
                event->'detail'->'connectorAccount'->>'toolkit' AS toolkit
           FROM vendo_audit
          WHERE tool = 'use_service_tool' AND kind = 'tool-call'`,
      );
      expect(audit).toEqual([{ outcome: "ok", toolkit: "gmail" }]);
    } finally {
      await stack.close();
    }
  });

  it("refuses a service action the automation was not granted, in the same run that runs a granted one", async () => {
    const stack = await createStack({ serviceTools: true });
    try {
      const ctx = ownerCtx(ADA.subject);
      const automation = await serviceAutomation(stack, "service.away.scope", [
        { id: "fetch", slug: "GMAIL_FETCH_EMAILS" },
        { id: "labels", slug: "GMAIL_LIST_LABELS" },
      ], ctx);
      // Approve ONLY the first action's ask. The automation arms anyway (07 §3)
      // with the second still pending — armed, and ungranted for that slug.
      // Both slugs grade `read`, so the two calls carry the SAME descriptor
      // hash: the only thing that can refuse the second one is its slug.
      const enabled = await stack.automations.enable(automation.id, ctx);
      const fetchAsk = enabled.missing.find(
        (request) => (request.call.args as { slug?: string }).slug === "GMAIL_FETCH_EMAILS",
      );
      await approve(stack, [fetchAsk!]);
      expect((await stack.guard.grants.list(ADA)).map((grant) => grant.scope)).toEqual([
        { kind: "service-tool", slug: "GMAIL_FETCH_EMAILS" },
      ]);

      const [runId] = await stack.automations.emit("service.away.scope", {}, ADA);
      const run = await stack.automations.runs.get(runId!, ctx);
      // The grant bought its own action and nothing beside it: the second slug
      // fails the run LOUDLY, naming the service action it needed.
      expect(run?.status).toBe("error");
      expect(run?.error).toMatchObject({ code: "needs-permission", slug: "GMAIL_LIST_LABELS" });
      expect(run?.steps.map((step) => step.outcome)).toEqual(["ok", "pending-approval"]);
      expect(serviceToolCalls.map((entry) => entry.slug)).toEqual(["GMAIL_FETCH_EMAILS"]);
      const asked = (await stack.guard.approvals.pending(ADA)).find(
        (entry) => entry.ctx.presence === "away" && entry.ctx.trigger?.automationId === automation.id,
      );
      expect((asked?.call.args as { slug?: string } | undefined)?.slug).toBe("GMAIL_LIST_LABELS");
    } finally {
      await stack.close();
    }
  });

  it("blocks a granted service action the broker grades destructive, exactly as it blocks a granted host send", async () => {
    const stack = await createStack({ serviceTools: true });
    try {
      const ctx = ownerCtx(ADA.subject);
      const automation = await serviceAutomation(
        stack,
        "service.away.destructive",
        [{ id: "send", slug: "GMAIL_SEND_EMAIL" }],
        ctx,
      );
      const asks = await enableAndApprove(stack, automation.id, ctx);
      // The grant is real, standing, automation-bound, and for this exact slug…
      expect(asks[0]?.descriptor.risk).toBe("destructive");
      expect((await stack.guard.grants.list(ADA)).map((grant) => grant.scope)).toEqual([
        { kind: "service-tool", slug: "GMAIL_SEND_EMAIL" },
      ]);

      // …and THE LAW (design §12) still refuses it. This is the same answer
      // `away-park-revoke` pins for a granted `host_invoices_send`: a grant has
      // never been able to run an irreversible action with nobody watching, and
      // a connector grant buys no more than a host one.
      const [runId] = await stack.automations.emit("service.away.destructive", {}, ADA);
      const run = await waitForRun(stack, runId!, ctx, "error");
      expect(run.steps.map((step) => step.outcome)).toEqual(["blocked"]);
      expect(run.error?.message).toBe(UNATTENDED_DESTRUCTIVE_REASON);
      expect(serviceToolCalls).toEqual([]);
    } finally {
      await stack.close();
    }
  });
});
