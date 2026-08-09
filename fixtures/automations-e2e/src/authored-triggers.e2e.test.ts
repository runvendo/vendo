/**
 * The authoring seam: a `triggers[]` entry that an AUTHOR wrote (not the
 * generation ladder) goes in through the real apps persist door and comes out
 * the other side as a run.
 *
 * No stub on either leg. The producer is `AppsRuntime.importApp`, which is the
 * only non-model door that accepts a whole document: it mints the id, runs the
 * real `validateAppDocument`, and writes the real store row. The consumer is the
 * real automations engine reading that row back — enable, tick, RunRecord. If
 * either side disagreed about the list shape (S1: `triggers[]`, each keyed by a
 * bare-identifier `id`, enabled per trigger) this test is where it would show,
 * which is the whole point: the two halves are never allowed to mock each other.
 *
 * The trigger id here is deliberately NOT "main" — the ladder's default. An
 * authored trigger picks its own id, and everything downstream (enable, the run
 * record) has to carry it.
 */
import type { AppDocument } from "@vendoai/core";
import { beforeEach, describe, expect, it } from "vitest";
import { createStack, ownerCtx, resetFixture } from "./harness.js";
import { ADA, enableAndApprove, waitForRun } from "./support.js";

const authoredDoc = (): AppDocument => ({
  format: "vendo/app@1",
  // Ignored on import: an artifact id is never trusted, so the door mints one.
  id: "app_authored",
  name: "Invoice watch",
  triggers: [{
    id: "watch",
    on: { kind: "schedule", at: "2026-08-05T08:30:00.000Z" },
    run: { kind: "steps", steps: [{ id: "rows", tool: "host_invoices_list" }] },
  }],
});

describe("an authored triggers[] entry arms and fires", () => {
  beforeEach(resetFixture);

  it("persists through the real apps door, arms through the real enable, and produces a RunRecord", async () => {
    const clock = new Date("2026-08-05T09:00:00.000Z");
    const stack = await createStack({ now: () => clock });
    try {
      const imported = await stack.apps.importApp(authoredDoc(), ownerCtx(ADA.subject));
      const appId = imported.id;
      // The authored list survived the real validate-and-persist path verbatim.
      expect(imported.triggers).toHaveLength(1);
      expect(imported.triggers?.[0]?.id).toBe("watch");

      const ctx = ownerCtx(ADA.subject, appId);
      // Arming is never the author's: a due trigger on a freshly persisted app
      // does nothing until a person enables it.
      expect(await stack.automations.tick(clock)).toEqual([]);

      await enableAndApprove(stack, appId, ctx, "watch");

      const fired = await stack.automations.tick(clock);
      expect(fired).toHaveLength(1);

      const run = await waitForRun(stack, fired[0]!, ctx, "ok");
      expect(run.appId).toBe(appId);
      expect(run.triggerId).toBe("watch");
      expect(run.steps.map((step) => step.tool)).toEqual(["host_invoices_list"]);
      expect(run.steps.map((step) => step.outcome)).toEqual(["ok"]);
    } finally {
      await stack.close();
    }
  });
});
