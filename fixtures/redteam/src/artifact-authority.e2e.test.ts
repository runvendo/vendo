/** Suite 2 — artifacts carry ZERO authority.
 *
 * A .vendoapp (or a raw AppDocument) is a copy-only interchange object. Grants
 * key on (subject, tool) + the ORIGINAL app id and never travel in the bytes;
 * import re-mints the id and strips server/forkedFrom and any attacker-injected
 * field. So an imported copy cannot ride the original owner's standing grant,
 * and a tampered archive confers nothing.
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  ADA,
  BOB,
  awayCtx,
  craftAppDocument,
  createStack,
  exportAndTamper,
  importDoc,
  loginCookie,
  ownerCtx,
  resetFixture,
} from "./harness.js";

describe("artifacts carry no authority", () => {
  beforeEach(resetFixture);

  it("does not let an imported copy ride the original owner's standing grant", async () => {
    // A write-ask policy makes the "no grant" case visibly PARK rather than
    // auto-run, so the grant is the only thing that could authorize a send.
    const stack = await createStack({
      policy: { rules: [{ match: { risk: "write" }, action: "ask" }] },
    });
    try {
      const originalId = "app_original_ada";
      await stack.putApp(
        ADA.subject,
        craftAppDocument({ id: originalId, name: "Ada's Sender" }),
      );

      // ADA mints a STANDING chat grant for host_invoices_send, bound to the
      // original app, via the real approval path.
      const adaCookie = await loginCookie(ADA.subject);
      const adaCtx = { ...ownerCtx(ADA.subject, originalId), requestHeaders: { cookie: adaCookie } };
      const parked = await stack.apps.call(originalId, "host_invoices_send", { id: "inv_0003" }, adaCtx);
      expect(parked.status).toBe("pending-approval");
      const chatApproval = (await stack.guard.approvals.pending(ADA)).find(
        (entry) => entry.call.tool === "host_invoices_send",
      );
      expect(chatApproval).toBeDefined();
      await stack.guard.approvals.decide(
        chatApproval!.id,
        { approve: true, remember: { scope: { kind: "tool" }, duration: "standing" } },
        ADA,
      );

      // Positive control: the grant is real — ADA's next send on the ORIGINAL runs.
      const authorized = await stack.apps.call(originalId, "host_invoices_send", { id: "inv_0003" }, adaCtx);
      expect(authorized.status).toBe("ok");

      // BOB imports a mimic of the app → fresh id, and BOB holds no grant.
      const imported = await importDoc(
        stack,
        craftAppDocument({ id: originalId, name: "Ada's Sender" }),
        ownerCtx(BOB.subject),
      );
      expect(imported.id).not.toBe(originalId);

      const bobCookie = await loginCookie(BOB.subject);
      const bobCtx = { ...ownerCtx(BOB.subject, imported.id), requestHeaders: { cookie: bobCookie } };
      const copyOutcome = await stack.apps.call(imported.id, "host_invoices_send", { id: "inv_0006" }, bobCtx);
      // The copy does NOT ride ADA's grant: different subject + fresh app id → parks.
      expect(copyOutcome.status).toBe("pending-approval");
      expect(await stack.guard.grants.list(BOB)).toEqual([]);
    } finally {
      await stack.close();
    }
  });

  it("strips forged server/forkedFrom/grant fields from a tampered .vendoapp and confers no authority", async () => {
    const stack = await createStack();
    try {
      const originalId = "app_tamper_source";
      await stack.putApp(
        ADA.subject,
        craftAppDocument({ id: originalId, name: "Tamper Source" }),
      );

      // Attacker rewrites app.json inside the exported archive.
      const tampered = await exportAndTamper(
        stack,
        originalId,
        ownerCtx(ADA.subject, originalId),
        (appJson) => {
          appJson.server = "vendo-snapshot:attacker-controlled";
          appJson.forkedFrom = "app_victim";
          appJson.egress = ["evil.example.com"];
          appJson.secrets = ["STRIPE_SECRET_KEY"];
          appJson.pins = [{ slot: "checkout", base: "sha256:deadbeef" }];
          // Grant-like fields an attacker hopes the import trusts.
          appJson.grants = [{ subject: BOB.subject, tool: "host_invoices_send_critical" }];
          appJson.grant = { authority: "all" };
          appJson.authority = "owner";
        },
      );

      const imported = await stack.apps.importApp(tampered, ownerCtx(BOB.subject));
      const asRecord = imported as unknown as Record<string, unknown>;

      // Identity re-minted; non-portable / attacker fields dropped.
      expect(imported.id).not.toBe(originalId);
      expect(imported.id.startsWith("app_")).toBe(true);
      expect(imported.forkedFrom).toBeUndefined();
      expect(imported.server).toBeUndefined();
      expect(asRecord.grants).toBeUndefined();
      expect(asRecord.grant).toBeUndefined();
      expect(asRecord.authority).toBeUndefined();

      // egress/secrets/pins are copy-only descriptors — even if carried they
      // confer no tool authority: an away run STILL parks.
      const outcome = await stack.bound.execute(
        { id: "call_tamper_away", tool: "host_invoices_send", args: { id: "inv_0003" } },
        awayCtx(BOB.subject, imported.id),
      );
      expect(outcome.status).toBe("pending-approval");
      expect(await stack.guard.grants.list(BOB)).toEqual([]);
    } finally {
      await stack.close();
    }
  });
});
