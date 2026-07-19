import { VENDO_APP_FORMAT, type AppDocument, type AuditEvent } from "@vendoai/core";
import { describe, expect, it } from "vitest";
import { createFnCaller } from "./fn.js";
import { createMachineLifecycle } from "./machine-lifecycle.js";
import { createScheduleEngine, SCHEDULE_STATE_COLLECTION } from "./schedules.js";
import type { SandboxAdapter, SandboxMachine } from "./sandbox.js";
import { memoryStore } from "./testing/index.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

interface BoxAnswer {
  status: number;
  headers?: Record<string, string>;
  body?: string;
}
type BoxHandler = (request: {
  method: string;
  path: string;
  body?: Uint8Array | string;
}) => BoxAnswer;

/** A v2 adapter whose machines dispatch to a swappable handler, counting resumes. */
const handlerSandbox = (initial: BoxHandler) => {
  const state = {
    handler: initial,
    resumes: 0,
    seen: [] as Array<{ method: string; path: string; body?: string }>,
  };
  const machine: SandboxMachine = {
    id: "fake_schedule_box",
    async request(request) {
      state.seen.push({
        method: request.method,
        path: request.path,
        ...(request.body === undefined
          ? {}
          : { body: typeof request.body === "string" ? request.body : decoder.decode(request.body) }),
      });
      const answer = state.handler(request);
      return { status: answer.status, headers: answer.headers ?? {}, body: encoder.encode(answer.body ?? "") };
    },
    async snapshot() { return "fake:snap"; },
    async stop() { /* sleep */ },
    async destroy() { /* gone */ },
  };
  const adapter: SandboxAdapter = {
    async create() { return machine; },
    async resume() { state.resumes += 1; return machine; },
    async destroy() { /* released */ },
  };
  return { adapter, state };
};

const machineDoc = (id = "app_sched"): AppDocument => ({
  format: VENDO_APP_FORMAT,
  id,
  name: "Schedule app",
  machine: { snapshotRef: "fake:snap", provisionedAt: "2026-07-19T00:00:00.000Z" },
});

const manifest = (schedules: Array<{ cron: string; fn: string }>): BoxAnswer => ({
  status: 200,
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ schedules }),
});

const fnOk: BoxAnswer = { status: 200, body: JSON.stringify({ result: { chased: true } }) };

const defaultHandler: BoxHandler = (request) => {
  if (request.method === "GET" && request.path === "/vendo.json") {
    return manifest([{ cron: "* * * * *", fn: "chase" }]);
  }
  if (request.method === "POST" && request.path === "/fn/chase") return fnOk;
  return { status: 404 };
};

async function setup(handler: BoxHandler = defaultHandler, doc: AppDocument = machineDoc()) {
  const store = memoryStore();
  const { adapter, state } = handlerSandbox(handler);
  const lifecycle = createMachineLifecycle({
    store,
    sandbox: adapter,
    // Idle auto-sleep is irrelevant to these tests; a no-op clock keeps
    // machines awake until the test sleeps them explicitly.
    clock: { setTimeout: () => 0, clearTimeout: () => undefined },
  });
  await store.records("vendo_apps").put({
    id: doc.id,
    data: { subject: "user_ada", enabled: false, doc },
    refs: { subject: "user_ada" },
  });
  const audits: AuditEvent[] = [];
  const engine = createScheduleEngine({
    store,
    lifecycle,
    callFn: createFnCaller({ wake: (app) => lifecycle.wake(app) }).callFn,
    audit: async (event) => { audits.push(event); },
  });
  return { store, state, lifecycle, engine, audits, doc };
}

const at = (iso: string): Date => new Date(iso);

