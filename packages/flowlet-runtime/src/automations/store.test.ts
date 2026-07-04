/**
 * AutomationEngineStore contract tests against the in-memory implementation.
 * The engine store EXTENDS the frozen core seam (@flowlet/core AutomationStore):
 * frozen methods keep their signatures; engine semantics (versions, grants,
 * envelopes, dedup, counters) are additive. The store owns identity and
 * timestamps — callers never supply them.
 */
import { describe, expect, it } from "vitest";
import type { Principal } from "@flowlet/core";
import { automationSpecSchema, type AutomationSpec } from "./schema";
import {
  DuplicateRunError,
  InMemoryAutomationStore,
  MAX_STEP_OUTPUT_BYTES,
  firingRunId,
  type TriggerEnvelope,
} from "./store";

const NOW = "2026-07-01T08:00:00.000Z";
const alice: Principal = { tenantId: "tenant-1", subject: "alice" };
const bob: Principal = { tenantId: "tenant-1", subject: "bob" };

function spec(overrides: Partial<AutomationSpec> = {}): AutomationSpec {
  return automationSpecSchema.parse({
    dslVersion: 1,
    name: "Test automation",
    description: "test",
    prompt: "test prompt",
    trigger: { type: "host_event", event: "transaction.created" },
    execution: {
      mode: "steps",
      steps: [{ id: "notify", type: "tool", tool: "SLACK_SEND_MESSAGE", input: { text: "hi" } }],
    },
    ...overrides,
  });
}

function envelope(overrides: Partial<TriggerEnvelope> = {}): TriggerEnvelope {
  return {
    source: "poller",
    eventId: "txn-1",
    subject: "alice",
    occurredAt: NOW,
    payload: { merchant: "DoorDash" },
    ...overrides,
  };
}

function makeStore() {
  return new InMemoryAutomationStore({ now: () => NOW });
}

async function create(store: InMemoryAutomationStore, scope: Principal = alice) {
  return store.create(scope, { spec: spec(), grants: [] });
}

describe("frozen core surface", () => {
  it("save() assigns id and timestamps and validates the opaque spec", async () => {
    const store = makeStore();
    const record = await store.save(alice, {
      name: "Core-shaped",
      status: "enabled",
      spec: spec(),
    });
    expect(record.id).toBeTruthy();
    expect(record.createdAt).toBe(NOW);
    expect(record.updatedAt).toBe(NOW);
    expect((await store.get(alice, record.id))?.name).toBe("Core-shaped");
  });

  it("save() rejects a spec that does not parse as the DSL", async () => {
    const store = makeStore();
    await expect(
      store.save(alice, { name: "bad", status: "enabled", spec: { nope: true } }),
    ).rejects.toThrowError();
  });

  it("get/list are Principal-scoped", async () => {
    const store = makeStore();
    const { automation } = await create(store, alice);
    await create(store, bob);
    expect(await store.get(bob, automation.id)).toBeUndefined();
    expect((await store.list(alice)).map((a) => a.id)).toEqual([automation.id]);
  });
});

describe("versioning", () => {
  it("creates version 1 and moves the pointer on update, keeping old versions readable", async () => {
    const store = makeStore();
    const { automation } = await create(store);
    expect(automation.currentVersion).toBe(1);
    expect(automation.status).toBe("enabled");
    expect(automation.triggerKind).toBe("host_event");
    expect(automation.triggerKey).toBe("transaction.created");

    const updated = await store.update(alice, automation.id, {
      spec: spec({ name: "Renamed" }),
      grants: [
        { tool: "SLACK_SEND_MESSAGE", descriptorHash: "d1", scopeHash: "s1", grantedAt: NOW },
      ],
      createdBy: "user_edit",
    });
    expect(updated.automation.currentVersion).toBe(2);
    expect(updated.automation.name).toBe("Renamed");

    const v1 = await store.getVersion(alice, automation.id, 1);
    const v2 = await store.getVersion(alice, automation.id, 2);
    expect(v1?.spec.name).toBe("Test automation");
    expect(v1?.grants).toEqual([]);
    expect(v2?.grants).toHaveLength(1);
  });
});

