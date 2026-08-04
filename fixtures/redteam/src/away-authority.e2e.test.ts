/** Suite 3 — away runs hold only app-bound automation grants (05 §6 / 07 §3).
 *
 * An unattended (presence "away") run is authorized ONLY by a grant whose
 * source is "automation" AND whose appId is the running app. A present chat
 * grant never reaches across; a revoked grant is honored at run time; and an
 * approved CRITICAL away call is single-use — it executes once and a replay
 * parks again.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { UNATTENDED_DESTRUCTIVE_REASON } from "@vendoai/core";
import {
  ADA,
  automationDoc,
  createStack,
  ownerCtx,
  resetFixture,
  serviceToolCalls,
} from "./harness.js";
import { approve, enableAndApprove, fixtureInvoices, waitForRun } from "./support.js";

describe("away runs hold only app-bound automation grants", () => {
  beforeEach(resetFixture);

  it("does not let a present chat grant authorize an away app run", async () => {
    // A chat-venue-only ask rule lets ADA mint a real STANDING chat grant via
    // the approval path, while leaving away/automation runs on the default
    // posture so their parking is purely the 05 §6 away-downgrade.
    const stack = await createStack({
      policy: { rules: [{ match: { tool: "host_invoices_send", venue: "chat" }, action: "ask" }] },
    });
    try {
      const parked = await stack.bound.execute(
        { id: "call_chat_grant", tool: "host_invoices_send", args: { id: "inv_0003" } },
        ownerCtx(ADA.subject),
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
      expect(chatGrant?.appId).toBeUndefined();

      // An automation that uses the same tool — enabled but its capture NOT approved.
      const appId = "app_away_chatgrant";
      await stack.putApp(
        ADA.subject,
        automationDoc({
          id: appId,
          trigger: {
            on: { kind: "host-event", event: "chatgrant.away" },
            run: { kind: "steps", steps: [{ id: "send", tool: "host_invoices_send", args: { id: "event.id" } }] },
          },
        }),
      );
      await stack.automations.enable(appId, ownerCtx(ADA.subject, appId));

      const [runId] = await stack.automations.emit("chatgrant.away", { id: "inv_0003" }, ADA);
      const run = await stack.automations.runs.get(runId!, ownerCtx(ADA.subject, appId));
      expect(run?.status).toBe("pending-approval");
      const awayApproval = (await stack.guard.approvals.pending(ADA)).find(
        (entry) =>
          entry.call.tool === "host_invoices_send"
          && entry.ctx.presence === "away"
          && entry.ctx.appId === appId,
      );
      expect(awayApproval).toBeDefined();
      // The chat grant did NOT send anything away.
      expect((await fixtureInvoices()).find((invoice) => invoice.id === "inv_0003")?.status).toBe("draft");

      // Positive control: an app-bound automation grant DOES authorize an away
      // WRITE. It cannot be `host_invoices_send` — THE LAW (design §12) refuses a
      // destructive or external action unattended no matter which grant is held,
      // so a send here would prove the run was stopped by the law rather than by
      // the 05 §6 grant rule this suite is about. A non-destructive write
      // (PATCH host_invoices_update) isolates the grant rule.
      const okAppId = "app_away_chatgrant_ok";
      await stack.putApp(
        ADA.subject,
        automationDoc({
          id: okAppId,
          trigger: {
            on: { kind: "host-event", event: "chatgrant.away.ok" },
            run: {
              kind: "steps",
              steps: [{ id: "send", tool: "host_invoices_update", args: { id: "event.id", memo: "'away-ok'" } }],
            },
          },
        }),
      );
      await enableAndApprove(stack, okAppId, ownerCtx(ADA.subject, okAppId));
      const [okRunId] = await stack.automations.emit("chatgrant.away.ok", { id: "inv_0006" }, ADA);
      expect((await waitForRun(stack, okRunId!, ownerCtx(ADA.subject, okAppId), "ok")).status).toBe("ok");
      expect((await fixtureInvoices()).find((invoice) => invoice.id === "inv_0006")?.memo).toBe("away-ok");
    } finally {
      await stack.close();
    }
  });

  // Revocation is the subject here, so the run must be one an automation may
  // legally complete unattended: THE LAW (design §12) would stop a send before
  // revocation could be shown to matter. Hence the non-destructive write.
  it("parks once an app-bound grant is revoked", async () => {
    const stack = await createStack();
    try {
      const appId = "app_away_revoke";
      await stack.putApp(
        ADA.subject,
        automationDoc({
          id: appId,
          trigger: {
            on: { kind: "host-event", event: "revoke.away" },
            run: {
              kind: "steps",
              steps: [
                { id: "list", tool: "host_invoices_list" },
                { id: "send", tool: "host_invoices_update", args: { id: "event.id", memo: "'revoke-leg'" } },
              ],
            },
          },
        }),
      );
      await enableAndApprove(stack, appId, ownerCtx(ADA.subject, appId));

      // One away run succeeds with the freshly minted app-bound grants.
      const [firstRun] = await stack.automations.emit("revoke.away", { id: "inv_0003" }, ADA);
      expect((await waitForRun(stack, firstRun!, ownerCtx(ADA.subject, appId), "ok")).status).toBe("ok");
      expect((await fixtureInvoices()).find((invoice) => invoice.id === "inv_0003")?.memo).toBe("revoke-leg");

      // Revoke the write grant; the next away run parks at that step.
      const sendGrant = (await stack.guard.grants.list(ADA)).find(
        (grant) => grant.tool === "host_invoices_update" && grant.appId === appId,
      );
      expect(sendGrant).toBeDefined();
      await stack.guard.grants.revoke(sendGrant!.id, ADA);

      const [secondRun] = await stack.automations.emit("revoke.away", { id: "inv_0006" }, ADA);
      const run = await stack.automations.runs.get(secondRun!, ownerCtx(ADA.subject, appId));
      expect(run?.status).toBe("pending-approval");
      const parkedSend = (await stack.guard.approvals.pending(ADA)).find(
        (entry) =>
          entry.call.tool === "host_invoices_update"
          && entry.ctx.presence === "away"
          && entry.ctx.appId === appId,
      );
      expect(parkedSend).toBeDefined();
      // inv_0006 was never touched by the revoked run.
      expect((await fixtureInvoices()).find((invoice) => invoice.id === "inv_0006")?.memo).not.toBe("revoke-leg");
    } finally {
      await stack.close();
    }
  });

  it("executes an approved critical away call ONCE and parks the replay", async () => {
    const stack = await createStack();
    try {
      const appId = "app_away_critical_replay";
      await stack.putApp(
        ADA.subject,
        automationDoc({
          id: appId,
          trigger: {
            on: { kind: "host-event", event: "critical.replay" },
            run: {
              kind: "steps",
              steps: [{ id: "send", tool: "host_invoices_send_critical", args: { id: "event.id" } }],
            },
          },
        }),
      );
      // Even a standing app-bound automation grant cannot suppress a critical ask.
      await enableAndApprove(stack, appId, ownerCtx(ADA.subject, appId));

      const [firstRun] = await stack.automations.emit("critical.replay", { id: "inv_0003" }, ADA);
      const firstParked = await stack.automations.runs.get(firstRun!, ownerCtx(ADA.subject, appId));
      expect(firstParked?.status).toBe("pending-approval");
      const approval = (await stack.guard.approvals.pending(ADA)).find(
        (entry) => entry.call.tool === "host_invoices_send_critical" && entry.ctx.appId === appId,
      );
      expect(approval).toBeDefined();

      // Approve → the run resumes and sends exactly once.
      await stack.guard.approvals.decide(approval!.id, { approve: true }, ADA);
      expect((await waitForRun(stack, firstRun!, ownerCtx(ADA.subject, appId), "ok")).status).toBe("ok");
      expect((await fixtureInvoices()).find((invoice) => invoice.id === "inv_0003")?.status).toBe("open");

      // A second, identical firing parks AGAIN — the approval was single-use.
      const [secondRun] = await stack.automations.emit("critical.replay", { id: "inv_0006" }, ADA);
      const secondParked = await stack.automations.runs.get(secondRun!, ownerCtx(ADA.subject, appId));
      expect(secondParked?.status).toBe("pending-approval");
      const replayApproval = (await stack.guard.approvals.pending(ADA)).find(
        (entry) => entry.call.tool === "host_invoices_send_critical" && entry.ctx.appId === appId,
      );
      expect(replayApproval).toBeDefined();
      expect((await fixtureInvoices()).find((invoice) => invoice.id === "inv_0006")?.status).toBe("draft");
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

  const serviceApp = (id: string, steps: Array<{ id: string; slug: string }>) => automationDoc({
    id,
    name: "Inbox digest",
    trigger: {
      on: { kind: "host-event", event: `${id}.fire` },
      run: {
        kind: "steps",
        // Step args are JSONata: a declared slug is a string literal.
        steps: steps.map((step) => ({ id: step.id, tool: "use_service_tool", args: { slug: `'${step.slug}'` } })),
      },
    },
  });

  it("runs the granted service action unattended, and the audit row names the toolkit", async () => {
    const stack = await createStack({ serviceTools: true });
    try {
      const appId = "app_service_away_ok";
      await stack.putApp(ADA.subject, serviceApp(appId, [{ id: "fetch", slug: "GMAIL_FETCH_EMAILS" }]));
      await enableAndApprove(stack, appId, ownerCtx(ADA.subject, appId));

      const [runId] = await stack.automations.emit(`${appId}.fire`, {}, ADA);
      const run = await waitForRun(stack, runId!, ownerCtx(ADA.subject, appId), "ok");
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
      const appId = "app_service_away_scope";
      await stack.putApp(ADA.subject, serviceApp(appId, [
        { id: "fetch", slug: "GMAIL_FETCH_EMAILS" },
        { id: "labels", slug: "GMAIL_LIST_LABELS" },
      ]));
      // Approve ONLY the first action's ask. The automation arms anyway (07 §3)
      // with the second still pending — armed, and ungranted for that slug.
      // Both slugs grade `read`, so the two calls carry the SAME descriptor
      // hash: the only thing that can refuse the second one is its slug.
      const enabled = await stack.automations.enable(appId, ownerCtx(ADA.subject, appId));
      const fetchAsk = enabled.missing.find(
        (request) => (request.call.args as { slug?: string }).slug === "GMAIL_FETCH_EMAILS",
      );
      await approve(stack, [fetchAsk!]);
      expect((await stack.guard.grants.list(ADA)).map((grant) => grant.scope)).toEqual([
        { kind: "service-tool", slug: "GMAIL_FETCH_EMAILS" },
      ]);

      const [runId] = await stack.automations.emit(`${appId}.fire`, {}, ADA);
      const run = await stack.automations.runs.get(runId!, ownerCtx(ADA.subject, appId));
      expect(run?.status).toBe("pending-approval");
      // The grant bought its own action and nothing beside it: the second slug
      // parks with a person, exactly as an ungranted away step always has.
      expect(run?.steps.map((step) => step.outcome)).toEqual(["ok", "pending-approval"]);
      expect(serviceToolCalls.map((entry) => entry.slug)).toEqual(["GMAIL_FETCH_EMAILS"]);
      const parked = (await stack.guard.approvals.pending(ADA)).find(
        (entry) => entry.ctx.presence === "away" && entry.ctx.appId === appId,
      );
      expect((parked?.call.args as { slug?: string } | undefined)?.slug).toBe("GMAIL_LIST_LABELS");
    } finally {
      await stack.close();
    }
  });

  it("blocks a granted service action the broker grades destructive, exactly as it blocks a granted host send", async () => {
    const stack = await createStack({ serviceTools: true });
    try {
      const appId = "app_service_away_destructive";
      await stack.putApp(ADA.subject, serviceApp(appId, [{ id: "send", slug: "GMAIL_SEND_EMAIL" }]));
      const asks = await enableAndApprove(stack, appId, ownerCtx(ADA.subject, appId));
      // The grant is real, standing, app-bound, and for this exact slug…
      expect(asks[0]?.descriptor.risk).toBe("destructive");
      expect((await stack.guard.grants.list(ADA)).map((grant) => grant.scope)).toEqual([
        { kind: "service-tool", slug: "GMAIL_SEND_EMAIL" },
      ]);

      // …and THE LAW (design §12) still refuses it. This is the same answer
      // `away-park-revoke` pins for a granted `host_invoices_send`: a grant has
      // never been able to run an irreversible action with nobody watching, and
      // a connector grant buys no more than a host one.
      const [runId] = await stack.automations.emit(`${appId}.fire`, {}, ADA);
      const run = await waitForRun(stack, runId!, ownerCtx(ADA.subject, appId), "error");
      expect(run.steps.map((step) => step.outcome)).toEqual(["blocked"]);
      expect(run.error?.message).toBe(UNATTENDED_DESTRUCTIVE_REASON);
      expect(serviceToolCalls).toEqual([]);
    } finally {
      await stack.close();
    }
  });
});
