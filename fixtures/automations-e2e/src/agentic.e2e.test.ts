import type { AgentRunner, ToolCall } from "@vendoai/core";
import { agentRunnerConformance, runConformance } from "@vendoai/core/conformance";
import { beforeEach, describe, expect, it } from "vitest";
import { automationDoc, createStack, ownerCtx, resetFixture } from "./harness.js";
import { ADA, approve, fixtureInvoices } from "./support.js";

interface RunnerObservation {
  prompt: string;
  maxToolCalls: number | undefined;
}

function scriptedRunner(observations: RunnerObservation[] = []): AgentRunner {
  return async (task, ctx) => {
    observations.push({ prompt: task.prompt, maxToolCalls: task.budget?.maxToolCalls });
    const names = new Set((await task.tools.descriptors()).map(({ name }) => name));
    if (names.has("conformance_echo")) {
      const call: ToolCall = { id: "call_conformance", tool: "conformance_echo", args: { ping: true } };
      const outcome = await task.tools.execute(call, ctx);
      return {
        status: "ok",
        summary: "conformance echo complete",
        toolCalls: [{ call, outcome: outcome.status }],
      };
    }

    const read: ToolCall = { id: "call_read", tool: "host_invoices_list", args: {} };
    const write: ToolCall = { id: "call_write", tool: "host_invoices_send", args: { id: "inv_0003" } };
    const readOutcome = await task.tools.execute(read, ctx);
    const writeOutcome = await task.tools.execute(write, ctx);
    return {
      status: "ok",
      summary: "did the rounds",
      toolCalls: [
        { call: read, outcome: readOutcome.status },
        { call: write, outcome: writeOutcome.status },
      ],
    };
  };
}

function agenticTrigger(maxToolCalls?: number) {
  return {
    on: { kind: "host-event" as const, event: "agent.rounds" },
    run: {
      kind: "agentic" as const,
      prompt: "List invoices with host_invoices_list, then send inv_0003 with host_invoices_send.",
      ...(maxToolCalls === undefined ? {} : { budget: { maxToolCalls } }),
    },
  };
}

describe("scripted agentic runs", () => {
  beforeEach(resetFixture);

  it("uses the supplied guard-bound tools and stores the runner report verbatim", async () => {
    const observations: RunnerObservation[] = [];
    const stack = await createStack({ runner: scriptedRunner(observations) });
    try {
      const appId = "app_agentic_scripted";
      const ctx = ownerCtx(ADA.subject, appId);
      await stack.putApp(ADA.subject, automationDoc({ id: appId, trigger: agenticTrigger() }));
      const enabled = await stack.automations.enable(appId, ctx);
      expect(enabled.enabled).toBe(true);
      await approve(stack, enabled.missing.filter((request) => request.call.tool === "host_invoices_list"));

      const ids = await stack.automations.emit("agent.rounds", { round: 1 }, ADA);
      const id = ids[0];
      if (!id) throw new Error("emit did not return a run id");
      const run = await stack.automations.runs.get(id, ctx);
      expect(run).toMatchObject({
        status: "ok",
        summary: "did the rounds",
        steps: [
          { id: "call_read", tool: "host_invoices_list", outcome: "ok" },
          { id: "call_write", tool: "host_invoices_send", outcome: "pending-approval" },
        ],
      });
      const stored = await stack.sql<{ status: string; record: unknown }>(
        "SELECT status, record FROM vendo_runs WHERE id = $1",
        [id],
      );
      expect(stored[0]?.status).toBe("ok");
      expect(stored[0]?.record).toMatchObject({
        summary: "did the rounds",
        steps: [
          { id: "call_read", tool: "host_invoices_list", outcome: "ok" },
          { id: "call_write", tool: "host_invoices_send", outcome: "pending-approval" },
        ],
      });
      expect(observations).toEqual([{
        prompt: "List invoices with host_invoices_list, then send inv_0003 with host_invoices_send.",
        maxToolCalls: 50,
      }]);
      expect((await fixtureInvoices()).find(({ id: invoiceId }) => invoiceId === "inv_0003")?.status).toBe("draft");
    } finally {
      await stack.close();
    }
  });

  it("passes the default budget of 50 and preserves a trigger override", async () => {
    const observations: RunnerObservation[] = [];
    const stack = await createStack({ runner: scriptedRunner(observations) });
    try {
      for (const [appId, budget] of [["app_agentic_default", undefined], ["app_agentic_custom", 7]] as const) {
        const ctx = ownerCtx(ADA.subject, appId);
        await stack.putApp(ADA.subject, automationDoc({ id: appId, trigger: agenticTrigger(budget) }));
        const enabled = await stack.automations.enable(appId, ctx);
        await approve(stack, enabled.missing);
      }
      await stack.automations.emit("agent.rounds", {}, ADA);
      expect(observations.map(({ maxToolCalls }) => maxToolCalls).sort((left, right) => (left ?? 0) - (right ?? 0)))
        .toEqual([7, 50]);
    } finally {
      await stack.close();
    }
  });

  it("keeps enable available but records an error when no runner is configured", async () => {
    const stack = await createStack();
    try {
      const appId = "app_agentic_unavailable";
      const ctx = ownerCtx(ADA.subject, appId);
      await stack.putApp(ADA.subject, automationDoc({ id: appId, trigger: agenticTrigger() }));
      const enabled = await stack.automations.enable(appId, ctx);
      expect(enabled.enabled).toBe(true);
      await approve(stack, enabled.missing);
      const ids = await stack.automations.emit("agent.rounds", {}, ADA);
      const id = ids[0];
      if (!id) throw new Error("emit did not return a run id");
      expect(await stack.automations.runs.get(id, ctx)).toMatchObject({
        status: "error",
        error: { code: "not-implemented" },
      });
    } finally {
      await stack.close();
    }
  });

  it("passes the core AgentRunner conformance kit", async () => {
    const report = await runConformance(agentRunnerConformance({
      makeRunner: async () => scriptedRunner(),
      ctx: ownerCtx("user_conformance"),
    }));
    expect(report.ok, JSON.stringify(report.failures)).toBe(true);
    expect(report.passed).toBeGreaterThan(0);
  });
});
