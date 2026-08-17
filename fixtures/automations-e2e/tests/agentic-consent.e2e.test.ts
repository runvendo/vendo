/**
 * The consent card an authored goal automation actually shows its owner.
 *
 * The seam, end to end and unmocked on both sides: the REAL planner
 * (`planAutomation`, the one the generation server lane calls) authors the
 * automation, the REAL create operation stores it, and the REAL arm-time capture
 * (`automations.enable`) reads it back. Each side stubbed the other before, which
 * is how "review the invoices and write a note" shipped an enable card asking for
 * 31 standing permissions — including Send money — behind one "Allow all 31 &
 * enable" button.
 *
 * ONE of that finding's two guarantees survives the centralization. `AutomationTask`
 * has no place for the tool set an authored plan declares, so the card can no
 * longer be the plan's own width: EVERY goal record gets the fallback surface and
 * the narrowing is the person's, card by card. What still holds — and what this
 * pins — is that the fallback never asks for a standing away grant on a tool THE
 * LAW would refuse away. Asking to allow a thing that can never happen is a false
 * choice, not consent.
 */
import { planAutomation, type HostToolInfo } from "@vendoai/apps";
import { scriptedLanguageModel } from "@vendoai/apps/testing";
import { withheldFromUnattended } from "@vendoai/core";
import { beforeEach, describe, expect, it } from "vitest";
import { createStack, hostTools, ownerCtx, resetFixture } from "../src/harness.js";
import { ADA } from "../src/support.js";

/** The fixture's own host surface, in the shape the planner reads it in. */
const plannerTools: HostToolInfo[] = hostTools.map(({ name, description, risk, inputSchema }) => ({
  name,
  description,
  risk,
  inputSchema: inputSchema as Record<string, unknown>,
}));

/** What the planner is asked for, in the words the finding used: a judgment run
 *  that READS and WRITES A NOTE. It reaches two tools; the deployment binds six. */
const REVIEW_INSTRUCTION =
  "Every morning, review the invoices and write a note about which ones look risky.";

/** The planner's answer, as a model really returns it — a create input, not an
 *  app document with a trigger on it. */
const REVIEW_PLAN = JSON.stringify({
  name: "Invoice review",
  when: "0 8 * * *",
  task: {
    kind: "goal",
    prompt: "Every morning, list the invoices with host_invoices_list, look up anything "
      + "unclear with host_invoices_get, judge which ones look risky, and note the reasons.",
    budget: { maxToolCalls: 20 },
  },
});

describe("goal consent surface", () => {
  beforeEach(resetFixture);

  it("stores what the planner authored and asks its owner only about away-safe tools", async () => {
    const planned = await planAutomation({
      appId: "app_agentic_authored",
      appName: "Invoice review",
      instruction: REVIEW_INSTRUCTION,
      mode: "goal",
      tools: plannerTools,
    }, scriptedLanguageModel(REVIEW_PLAN));

    if (planned.kind !== "plan") throw new Error(`planning failed: ${planned.issues.join(" | ")}`);
    const { plan } = planned;
    expect(plan.task.kind).toBe("goal");

    const stack = await createStack();
    try {
      const ctx = ownerCtx(ADA.subject);
      // What the planner authored goes through the ONE create door every other
      // authoring door uses — nothing here reshapes it on the way.
      const created = await stack.create({
        owner: ADA,
        when: plan.when,
        task: plan.task,
        authoredBy: "chat",
      }, ctx);
      // The authored `when` is normalized once, at create, and stored that way.
      expect((await stack.automations.get(created.id, ctx))?.when)
        .toEqual({ kind: "schedule", cron: "0 8 * * *" });

      const enabled = await stack.automations.enable(created.id, ctx);
      expect(enabled.enabled).toBe(true);
      // The headline of the finding: no card for a thing this run can never do.
      expect(enabled.missing.every((request) => !withheldFromUnattended(request.descriptor))).toBe(true);
      expect(enabled.missing.map((request) => request.call.tool).sort()).toEqual([
        "host_invoices_create",
        "host_invoices_get",
        "host_invoices_list",
        "host_invoices_send_critical",
        "host_invoices_update",
      ]);
      // ONE grant set, so a single decision settles the whole card.
      expect(enabled.grantSetId).toBeTruthy();
    } finally {
      await stack.close();
    }
  });
});
