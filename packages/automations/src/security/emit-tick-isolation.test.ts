import {
  VENDO_APP_FORMAT,
  type AppDocument,
  type ApprovalId,
  type AuditEvent,
  type Guard,
  type RunContext,
  type StoreAdapter,
  type ToolRegistry,
} from "@vendoai/core";
import { memoryStoreAdapter } from "@vendoai/core/conformance";
import type { AppsRuntime } from "@vendoai/apps";
import { beforeEach, describe, expect, it } from "vitest";
import { createAutomations } from "../index.js";

// Red-team suite for cross-principal isolation of emit()/tick() (07-automations).
// emit() and tick() start AWAY runs that act as the app owner. A run must fire ONLY
// for the principal who owns the matching app: principal A emitting an event must
// never trigger principal B's automation, and a schedule must fire each app under
// its OWN owner. Otherwise one user could drive another user's authority.

const NOW = new Date("2026-07-12T12:00:00.000Z");

const ctx = (subject: string): RunContext => ({
  principal: { kind: "user", subject },
  venue: "chat",
  presence: "present",
  sessionId: `session_${subject}`,
});

const app = (id: string, trigger: NonNullable<AppDocument["trigger"]>): AppDocument =>
  ({ format: VENDO_APP_FORMAT, id, name: id, trigger });

const seedApp = async (store: StoreAdapter, doc: AppDocument, subject: string, enabled = true): Promise<void> => {
  await store.records("vendo_apps").put({ id: doc.id, data: { subject, enabled, doc }, refs: { subject } });
};

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

const appsDouble = (
  call: AppsRuntime["call"] = async () => ({ status: "ok", output: {} }),
): AppsRuntime => ({ call } as AppsRuntime);

const hostEvent = (id: string, event: string) => app(id, {
  on: { kind: "host-event", event },
  run: { kind: "steps", steps: [{ id: "s", tool: "fn:main" }] },
});

describe("emit / tick cross-principal isolation", () => {
  let store: StoreAdapter;
  let guard: GuardDouble;

  beforeEach(() => {
    store = memoryStoreAdapter();
    guard = new GuardDouble();
  });

  it("emit fires only the emitting principal's matching automation, never another user's", async () => {
    await seedApp(store, hostEvent("app_a", "go"), "user_a");
    await seedApp(store, hostEvent("app_b", "go"), "user_b"); // same event, different owner
    const engine = createAutomations({ apps: appsDouble(), tools: registry(), guard, store, now: () => NOW });

    const ids = await engine.emit("go", { n: 1 }, ctx("user_a").principal);

    expect(ids).toHaveLength(1);
    // The single run belongs to user_a's app; user_b sees nothing.
    const run = await engine.runs.get(ids[0]!, ctx("user_a"));
    expect(run?.appId).toBe("app_a");
    expect(await engine.runs.get(ids[0]!, ctx("user_b"))).toBeNull();
    expect((await engine.runs.list({}, ctx("user_b"))).runs).toEqual([]);
    expect((await store.records("vendo_runs").list()).records).toHaveLength(1);
  });

  it("emit ignores a disabled automation and a non-matching event for the same owner", async () => {
    await seedApp(store, hostEvent("app_enabled", "go"), "user_a", true);
    await seedApp(store, hostEvent("app_disabled", "go"), "user_a", false);
    await seedApp(store, hostEvent("app_other_event", "different"), "user_a", true);
    const engine = createAutomations({ apps: appsDouble(), tools: registry(), guard, store, now: () => NOW });

    const ids = await engine.emit("go", {}, ctx("user_a").principal);
    expect(ids).toHaveLength(1);
    expect((await engine.runs.get(ids[0]!, ctx("user_a")))?.appId).toBe("app_enabled");
  });

  it("tick fires each due schedule under its own owner and scopes visibility per owner", async () => {
    const scheduleTrigger = (): NonNullable<AppDocument["trigger"]> => ({
      on: { kind: "schedule", every: "15m" },
      run: { kind: "steps", steps: [{ id: "s", tool: "fn:main", args: { event: "event" } }] },
    });
    await seedApp(store, app("app_sched_a", scheduleTrigger()), "user_a");
    await seedApp(store, app("app_sched_b", scheduleTrigger()), "user_b");
    for (const id of ["app_sched_a", "app_sched_b"]) {
      await store.records("automations:schedule").put({ id, data: { lastFiredAt: "2026-07-12T08:00:00.000Z" } });
    }
    const engine = createAutomations({ apps: appsDouble(), tools: registry(), guard, store, now: () => NOW });

    const fired = await engine.tick();
    expect(fired).toHaveLength(2);

    // Each owner can only see the run for their own app.
    const aRuns = (await engine.runs.list({}, ctx("user_a"))).runs;
    const bRuns = (await engine.runs.list({}, ctx("user_b"))).runs;
    expect(aRuns.map((r) => r.appId)).toEqual(["app_sched_a"]);
    expect(bRuns.map((r) => r.appId)).toEqual(["app_sched_b"]);
  });

  it("tick collapses a missed window and never backfills a second run", async () => {
    await seedApp(store, app("app_every", {
      on: { kind: "schedule", every: "15m" },
      run: { kind: "steps", steps: [{ id: "s", tool: "fn:main" }] },
    }), "user_a");
    // Cursor is 4 hours behind — many windows were "missed".
    await store.records("automations:schedule").put({ id: "app_every", data: { lastFiredAt: "2026-07-12T08:00:00.000Z" } });
    const engine = createAutomations({ apps: appsDouble(), tools: registry(), guard, store, now: () => NOW });

    const first = await engine.tick();
    expect(first).toHaveLength(1); // one run for all missed windows, not one-per-window
    const second = await engine.tick();
    expect(second).toEqual([]); // cursor advanced; no backfill on the next tick
    expect((await store.records("vendo_runs").list()).records).toHaveLength(1);
  });
});
