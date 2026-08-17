/** FLOW 7 — a named runner that is not registered FAILS LOUDLY.
 *
 * Agents are code, never stored. A record carries an agent NAME; the runner map
 * is filled at boot and looked up at fire time. The two ways that can go wrong
 * are the two things pinned here:
 *
 *  1. a DUPLICATE name throws at REGISTRATION — at boot, where a developer is
 *     watching, never at 2am inside a firing;
 *  2. a MISSING name at fire time writes a FAILED run row naming the name it
 *     could not find, and stops. There is no silent skip (a run row that never
 *     appears is an automation nobody can tell is broken) and no fallback brain
 *     (running someone else's agent under this record's grants is worse than
 *     failing).
 *
 * The default runner is registered and counts every call it receives, so
 * "no fallback brain" is asserted against a witness rather than assumed.
 */
import type { AgentRunner } from "@vendoai/core";
import { DEFAULT_RUNNER_NAME } from "@vendoai/core";
import { beforeEach, describe, expect, it } from "vitest";
import { createStack, ownerCtx, resetFixture } from "../src/harness.js";
import { ADA, approve, record } from "../src/support.js";

/** Answers ok and remembers it was asked — the witness for "nothing else ran". */
const countingRunner = (calls: string[]): AgentRunner => async (task) => {
  calls.push(task.prompt);
  return { status: "ok", summary: "ran", toolCalls: [] };
};

const goalFor = (agent: string) => ({
  owner: ADA,
  when: { event: "digest.due" },
  task: { kind: "goal" as const, prompt: "summarise the invoices" },
  agent,
  authoredBy: "chat" as const,
});

describe("named runners", () => {
  beforeEach(resetFixture);

  it("throws at registration when two brains claim one name", async () => {
    const calls: string[] = [];
    const stack = await createStack({ runner: countingRunner(calls) });
    try {
      // The default seat is already taken by the composed agent…
      expect(() => stack.runners.register(DEFAULT_RUNNER_NAME, countingRunner(calls)))
        .toThrow(/agent/i);
      // …and so is any name that registered once.
      stack.runners.register("support", countingRunner(calls));
      expect(() => stack.runners.register("support", countingRunner(calls))).toThrow(/support/);
      expect(calls).toEqual([]);
    } finally {
      await stack.close();
    }
  });

  it("fails the run LOUDLY on a name nobody registered, and runs no other brain", async () => {
    const calls: string[] = [];
    const stack = await createStack({ runner: countingRunner(calls) });
    try {
      const ctx = ownerCtx(ADA.subject);
      const created = await stack.create(goalFor("nightly"), ctx);
      await approve(stack, (await stack.automations.enable(created.id, ctx)).missing);

      const [runId] = await stack.automations.emit("digest.due", {}, ADA);
      // A run row EXISTS — the failure is visible in the ledger, not a silence.
      if (runId === undefined) throw new Error("a missing runner produced no run at all");
      const run = await stack.automations.runs.get(runId, ctx);
      expect(run?.status).toBe("error");
      expect(run?.finishedAt).toBeTruthy();
      // It names the name it could not find, so the fix is obvious.
      expect(run?.error?.message).toContain("nightly");
      expect(run?.steps).toEqual([]);

      // Terminal in the STORE too, keyed to the automation.
      const stored = await stack.sql<{ status: string; record: unknown }>(
        "SELECT status, record FROM vendo_runs WHERE automation_id = $1",
        [created.id],
      );
      expect(stored).toHaveLength(1);
      expect(stored[0]?.status).toBe("error");
      expect(record(stored[0]?.record).agent).toBe("nightly");

      // THE HEADLINE: the deployment's own agent was never handed the task.
      expect(calls).toEqual([]);
    } finally {
      await stack.close();
    }
  });

  it("routes a record to the brain its name points at, and to no other", async () => {
    const support: string[] = [];
    const fallback: string[] = [];
    const stack = await createStack({
      runner: countingRunner(fallback),
      runners: { support: countingRunner(support) },
    });
    try {
      const ctx = ownerCtx(ADA.subject);
      const named = await stack.create(goalFor("support"), ctx);
      await approve(stack, (await stack.automations.enable(named.id, ctx)).missing);
      // A record with NO agent resolves to the default seat, which is the only
      // thing the absent field may ever mean.
      const anonymous = await stack.create({
        owner: ADA,
        when: { event: "digest.anon" },
        task: { kind: "goal", prompt: "summarise the invoices" },
        authoredBy: "chat",
      }, ctx);
      await approve(stack, (await stack.automations.enable(anonymous.id, ctx)).missing);

      const [namedRun] = await stack.automations.emit("digest.due", {}, ADA);
      expect((await stack.automations.runs.get(namedRun!, ctx))?.agent).toBe("support");
      expect(support).toHaveLength(1);
      expect(fallback).toEqual([]);

      const [anonRun] = await stack.automations.emit("digest.anon", {}, ADA);
      // A goal run's row names the seat that actually ran it, resolved from the
      // record's absent field — so the ledger says which brain to look at even
      // when the record never named one.
      expect((await stack.automations.runs.get(anonRun!, ctx))?.agent).toBe(DEFAULT_RUNNER_NAME);
      expect(fallback).toHaveLength(1);
      expect(support).toHaveLength(1);
    } finally {
      await stack.close();
    }
  });

  it("keeps a steps task off the runner map entirely", async () => {
    const calls: string[] = [];
    const stack = await createStack({ runner: countingRunner(calls) });
    try {
      const ctx = ownerCtx(ADA.subject);
      const created = await stack.create({
        owner: ADA,
        when: { event: "digest.steps" },
        task: { kind: "steps", steps: [{ id: "list", tool: "host_invoices_list" }] },
        authoredBy: "chat",
      }, ctx);
      await approve(stack, (await stack.automations.enable(created.id, ctx)).missing);

      const [runId] = await stack.automations.emit("digest.steps", {}, ADA);
      const run = await stack.automations.runs.get(runId!, ctx);
      expect(run?.status).toBe("ok");
      // Steps run in-process: no brain, no box, and no `agent` on the row.
      expect(run?.agent).toBeUndefined();
      expect(calls).toEqual([]);
    } finally {
      await stack.close();
    }
  });
});
