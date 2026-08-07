/**
 * The refusal law at AUTHORING time (§12): an ask whose unattended fulfillment
 * needs an irreversible effect is refused here, in the planner, with a sentence
 * that names why and what IS possible instead.
 *
 * Why it has to be the planner and not just the arm: the generation pipeline
 * plans with the CREATING person's context (`presence: "present"`), so
 * `projectableForRun` hands it the destructive tools too — a plan naming one
 * validates, lands, and then dies at arm time as "unknown tool in automation",
 * because the away run is the venue where the law withholds it. The person is
 * told nothing useful. Refusing at authoring time is the only place the answer
 * can still be a sentence about their request.
 *
 * `host_invoices_send` is the case that matters, and it is graded `destructive`
 * because THE DECLARED LABEL IS THE TRUTH. This test was first written against a
 * `write`-declared send tool that core's `mechanicalRisk` name vote overruled;
 * that vote was deleted repo-wide with two-vote grading (#791), and
 * `packages/actions/src/sync/protocol-facts.test.ts` now forbids concluding
 * anything from a tool's name. So a mislabelled tool is a grading problem
 * (`vendo sync`, `.vendo/overrides.json`), not the planner's — and what the
 * planner owes is exactly what is asserted below: a labelled-irreversible tool is
 * never offered, and an ask that needs one comes back as a sentence.
 */
import { planAutomation, type AutomationPlanInput, type HostToolInfo } from "@vendoai/apps";
import { scriptedLanguageModel, type ScriptedModelCall } from "@vendoai/apps/testing";
import { UNATTENDED_DESTRUCTIVE_REASON } from "@vendoai/core";
import { describe, expect, it } from "vitest";

const SEND_TOOL = "host_invoices_send";

/** The prompt the planner was asked with, flattened. */
const promptText = (call: ScriptedModelCall): string => call.prompt
  .map((message) => typeof message.content === "string"
    ? message.content
    : message.content.map((part) => part.text ?? "").join(""))
  .join("\n");

const tools: HostToolInfo[] = [
  { name: "host_invoices_list", description: "List invoices", risk: "read" },
  // Graded destructive by whoever owns the catalog — the one signal the law reads.
  { name: SEND_TOOL, description: "Send invoice", risk: "destructive" },
  { name: "vendo_apps_data_put", description: "Publish app records", risk: "write" },
];

const stepsInput: AutomationPlanInput = {
  appId: "app_chaser",
  appName: "Invoice chaser",
  instruction: "every morning, email every customer with an overdue invoice",
  mode: "steps",
  tools,
};

const publishStep = {
  id: "publish",
  tool: "vendo_apps_data_put",
  args: {
    appId: "'app_chaser'",
    collection: "'chased'",
    id: "'latest'",
    data: "steps.rows",
  },
};

const stepsPlan = (steps: unknown[]): string => JSON.stringify({
  name: "Overdue chaser",
  trigger: {
    on: { kind: "schedule", cron: "0 8 * * *" },
    run: { kind: "steps", steps },
  },
  resultsCollection: "chased",
});

const readAndSend = stepsPlan([
  { id: "rows", tool: "host_invoices_list" },
  { id: "send", tool: SEND_TOOL, args: { id: "steps.rows.items[0].id" } },
  publishStep,
]);

const readAndPublish = stepsPlan([
  { id: "rows", tool: "host_invoices_list" },
  publishStep,
]);

const issuesOf = (result: Awaited<ReturnType<typeof planAutomation>>): string[] => {
  if (result.kind !== "failure") {
    throw new Error(`expected a refusal, got a plan: ${JSON.stringify(result)}`);
  }
  return result.issues;
};

describe("automation authoring refuses irreversible work", () => {
  it("refuses a steps body that names a destructive send tool, in the person's words", async () => {
    const result = await planAutomation(stepsInput, scriptedLanguageModel(readAndSend));

    const refusal = issuesOf(result).find((issue) => issue.includes(SEND_TOOL));
    expect(refusal).toBeDefined();
    // The reason is the deployment's ONE definition of it, not a second wording.
    expect(refusal).toContain(UNATTENDED_DESTRUCTIVE_REASON);
    // And it is a refusal, not the planner mistaking it for a typo.
    expect(refusal).not.toContain("unknown tool");
  });

  it("never offers the destructive tool to the model in the first place", async () => {
    const offered: string[] = [];
    const model = scriptedLanguageModel((call) => {
      const prompt = promptText(call);
      offered.push(prompt);
      return readAndPublish;
    });

    await planAutomation(stepsInput, model);

    const contract = offered[0] ?? "";
    expect(contract).toContain("host_invoices_list");
    expect(contract).toContain("vendo_apps_data_put");
    expect(contract).not.toContain(SEND_TOOL);
  });

  it("refuses an agentic prompt whose point is the destructive tool", async () => {
    const agentic = JSON.stringify({
      name: "Overdue chaser",
      trigger: {
        on: { kind: "schedule", cron: "0 8 * * *" },
        run: {
          kind: "agentic",
          prompt: `Find the overdue invoices with host_invoices_list and ${SEND_TOOL} a reminder for each one.`,
          budget: { maxToolCalls: 20 },
        },
      },
    });

    const result = await planAutomation(
      { ...stepsInput, mode: "agentic" },
      scriptedLanguageModel(agentic),
    );

    const refusal = issuesOf(result).find((issue) => issue.includes(SEND_TOOL));
    expect(refusal).toBeDefined();
    expect(refusal).toContain(UNATTENDED_DESTRUCTIVE_REASON);
  });

  it("still accepts the away-safe version of the same ask — read, then publish", async () => {
    const result = await planAutomation(stepsInput, scriptedLanguageModel(readAndPublish));

    expect(result.kind).toBe("plan");
    if (result.kind !== "plan") return;
    expect(result.plan.resultsCollection).toBe("chased");
    expect(result.plan.trigger.run.kind).toBe("steps");
  });
});
