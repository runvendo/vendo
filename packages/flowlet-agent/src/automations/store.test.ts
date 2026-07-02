/**
 * AutomationStore contract tests, exercised against the in-memory
 * implementation (the embedded Store-seam slot; Postgres lands behind the same
 * interface in ENG-198).
 */
import { describe, expect, it } from "vitest";
import { automationSpecSchema, type AutomationSpec } from "./schema";
import {
  DuplicateRunError,
  InMemoryAutomationStore,
  MAX_STEP_OUTPUT_BYTES,
  firingRunId,
  type TriggerEnvelope,
} from "./store";

const NOW = "2026-07-01T08:00:00.000Z";
const LATER = "2026-07-01T09:00:00.000Z";

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
    subject: "user-1",
    occurredAt: NOW,
    payload: { merchant: "DoorDash" },
    ...overrides,
  };
}

function create(store: InMemoryAutomationStore, overrides: { userId?: string } = {}) {
  return store.createAutomation({
    tenantId: "tenant-1",
    userId: overrides.userId ?? "user-1",
    spec: spec(),
    grants: [],
    now: NOW,
  });
}

describe("versioning", () => {
  it("creates version 1 and moves the pointer on update, keeping old versions readable", async () => {
    const store = new InMemoryAutomationStore();
    const { automation } = await create(store);
    expect(automation.currentVersion).toBe(1);
    expect(automation.status).toBe("enabled");
    expect(automation.triggerKind).toBe("host_event");
    expect(automation.triggerKey).toBe("transaction.created");

    const updated = await store.updateAutomation(automation.id, {
      spec: spec({ name: "Renamed" }),
      grants: [
        { tool: "SLACK_SEND_MESSAGE", descriptorHash: "d1", scopeHash: "s1", grantedAt: LATER },
      ],
      createdBy: "user_edit",
      now: LATER,
    });
    expect(updated.automation.currentVersion).toBe(2);
    expect(updated.automation.name).toBe("Renamed");

    const v1 = await store.getVersion(automation.id, 1);
    const v2 = await store.getVersion(automation.id, 2);
    expect(v1?.spec.name).toBe("Test automation");
    expect(v1?.grants).toEqual([]);
    expect(v2?.grants).toHaveLength(1);
  });
});