describe("createScheduleEngine (execution-v2 BYO schedule execution)", () => {
  it("first tick syncs the manifest over the box door and fires nothing", async () => {
    const { state, engine } = await setup();
    const report = await engine.tick(at("2026-07-19T12:00:10.000Z"));
    expect(report.fired).toEqual([]);
    expect(report.errors).toEqual([]);
    expect(report.checked).toBe(1);
    expect(state.seen).toEqual([{ method: "GET", path: "/vendo.json" }]);
  });

  it("fires a due schedule exactly once and records last-fired state", async () => {
    const { state, engine, store, audits } = await setup();
    await engine.tick(at("2026-07-19T12:00:10.000Z"));
    const report = await engine.tick(at("2026-07-19T12:01:30.000Z"));
    expect(report.fired).toEqual([{
      appId: "app_sched",
      fn: "chase",
      cron: "* * * * *",
      scheduledFor: "2026-07-19T12:01:00.000Z",
      status: "ok",
    }]);
    const fires = state.seen.filter((request) => request.path === "/fn/chase");
    expect(fires).toEqual([{ method: "POST", path: "/fn/chase", body: JSON.stringify({ args: {} }) }]);

    // The store carries the fired state for doctor and idempotency.
    const record = await store.records(SCHEDULE_STATE_COLLECTION).get("app_sched");
    expect(record?.data).toMatchObject({
      schedules: [{ cron: "* * * * *", fn: "chase", lastFiredAt: "2026-07-19T12:01:00.000Z" }],
    });
    // The fire is audited as the app owner's away schedule execution.
    expect(audits).toEqual([expect.objectContaining({
      kind: "app-lifecycle",
      principal: { kind: "user", subject: "user_ada" },
      presence: "away",
      appId: "app_sched",
      detail: expect.objectContaining({ operation: "schedule-fire", fn: "chase" }),
    })]);

    // A second hit inside the same cron window is a no-op (double-hit safety).
    const again = await engine.tick(at("2026-07-19T12:01:45.000Z"));
    expect(again.fired).toEqual([]);
    expect(state.seen.filter((request) => request.path === "/fn/chase")).toHaveLength(1);
  });

  it("collapses missed occurrences into one fire at the latest due time", async () => {
    const { state, engine } = await setup();
    await engine.tick(at("2026-07-19T12:00:10.000Z"));
    const report = await engine.tick(at("2026-07-19T12:10:05.000Z"));
    expect(report.fired).toEqual([expect.objectContaining({ scheduledFor: "2026-07-19T12:10:00.000Z" })]);
    expect(state.seen.filter((request) => request.path === "/fn/chase")).toHaveLength(1);
  });

  it("never wakes a sleeping machine with no due schedule", async () => {
    const { state, engine, lifecycle, doc } = await setup((request) =>
      request.path === "/vendo.json" ? manifest([{ cron: "0 8 * * *", fn: "chase" }]) : fnOk);
    await engine.tick(at("2026-07-19T12:00:10.000Z"));
    const resumesAfterSync = state.resumes;
    await lifecycle.sleep(doc);
    const report = await engine.tick(at("2026-07-19T12:05:00.000Z"));
    expect(report.fired).toEqual([]);
    expect(state.resumes).toBe(resumesAfterSync);
  });

  it("caches an absent manifest (404) as no schedules", async () => {
    const { state, engine, lifecycle, doc } = await setup(() => ({ status: 404 }));
    const report = await engine.tick(at("2026-07-19T12:00:10.000Z"));
    expect(report.errors).toEqual([]);
    await lifecycle.sleep(doc);
    await engine.tick(at("2026-07-19T12:10:00.000Z"));
    expect(state.resumes).toBe(1);
  });

  it("reports an invalid manifest loudly and fires nothing", async () => {
    const { engine } = await setup(() => ({ status: 200, body: JSON.stringify({ schedules: [{ cron: "not cron", fn: "x" }] }) }));
    const report = await engine.tick(at("2026-07-19T12:00:10.000Z"));
    expect(report.errors).toEqual([expect.objectContaining({ appId: "app_sched" })]);
    expect(report.fired).toEqual([]);
  });

  it("records a failed fn fire as consumed (no retry storm) with error status", async () => {
    const { state, engine } = await setup((request) => {
      if (request.path === "/vendo.json") return manifest([{ cron: "* * * * *", fn: "chase" }]);
      return { status: 500, body: "boom" };
    });
    await engine.tick(at("2026-07-19T12:00:10.000Z"));
    const report = await engine.tick(at("2026-07-19T12:01:30.000Z"));
    expect(report.fired).toEqual([expect.objectContaining({ status: "error" })]);
    const again = await engine.tick(at("2026-07-19T12:01:50.000Z"));
    expect(again.fired).toEqual([]);
    expect(state.seen.filter((request) => request.path === "/fn/chase")).toHaveLength(1);
  });

  it("refreshes the manifest while the machine is awake, preserving last-fired state", async () => {
    const { state, engine } = await setup();
    await engine.tick(at("2026-07-19T12:00:10.000Z"));
    await engine.tick(at("2026-07-19T12:01:30.000Z"));
    // The box's manifest grows a second schedule while the machine is awake.
    state.handler = (request) => {
      if (request.path === "/vendo.json") {
        return manifest([{ cron: "* * * * *", fn: "chase" }, { cron: "0 8 * * *", fn: "digest" }]);
      }
      return fnOk;
    };
    await engine.tick(at("2026-07-19T12:01:40.000Z"));
    const status = await engine.report();
    expect(status).toEqual([expect.objectContaining({
      appId: "app_sched",
      awake: true,
      schedules: [
        expect.objectContaining({ cron: "* * * * *", fn: "chase", lastFiredAt: "2026-07-19T12:01:00.000Z" }),
        expect.objectContaining({ cron: "0 8 * * *", fn: "digest" }),
      ],
    })]);
  });

  it("skips apps without a machine and clears their stale schedule state", async () => {
    const { engine, store } = await setup(defaultHandler, {
      format: VENDO_APP_FORMAT,
      id: "app_sched",
      name: "De-graduated app",
    });
    await store.records(SCHEDULE_STATE_COLLECTION).put({
      id: "app_sched",
      data: { syncedAt: "2026-07-19T00:00:00.000Z", schedules: [{ cron: "* * * * *", fn: "chase" }] },
    });
    const report = await engine.tick(at("2026-07-19T12:00:10.000Z"));
    expect(report.checked).toBe(0);
    expect(report.fired).toEqual([]);
    expect(await store.records(SCHEDULE_STATE_COLLECTION).get("app_sched")).toBeNull();
  });

  it("syncManifest is the Wave-3 hook: an explicit sync makes new schedules fireable", async () => {
    const { engine, doc } = await setup();
    await engine.syncManifest(doc, at("2026-07-19T12:00:10.000Z"));
    const report = await engine.tick(at("2026-07-19T12:01:30.000Z"));
    expect(report.fired).toEqual([expect.objectContaining({ fn: "chase" })]);
  });

  it("concurrent ticks coalesce to one run", async () => {
    const { state, engine } = await setup();
    await engine.tick(at("2026-07-19T12:00:10.000Z"));
    const [first, second] = await Promise.all([
      engine.tick(at("2026-07-19T12:01:30.000Z")),
      engine.tick(at("2026-07-19T12:01:30.000Z")),
    ]);
    expect(first).toBe(second);
    expect(state.seen.filter((request) => request.path === "/fn/chase")).toHaveLength(1);
  });
});