describe("runs", () => {
  it("pins the version a run executed even after later edits", async () => {
    const store = makeStore();
    const { automation } = await create(store);
    const run = await store.createRun(alice, {
      automation,
      version: 1,
      envelope: envelope(),
      isTest: false,
    });
    await store.update(alice, automation.id, {
      spec: spec({ name: "Renamed" }),
      grants: [],
      createdBy: "user_edit",
    });
    const stored = await store.getRun(alice, run.id);
    expect(stored?.version).toBe(1);
    expect((await store.getVersion(alice, automation.id, stored!.version))?.spec.name).toBe(
      "Test automation",
    );
  });

  it("derives deterministic run ids and rejects duplicate firings", async () => {
    const store = makeStore();
    const { automation } = await create(store);
    const id1 = firingRunId(automation.id, "poller", "txn-1");
    expect(id1).toBe(firingRunId(automation.id, "poller", "txn-1"));

    await store.createRun(alice, { automation, version: 1, envelope: envelope(), isTest: false });
    await expect(
      store.createRun(alice, { automation, version: 1, envelope: envelope(), isTest: false }),
    ).rejects.toThrowError(DuplicateRunError);
  });

  it("maps engine outcomes onto the frozen coarse status", async () => {
    const store = makeStore();
    const { automation } = await create(store);
    const skipped = await store.createRun(alice, {
      automation,
      version: 1,
      envelope: envelope({ eventId: "s1" }),
      isTest: false,
    });
    const finalized = await store.finalizeRun(alice, skipped.id, { outcome: "skipped" });
    expect(finalized.status).toBe("succeeded"); // frozen coarse status
    expect(finalized.outcome).toBe("skipped");
    expect(finalized.steps).toEqual([]); // compact

    const dropped = await store.createRun(alice, {
      automation,
      version: 1,
      envelope: envelope({ eventId: "c1" }),
      isTest: false,
    });
    const cancelled = await store.finalizeRun(alice, dropped.id, {
      outcome: "cancelled",
      error: "capped",
    });
    expect(cancelled.status).toBe("failed");
    expect(cancelled.outcome).toBe("cancelled");
  });

  it("updates counters on finalization; cancelled/skipped never count as failures", async () => {
    const store = makeStore();
    const { automation } = await create(store);

    for (let i = 0; i < 3; i++) {
      const run = await store.createRun(alice, {
        automation,
        version: 1,
        envelope: envelope({ eventId: `fail-${i}` }),
        isTest: false,
      });
      await store.finalizeRun(alice, run.id, { status: "failed", error: "boom" });
    }
    let record = await store.get(alice, automation.id);
    expect(record?.counters).toMatchObject({
      totalRuns: 3,
      totalFailures: 3,
      consecutiveFailures: 3,
    });

    const cancelled = await store.createRun(alice, {
      automation,
      version: 1,
      envelope: envelope({ eventId: "c-1" }),
      isTest: false,
    });
    await store.finalizeRun(alice, cancelled.id, { outcome: "cancelled", error: "capped" });
    record = await store.get(alice, automation.id);
    expect(record?.counters.consecutiveFailures).toBe(3); // unchanged

    const ok = await store.createRun(alice, {
      automation,
      version: 1,
      envelope: envelope({ eventId: "ok-1" }),
      isTest: false,
    });
    await store.finalizeRun(alice, ok.id, { status: "succeeded" });
    record = await store.get(alice, automation.id);
    expect(record?.counters).toMatchObject({ totalFailures: 3, consecutiveFailures: 0 });
  });

  it("retains every run — no eviction (v1 ruling)", async () => {
    const store = makeStore();
    const { automation } = await create(store);
    for (let i = 0; i < 150; i++) {
      const run = await store.createRun(alice, {
        automation,
        version: 1,
        envelope: envelope({ eventId: `e-${i}` }),
        isTest: false,
      });
      await store.finalizeRun(alice, run.id, { status: "succeeded" });
    }
    expect(await store.listRuns(alice, automation.id)).toHaveLength(150);
  });

  it("truncates oversized step outputs with a flag", async () => {
    const store = makeStore();
    const { automation } = await create(store);
    const run = await store.createRun(alice, {
      automation,
      version: 1,
      envelope: envelope(),
      isTest: false,
    });
    await store.finalizeRun(alice, run.id, {
      status: "succeeded",
      steps: [
        {
          id: "notify",
          status: "succeeded",
          startedAt: NOW,
          finishedAt: NOW,
          idempotencyKey: `${run.id}/notify/1`,
          output: { blob: "x".repeat(MAX_STEP_OUTPUT_BYTES * 2) },
        },
      ],
    });
    const step = (await store.getRun(alice, run.id))!.steps[0]!;
    expect(step.outputTruncated).toBe(true);
    expect(JSON.stringify(step.output).length).toBeLessThanOrEqual(MAX_STEP_OUTPUT_BYTES + 256);
  });
});

