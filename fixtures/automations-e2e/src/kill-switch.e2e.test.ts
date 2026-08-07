/** 07 §1 runs.stop — the kill switch. A run held mid-flight (inside a
 * blocking in-process step tool) is cancelled best-effort: it is marked
 * "stopped" with finishedAt set, steps after the stop never execute, stop is
 * owner-scoped, and a terminal run cannot be stopped again.
 * (The hold vehicle was an fn: step against a v1 in-process machine; that
 * path died with execution-v2 Wave 1.5, so the hold now rides a fixture-local
 * wrapped tool — the run mechanics under test are unchanged.)
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { ToolRegistry } from "@vendoai/core";
import { automationDoc, createStack, ownerCtx, resetFixture } from "./harness.js";
import { ADA, BOB, fixtureInvoices, enableAndApprove } from "./support.js";

/** Wrap the bound registry with an in-process `hold` tool that blocks until released. */
const withHoldTool = (hold: () => Promise<void>) => (bound: ToolRegistry): ToolRegistry => ({
  async descriptors() {
    return [
      ...await bound.descriptors(),
      { name: "hold", description: "Block until released", inputSchema: { type: "object" }, risk: "read" },
    ];
  },
  async execute(call, ctx) {
    if (call.tool !== "hold") return bound.execute(call, ctx);
    await hold();
    return { status: "ok", output: { held: true } };
  },
});

describe("kill switch (runs.stop)", () => {
  beforeEach(resetFixture);

  it("cancels a held run mid-flight, skips later steps, and rejects owner/terminal misuse", async () => {
    let releaseHold!: () => void;
    const held = new Promise<void>((resolve) => { releaseHold = resolve; });
    let signalStarted!: () => void;
    const started = new Promise<void>((resolve) => { signalStarted = resolve; });

    const stack = await createStack({
      wrapTools: withHoldTool(async () => {
        signalStarted();
        await held;
      }),
    });
    try {
      const appId = "app_kill_hold";
      const ctx = ownerCtx(ADA.subject, appId);
      await stack.putApp(ADA.subject, {
        ...automationDoc({
          id: appId,
          trigger: {
            on: { kind: "host-event", event: "kill.hold" },
            run: {
              kind: "steps",
              steps: [
                { id: "hold", tool: "hold", args: {} },
                {
                  id: "record",
                  tool: "host_invoices_create",
                  args: { customerId: "'cus_ada'", amountCents: "1", memo: "'stopped-should-not-write'" },
                },
              ],
            },
          },
        }),
      });
      await enableAndApprove(stack, appId, ctx);

      const emitted = stack.automations.emit("kill.hold", {}, ADA);
      await started;
      const running = (await stack.automations.runs.list({ status: "running" }, ctx)).runs;
      expect(running).toHaveLength(1);
      const runId = running[0]?.id;
      if (!runId) throw new Error("no running run to stop");

      // Owner scoping: a non-owner cannot even see the run to stop it.
      await expect(stack.automations.runs.stop(runId, ownerCtx(BOB.subject, appId)))
        .rejects.toMatchObject({ code: "not-found" });

      await stack.automations.runs.stop(runId, ctx);
      releaseHold();
      await emitted;

      const run = await stack.automations.runs.get(runId, ctx);
      expect(run?.status).toBe("stopped");
      expect(run?.summary).toBe("stopped by user");
      expect(run?.finishedAt).toBeTruthy();
      expect(run?.steps.some((step) => step.id === "record")).toBe(false);

      const stored = await stack.sql<{ status: string; finished_at: unknown }>(
        "SELECT status, record->>'finishedAt' AS finished_at FROM vendo_runs WHERE id = $1",
        [runId],
      );
      expect(stored[0]?.status).toBe("stopped");
      expect(stored[0]?.finished_at).toBeTruthy();

      // The later host write never ran.
      expect((await fixtureInvoices()).some(({ memo }) => memo === "stopped-should-not-write")).toBe(false);

      // Stopping an already-terminal run conflicts.
      await expect(stack.automations.runs.stop(runId, ctx)).rejects.toMatchObject({ code: "conflict" });
    } finally {
      releaseHold();
      await stack.close();
    }
  });
});
