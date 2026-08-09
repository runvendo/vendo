import { awayRunner } from "@vendoai/agents";
import { USE_SERVICE_TOOL, type AgentRunner, type ToolCall, type ToolOutcome } from "@vendoai/core";
import { agentRunnerConformance, runConformance } from "@vendoai/core/conformance";
import { createGuard } from "@vendoai/guard";
import { defineHarness } from "@vendoai/harnesses";
import { createStore } from "@vendoai/store";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { automationDoc, createStack, ownerCtx, resetFixture, serviceToolCalls } from "../src/harness.js";
import { ADA, approve, fixtureInvoices } from "../src/support.js";

interface RunnerObservation {
  prompt: string;
  maxToolCalls: number | undefined;
}

function scriptedRunner(observations: RunnerObservation[] = []): AgentRunner {
  return async (task, ctx) => {
    observations.push({ prompt: task.prompt, maxToolCalls: task.budget?.maxToolCalls });
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
      const enabled = await stack.automations.enable(appId, "main", ctx);
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
        const enabled = await stack.automations.enable(appId, "main", ctx);
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
      const enabled = await stack.automations.enable(appId, "main", ctx);
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

  /** The SHIPPED away entry against core's own kit — unmodified. The thinker is
   *  scripted (a conformance run must not need a key), but everything the seam is
   *  about is real: the harness runtime, the guard, the store-backed thread and
   *  workspace, `interactive: false`, and the report the engine consumes. */
  it("passes the core AgentRunner conformance kit", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "vendo-away-conformance-"));
    const store = createStore({ dataDir });
    try {
      const report = await runConformance(agentRunnerConformance({
        makeRunner: async () => awayRunner({
          store,
          guard: createGuard({ store }),
          harness: defineHarness({
            name: "conformance",
            async *run(turn) {
              const listed = await turn.tools.list();
              for (const tool of listed) await turn.tools.call(tool.name, { ping: true });
              yield { type: "text" as const, delta: "The conformance echo ran." };
            },
          }),
        }),
        ctx: ownerCtx("user_conformance"),
      }));
      expect(report.ok, JSON.stringify(report.failures)).toBe(true);
      expect(report.passed).toBeGreaterThan(0);
    } finally {
      await store.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});

/**
 * The SHIPPED away entry driving a real automation, end to end, with no key: the
 * real engine fires it, the real `@vendoai/agents` runner runs it on the real
 * harness runtime, the real guard decides its calls, and the real fixture host
 * serves them. Only the thinker is scripted — the live leg (`live-agentic`) is the
 * same wiring with a real model in that one slot.
 */
describe("the away runner on a real automation", () => {
  beforeEach(resetFixture);

  it("reads through the guard-bound surface it was handed and stores its own words as the run summary", async () => {
    const stack = await createStack({
      runnerFrom: ({ guard, store }) => awayRunner({
        store,
        guard,
        harness: defineHarness({
          name: "scripted-away",
          async *run(turn) {
            const listed = (await turn.tools.list()).map(({ name }) => name);
            // THE LAW, from inside the harness: an away listing has the read and
            // not the destructive send, so the model is never offered the send.
            const result = listed.includes("host_invoices_list")
              ? await turn.tools.call("host_invoices_list", {})
              : { status: "error" as const, error: { code: "missing", message: "no read on the listing" } };
            yield {
              type: "text" as const,
              delta: `read=${result.status} send_offered=${String(listed.includes("host_invoices_send"))}`,
            };
          },
        }),
      }),
    });
    try {
      const appId = "app_away_runner_real";
      const ctx = ownerCtx(ADA.subject, appId);
      await stack.putApp(ADA.subject, automationDoc({
        id: appId,
        trigger: {
          on: { kind: "host-event", event: "away.real" },
          run: { kind: "agentic", prompt: "Count the invoices.", tools: ["host_invoices_list"] },
        },
      }));
      const enabled = await stack.automations.enable(appId, "main", ctx);
      // The declaration is one tool, so consent is one card — not the whole surface.
      expect(enabled.missing.map((request) => request.call.tool)).toEqual(["host_invoices_list"]);
      await approve(stack, enabled.missing);

      const [runId] = await stack.automations.emit("away.real", {}, ADA);
      const run = await stack.automations.runs.get(runId!, ctx);

      expect(run?.status).toBe("ok");
      expect(run?.summary).toBe("read=ok send_offered=false");
      // The run record is the runner's report: one guarded call, the guard's outcome.
      expect(run?.steps.map((step) => [step.tool, step.outcome])).toEqual([["host_invoices_list", "ok"]]);
      // The row on disk agrees with what the door answered.
      const stored = await stack.sql<{ status: string; record: { summary?: string } }>(
        "SELECT status, record FROM vendo_runs WHERE id = $1",
        [runId],
      );
      expect(stored[0]?.status).toBe("ok");
      expect(stored[0]?.record.summary).toBe("read=ok send_offered=false");
    } finally {
      await stack.close();
    }
  });

  it("records a call it was NOT granted as pending, and nothing happens at the host", async () => {
    const stack = await createStack({
      runnerFrom: ({ guard, store }) => awayRunner({
        store,
        guard,
        harness: defineHarness({
          name: "overreaching",
          async *run(turn) {
            const result = await turn.tools.call("host_invoices_create", { memo: "nope" });
            yield { type: "text" as const, delta: `create=${result.status}` };
          },
        }),
      }),
    });
    try {
      const appId = "app_away_runner_ungranted";
      const ctx = ownerCtx(ADA.subject, appId);
      await stack.putApp(ADA.subject, automationDoc({
        id: appId,
        trigger: {
          on: { kind: "host-event", event: "away.ungranted" },
          // Declares only the read; the harness reaches for a write anyway.
          run: { kind: "agentic", prompt: "Count the invoices.", tools: ["host_invoices_list"] },
        },
      }));
      await approve(stack, (await stack.automations.enable(appId, "main", ctx)).missing);
      const before = (await fixtureInvoices()).length;

      const [runId] = await stack.automations.emit("away.ungranted", {}, ADA);
      const run = await stack.automations.runs.get(runId!, ctx);

      expect(run?.steps.map((step) => [step.tool, step.outcome]))
        .toEqual([["host_invoices_create", "pending-approval"]]);
      expect(run?.summary).toBe("create=denied");
      expect((await fixtureInvoices()).length).toBe(before);
      // The card STANDS, so "Grant & re-run" has something to collect.
      const parked = (await stack.guard.approvals.pending(ADA))
        .filter((entry) => entry.ctx.presence === "away" && entry.call.tool === "host_invoices_create");
      expect(parked).toHaveLength(1);
    } finally {
      await stack.close();
    }
  });
});