describe("listEnabledSchedules", () => {
  it("lists enabled schedule-triggered automations across scopes with their stored principal", async () => {
    const store = makeStore();
    const tenantAUser1: Principal = { tenantId: "tenant-a", subject: "user1" };
    const tenantBUser2: Principal = { tenantId: "tenant-b", subject: "user2" };

    const scheduleSpec = spec({
      trigger: { type: "schedule", cron: "0 9 * * *", timezone: "America/New_York" },
    });
    const { automation: scheduled } = await store.create(tenantAUser1, {
      spec: scheduleSpec,
      grants: [],
    });
    await store.create(tenantBUser2, { spec: spec(), grants: [] }); // host_event, different scope

    const entries = await store.listEnabledSchedules();
    expect(entries).toEqual([
      {
        automationId: scheduled.id,
        trigger: scheduleSpec.trigger,
        principal: tenantAUser1,
      },
    ]);

    await store.setStatus(tenantAUser1, scheduled.id, "paused");
    expect(await store.listEnabledSchedules()).toEqual([]);
  });
});

describe("lifecycle", () => {
  it("finds only enabled automations matching kind+key within the scope", async () => {
    const store = makeStore();
    const { automation: mine } = await create(store, alice);
    await create(store, bob);
    const { automation: paused } = await create(store, alice);
    await store.setStatus(alice, paused.id, "paused");

    const hits = await store.findEnabledByTrigger(alice, {
      kind: "host_event",
      key: "transaction.created",
    });
    expect(hits.map((a) => a.id)).toEqual([mine.id]);
  });

  it("records a disabledReason when parking a failing automation", async () => {
    const store = makeStore();
    const { automation } = await create(store);
    await store.setStatus(alice, automation.id, "paused", {
      disabledReason: "consecutive_failures",
    });
    const record = await store.get(alice, automation.id);
    expect(record?.status).toBe("paused"); // frozen union untouched
    expect(record?.disabledReason).toBe("consecutive_failures");
    await store.setStatus(alice, automation.id, "enabled");
    expect((await store.get(alice, automation.id))?.disabledReason).toBeUndefined();
  });

  it("cancels pending waiting_approval runs", async () => {
    const store = makeStore();
    const { automation } = await create(store);
    const run = await store.createRun(alice, {
      automation,
      version: 1,
      envelope: envelope(),
      isTest: false,
    });
    await store.updateRun(alice, run.id, {
      outcome: "waiting_approval",
      pendingApproval: {
        stepId: "notify",
        tool: "SLACK_SEND_MESSAGE",
        requestedAt: NOW,
        expiresAt: NOW,
        checkpoint: { stepIndex: 0, outputs: {} },
      },
    });
    expect((await store.getRun(alice, run.id))?.status).toBe("running"); // coarse
    await store.cancelPendingRuns(alice, automation.id);
    const stored = await store.getRun(alice, run.id);
    expect(stored?.status).toBe("failed");
    expect(stored?.outcome).toBe("cancelled");
    expect(stored?.pendingApproval).toBeUndefined();
  });
});

