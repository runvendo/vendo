import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  VENDO_APP_FORMAT,
  type AppDocument,
  type Principal,
} from "@vendoai/core";
import type { SandboxAdapter, SandboxMachine } from "@vendoai/apps";
import { inMemoryBoxFiles } from "@vendoai/apps/testing";
import { createStore, type VendoStore } from "@vendoai/store";
import type { LanguageModel } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createVendo, type Vendo } from "../src/server.js";

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
    async request(request): Promise<Awaited<ReturnType<SandboxMachine["request"]>>> {
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
    // The seam's ONE in-memory implementation (@vendoai/apps/testing), so no
    // two fakes can drift over what reading a box file means.
    files: inMemoryBoxFiles(new Map()),
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
    models: { default: {} as LanguageModel },
    principal: async (req) => {
      const subject = req.headers.get("x-test-user");
      return subject === null ? null : { kind: "user", subject };
    },
    store,
    sandbox: servingSandbox(),
  });
  // Seed a tree app that already GRADUATED — the row graduation leaves behind,
  // its machine asleep behind the snapshot ref this suite's fake sandbox really
  // produces — then flip the stored surface: the wire test targets serving, not
  // generation, and building the box is graduation's own internal lifecycle.
  await store.records("vendo_apps").put({
    id: "app_served",
    data: {
      subject: ADA.subject,
      enabled: false,
      doc: {
        ...servedDoc(),
        ui: "tree",
        machine: { snapshotRef: "fake:served-snap", provisionedAt: "2026-07-12T00:00:00.000Z" },
      },
    },
    refs: { subject: ADA.subject },
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
      handing back a URL nobody can follow.

      The refusal now comes from the seam being ABSENT rather than from a callback
      that exists and throws — the composition supplies `servedProxyPath` only once
      it has an origin — so this is the apps block's `not-implemented`, and it names
      both ways to get here (no wire, or no origin). */
  it("refuses when this deployment never named the origin it serves from", async () => {
    const vendo = await setup();
    vi.stubEnv("VENDO_BASE_URL", "");
    const noOrigin = createVendo({
      models: { default: {} as LanguageModel },
      principal: async (req) => {
        const subject = req.headers.get("x-test-user");
        return subject === null ? null : { kind: "user", subject };
      },
      store: vendo.store,
      sandbox: servingSandbox(),
    });

    const response = await noOrigin.handler(wireRequest("/apps/app_served/open", ADA.subject));

    expect(response.status).toBe(501);
    const body = await response.json() as { error: { code: string; message: string } };
    expect(body.error.code).toBe("not-implemented");
    expect(body.error.message).toContain("VENDO_BASE_URL");
    // No provider ingress URL is ever the fallback for a missing door.
    expect(body.error.message).not.toContain("served_box");
  });
});

/**
 * The lane gate reads proxy AVAILABILITY, and availability has to mean "can
 * actually produce a path" — not "a callback exists". `servedProxyPath` used to be
 * supplied unconditionally and throw when used without `VENDO_BASE_URL`, so
 * `config.servedProxyPath !== undefined` was true on a deployment that could never
 * serve anything: the planner offered the served lane and the failure arrived at
 * serve time, after a machine had been built and a surface flipped.
 */
describe("the served lane is offered only where it can actually serve", () => {
  interface ModelCall {
    prompt: Array<{ role: string; content: string | Array<{ type?: string; text?: string }> }>;
  }

  const promptText = (call: ModelCall): string => call.prompt
    .map((message) => typeof message.content === "string"
      ? message.content
      : message.content.map((part) => part.text ?? "").join(""))
    .join("\n");

  /** Captures every prompt the brain is handed. The answer is deliberate junk —
   *  this asserts what the host TOLD the brain, not what the brain did with it. */
  const capturingModel = (captured: string[]): LanguageModel => ({
    specificationVersion: "v2",
    provider: "vendo-lane-gate-fixture",
    modelId: "vendo-lane-gate-fixture-v1",
    supportedUrls: {},
    async doGenerate(call: ModelCall) {
      captured.push(promptText(call));
      return {
        content: [{ type: "text" as const, text: "" }],
        finishReason: "stop" as const,
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      };
    },
    async doStream(call: ModelCall) {
      captured.push(promptText(call));
      return {
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: "stream-start", warnings: [] });
            controller.enqueue({ type: "text-start", id: "text_1" });
            controller.enqueue({ type: "text-delta", id: "text_1", delta: "" });
            controller.enqueue({ type: "text-end", id: "text_1" });
            controller.enqueue({
              type: "finish",
              finishReason: "stop",
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            });
            controller.close();
          },
        }),
      };
    },
  } as unknown as LanguageModel);

  /** Drive ONE real edit through the real composition and hand back everything the
   *  brain was told. `baseUrl` undefined = this deployment never named its origin. */
  const whatTheBrainWasTold = async (baseUrl: string | undefined): Promise<string> => {
    vi.stubEnv("VENDO_BASE_URL", baseUrl ?? "");
    const store = await tempStore("vendo-lane-gate-");
    await store.ensureSchema();
    const captured: string[] = [];
    const vendo = createVendo({
      models: { default: capturingModel(captured) },
      principal: async () => ADA,
      store,
      // A sandbox, so the only lane in question is the served one.
      sandbox: servingSandbox(),
    });
    const ctx = { principal: ADA, venue: "app" as const, presence: "present" as const, sessionId: "s_lane_gate" };
    const imported = await vendo.apps.importApp({
      format: VENDO_APP_FORMAT,
      id: "app_replaced",
      name: "Invoice board",
      ui: "tree",
      tree: {
        formatVersion: "vendo-genui/v2",
        root: "root",
        nodes: [{ id: "root", component: "Stack", source: "prewired" }],
      },
    } as AppDocument, ctx);
    // The junk answer fails the plan parse; the prompt was already captured.
    await vendo.apps.edit(imported.id, "Give me a drag-and-drop kanban board", ctx)
      .catch(() => undefined);
    return captured.join("\n=== next call ===\n");
  };

  // The "WHAT THIS HOST CANNOT DO" case that stood here is GONE, and nothing
  // replaced it: that block was `laneGates` → `hostCannot` → the BRAIN's prompt,
  // and the brain was its only reader, so it died with the brain. There is no
  // plan-time telling any more — the capability gap surfaces where the person
  // meets it instead: on the receipt (`vendo_make` answers "failed" with the
  // reason) and at the served flip, which refuses without an origin (see the
  // 501 case above). The negative below still guards the OTHER direction: a
  // deployment that CAN serve is never told it cannot.
  it("says no such thing when the deployment has an origin — the lane is real", async () => {
    const told = await whatTheBrainWasTold("http://wire.test");

    expect(told).not.toContain("cannot serve its own web pages");
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
