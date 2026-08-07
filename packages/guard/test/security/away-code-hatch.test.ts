import type { GuardDecision } from "@vendoai/core";
import { describe, expect, it } from "vitest";
import { createGuard } from "../../src/index.js";
import { createMemoryStore } from "../fixtures/memory-store.js";
import { FixtureTools, alice, call, context, descriptor } from "../fixtures/tools.js";

// P1-A: the policy-code escape hatch must not be able to forge a grant-sourced
// "run". `decidedBy: "grant"` is the only provenance the away-downgrade gate
// (05 §6) exempts from parking; if code could self-attribute it, an unattended
// automation step would execute with no real app-bound grant behind it.
describe("away code-hatch bypass (P1-A)", () => {
  const forgeGrantRun = (): GuardDecision => ({ action: "run", decidedBy: "grant" });

  it("parks an away code-run that forged decidedBy:'grant' instead of running", async () => {
    const store = createMemoryStore();
    const d = descriptor("write", { name: "host_hatch" });
    const guard = createGuard({ store, policy: { code: forgeGrantRun } });
    const tools = new FixtureTools([d]);
    const bound = guard.bind(tools);
    const ctx = context({
      venue: "automation",
      presence: "away",
      appId: "app_1",
      trigger: { runId: "run_hatch", kind: "host-event" },
    });
    const c = call(d.name, { amount: 1 }, "call_hatch");

    // The decision itself must be downgraded to a default park, never a grant-run.
    await expect(guard.check(c, d, ctx)).resolves.toMatchObject({
      action: "ask",
      decidedBy: "default",
    });

    // End-to-end: the away call parks and nothing executes.
    await expect(bound.execute(c, ctx)).resolves.toMatchObject({ status: "pending-approval" });
    expect(tools.executions).toHaveLength(0);

    // Audit must honestly attribute the decision — never as a grant the code
    // fabricated. (The code stage is labeled "rule"; the away downgrade "default".)
    const { events } = await guard.audit.query({ principal: alice });
    expect(events.length).toBeGreaterThan(0);
    for (const event of events) {
      expect(event.decidedBy).not.toBe("grant");
    }
  });

  it("still lets the same code-run execute when the user is present (only away downgrades)", async () => {
    const store = createMemoryStore();
    const d = descriptor("write", { name: "host_hatch_present" });
    const guard = createGuard({ store, policy: { code: forgeGrantRun } });
    const tools = new FixtureTools([d]);
    const bound = guard.bind(tools);
    const c = call(d.name, { amount: 1 }, "call_present");

    // Present: a code-run is honestly a rule-sourced run, and it runs.
    await expect(guard.check(c, d, context())).resolves.toMatchObject({
      action: "run",
      decidedBy: "rule",
    });
    await expect(bound.execute(c, context())).resolves.toMatchObject({ status: "ok" });
    expect(tools.executions).toHaveLength(1);
  });
});
