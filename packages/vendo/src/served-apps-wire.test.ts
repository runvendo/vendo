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
 * execution-v2 Wave 4 — the layer-3 served surface across the umbrella. GET
 * /apps/:id/open is where a served app's surface reaches the client
 * ({ kind: "http", url }), and that url is always this deployment's own
 * authenticated proxy: the composition fills `servedProxyPath`, the wire answers
 * it at /apps/:id/serve/**, and `can(viewer)` is re-checked on every request
 * through it. No experimental flag stands in front of any of that — a served app
 * is a narrowing of layer 2, so what gates it is having a machine and an
 * absolute origin to serve from.
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

async function setup(): Promise<Vendo> {
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
    // Wave 9 — machines (layer 2) stay on: the fixture provisions a machine, and
    // a served surface is served BY that machine.
    apps: { experimentalMachines: true },
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
  /** The seam, end to end and unstubbed on both sides: the composition fills
      `servedProxyPath` (the write path), open() hands that URL to the client,
      and the URL is fetched straight back through the wire's own /serve/ door
      (the read path). Nothing here asserts a URL SHAPE and stops — a URL that
      does not serve the app is not a URL. */
  it("hands back this deployment's proxy URL, and that URL really serves the app", async () => {
    const vendo = await setup();
    const response = await vendo.handler(wireRequest("/apps/app_served/open", ADA.subject));
    expect(response.status).toBe(200);
    const surface = await response.json() as { kind: string; url: string };
    expect(surface.kind).toBe("http");
    expect(surface.url).toBe("http://wire.test/api/vendo/apps/app_served/serve/");
    // Never the sandbox provider's own ingress: that URL answers anyone holding
    // it, which is the capability leak the proxy exists to close.
    expect(surface.url).not.toContain("served_box");

    // The read path: the owner fetches the URL they were just handed.
    const owner = await vendo.handler(new Request(surface.url, {
      headers: new Headers({ "x-test-user": ADA.subject }),
    }));
    expect(owner.status).toBe(200);
    expect(await owner.text()).toContain("Served");

    // The same URL, a caller with no standing: the door re-checks and refuses.
    const stranger = await vendo.handler(new Request(surface.url, {
      headers: new Headers({ "x-test-user": "user_mallory" }),
    }));
    expect(stranger.status).toBe(404);
  });

  /** Where the experimental flag's 501 used to stand, this is the refusal that
      remains: the proxy URL has to be ABSOLUTE (an MCP client or a native app is
      not sitting on this origin), so a deployment that never named its own origin
      cannot answer a served app at all. It says which variable to set rather than
      handing back a URL nobody can follow. */
  it("refuses when this deployment never named the origin it serves from", async () => {
    const vendo = await setup();
    vi.stubEnv("VENDO_BASE_URL", "");
    const noOrigin = createVendo({
      model: {} as LanguageModel,
      principal: async (req) => {
        const subject = req.headers.get("x-test-user");
        return subject === null ? null : { kind: "user", subject };
      },
      store: vendo.store,
      sandbox: servingSandbox(),
      apps: { experimentalMachines: true },
    });

    const response = await noOrigin.handler(wireRequest("/apps/app_served/open", ADA.subject));

    expect(response.status).toBe(400);
    const body = await response.json() as { error: { code: string; message: string } };
    expect(body.error.code).toBe("validation");
    expect(body.error.message).toContain("VENDO_BASE_URL");
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
    const vendo = await setup();
    const response = await vendo.handler(pingRequest(ADA.subject));
    expect(response.status).toBe(200);
    // The provisioned machine slept (snapshot) — the first ping wakes it.
    expect(await response.json()).toEqual({ state: "woke" });
  });

  it("stays owner-scoped: a non-owner sees the app's absence", async () => {
    const vendo = await setup();
    const response = await vendo.handler(pingRequest("user_mallory"));
    expect(response.status).toBe(404);
  });
});
