import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VENDO_APP_FORMAT, type AppDocument, type Principal } from "@vendoai/core";
import { createStore, type VendoStore } from "@vendoai/store";
import type { LanguageModel } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createVendo, type Vendo } from "./server.js";
import { hostedStore } from "./hosted-store.js";
import { fakeConsole } from "./hosted-store.test-util.js";

/**
 * wave 2 (Cloud auto): a keyed deployment runs schedule- and external-triggered
 * automations automatically on Vendo Cloud — Cloud's scheduler fires them, Composio
 * delivers external events to Cloud. If the LOCAL engine ALSO fires those triggers, a
 * keyed deployment double-runs every automation. Composing over the hosted store must
 * defer schedule/external firing to Cloud (with one process-level warn) while leaving
 * host-event automations (vendo.emit) untouched. Composing over a local/BYO store must
 * be byte-identical to before this change: no warning, every trigger kind fires.
 */

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const principal: Principal = { kind: "user", subject: "user_a" };

const scheduleApp = (id: string): AppDocument => ({
  format: VENDO_APP_FORMAT,
  id,
  name: id,
  trigger: { on: { kind: "schedule", every: "15m" }, run: { kind: "steps", steps: [] } },
});

const hostEventApp = (id: string): AppDocument => ({
  format: VENDO_APP_FORMAT,
  id,
  name: id,
  trigger: { on: { kind: "host-event", event: "go" }, run: { kind: "steps", steps: [] } },
});

async function seedDueSchedule(store: VendoStore, doc: AppDocument): Promise<void> {
  await store.records("vendo_apps").put({
    id: doc.id,
    data: { subject: principal.subject, enabled: true, doc },
    refs: { subject: principal.subject, trigger_kind: "schedule" },
  });
  await store.records("automations:schedule").put({
    id: doc.id,
    data: { lastFiredAt: new Date(Date.now() - 20 * 60_000).toISOString() },
  });
}

async function seedHostEventApp(store: VendoStore, doc: AppDocument): Promise<void> {
  await store.records("vendo_apps").put({
    id: doc.id,
    data: { subject: principal.subject, enabled: true, doc },
    refs: { subject: principal.subject, trigger_kind: "host-event" },
  });
}

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

function hostedComposition(): Vendo {
  const store = hostedStore({
    apiKey: "vnd_secret",
    baseUrl: "https://cloud.test",
    fetch: fakeConsole().handler as unknown as typeof fetch,
  });
  const vendo = createVendo({ model: {} as LanguageModel, store });
  cleanups.push(async () => { await vendo.store.close(); });
  return vendo;
}

describe("automations composition: the hosted store defers schedule/external firing to Cloud", () => {
  it("warns exactly ONCE naming Cloud as the firing authority — not once per tick", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const vendo = hostedComposition();
    await vendo.automations.tick();
    await vendo.automations.tick();

    const cloudWarns = warn.mock.calls.filter(([message]) =>
      typeof message === "string" && message.includes("Cloud"));
    expect(cloudWarns).toHaveLength(1);
  });

  it("does not launch a due schedule automation on tick", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const vendo = hostedComposition();
    const doc = scheduleApp("app_defer_schedule");
    await seedDueSchedule(vendo.store, doc);

    await expect(vendo.automations.tick()).resolves.toEqual([]);
    expect((await vendo.store.records("vendo_runs").list()).records).toHaveLength(0);
  });

  it("answers an external webhook delivery with a deferred-to-Cloud no-op instead of launching a run", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const vendo = hostedComposition();

    const response = await vendo.automations.webhook(new Request("https://host.test/api/webhooks/github", {
      method: "POST",
      headers: { "webhook-id": "d1", "webhook-timestamp": "0", "webhook-signature": "v1,bogus" },
      body: "{}",
    }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ deferred: true });
    expect((await vendo.store.records("vendo_runs").list()).records).toHaveLength(0);
  });

  it("still fires host-event automations via emit exactly as before", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const vendo = hostedComposition();
    const doc = hostEventApp("app_defer_host_event");
    await seedHostEventApp(vendo.store, doc);

    const ids = await vendo.emit("go", {}, principal);

    expect(ids).toHaveLength(1);
    expect((await vendo.store.records("vendo_runs").list()).records).toHaveLength(1);
  });
});

describe("automations composition: a local/BYO store is untouched (existing behavior)", () => {
  it("logs no Cloud-authority warning and fires a due schedule automation on tick", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const store = await tempStore("vendo-automations-defer-");
    const vendo = createVendo({ model: {} as LanguageModel, store });
    await vendo.store.ensureSchema();
    const doc = scheduleApp("app_local_schedule");
    await seedDueSchedule(vendo.store, doc);

    await expect(vendo.automations.tick()).resolves.toHaveLength(1);
    expect((await vendo.store.records("vendo_runs").list()).records).toHaveLength(1);
    expect(warn.mock.calls.filter(([message]) =>
      typeof message === "string" && message.includes("Cloud"))).toHaveLength(0);
  });

  it("still fires host-event automations via emit", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const store = await tempStore("vendo-automations-defer-host-");
    const vendo = createVendo({ model: {} as LanguageModel, store });
    await vendo.store.ensureSchema();
    const doc = hostEventApp("app_local_host_event");
    await seedHostEventApp(vendo.store, doc);

    const ids = await vendo.emit("go", {}, principal);

    expect(ids).toHaveLength(1);
  });
});
