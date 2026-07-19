import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  VENDO_APP_FORMAT,
  type AppDocument,
  type Principal,
} from "@vendoai/core";
import { SCHEDULE_STATE_COLLECTION, type SandboxAdapter, type SandboxMachine } from "@vendoai/apps";
import { createStore, type VendoStore } from "@vendoai/store";
import type { LanguageModel } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createVendo, type Vendo } from "./server.js";

/**
 * execution-v2 Lane D gate (wire level): an external-cron hit on the
 * authenticated POST /tick fires a due vendo.json schedule exactly once — a
 * second hit inside the same cron window is a no-op — the box received the
 * fn POST, the store records last-fired, and GET /doctor/machines reports it.
 *
 * Time is faked Date-only (timers stay real) so the cron window is
 * deterministic; the schedule engine reads the clock through `new Date()`.
 */

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function tempStore(prefix: string): Promise<VendoStore> {
  const dataDir = await mkdtemp(join(tmpdir(), prefix));
  const store = createStore({ dataDir });
  cleanups.push(async () => {
    await store.ensureSchema().catch(() => undefined);
    await store.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  return store;
}

const ADA: Principal = { kind: "user", subject: "user_ada" };
const TICK_SECRET = "tick-secret-for-tests";

const encoder = new TextEncoder();

const doc: AppDocument = {
  format: VENDO_APP_FORMAT,
  id: "app_cron",
  name: "Cron app",
};

/** A box declaring one every-minute schedule, counting its fn fires. */
function cronBox() {
  const fires: string[] = [];
  const machine: SandboxMachine = {
    id: "fake_cron_box",
    async request(request) {
      const respond = (status: number, payload: unknown) => ({
        status,
        headers: { "content-type": "application/json" },
        body: encoder.encode(JSON.stringify(payload)),
      });
      if (request.method === "GET" && request.path === "/vendo.json") {
        return respond(200, { schedules: [{ cron: "* * * * *", fn: "chase" }] });
      }
      if (request.method === "POST" && request.path === "/fn/chase") {
        fires.push(new Date().toISOString());
        return respond(200, { result: { chased: true } });
      }
      return { status: 404, headers: {}, body: new Uint8Array() };
    },
    async snapshot() { return "fake:cron-snap"; },
    async stop() { /* sleep */ },
    async destroy() { /* gone */ },
  };
  const adapter: SandboxAdapter = {
    async create() { return machine; },
    async resume() { return machine; },
    async destroy() { /* released */ },
  };
  return { adapter, fires };
}

async function setup(): Promise<{ vendo: Vendo; store: VendoStore; fires: string[] }> {
  vi.stubEnv("VENDO_BASE_URL", "http://wire.test");
  vi.stubEnv("VENDO_TICK_SECRET", TICK_SECRET);
  const store = await tempStore("vendo-schedule-wire-");
  await store.ensureSchema();
  await store.records("vendo_apps").put({
    id: doc.id,
    data: { subject: ADA.subject, enabled: false, doc },
    refs: { subject: ADA.subject },
  });
  const { adapter, fires } = cronBox();
  const vendo = createVendo({
    model: {} as LanguageModel,
    principal: async (req) => {
      const subject = req.headers.get("x-test-user");
      return subject === null ? null : { kind: "user", subject };
    },
    store,
    sandbox: adapter,
  });
  await vendo.apps.machine.provision(doc.id, {
    principal: ADA,
    venue: "app",
    presence: "present",
    sessionId: "session_schedule_wire",
  });
  return { vendo, store, fires };
}

const tick = (vendo: Vendo, authorization?: string): Promise<Response> =>
  vendo.handler(new Request("http://wire.test/api/vendo/tick", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(authorization === undefined ? {} : { authorization }),
    },
    body: "{}",
  }));

describe("POST /tick fires vendo.json schedules (execution-v2 Lane D gate)", () => {
  it("rejects a caller without the host-configured token", async () => {
    const { vendo } = await setup();
    expect((await tick(vendo)).status).toBe(401);
    expect((await tick(vendo, "Bearer wrong")).status).toBe(401);
  });

  it("fires a due schedule exactly once across double-hits, records last-fired, and reports via doctor", async () => {
    const { vendo, store, fires } = await setup();
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-07-19T12:00:10.000Z") });

    // First hit learns the box's schedules (wakes once to read vendo.json);
    // declarations only fire forward from their sync.
    const first = await tick(vendo, `Bearer ${TICK_SECRET}`);
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({
      runIds: [],
      schedules: { checked: 1, fired: [], errors: [] },
    });

    // Next cron window: the schedule is due — the box gets exactly one POST.
    vi.setSystemTime(new Date("2026-07-19T12:01:30.000Z"));
    const second = await tick(vendo, `Bearer ${TICK_SECRET}`);
    expect(await second.json()).toMatchObject({
      schedules: {
        fired: [{
          appId: "app_cron",
          fn: "chase",
          cron: "* * * * *",
          scheduledFor: "2026-07-19T12:01:00.000Z",
          status: "ok",
        }],
      },
    });
    expect(fires).toHaveLength(1);

    // Double-hit inside the same window: a no-op, not a double-fire.
    vi.setSystemTime(new Date("2026-07-19T12:01:45.000Z"));
    const third = await tick(vendo, `Bearer ${TICK_SECRET}`);
    expect(await third.json()).toMatchObject({ schedules: { fired: [] } });
    expect(fires).toHaveLength(1);

    // The store carries the last-fired state...
    const record = await store.records(SCHEDULE_STATE_COLLECTION).get("app_cron");
    expect(record?.data).toMatchObject({
      schedules: [{ cron: "* * * * *", fn: "chase", lastFiredAt: "2026-07-19T12:01:00.000Z", lastStatus: "ok" }],
    });

    // ...and the doctor surface reports machine, schedule caller, last-fired.
    const machines = await vendo.handler(new Request("http://wire.test/api/vendo/doctor/machines"));
    expect(machines.status).toBe(200);
    expect(await machines.json()).toMatchObject({
      scheduleCallerConfigured: true,
      machines: [{
        appId: "app_cron",
        awake: true,
        schedules: [{ cron: "* * * * *", fn: "chase", lastFiredAt: "2026-07-19T12:01:00.000Z" }],
      }],
    });
  });
});
