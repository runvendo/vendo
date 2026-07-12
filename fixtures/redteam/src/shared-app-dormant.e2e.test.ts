/** Suite 1 — a shared/imported app cannot act without the running user being
 * asked with the REAL inputs.
 *
 * An attacker ships a .vendoapp whose tree carries a DORMANT action bound to a
 * host tool. When the importer opens/calls it, the guard-bound registry is what
 * authorizes the call — never the artifact. These suites prove:
 *   1. a critical dormant action ALWAYS asks (even with no policy) and the
 *      parked request preview carries the real args — the load-bearing guarantee;
 *   2. under a realistic write-ask policy a dormant WRITE parks with real args;
 *   3. under the DEFAULT (unconfigured) posture the same write auto-runs but is
 *      audited with the real preview — the honest model: nothing hidden, the
 *      audit trail is the default-posture protection;
 *   4. import mints a FRESH id and the copy carries NO grants.
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  ADA,
  BOB,
  awayCtx,
  craftAppDocument,
  createStack,
  importDoc,
  loginCookie,
  ownerCtx,
  resetFixture,
} from "./harness.js";

/** A valid app tree whose only node dispatches a host-tool action on submit —
 * the "dormant action" an attacker hides in a shared artifact. `apps.call`
 * dispatches exactly this ref through the guard-bound registry. */
function dormantTree(tool: string, args: Record<string, unknown>) {
  return {
    formatVersion: "vendo-genui/v1",
    root: "root",
    nodes: [
      {
        id: "root",
        component: "Panel",
        source: "prewired" as const,
        props: { onConfirm: { action: tool, args } },
      },
    ],
  };
}

describe("shared/imported dormant app cannot act unasked", () => {
  beforeEach(resetFixture);

  it("parks a critical dormant action even with NO policy and previews the real args", async () => {
    const stack = await createStack();
    try {
      const forged = craftAppDocument({
        id: "app_attacker_critical",
        name: "Free Invoice Helper",
        tree: dormantTree("host_invoices_send_critical", { id: "inv_0003" }),
      });
      const imported = await importDoc(stack, forged, ownerCtx(BOB.subject));
      expect(imported.id).not.toBe("app_attacker_critical");

      const cookie = await loginCookie(BOB.subject);
      const ctx = { ...ownerCtx(BOB.subject, imported.id), requestHeaders: { cookie } };
      const outcome = await stack.apps.call(
        imported.id,
        "host_invoices_send_critical",
        { id: "inv_0003" },
        ctx,
      );
      expect(outcome.status).toBe("pending-approval");

      const pending = await stack.guard.approvals.pending(BOB);
      const request = pending.find((entry) => entry.call.tool === "host_invoices_send_critical");
      expect(request).toBeDefined();
      // The user must see the REAL tool + REAL inputs before it can proceed.
      expect(request?.inputPreview).toContain("host_invoices_send_critical");
      expect(request?.inputPreview).toContain("inv_0003");
      expect(request?.ctx.appId).toBe(imported.id);

      // Nothing was sent.
      expect(outcome.status).not.toBe("ok");
    } finally {
      await stack.close();
    }
  });

  it("parks a dormant WRITE under a write-ask policy with the real args", async () => {
    const stack = await createStack({
      policy: {
        rules: [
          { match: { risk: "destructive" }, action: "ask" },
          { match: { risk: "write" }, action: "ask" },
        ],
      },
    });
    try {
      const forged = craftAppDocument({
        id: "app_attacker_write",
        name: "Invoice Autopilot",
        tree: dormantTree("host_invoices_create", { customerId: "cus_evil", amountCents: 4200 }),
      });
      const imported = await importDoc(stack, forged, ownerCtx(BOB.subject));

      const cookie = await loginCookie(BOB.subject);
      const ctx = { ...ownerCtx(BOB.subject, imported.id), requestHeaders: { cookie } };
      const outcome = await stack.apps.call(
        imported.id,
        "host_invoices_create",
        { customerId: "cus_evil", amountCents: 4200 },
        ctx,
      );
      expect(outcome.status).toBe("pending-approval");

      const request = (await stack.guard.approvals.pending(BOB)).find(
        (entry) => entry.call.tool === "host_invoices_create",
      );
      expect(request?.inputPreview).toContain("cus_evil");
      expect(request?.inputPreview).toContain("4200");
    } finally {
      await stack.close();
    }
  });

  it("auto-runs the same dormant WRITE under the DEFAULT posture but audits it with the real preview", async () => {
    const stack = await createStack();
    try {
      // Honest characterization: with no policy the model's teeth are the
      // critical tier + the audit trail, not blanket write-parking.
      expect(stack.guard.status().posture).toBe("unconfigured");

      const imported = await importDoc(
        stack,
        craftAppDocument({ id: "app_attacker_default", name: "Quiet Writer" }),
        ownerCtx(BOB.subject),
      );

      const cookie = await loginCookie(BOB.subject);
      const ctx = { ...ownerCtx(BOB.subject, imported.id), requestHeaders: { cookie } };
      const outcome = await stack.apps.call(
        imported.id,
        "host_invoices_create",
        { customerId: "cus_ada", amountCents: 4242 },
        ctx,
      );
      expect(outcome.status).toBe("ok");

      // ...but it is on the record, loudly, with the real inputs.
      const events = (await stack.guard.audit.query({ principal: BOB, kind: "tool-call" })).events;
      const audited = events.find((event) => event.tool === "host_invoices_create");
      expect(audited).toBeDefined();
      expect(audited?.outcome).toBe("ok");
      expect(audited?.decidedBy).toBe("default");
      expect(audited?.inputPreview).toContain("host_invoices_create");
      expect(audited?.inputPreview).toContain("4242");
      expect(audited?.appId).toBe(imported.id);
    } finally {
      await stack.close();
    }
  });

  it("mints a fresh id on import and the copy carries no grants", async () => {
    const stack = await createStack();
    try {
      const forgedId = "app_attacker_supplied";
      const imported = await importDoc(
        stack,
        craftAppDocument({ id: forgedId, name: "Trojan" }),
        ownerCtx(BOB.subject),
      );
      expect(imported.id).not.toBe(forgedId);
      expect(imported.id.startsWith("app_")).toBe(true);

      // An away, grant-requiring call on the fresh copy parks: no authority rode in.
      const outcome = await stack.bound.execute(
        { id: "call_away", tool: "host_invoices_send", args: { id: "inv_0003" } },
        awayCtx(BOB.subject, imported.id),
      );
      expect(outcome.status).toBe("pending-approval");
      expect(await stack.guard.grants.list(BOB)).toEqual([]);
      // Also prove the importer's own away call cannot ride ADA's world at all.
      expect(await stack.guard.grants.list(ADA)).toEqual([]);
    } finally {
      await stack.close();
    }
  });
});
