/** Goal tasks: the runner seam, the budget, and what an away run may reach.
 *
 * The unit is the RECORD. A goal task is `{ kind: "goal", prompt, budget? }` and
 * NOTHING else — there is no declared tool set on it any more, so arming
 * captures the whole away-safe surface and the narrowing is the person's: they
 * approve the cards they mean. Every test below grants exactly the cards its
 * subject needs and leaves the rest standing.
 */
import { awayRunner } from "@vendoai/agents";
import {
  DEFAULT_RUNNER_NAME,
  serviceToolSlug,
  USE_SERVICE_TOOL,
  type AgentRunner,
  type CreateAutomationInput,
  type RunContext,
  type ToolCall,
  type ToolOutcome,
} from "@vendoai/core";
import { agentRunnerConformance, runConformance } from "@vendoai/core/conformance";
import { createGuard } from "@vendoai/guard";
import { defineHarness } from "@vendoai/harnesses";
import { createStore } from "@vendoai/store";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { createStack, ownerCtx, resetFixture, serviceToolCalls, type Stack } from "../src/harness.js";
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

const ROUNDS_PROMPT = "List invoices with host_invoices_list, then send inv_0003 with host_invoices_send.";

const goalRecord = (event: string, maxToolCalls?: number): CreateAutomationInput => ({
  owner: ADA,
  when: { event },
  task: {
    kind: "goal",
    prompt: ROUNDS_PROMPT,
    ...(maxToolCalls === undefined ? {} : { budget: { maxToolCalls } }),
  },
  authoredBy: "chat",
});