describe("parked actions", () => {
  const scope = { tenantId: "t", subject: "u" };
  const draft = (over: Partial<Parameters<InMemoryAutomationStore["createParkedAction"]>[1]> = {}) => ({
    automationId: "auto-1",
    runId: "run-1",
    stepId: "send-reminder",
    tool: "GMAIL_SEND_EMAIL",
    input: { to: "acme@example.com" },
    reason: "ungranted" as const,
    tier: "act" as const,
    descriptorHash: "hash-1",
    requestedAt: "2026-07-04T00:00:00Z",
    ...over,
  });

  it("creates a parked action with a store-assigned id, scoped to the principal", async () => {
    const store = new InMemoryAutomationStore({ now: () => "2026-07-04T00:00:00Z" });
    const action = await store.createParkedAction(scope, draft());
    expect(action.id).toBeTruthy();
    expect(action.resolution).toBeUndefined();
    expect(await store.listParkedActions(scope, {})).toHaveLength(1);
    expect(await store.listParkedActions({ tenantId: "t", subject: "someone-else" }, {})).toHaveLength(0);
  });

  it("filters by automationId, runId, and unresolvedOnly", async () => {
    const store = new InMemoryAutomationStore();
    const a1 = await store.createParkedAction(scope, draft({ runId: "run-1" }));
    await store.createParkedAction(scope, draft({ runId: "run-2", automationId: "auto-2" }));
    await store.resolveParkedAction(scope, a1.id, "declined", "2026-07-04T01:00:00Z");
    expect(await store.listParkedActions(scope, { runId: "run-1" })).toHaveLength(1);
    expect(await store.listParkedActions(scope, { automationId: "auto-2" })).toHaveLength(1);
    expect(await store.listParkedActions(scope, { unresolvedOnly: true })).toHaveLength(1);
  });

  it("caps a large input like step outputs, flags it, and records the true size", async () => {
    const store = new InMemoryAutomationStore();
    const big = { blob: "x".repeat(MAX_STEP_OUTPUT_BYTES + 500) };
    const action = await store.createParkedAction(scope, draft({ input: big }));
    expect(action.inputTruncated).toBe(true);
    expect(action.inputBytes).toBeGreaterThan(MAX_STEP_OUTPUT_BYTES);
  });

  it("resolve stamps resolvedAt + resolution and is idempotent-safe: a second resolve on an already-resolved row throws", async () => {
    const store = new InMemoryAutomationStore({ now: () => "2026-07-04T02:00:00Z" });
    const action = await store.createParkedAction(scope, draft());
    const resolved = await store.resolveParkedAction(scope, action.id, "approved", "2026-07-04T02:00:00Z");
    expect(resolved.resolution).toBe("approved");
    expect(resolved.resolvedAt).toBe("2026-07-04T02:00:00Z");
    await expect(store.resolveParkedAction(scope, action.id, "approved", "later")).rejects.toThrow(/already resolved/);
  });

  it("getParkedAction respects principal scoping", async () => {
    const store = new InMemoryAutomationStore();
    const action = await store.createParkedAction(scope, draft());
    expect(await store.getParkedAction(scope, action.id)).toBeDefined();
    expect(await store.getParkedAction({ tenantId: "t", subject: "other" }, action.id)).toBeUndefined();
  });

  it("list sweeps unresolved rows past the 7-day TTL to 'expired' — matching PendingApproval's TTL (review follow-up)", async () => {
    const now = "2026-07-11T00:00:01Z"; // 7 days + 1s after requestedAt
    const store = new InMemoryAutomationStore({ now: () => now });
    const stale = await store.createParkedAction(scope, draft({ requestedAt: "2026-07-04T00:00:00Z" }));
    const fresh = await store.createParkedAction(scope, draft({ requestedAt: "2026-07-10T00:00:00Z" }));

    const unresolved = await store.listParkedActions(scope, { unresolvedOnly: true });
    expect(unresolved.map((a) => a.id)).toEqual([fresh.id]);

    const swept = await store.getParkedAction(scope, stale.id);
    expect(swept?.resolution).toBe("expired");
    expect(swept?.resolvedAt).toBe(now);
    // An expired row is settled — a late human gesture cannot revive it.
    await expect(store.resolveParkedAction(scope, stale.id, "approved", now)).rejects.toThrow(
      /already resolved \(expired\)/,
    );
  });
});
