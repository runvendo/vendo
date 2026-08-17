import {
  type ApprovalId,
  type AuditEvent,
  type AutomationRecord,
  type CreateAutomationInput,
  type Guard,
  type RunContext,
  type StoreAdapter,
  type ToolRegistry,
} from "@vendoai/core";
import { memoryStoreAdapter } from "@vendoai/core/conformance";
import { beforeEach, describe, expect, it } from "vitest";
import { automationsInternals, createAutomations, type AutomationsEngine } from "../../src/index.js";
import { SCHEDULE } from "../../src/types.js";

// Red-team suite for cross-principal isolation of emit()/tick() (07-automations).
// emit() and tick() start AWAY runs that act as the record's owner. A run must fire
// ONLY for the principal who owns the matching record: principal A emitting an
// event must never trigger principal B's automation, and a schedule must fire each
// record under its OWN owner. Otherwise one user could drive another's authority.

const NOW = new Date("2026-07-12T12:00:00.000Z");

const ctx = (subject: string): RunContext => ({
  principal: { kind: "user", subject },
  venue: "chat",
  presence: "present",
  sessionId: `session_${subject}`,
});

const oneStep: CreateAutomationInput["task"] = { kind: "steps", steps: [{ id: "s", tool: "host_do" }] };

class GuardDouble implements Guard {
  readonly audit: AuditEvent[] = [];
  private readonly callbacks = new Set<(id: ApprovalId, approved: boolean) => void>();
  async check(): Promise<{ action: "run"; decidedBy: "default" }> { return { action: "run", decidedBy: "default" }; }
  async report(event: AuditEvent): Promise<void> { this.audit.push(structuredClone(event)); }
  async directions(): Promise<string[]> { return []; }
  onApprovalDecision(cb: (id: ApprovalId, approved: boolean) => void): () => void { this.callbacks.add(cb); return () => this.callbacks.delete(cb); }
}

const registry = (): ToolRegistry => ({
  async descriptors() { return []; },
  async execute() { return { status: "ok", output: {} }; },
});

/** The ONE create op — there is no public create, so the tests use the same
 *  internal door every authoring surface does. The owner is the ctx's principal,
 *  which is what makes a per-owner record per-owner. */
const create = async (
  engine: AutomationsEngine,
  subject: string,
  input: Pick<CreateAutomationInput, "id" | "when"> & { armed?: boolean },
): Promise<AutomationRecord> =>
  await automationsInternals(engine).create(
    { ...input, owner: ctx(subject).principal, authoredBy: "chat", task: oneStep },
    ctx(subject),
  );

/** Backdate the cursor `create` seeded, so the record is DUE on the next tick. */
const backdateCursor = async (store: StoreAdapter, automationId: string): Promise<void> => {
  await store.records(SCHEDULE).put({
    id: automationId,
    data: { lastFiredAt: "2026-07-12T08:00:00.000Z" },
    refs: { automation_id: automationId },
  });
};

describe("emit / tick cross-principal isolation", () => {
  let store: StoreAdapter;
  let guard: GuardDouble;
  let engine: AutomationsEngine;

  beforeEach(() => {
    store = memoryStoreAdapter();
    guard = new GuardDouble();
    engine = createAutomations({ tools: registry(), guard, store, now: () => NOW });
  });

  it("emit fires only the emitting principal's matching record, never another user's", async () => {
    await create(engine, "user_a", { id: "atm_a", when: { event: "go" } });
    // Same event, different owner.
    await create(engine, "user_b", { id: "atm_b", when: { event: "go" } });

    const ids = await engine.emit("go", { n: 1 }, ctx("user_a").principal);

    expect(ids).toHaveLength(1);
    // The single run belongs to user_a's record; user_b sees nothing.
    expect((await engine.runs.get(ids[0]!, ctx("user_a")))?.automationId).toBe("atm_a");
    expect(await engine.runs.get(ids[0]!, ctx("user_b"))).toBeNull();
    expect((await engine.runs.list({}, ctx("user_b"))).runs).toEqual([]);
    expect((await store.records("vendo_runs").list()).records).toHaveLength(1);
  });

  it("emit ignores a disarmed record and a non-matching event for the same owner", async () => {
    await create(engine, "user_a", { id: "atm_armed", when: { event: "go" } });
    await create(engine, "user_a", { id: "atm_disarmed", when: { event: "go" }, armed: false });
    await create(engine, "user_a", { id: "atm_other_event", when: { event: "different" } });

    const ids = await engine.emit("go", {}, ctx("user_a").principal);

    expect(ids).toHaveLength(1);
    expect((await engine.runs.get(ids[0]!, ctx("user_a")))?.automationId).toBe("atm_armed");
  });

  it("tick fires each due schedule under its own owner and scopes visibility per owner", async () => {
    await create(engine, "user_a", { id: "atm_sched_a", when: { every: "15m" } });
    await create(engine, "user_b", { id: "atm_sched_b", when: { every: "15m" } });
    await backdateCursor(store, "atm_sched_a");
    await backdateCursor(store, "atm_sched_b");

    expect(await engine.tick()).toHaveLength(2);

    // Each owner can only see the run for their own record.
    expect((await engine.runs.list({}, ctx("user_a"))).runs.map((run) => run.automationId))
      .toEqual(["atm_sched_a"]);
    expect((await engine.runs.list({}, ctx("user_b"))).runs.map((run) => run.automationId))
      .toEqual(["atm_sched_b"]);
  });

  it("tick collapses a missed window and never backfills a second run", async () => {
    await create(engine, "user_a", { id: "atm_every", when: { every: "15m" } });
    // Cursor is 4 hours behind — many windows were "missed".
    await backdateCursor(store, "atm_every");

    // One run for all missed windows, not one per window.
    expect(await engine.tick()).toHaveLength(1);
    // Cursor advanced; no backfill on the next tick.
    expect(await engine.tick()).toEqual([]);
    expect((await store.records("vendo_runs").list()).records).toHaveLength(1);
  });
});