describe("runs", () => {
  it("pins the version a run executed even after later edits", async () => {
    const store = new InMemoryAutomationStore();
    const { automation } = await create(store);
    const run = await store.createRun({
      automation,
      version: 1,
      envelope: envelope(),
      isTest: false,
      now: NOW,
    });
    await store.updateAutomation(automation.id, {
      spec: spec({ name: "Renamed" }),
      grants: [],
      createdBy: "user_edit",
      now: LATER,
    });
    const stored = await store.getRun(run.id);
    expect(stored?.version).toBe(1);
    expect((await store.getVersion(automation.id, stored!.version))?.spec.name).toBe(
      "Test automation",
    );
  });

  it("derives deterministic run ids and rejects duplicate firings", async () => {
    const store = new InMemoryAutomationStore();
    const { automation } = await create(store);
    const id1 = firingRunId(automation.id, "poller", "txn-1");
    expect(id1).toBe(firingRunId(automation.id, "poller", "txn-1"));
    expect(id1).not.toBe(firingRunId(automation.id, "poller", "txn-2"));

    await store.createRun({ automation, version: 1, envelope: envelope(), isTest: false, now: NOW });
    await expect(
      store.createRun({ automation, version: 1, envelope: envelope(), isTest: false, now: NOW }),
    ).rejects.toThrowError(DuplicateRunError);
  });

  it("updates counters on finalization and resets the consecutive-failure streak on success", async () => {
    const store = new InMemoryAutomationStore();
    const { automation } = await create(store);

    for (let i = 0; i < 3; i++) {
      const run = await store.createRun({
        automation,
        version: 1,
        envelope: envelope({ eventId: `fail-${i}` }),
        isTest: false,
        now: NOW,
      });
      await store.finalizeRun(run.id, { status: "failed", error: "boom", now: LATER });
    }
    let record = await store.getAutomation(automation.id);
    expect(record?.counters).toMatchObject({
      totalRuns: 3,
      totalFailures: 3,
      consecutiveFailures: 3,
      lastStatus: "failed",
    });

    const ok = await store.createRun({
      automation,
      version: 1,
      envelope: envelope({ eventId: "ok-1" }),
      isTest: false,
      now: NOW,
    });
    await store.finalizeRun(ok.id, { status: "succeeded", now: LATER });
    record = await store.getAutomation(automation.id);
    expect(record?.counters).toMatchObject({
      totalRuns: 4,
      totalFailures: 3,
      consecutiveFailures: 0,
      lastStatus: "succeeded",
    });
  });

  it("skipped runs never count as failures", async () => {
    const store = new InMemoryAutomationStore();
    const { automation } = await create(store);
    const run = await store.createRun({
      automation,
      version: 1,
      envelope: envelope({ eventId: "skip-1" }),
      isTest: false,
      now: NOW,
    });
    await store.finalizeRun(run.id, { status: "skipped", now: LATER });
    const record = await store.getAutomation(automation.id);
    expect(record?.counters).toMatchObject({ totalFailures: 0, consecutiveFailures: 0 });
  });

  it("retains every run — no eviction at any count (v1 ruling)", async () => {
    const store = new InMemoryAutomationStore();
    const { automation } = await create(store);
    for (let i = 0; i < 150; i++) {
      const run = await store.createRun({
        automation,
        version: 1,
        envelope: envelope({ eventId: `e-${i}` }),
        isTest: false,
        now: NOW,
      });
      await store.finalizeRun(run.id, { status: "succeeded", now: LATER });
    }
    expect(await store.listRuns(automation.id)).toHaveLength(150);
  });

  it("truncates oversized step outputs with a flag and records the full size", async () => {
    const store = new InMemoryAutomationStore();
    const { automation } = await create(store);
    const run = await store.createRun({
      automation,
      version: 1,
      envelope: envelope(),
      isTest: false,
      now: NOW,
    });
    await store.finalizeRun(run.id, {
      status: "succeeded",
      steps: [
        {
          id: "notify",
          status: "succeeded",
          startedAt: NOW,
          finishedAt: LATER,
          idempotencyKey: `${run.id}/notify/1`,
          output: { blob: "x".repeat(MAX_STEP_OUTPUT_BYTES * 2) },
        },
      ],
      now: LATER,
    });
    const stored = await store.getRun(run.id);
    const step = stored!.steps[0]!;
    expect(step.outputTruncated).toBe(true);
    expect(JSON.stringify(step.output).length).toBeLessThanOrEqual(MAX_STEP_OUTPUT_BYTES + 256);
  });
});

describe("fan-out lookup and lifecycle", () => {
  it("finds only enabled automations matching kind, key AND subject", async () => {
    const store = new InMemoryAutomationStore();
    const { automation: alice } = await create(store, { userId: "alice" });
    await create(store, { userId: "bob" });
    const { automation: paused } = await create(store, { userId: "alice" });
    await store.setStatus(paused.id, "paused", LATER);

    const hits = await store.findEnabledByTrigger({
      tenantId: "tenant-1",
      userId: "alice",
      kind: "host_event",
      key: "transaction.created",
    });
    expect(hits.map((a) => a.id)).toEqual([alice.id]);
  });

  it("cancels pending waiting_approval runs", async () => {
    const store = new InMemoryAutomationStore();
    const { automation } = await create(store);
    const run = await store.createRun({
      automation,
      version: 1,
      envelope: envelope(),
      isTest: false,
      now: NOW,
    });
    await store.updateRun(run.id, {
      status: "waiting_approval",
      pendingApproval: {
        stepId: "notify",
        tool: "SLACK_SEND_MESSAGE",
        requestedAt: NOW,
        expiresAt: LATER,
        checkpoint: { stepIndex: 0, outputs: {} },
      },
    });
    await store.cancelPendingRuns(automation.id, LATER);
    const stored = await store.getRun(run.id);
    expect(stored?.status).toBe("cancelled");
    expect(stored?.pendingApproval).toBeNull();
  });
});
