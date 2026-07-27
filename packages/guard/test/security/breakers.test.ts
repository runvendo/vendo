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

// genqa defect 1 — the agent bridge's needsApproval→execute pairing calls the
// guard twice for one logical call (packages/agent/src/tools.ts): a preview
// through `previewCheck`, then the real, dispatching check through
// `check()`/`bind().execute()` moments later. A `previewCheck` "run" must
// never itself spend the write budget or call-rate window — only the REAL
// check that follows it does — or a run's budget silently halves.
describe("previewCheck does not double-spend the breakers (genqa defect 1)", () => {
  it("previewing every write before the real check still allows the full maxWritesPerRun budget", async () => {
    const store = createMemoryStore();
    const guard = createGuard({
      store,
      breakers: { maxWritesPerRun: 20, maxCallsPerMinute: 1000 },
      policy: { rules: [{ match: {}, action: "run" }] },
    });
    const write = descriptor("write");
    const run = context({ trigger: { runId: "run_preview_writes", kind: "schedule" } });

    for (let i = 0; i < 20; i += 1) {
      const c = call(write.name, {}, `preview-${i}`);
      // The SDK's needsApproval preview, exactly as tools.ts calls it.
      await expect(guard.previewCheck!(c, write, run)).resolves.toMatchObject({ action: "run" });
      // The SDK's real, dispatching call for the SAME logical tool call.
      await expect(guard.check(c, write, run)).resolves.toMatchObject({ action: "run" });
    }
    // A 21st write — previewed and real-checked once each, like every write
    // above — is the first one that should actually trip the budget.
    const overBudget = call(write.name, {}, "preview-20");
    await expect(guard.previewCheck!(overBudget, write, run)).resolves.toMatchObject({
      action: "ask",
      decidedBy: "breaker",
    });
    await expect(guard.check(overBudget, write, run)).resolves.toMatchObject({
      action: "ask",
      decidedBy: "breaker",
    });
  });

  it("a previewed ask still parks a real, decidable approval", async () => {
    const store = createMemoryStore();
    const guard = createGuard({
      store,
      breakers: { maxWritesPerRun: 0, maxCallsPerMinute: 1000 },
      policy: { rules: [{ match: {}, action: "run" }] },
    });
    const write = descriptor("write");
    const run = context({ trigger: { runId: "run_preview_ask", kind: "schedule" } });
    const c = call(write.name, {}, "preview-ask-1");

    const previewed = await guard.previewCheck!(c, write, run);
    expect(previewed).toMatchObject({ action: "ask", decidedBy: "breaker" });
    if (previewed.action !== "ask") throw new Error("unreachable");
    await expect(guard.approvals.pending(run.principal)).resolves.toMatchObject([
      { id: previewed.approval.id },
    ]);
  });

  it("previewCheck alone never spends the write budget when the real call never follows", async () => {
    const store = createMemoryStore();
    const guard = createGuard({
      store,
      breakers: { maxWritesPerRun: 1, maxCallsPerMinute: 1000 },
      policy: { rules: [{ match: {}, action: "run" }] },
    });
    const write = descriptor("write");
    const run = context({ trigger: { runId: "run_preview_only", kind: "schedule" } });

    await expect(guard.previewCheck!(call(write.name, {}, "preview-only-1"), write, run))
      .resolves.toMatchObject({ action: "run" });
    await expect(guard.previewCheck!(call(write.name, {}, "preview-only-2"), write, run))
      .resolves.toMatchObject({ action: "run" });
    // Neither preview committed a spend — the budget of 1 is still untouched.
    await expect(guard.check(call(write.name, {}, "real-1"), write, run)).resolves.toMatchObject({
      action: "run",
    });
  });
});
