import { describe, expect, it } from "vitest";
import { createGuard } from "../../src/index.js";
import { createMemoryStore } from "../fixtures/memory-store.js";
import { call, context, descriptor, seedGrant } from "../fixtures/tools.js";

// 05 §2: deterministic breakers wrap the pipeline and downgrade would-be runs to
// asks. They sit ABOVE grants — even an away automation grant cannot spend past
// the write budget.
describe("deterministic breakers (05 §2)", () => {
  it("parks the write that exceeds maxWritesPerRun in one run (destructive counts as a write)", async () => {
    const store = createMemoryStore();
    const guard = createGuard({
      store,
      breakers: { maxWritesPerRun: 2, maxCallsPerMinute: 100 },
      policy: { rules: [{ match: {}, action: "run" }] },
    });
    const write = descriptor("write");
    const destructive = descriptor("destructive");
    const run = context({ trigger: { runId: "run_writes", kind: "schedule" } });

    await expect(guard.check(call(write.name, {}, "w1"), write, run)).resolves.toMatchObject({
      action: "run",
    });
    await expect(guard.check(call(write.name, {}, "w2"), write, run)).resolves.toMatchObject({
      action: "run",
    });
    // Third write in the run — a destructive call counts as a write — trips the breaker.
    await expect(
      guard.check(call(destructive.name, {}, "w3"), destructive, run),
    ).resolves.toMatchObject({ action: "ask", decidedBy: "breaker" });
  });

  it("parks the call that exceeds maxCallsPerMinute for one subject", async () => {
    const store = createMemoryStore();
    const guard = createGuard({ store, breakers: { maxCallsPerMinute: 2 } });
    const read = descriptor("read");

    await expect(guard.check(call(read.name, {}, "c1"), read, context())).resolves.toMatchObject({
      action: "run",
    });
    await expect(guard.check(call(read.name, {}, "c2"), read, context())).resolves.toMatchObject({
      action: "run",
    });
    await expect(guard.check(call(read.name, {}, "c3"), read, context())).resolves.toMatchObject({
      action: "ask",
      decidedBy: "breaker",
    });
  });

  it("applies the write breaker to an away grant-authorized run", async () => {
    const store = createMemoryStore();
    const d = descriptor("write", { name: "host_away_writes" });
    await seedGrant(store, { descriptor: d, appId: "app_1", source: "automation" });
    const guard = createGuard({ store, breakers: { maxWritesPerRun: 2, maxCallsPerMinute: 100 } });
    const away = context({
      venue: "automation",
      presence: "away",
      appId: "app_1",
      trigger: { runId: "run_away_writes", kind: "host-event" },
    });

    // The automation grant authorizes the away run (decidedBy "grant", so the
    // away downgrade does not apply) — but only up to the write budget.
    await expect(guard.check(call(d.name, {}, "aw1"), d, away)).resolves.toMatchObject({
      action: "run",
      decidedBy: "grant",
    });
    await expect(guard.check(call(d.name, {}, "aw2"), d, away)).resolves.toMatchObject({
      action: "run",
      decidedBy: "grant",
    });
    await expect(guard.check(call(d.name, {}, "aw3"), d, away)).resolves.toMatchObject({
      action: "ask",
      decidedBy: "breaker",
    });
  });
});
