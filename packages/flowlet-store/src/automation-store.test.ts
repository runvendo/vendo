/**
 * DrizzleAutomationStore contract tests — a direct port of every scenario in
 * packages/flowlet-runtime/src/automations/store.test.ts (the behavioral
 * spec, InMemoryAutomationStore) run against the durable Postgres-dialect
 * store instead, plus DB-specific additions (duplicate createRun, concurrent
 * claim, the toIso timestamp helper). One PGlite instance is migrated once
 * per file (`beforeAll`); every test gets a clean slate via `TRUNCATE` in
 * `beforeEach` — cheaper than a fresh in-memory Postgres per test and just as
 * deterministic since nothing here depends on cross-test state.
 */
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type { Principal } from "@flowlet/core";
import { automationSpecSchema, DuplicateRunError, firingRunId, MAX_STEP_OUTPUT_BYTES, type AutomationSpec, type TriggerEnvelope } from "@flowlet/runtime";
import { createFlowletDatabase, migrateFlowletDatabase, type FlowletDb } from "./db.js";
import { DrizzleAutomationStore, toIso } from "./automation-store.js";

const NOW = "2026-07-01T08:00:00.000Z";
const alice: Principal = { tenantId: "tenant-1", subject: "alice" };
const bob: Principal = { tenantId: "tenant-1", subject: "bob" };

let suffix = 0;
function uniqueDataDir(): string {
  suffix += 1;
  return `memory://automation-store-test-${Date.now()}-${suffix}`;
}

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

let handle: FlowletDb;
let store: DrizzleAutomationStore;

async function create(scope: Principal = alice) {
  return store.create(scope, { spec: spec(), grants: [] });
}

beforeAll(async () => {
  handle = await createFlowletDatabase({ pglite: { dataDir: uniqueDataDir() } });
  await migrateFlowletDatabase(handle);
});

beforeEach(async () => {
  await handle.db.execute(
    sql`truncate table flowlet.automation_runs, flowlet.automation_versions, flowlet.automations`,
  );
  store = new DrizzleAutomationStore(handle, { now: () => NOW });
});

describe("frozen core surface", () => {
  it("save() assigns id and timestamps and validates the opaque spec", async () => {
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
    await expect(
      store.save(alice, { name: "bad", status: "enabled", spec: { nope: true } }),
    ).rejects.toThrowError();
  });

  it("get/list are Principal-scoped", async () => {
    const { automation } = await create(alice);
    await create(bob);
    expect(await store.get(bob, automation.id)).toBeUndefined();
    expect((await store.list(alice)).map((a) => a.id)).toEqual([automation.id]);
  });
});

describe("versioning", () => {
  it("creates version 1 and moves the pointer on update, keeping old versions readable", async () => {
    const { automation } = await create();
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
    const { automation } = await create();
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
    const { automation } = await create();
    const id1 = firingRunId(automation.id, "poller", "txn-1");
    expect(id1).toBe(firingRunId(automation.id, "poller", "txn-1"));

    await store.createRun(alice, { automation, version: 1, envelope: envelope(), isTest: false });
    await expect(
      store.createRun(alice, { automation, version: 1, envelope: envelope(), isTest: false }),
    ).rejects.toThrowError(DuplicateRunError);
  });

  it("maps engine outcomes onto the frozen coarse status", async () => {
    const { automation } = await create();
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
    const { automation } = await create();

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
    const { automation } = await create();
    for (let i = 0; i < 40; i++) {
      const run = await store.createRun(alice, {
        automation,
        version: 1,
        envelope: envelope({ eventId: `e-${i}` }),
        isTest: false,
      });
      await store.finalizeRun(alice, run.id, { status: "succeeded" });
    }
    expect(await store.listRuns(alice, automation.id)).toHaveLength(40);
  });

  it("truncates oversized step outputs with a flag", async () => {
    const { automation } = await create();
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

describe("claimPendingApproval", () => {
  const pending = {
    stepId: "notify",
    tool: "SLACK_SEND_MESSAGE",
    requestedAt: NOW,
    expiresAt: NOW,
    checkpoint: { stepIndex: 0, outputs: {} },
  };

  async function waitingRun() {
    const { automation } = await create();
    const run = await store.createRun(alice, {
      automation,
      version: 1,
      envelope: envelope(),
      isTest: false,
    });
    await store.updateRun(alice, run.id, {
      outcome: "waiting_approval",
      pendingApproval: pending,
    });
    return run;
  }

  it("first claim returns the approval and removes it from the run; second claim loses", async () => {
    const run = await waitingRun();

    const claimed = await store.claimPendingApproval(alice, run.id);
    expect(claimed).toEqual(pending);
    expect((await store.getRun(alice, run.id))?.pendingApproval).toBeUndefined();

    expect(await store.claimPendingApproval(alice, run.id)).toBeUndefined();
  });

  it("wrong-scope claim returns undefined and leaves the approval in place", async () => {
    const run = await waitingRun();

    expect(await store.claimPendingApproval(bob, run.id)).toBeUndefined();
    expect((await store.getRun(alice, run.id))?.pendingApproval).toEqual(pending);
  });

  it("claim on a run with nothing pending returns undefined", async () => {
    const { automation } = await create();
    const run = await store.createRun(alice, {
      automation,
      version: 1,
      envelope: envelope(),
      isTest: false,
    });
    expect(await store.claimPendingApproval(alice, run.id)).toBeUndefined();
  });

  it("Promise.all double-claim on the same run: exactly one wins", async () => {
    const run = await waitingRun();
    const [a, b] = await Promise.all([
      store.claimPendingApproval(alice, run.id),
      store.claimPendingApproval(alice, run.id),
    ]);
    const winners = [a, b].filter((r) => r !== undefined);
    expect(winners).toHaveLength(1);
    expect(winners[0]).toEqual(pending);
    expect((await store.getRun(alice, run.id))?.pendingApproval).toBeUndefined();
  });
});

describe("listEnabledSchedules", () => {
  it("lists enabled schedule-triggered automations across scopes with their stored principal", async () => {
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
    const { automation: mine } = await create(alice);
    await create(bob);
    const { automation: paused } = await create(alice);
    await store.setStatus(alice, paused.id, "paused");

    const hits = await store.findEnabledByTrigger(alice, {
      kind: "host_event",
      key: "transaction.created",
    });
    expect(hits.map((a) => a.id)).toEqual([mine.id]);
  });

  it("records a disabledReason when parking a failing automation", async () => {
    const { automation } = await create();
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
    const { automation } = await create();
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

describe("toIso", () => {
  it("round-trips an ISO string unchanged", () => {
    const iso = "2026-07-01T08:00:00.000Z";
    expect(toIso(iso)).toBe(iso);
  });

  it("normalizes Postgres's own text rendering back to the same instant", () => {
    // What `timestamp(..., { mode: "string" })` actually hands back from PG.
    expect(toIso("2026-07-01 08:00:00+00")).toBe("2026-07-01T08:00:00.000Z");
  });
});