/**
 * The caged dispatcher: at 2am the run sees it, and only granted actions execute.
 *
 * `use_service_tool` is a whole third-party catalog behind one tool name, so its
 * descriptor is `ungraded` — and §12's projection withholds every `ungraded`
 * descriptor from an unattended run exactly as it withholds destructive ones
 * (`withheldFromUnattended`, core grant-sets.ts). Applied to the dispatcher with
 * no exception, that did not cage an agentic automation's connector access, it
 * REMOVED it: no unattended run could reach a connector at all, however
 * explicitly a person had allowed one particular action.
 *
 * So the projection has exactly one exemption, and these pin its edges: the
 * dispatcher is on an unattended listing IFF the firing (app, trigger) holds at
 * least one live per-slug service grant (`isGrantedDispatcher`, core
 * grant-sets.ts; the slugs are read at fire time by the engine). One tool name,
 * not a risk level — every other `ungraded` tool stays withheld — and
 * `destructive` has no exemption at all.
 *
 * THE PINNED LAWS, restated for an agentic run, and untouched by any of that
 * because they are CALL-time: an unattended run can never call an ungranted slug,
 * and a destructive-graded slug never executes away — granted or not. Being shown
 * the door is not being through it.
 */
describe("agentic runs and the connector dispatcher", () => {
  beforeEach(resetFixture);

  /** Reports the surface it was handed, and dispatches whatever slugs it is told to. */
  function dispatchingRunner(seen: { tools: string[][] }, slugs: string[] = []): AgentRunner {
    return async (task, ctx) => {
      seen.tools.push((await task.tools.descriptors(ctx)).map(({ name }) => name).sort());
      const toolCalls: Array<{ call: ToolCall; outcome: ToolOutcome["status"] }> = [];
      for (const [index, slug] of slugs.entries()) {
        const call: ToolCall = { id: `call_${index}`, tool: USE_SERVICE_TOOL, args: { slug } };
        toolCalls.push({ call, outcome: (await task.tools.execute(call, ctx)).status });
      }
      return { status: "ok", summary: "dispatched", toolCalls };
    };
  }

  const agenticServiceApp = (id: string, tools?: string[]) => automationDoc({
    id,
    name: "Inbox digest",
    trigger: {
      on: { kind: "host-event", event: `${id}.fire` },
      run: {
        kind: "agentic",
        prompt: "read the inbox and summarise it",
        ...(tools === undefined ? {} : { tools }),
      },
    },
  });

  it("shows the dispatcher to a trigger that holds a service grant, and withholds it from one that does not", async () => {
    const seen = { tools: [] as string[][] };
    const stack = await createStack({ serviceTools: true, runner: dispatchingRunner(seen) });
    try {
      const ungranted = "app_agentic_no_service_grant";
      await stack.putApp(ADA.subject, agenticServiceApp(ungranted));
      await approve(stack, (await stack.automations.enable(ungranted, "main", ownerCtx(ADA.subject, ungranted))).missing);

      const granted = "app_agentic_service_granted";
      await stack.putApp(ADA.subject, agenticServiceApp(granted, ["GMAIL_FETCH_EMAILS"]));
      await approve(stack, (await stack.automations.enable(granted, "main", ownerCtx(ADA.subject, granted))).missing);
      // The grant is real, standing, app-bound and for that exact slug…
      expect((await stack.guard.grants.list(ADA)).map((grant) => grant.scope))
        .toContainEqual({ kind: "service-tool", slug: "GMAIL_FETCH_EMAILS" });

      await stack.automations.emit(`${ungranted}.fire`, {}, ADA);
      await stack.automations.emit(`${granted}.fire`, {}, ADA);
      expect(seen.tools).toHaveLength(2);
      const [withoutGrant, withGrant] = seen.tools as [string[], string[]];

      // …so at 2am the run SEES the dispatcher — caged, not absent. Withholding
      // it outright left an agentic automation unable to reach a connector at
      // all, however explicitly it had been allowed one.
      expect(withGrant).toContain(USE_SERVICE_TOOL);
      // A trigger nobody granted a service action keeps the old answer: the
      // dispatcher is an `ungraded` tool, and nothing has said it may run one.
      expect(withoutGrant).not.toContain(USE_SERVICE_TOOL);

      for (const surface of seen.tools) {
        // The cage is exactly one door wide. Destructive stays withheld on BOTH
        // surfaces — a service grant buys the dispatcher, never the law.
        expect(surface).not.toContain("host_invoices_send");
        // And caging is not a lockdown: the graded surface is all there.
        expect(surface).toContain("host_invoices_list");
        expect(surface).toContain("host_invoices_create");
      }
    } finally {
      await stack.close();
    }
  });

  it("runs the granted slug the dispatcher was shown for", async () => {
    const seen = { tools: [] as string[][] };
    const stack = await createStack({
      serviceTools: true,
      runner: dispatchingRunner(seen, ["GMAIL_FETCH_EMAILS"]),
    });
    try {
      const appId = "app_agentic_caged_ok";
      await stack.putApp(ADA.subject, agenticServiceApp(appId, ["GMAIL_FETCH_EMAILS"]));
      const enabled = await stack.automations.enable(appId, "main", ownerCtx(ADA.subject, appId));
      await approve(stack, enabled.missing);

      const [runId] = await stack.automations.emit(`${appId}.fire`, {}, ADA);
      const run = await stack.automations.runs.get(runId!, ownerCtx(ADA.subject, appId));

      expect(run?.steps.map((step) => step.outcome)).toEqual(["ok"]);
      expect(serviceToolCalls.map((entry) => entry.slug)).toEqual(["GMAIL_FETCH_EMAILS"]);
    } finally {
      await stack.close();
    }
  });

  it("LAW: an ungranted slug never runs, in the same run that runs a granted one", async () => {
    const seen = { tools: [] as string[][] };
    const stack = await createStack({
      serviceTools: true,
      // Both slugs grade `read`, so the descriptor hash cannot tell them apart:
      // the only thing that can refuse the second one is its slug.
      runner: dispatchingRunner(seen, ["GMAIL_FETCH_EMAILS", "GMAIL_LIST_LABELS"]),
    });
    try {
      const appId = "app_agentic_caged_scope";
      await stack.putApp(ADA.subject, agenticServiceApp(appId, ["GMAIL_FETCH_EMAILS"]));
      const enabled = await stack.automations.enable(appId, "main", ownerCtx(ADA.subject, appId));
      await approve(stack, enabled.missing);

      const [runId] = await stack.automations.emit(`${appId}.fire`, {}, ADA);
      const run = await stack.automations.runs.get(runId!, ownerCtx(ADA.subject, appId));

      expect(run?.steps.map((step) => step.outcome)).toEqual(["ok", "pending-approval"]);
      expect(serviceToolCalls.map((entry) => entry.slug)).toEqual(["GMAIL_FETCH_EMAILS"]);
    } finally {
      await stack.close();
    }
  });

  it("LAW: a destructive-graded slug never executes away, granted or not", async () => {
    const seen = { tools: [] as string[][] };
    const stack = await createStack({
      serviceTools: true,
      runner: dispatchingRunner(seen, ["GMAIL_SEND_EMAIL"]),
    });
    try {
      const appId = "app_agentic_caged_destructive";
      await stack.putApp(ADA.subject, agenticServiceApp(appId, ["GMAIL_SEND_EMAIL"]));
      const enabled = await stack.automations.enable(appId, "main", ownerCtx(ADA.subject, appId));
      // The grant is real, standing, app-bound and for this exact slug…
      expect(enabled.missing.map((request) => request.descriptor.risk)).toEqual(["destructive"]);
      await approve(stack, enabled.missing);

      const [runId] = await stack.automations.emit(`${appId}.fire`, {}, ADA);
      const run = await stack.automations.runs.get(runId!, ownerCtx(ADA.subject, appId));

      // …and THE LAW still refuses it, exactly as it refuses a granted host send.
      expect(run?.steps.map((step) => step.outcome)).toEqual(["blocked"]);
      expect(serviceToolCalls).toEqual([]);
    } finally {
      await stack.close();
    }
  });
});
