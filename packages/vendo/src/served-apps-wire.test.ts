import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  VENDO_APP_FORMAT,
  type AppDocument,
  type Principal,
} from "@vendoai/core";
import type { SandboxAdapter, SandboxMachine } from "@vendoai/apps";
import { createStore, type VendoStore } from "@vendoai/store";
import type { LanguageModel } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createVendo, type Vendo } from "./server.js";

/**
 * execution-v2 Wave 4 — the layer-3 experimental flag across the umbrella:
 * `createVendo({ apps: { experimentalServedApps: true } })` is the ONE host
 * opt-in, and GET /apps/:id/open is where a served app's surface reaches the
 * client ({ kind: "http", url }). Flag off → the typed refusal (501) naming
 * the flag.
 */

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
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

/** A box whose $PORT serves a real page (the layer-3 shape). */
function servingSandbox(): SandboxAdapter {
  const machine: SandboxMachine = {
    id: "served_box",
    async request(request) {
      if (request.method === "GET" && request.path === "/") {
        return {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
          body: new TextEncoder().encode("<!doctype html><h1>Served</h1>"),
        };
      }
      return { status: 404, headers: {}, body: new Uint8Array() };
    },
    async url(port?: number) { return `https://${port ?? 8080}-served_box.wire.test`; },
    async snapshot() { return "fake:served-snap"; },
    async stop() { /* sleep */ },
    async destroy() { /* gone */ },
  };
  return {
    async create() { return machine; },
    async resume() { return machine; },
    async destroy() { /* released */ },
  };
}

const servedDoc = (id = "app_served"): AppDocument => ({
  format: VENDO_APP_FORMAT,
  id,
  name: "Served app",
  ui: "http",
});

async function setup(options: { experimentalServedApps?: boolean } = {}): Promise<Vendo> {
  vi.stubEnv("VENDO_BASE_URL", "http://wire.test");
  const store = await tempStore("vendo-served-wire-");
  await store.ensureSchema();
  const vendo = createVendo({
    model: {} as LanguageModel,
    principal: async (req) => {
      const subject = req.headers.get("x-test-user");
      return subject === null ? null : { kind: "user", subject };
    },
    store,
    sandbox: servingSandbox(),
    ...(options.experimentalServedApps === undefined ? {} : { apps: { experimentalServedApps: options.experimentalServedApps } }),
  });
  // Seed a tree app, provision its machine (graduation's Lane B step), then
  // flip the stored surface — the wire test targets serving, not generation.
  await store.records("vendo_apps").put({
    id: "app_served",
    data: { subject: ADA.subject, enabled: false, doc: { ...servedDoc(), ui: "tree" } },
    refs: { subject: ADA.subject },
  });
  await vendo.apps.machine.provision("app_served", {
    principal: ADA,
    venue: "app",
    presence: "present",
    sessionId: "session_served_wire",
  });
  const record = await store.records("vendo_apps").get("app_served");
  const data = record?.data as { subject: string; enabled: boolean; doc: AppDocument };
  await store.records("vendo_apps").put({
    id: "app_served",
    data: { ...data, doc: { ...data.doc, ui: "http" } },
    refs: { subject: ADA.subject },
  });
  return vendo;
}

function wireRequest(path: string, subject?: string): Request {
  const headers = new Headers();
  if (subject !== undefined) headers.set("x-test-user", subject);
  return new Request(`http://wire.test/api/vendo${path}`, { headers });
}

describe("GET /apps/:id/open on a served (layer-3) app", () => {
  it("serves { kind: 'http', url } from the machine's public ingress when the flag is on", async () => {
    const vendo = await setup({ experimentalServedApps: true });
    const response = await vendo.handler(wireRequest("/apps/app_served/open", ADA.subject));
    expect(response.status).toBe(200);
    const surface = await response.json() as { kind: string; url: string };
    expect(surface.kind).toBe("http");
    expect(surface.url).toMatch(/^https:\/\/8080-served_box\.wire\.test\/?$/);
  });

  it("refuses with the typed flag error when the flag is off (the default)", async () => {
    const vendo = await setup();
    const response = await vendo.handler(wireRequest("/apps/app_served/open", ADA.subject));
    expect(response.status).toBe(501);
    const body = await response.json() as { error: { code: string; message: string } };
    expect(body.error.code).toBe("not-implemented");
    expect(body.error.message).toContain("experimentalServedApps");
  });
});

describe("POST /apps/:id/machine/ping (Wave 7 H2 — the embed keepalive)", () => {
  const pingRequest = (subject?: string): Request => {
    const headers = new Headers({ "content-type": "application/json" });
    if (subject !== undefined) headers.set("x-test-user", subject);
    return new Request("http://wire.test/api/vendo/apps/app_served/machine/ping", {
      method: "POST",
      headers,
      body: "{}",
    });
  };

  it("relays the runtime's ping state (woke on a sleeping machine)", async () => {
    const vendo = await setup({ experimentalServedApps: true });
    const response = await vendo.handler(pingRequest(ADA.subject));
    expect(response.status).toBe(200);
    // The provisioned machine slept (snapshot) — the first ping wakes it.
    expect(await response.json()).toEqual({ state: "woke" });
  });

  it("stays owner-scoped: a non-owner sees the app's absence", async () => {
    const vendo = await setup({ experimentalServedApps: true });
    const response = await vendo.handler(pingRequest("user_mallory"));
    expect(response.status).toBe(404);
  });
});
