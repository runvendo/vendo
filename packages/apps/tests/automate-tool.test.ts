/**
 * `vendo_automate` — the chat door onto the one create operation.
 *
 * It rides the REAL tool registry (`createAgentTools().execute`), so the
 * descriptor, the dispatch and the executor are the ones a host actually mounts,
 * and the answer is parsed back with core's own `vendoAutomationRefSchema` — the
 * schema every downstream reader validates with. A hand-built envelope asserted
 * against a hand-built expectation would agree with itself and prove nothing.
 *
 * What it deliberately does NOT reach is an app. An automation carries no app
 * reference at all: a task reaches an app's function the same way it reaches any
 * other tool, by naming it.
 */
import {
  parseVendoToolEnvelope,
  VENDO_AUTOMATE_TOOL,
  VENDO_AUTOMATION_REF_KIND,
  type RunContext,
  type ToolOutcome,
} from "@vendoai/core";
import { describe, expect, it } from "vitest";
import { agentToolDescriptors, createAgentTools, type AgentToolsDataDependencies } from "../src/server/doors/agent-tools.js";
import type { AppsRuntime } from "../src/server/runtime/types.js";
import { fakeAutomations } from "./automations-double.test-util.js";

const ctx: RunContext = {
  principal: { kind: "user", subject: "user_ada" },
  venue: "chat",
  presence: "present",
  sessionId: "session_ada",
};

const registryWith = (engine?: ReturnType<typeof fakeAutomations>) => createAgentTools(
  {} as unknown as AppsRuntime,
  {
    claimSlot: async () => {},
    markUnbuilt: async () => {},
    ...(engine === undefined ? {} : { automations: engine.seam }),
  } as unknown as AgentToolsDataDependencies,
);

const arm = async (
  engine: ReturnType<typeof fakeAutomations>,
  args: Record<string, unknown>,
): Promise<ToolOutcome> =>
  await registryWith(engine).execute(
    { id: "call_1", tool: VENDO_AUTOMATE_TOOL, args: args as never },
    ctx,
  );

const refIn = (outcome: ToolOutcome): Record<string, unknown> => {
  if (outcome.status !== "ok") throw new Error(`expected ok, got ${JSON.stringify(outcome)}`);
  const envelope = parseVendoToolEnvelope(outcome.output);
  if (envelope === null || envelope.kind !== VENDO_AUTOMATION_REF_KIND) {
    throw new Error(`not an automation ref: ${JSON.stringify(outcome.output)}`);
  }
  return envelope as unknown as Record<string, unknown>;
};

describe("vendo_automate", () => {
  it("is offered to the model, with a title and a write grade", () => {
    const descriptor = agentToolDescriptors.find(({ name }) => name === VENDO_AUTOMATE_TOOL);
    expect(descriptor).toMatchObject({ risk: "write", title: "Set this to run on its own" });
  });

  it("creates the record through the ONE create operation and answers with the ref core parses", async () => {
    const engine = fakeAutomations();
    const ref = refIn(await arm(engine, { when: "0 9 * * 1", task: "summarize the week and email ops" }));

    const record = engine.records.get(ref.automationId as string);
    expect(record).toMatchObject({
      when: { kind: "schedule", cron: "0 9 * * 1" },
      task: { kind: "goal", prompt: "summarize the week and email ops" },
      authoredBy: "chat",
      owner: ctx.principal,
    });
    // The layering flip, asserted rather than assumed: nothing about an app.
    expect(Object.keys(record ?? {})).not.toContain("appId");
    expect(ref).toMatchObject({ armed: true, summary: expect.stringContaining("0 9 * * 1") });
  });

  it("computes the next run from `when` for every schedule shape, and for none other", async () => {
    const engine = fakeAutomations();
    expect(refIn(await arm(engine, { when: "0 9 * * 1", task: "weekly" })).nextRunAt).toEqual(expect.any(String));
    expect(refIn(await arm(engine, { when: { every: "1d" }, task: "daily" })).nextRunAt).toEqual(expect.any(String));
    expect(refIn(await arm(engine, { when: { at: "2099-09-01T09:00:00.000Z" }, task: "once" })).nextRunAt)
      .toBe("2099-09-01T09:00:00.000Z");
    // An event has no next run to name, so the field is absent rather than a lie.
    expect(refIn(await arm(engine, { when: { event: "payment.failed" }, task: "triage" })).nextRunAt)
      .toBeUndefined();
  });

  it("names the outstanding permissions in the line the model reads out", async () => {
    const engine = fakeAutomations({
      enable: async () => ({ enabled: false, missing: [{}, {}] as never }),
    });
    const ref = refIn(await arm(engine, { when: "0 9 * * 1", task: "weekly" }));

    expect(ref.armed).toBe(false);
    expect(ref.summary).toContain("2 permission(s) still to allow");
  });

  it("refuses plain English rather than storing a schedule nothing can fire", async () => {
    const outcome = await arm(fakeAutomations(), { when: "every monday", task: "weekly" });

    expect(outcome.status).toBe("error");
    expect(outcome.status === "error" && outcome.error.message).toContain("Did you mean");
  });

  it("says so when no automations engine is composed, rather than reporting a schedule that runs", async () => {
    const outcome = await registryWith().execute(
      { id: "call_1", tool: VENDO_AUTOMATE_TOOL, args: { when: "0 9 * * 1", task: "weekly" } },
      ctx,
    );

    expect(outcome.status).toBe("error");
    expect(outcome.status === "error" && outcome.error.message).toContain("no automations engine");
  });
});
