/**
 * The consent card an authored agentic automation actually shows its owner.
 *
 * The seam, end to end and unmocked on both sides: the REAL planner
 * (`planAutomation`, the one the generation server lane calls) authors the
 * trigger, and the REAL arm-time capture (`automations.enable`) reads it back.
 * Each side stubbed the other before, which is how "review the invoices and
 * write a note" shipped an enable card asking for 31 standing permissions —
 * including Send money — behind one "Allow all 31 & enable" button.
 *
 * Two independent guarantees, because the bug had two causes:
 *  1. the plan DECLARES what it will reach, so the card is the plan's own width;
 *  2. with no declaration, the fallback still never asks for a standing away
 *     grant on a tool THE LAW would refuse away — asking to allow a thing that
 *     can never happen is a false choice, not consent.
 */
import { planAutomation, type HostToolInfo } from "@vendoai/apps";
import { scriptedLanguageModel } from "@vendoai/apps/testing";
import { withheldFromUnattended, type ToolDescriptor } from "@vendoai/core";
import { beforeEach, describe, expect, it } from "vitest";
import { automationDoc, createStack, hostTools, ownerCtx, resetFixture } from "../src/harness.js";
import { ADA } from "../src/support.js";

/** The fixture's own host surface, in the shape the planner reads it in. */
const plannerTools: HostToolInfo[] = hostTools.map(({ name, description, risk, inputSchema }) => ({
  name,
  description,
  risk,
  inputSchema: inputSchema as Record<string, unknown>,
}));

const descriptorFor = (name: string): ToolDescriptor => {
  const tool = hostTools.find((entry) => entry.name === name);
  if (tool === undefined) throw new Error(`no fixture tool named ${name}`);
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema as ToolDescriptor["inputSchema"],
    risk: tool.risk as ToolDescriptor["risk"],
  };
};

/** What the planner is asked for, in the words the finding used: a judgment run
 *  that READS and WRITES A NOTE. It reaches two tools; the app is bound to six. */
const REVIEW_INSTRUCTION =
  "Every morning, review the invoices and write a note about which ones look risky.";

/** The planner's answer, as a model really returns it: the agentic contract tells
 *  it to name its tools in the prompt, and it does. */
const REVIEW_PLAN = JSON.stringify({
  name: "Invoice review",
  trigger: {
    on: { kind: "schedule", cron: "0 8 * * *" },
    run: {
      kind: "agentic",
      prompt: "Every morning, list the invoices with host_invoices_list, look up anything "
        + "unclear with host_invoices_get, judge which ones look risky, and note the reasons.",
      budget: { maxToolCalls: 20 },
    },
  },
});

describe("agentic consent surface", () => {
  beforeEach(resetFixture);

  it("asks only for the tools the authored plan names — not the whole bound surface", async () => {
    const appId = "app_agentic_authored";
    const planned = await planAutomation({
      appId,
      appName: "Invoice review",
      instruction: REVIEW_INSTRUCTION,
      mode: "agentic",
      tools: plannerTools,
    }, scriptedLanguageModel(REVIEW_PLAN));

    if (planned.kind !== "plan") throw new Error(`planning failed: ${planned.issues.join(" | ")}`);
    const { run } = planned.plan.trigger;
    if (run.kind !== "agentic") throw new Error("the planner authored a non-agentic run");
    // The plan says what it will reach. Authoring is the only moment that KNOWS
    // (it wrote the prompt), so a declaration written anywhere later would be a
    // guess.
    expect(run.tools).toEqual(["host_invoices_list", "host_invoices_get"]);

    const stack = await createStack();
    try {
      await stack.putApp(ADA.subject, automationDoc({
        id: appId,
        name: "Invoice review",
        trigger: planned.plan.trigger,
      }));
      const enabled = await stack.automations.enable(appId, "main", ownerCtx(ADA.subject, appId));

      expect(enabled.enabled).toBe(true);
      expect(enabled.missing.map((request) => request.call.tool))
        .toEqual(["host_invoices_list", "host_invoices_get"]);
      // The headline of the finding: no card for a thing this run can never do.
      expect(enabled.missing.every((request) => !withheldFromUnattended(request.descriptor))).toBe(true);
      // Narrower than the surface it is bound to — the whole point.
      expect(enabled.missing.length).toBeLessThan((await stack.bound.descriptors(
        ownerCtx(ADA.subject, appId),
      )).length);
    } finally {
      await stack.close();
    }
  });

  it("never asks to allow an irreversible tool away, even with no declaration to narrow it", async () => {
    const stack = await createStack();
    try {
      const appId = "app_agentic_undeclared";
      await stack.putApp(ADA.subject, automationDoc({
        id: appId,
        name: "Invoice review",
        trigger: {
          on: { kind: "host-event", event: "review.ready" },
          // No `tools`: an automation authored before declarations existed, or one
          // whose plan could not name them. The card is still the person's, so it
          // still may not ask about what would be refused anyway.
          run: { kind: "agentic", prompt: "Review the invoices and note what looks risky." },
        },
      }));

      const enabled = await stack.automations.enable(appId, "main", ownerCtx(ADA.subject, appId));
      const asked = enabled.missing.map((request) => request.call.tool);

      expect(asked).not.toContain("host_invoices_send");
      expect(asked.every((tool) => !withheldFromUnattended(descriptorFor(tool)))).toBe(true);
      // Still the fallback — everything the run COULD reach away is offered.
      expect(asked.sort()).toEqual([
        "host_invoices_create",
        "host_invoices_get",
        "host_invoices_list",
        "host_invoices_send_critical",
        "host_invoices_update",
      ]);
    } finally {
      await stack.close();
    }
  });
});
