/** Suite 3 — away runs hold only app-bound automation grants (05 §6 / 07 §3).
 *
 * An unattended (presence "away") run is authorized ONLY by a grant whose
 * source is "automation" AND whose appId is the running app. A present chat
 * grant never reaches across; a revoked grant is honored at run time; and an
 * approved CRITICAL away call is single-use — it executes once and a replay
 * parks again.
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  ADA,
  automationDoc,
  createStack,
  ownerCtx,
  resetFixture,
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

      // Positive control: an app-bound automation grant DOES authorize the away send.
      const okAppId = "app_away_chatgrant_ok";
      await stack.putApp(
        ADA.subject,
        automationDoc({
          id: okAppId,
          trigger: {
            on: { kind: "host-event", event: "chatgrant.away.ok" },
            run: { kind: "steps", steps: [{ id: "send", tool: "host_invoices_send", args: { id: "event.id" } }] },
          },
        }),
      );
      await enableAndApprove(stack, okAppId, ownerCtx(ADA.subject, okAppId));
      const [okRunId] = await stack.automations.emit("chatgrant.away.ok", { id: "inv_0006" }, ADA);
      expect((await waitForRun(stack, okRunId!, ownerCtx(ADA.subject, okAppId), "ok")).status).toBe("ok");
      expect((await fixtureInvoices()).find((invoice) => invoice.id === "inv_0006")?.status).toBe("open");
    } finally {
      await stack.close();
    }
  });

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
                { id: "send", tool: "host_invoices_send", args: { id: "event.id" } },
              ],
            },
          },
        }),
      );
      await enableAndApprove(stack, appId, ownerCtx(ADA.subject, appId));

      // One away run succeeds with the freshly minted app-bound grants.
      const [firstRun] = await stack.automations.emit("revoke.away", { id: "inv_0003" }, ADA);
      expect((await waitForRun(stack, firstRun!, ownerCtx(ADA.subject, appId), "ok")).status).toBe("ok");
      expect((await fixtureInvoices()).find((invoice) => invoice.id === "inv_0003")?.status).toBe("open");

      // Revoke the send grant; the next away run parks at the send step.
      const sendGrant = (await stack.guard.grants.list(ADA)).find(
        (grant) => grant.tool === "host_invoices_send" && grant.appId === appId,
      );
      expect(sendGrant).toBeDefined();
      await stack.guard.grants.revoke(sendGrant!.id, ADA);

      const [secondRun] = await stack.automations.emit("revoke.away", { id: "inv_0006" }, ADA);
      const run = await stack.automations.runs.get(secondRun!, ownerCtx(ADA.subject, appId));
      expect(run?.status).toBe("pending-approval");
      const parkedSend = (await stack.guard.approvals.pending(ADA)).find(
        (entry) =>
          entry.call.tool === "host_invoices_send"
          && entry.ctx.presence === "away"
          && entry.ctx.appId === appId,
      );
      expect(parkedSend).toBeDefined();
      // inv_0006 was never sent by the revoked run.
      expect((await fixtureInvoices()).find((invoice) => invoice.id === "inv_0006")?.status).toBe("draft");
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