describe("scripted goal runs", () => {
  beforeEach(resetFixture);

  it("uses the supplied guard-bound tools and stores the runner report verbatim", async () => {
    const observations: RunnerObservation[] = [];
    const stack = await createStack({ runner: scriptedRunner(observations) });
    try {
      const ctx = ownerCtx(ADA.subject);
      const created = await stack.create(goalRecord("agent.rounds"), ctx);
      const enabled = await stack.automations.enable(created.id, ctx);
      expect(enabled.enabled).toBe(true);
      await approve(stack, enabled.missing.filter(({ call }) => call.tool === "host_invoices_list"));

      const [id] = await stack.automations.emit("agent.rounds", { round: 1 }, ADA);
      if (id === undefined) throw new Error("emit did not return a run id");
      const run = await stack.automations.runs.get(id, ctx);
      expect(run).toMatchObject({
        automationId: created.id,
        agent: DEFAULT_RUNNER_NAME,
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
      expect(observations).toEqual([{ prompt: ROUNDS_PROMPT, maxToolCalls: 50 }]);
      expect((await fixtureInvoices()).find(({ id: invoiceId }) => invoiceId === "inv_0003")?.status).toBe("draft");
    } finally {
      await stack.close();
    }
  });

  it("passes the default budget of 50 and preserves a per-record override", async () => {
    const observations: RunnerObservation[] = [];
    const stack = await createStack({ runner: scriptedRunner(observations) });
    try {
      const ctx = ownerCtx(ADA.subject);
      // Two records on ONE event: the budget travels with the record, not the event.
      for (const budget of [undefined, 7]) {
        const created = await stack.create(goalRecord("agent.rounds", budget), ctx);
        await approve(stack, (await stack.automations.enable(created.id, ctx)).missing);
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
      const ctx = ownerCtx(ADA.subject);
      const created = await stack.create(goalRecord("agent.rounds"), ctx);
      const enabled = await stack.automations.enable(created.id, ctx);
      // Arming is a consent ceremony, not a runner check: the person can allow it
      // before the deployment has a brain to run it.
      expect(enabled.enabled).toBe(true);
      await approve(stack, enabled.missing);

      const [id] = await stack.automations.emit("agent.rounds", {}, ADA);
      if (id === undefined) throw new Error("emit did not return a run id");
      const run = await stack.automations.runs.get(id, ctx);
      // The default seat is empty, so the fire-time lookup misses and says which
      // name it missed — the same failure a named runner's miss produces.
      expect(run?.status).toBe("error");
      expect(run?.error?.message).toContain(DEFAULT_RUNNER_NAME);
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
      const ctx = ownerCtx(ADA.subject);
      const created = await stack.create({
        owner: ADA,
        when: { event: "away.real" },
        task: { kind: "goal", prompt: "Count the invoices." },
        authoredBy: "chat",
      }, ctx);
      const enabled = await stack.automations.enable(created.id, ctx);
      // The card is the away-safe surface, so it never asks about the send —
      // and the person allows the one tool they meant.
      expect(enabled.missing.map(({ call }) => call.tool)).not.toContain("host_invoices_send");
      await approve(stack, enabled.missing.filter(({ call }) => call.tool === "host_invoices_list"));

      const [runId] = await stack.automations.emit("away.real", {}, ADA);
      const run = await stack.automations.runs.get(runId!, ctx);

      expect(run?.status).toBe("ok");
      expect(run?.summary).toBe("read=ok send_offered=false");
      // The run record is the runner's report: one guarded call, the guard's outcome.
      expect(run?.steps.map((step) => [step.tool, step.outcome])).toEqual([["host_invoices_list", "ok"]]);
      // The row on disk agrees with what the door answered, keyed to the record.
      const stored = await stack.sql<{ status: string; record: { summary?: string } }>(
        "SELECT status, record FROM vendo_runs WHERE automation_id = $1",
        [created.id],
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
      const ctx = ownerCtx(ADA.subject);
      const created = await stack.create({
        owner: ADA,
        when: { event: "away.ungranted" },
        task: { kind: "goal", prompt: "Count the invoices." },
        authoredBy: "chat",
      }, ctx);
      // The person allowed the read and nothing else; the harness reaches for a
      // write anyway.
      const enabled = await stack.automations.enable(created.id, ctx);
      await approve(stack, enabled.missing.filter(({ call }) => call.tool === "host_invoices_list"));
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
 * no exception, that did not cage a goal automation's connector access, it
 * REMOVED it: no unattended run could reach a connector at all, however
 * explicitly a person had allowed one particular action.
 *
 * So the projection has exactly one exemption, and these pin its edges: the
 * dispatcher is on an unattended listing IFF the firing RECORD holds at least one
 * live per-slug service grant (`isGrantedDispatcher`, core grant-sets.ts; the
 * slugs are read at fire time by the engine). One tool name, not a risk level —
 * every other `ungraded` tool stays withheld — and `destructive` has no exemption
 * at all.
 *
 * How a record comes to hold such a grant is the only thing that moved: a goal
 * task declares no tools, so arming captures none, and the grant is earned the
 * way people really earn one — the run reaches for the slug, the guard parks the
 * card away, the owner allows it, and the NEXT firing is read against it. That is
 * "Grant & re-run", through both real doors.
 *
 * THE PINNED LAWS, restated for a goal run, and untouched by any of that because
 * they are CALL-time: an unattended run can never call an ungranted slug, and a
 * destructive-graded slug never executes away — granted or not. Being shown the
 * door is not being through it.
 */
describe("goal runs and the connector dispatcher", () => {
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

  const serviceRecord = (event: string): CreateAutomationInput => ({
    owner: ADA,
    when: { event },
    task: { kind: "goal", prompt: "read the inbox and summarise it" },
    authoredBy: "chat",
  });

  /** Arm a record and allow the away-safe surface its owner was asked about. */
  const arm = async (stack: Stack, event: string, ctx: RunContext): Promise<void> => {
    const created = await stack.create(serviceRecord(event), ctx);
    await approve(stack, (await stack.automations.enable(created.id, ctx)).missing);
  };

  /** The owner allows the away card ONE dispatch parked, which mints the standing
   *  per-slug grant bound to the record that raised it. */
  const allowSlug = async (stack: Stack, slug: string): Promise<void> => {
    const parked = (await stack.guard.approvals.pending(ADA))
      .filter((entry) => entry.ctx.presence === "away" && serviceToolSlug(entry.call) === slug);
    expect(parked).toHaveLength(1);
    await approve(stack, parked);
  };

  it("shows the dispatcher to a record that holds a service grant, and withholds it from one that does not", async () => {
    const seen = { tools: [] as string[][] };
    const stack = await createStack({
      serviceTools: true,
      runner: dispatchingRunner(seen, ["GMAIL_FETCH_EMAILS"]),
    });
    try {
      const ctx = ownerCtx(ADA.subject);
      await arm(stack, "granted.fire", ctx);
      await arm(stack, "ungranted.fire", ctx);

      // Firing one: nothing has been allowed yet, so the dispatcher is withheld
      // and the reach for it parks.
      await stack.automations.emit("granted.fire", {}, ADA);
      await allowSlug(stack, "GMAIL_FETCH_EMAILS");
      // The grant is real, standing, record-bound and for that exact slug…
      expect((await stack.guard.grants.list(ADA)).map((grant) => grant.scope))
        .toContainEqual({ kind: "service-tool", slug: "GMAIL_FETCH_EMAILS" });

      await stack.automations.emit("granted.fire", {}, ADA);
      await stack.automations.emit("ungranted.fire", {}, ADA);
      expect(seen.tools).toHaveLength(3);
      const [beforeGrant, withGrant, otherRecord] = seen.tools as [string[], string[], string[]];

      // …so at 2am the run SEES the dispatcher — caged, not absent. Withholding
      // it outright left a goal automation unable to reach a connector at all,
      // however explicitly it had been allowed one.
      expect(withGrant).toContain(USE_SERVICE_TOOL);
      // Before the grant, and for a record nobody granted a service action, the
      // answer is the old one: the dispatcher is `ungraded`, and nothing has said
      // this record may run one.
      expect(beforeGrant).not.toContain(USE_SERVICE_TOOL);
      expect(otherRecord).not.toContain(USE_SERVICE_TOOL);

      for (const surface of seen.tools) {
        // The cage is exactly one door wide. Destructive stays withheld on EVERY
        // surface — a service grant buys the dispatcher, never the law.
        expect(surface).not.toContain("host_invoices_send");
        // And caging is not a lockdown: the graded surface is all there.
        expect(surface).toContain("host_invoices_list");
        expect(surface).toContain("host_invoices_create");
      }
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
      const ctx = ownerCtx(ADA.subject);
      await arm(stack, "caged.scope", ctx);

      // Firing one parks both reaches and runs neither; the owner allows exactly
      // one of them.
      await stack.automations.emit("caged.scope", {}, ADA);
      expect(serviceToolCalls).toEqual([]);
      await allowSlug(stack, "GMAIL_FETCH_EMAILS");

      const [runId] = await stack.automations.emit("caged.scope", {}, ADA);
      const run = await stack.automations.runs.get(runId!, ctx);

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
      runner: dispatchingRunner(seen, ["GMAIL_FETCH_EMAILS", "GMAIL_SEND_EMAIL"]),
    });
    try {
      const ctx = ownerCtx(ADA.subject);
      await arm(stack, "caged.destructive", ctx);

      // The owner allows BOTH slugs, the destructive one included. That is the
      // whole point: an ungranted call is refused for want of authority, which
      // proves nothing about the law. Only a call that HOLDS a live standing
      // grant and is still refused proves it.
      await stack.automations.emit("caged.destructive", {}, ADA);
      await allowSlug(stack, "GMAIL_FETCH_EMAILS");
      await allowSlug(stack, "GMAIL_SEND_EMAIL");

      const [runId] = await stack.automations.emit("caged.destructive", {}, ADA);
      const run = await stack.automations.runs.get(runId!, ctx);

      // The dispatcher is on the surface and one slug really runs — and THE LAW
      // still refuses the destructive one, exactly as it refuses a granted host send.
      expect(seen.tools[1]).toContain(USE_SERVICE_TOOL);
      expect(run?.steps.map((step) => step.outcome)).toEqual(["ok", "blocked"]);
      expect(serviceToolCalls.map((entry) => entry.slug)).toEqual(["GMAIL_FETCH_EMAILS"]);
    } finally {
      await stack.close();
    }
  });
});
