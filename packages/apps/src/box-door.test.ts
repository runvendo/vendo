import { VENDO_APP_FORMAT, type AppDocument, type RunContext, type ToolRegistry } from "@vendoai/core";
import { describe, expect, it } from "vitest";
import { createApps } from "./index.js";
import type { MachineSandboxAdapter } from "./machine-lifecycle.js";
import type { SandboxMachine } from "./sandbox.js";
import { basicLanguageModel, guardFixture, memoryStore, seedAppRow } from "./testing/index.js";

const model = basicLanguageModel();
const decoder = new TextDecoder();
const encoder = new TextEncoder();

const ctx = (subject = "user_ada"): RunContext => ({
  principal: { kind: "user", subject },
  venue: "app",
  presence: "present",
  sessionId: `session_${subject}`,
});

const doc: AppDocument = {
  format: VENDO_APP_FORMAT,
  id: "app_box_door",
  name: "Box door app",
};

const emptyTools: ToolRegistry = {
  async descriptors() { return []; },
  async execute() { return { status: "error", error: { code: "not-found", message: "missing" } }; },
};

type BoxHandler = (request: {
  method: string;
  path: string;
  headers?: Record<string, string>;
  body?: Uint8Array | string;
}) => { status: number; headers?: Record<string, string>; body?: string } | Promise<{ status: number; headers?: Record<string, string>; body?: string }>;

/** A v2 fake whose resumed machines dispatch requests to the given handler. */
function handlerSandbox(handler: BoxHandler): MachineSandboxAdapter {
  const machine: SandboxMachine = {
    id: "fake_box_v2",
    async request(request) {
      const answer = await handler(request);
      return {
        status: answer.status,
        headers: answer.headers ?? {},
        body: encoder.encode(answer.body ?? ""),
      };
    },
    async snapshot() { return "fake:box-door"; },
    async stop() { /* sleep */ },
    async destroy() { /* gone */ },
  };
  return {
    async create() { return machine; },
    async resume() { return machine; },
    async destroy() { /* released */ },
  };
}

describe("AppsRuntime.box.request (execution-v2 fn door over the machine lifecycle)", () => {
  it("wakes the provisioned machine and proxies one request to its $PORT", async () => {
    const store = memoryStore();
    const seen: Array<{ method: string; path: string; body?: Uint8Array | string }> = [];
    const runtime = createApps({
      store,
      guard: guardFixture(),
      tools: emptyTools,
      catalog: [],
      model,
      machine: {
        sandbox: handlerSandbox((request) => {
          seen.push(request);
          return { status: 201, headers: { "content-type": "application/json" }, body: JSON.stringify({ ok: true }) };
        }),
      },
    });
    await seedAppRow(store, doc, "user_ada");
    await runtime.machine.provision(doc.id, ctx());

    const response = await runtime.box.request(doc.id, {
      method: "POST",
      path: "/fn/chaseInvoices",
      body: JSON.stringify({ invoice: "inv_1" }),
    }, ctx());

    expect(response.status).toBe(201);
    expect(JSON.parse(decoder.decode(response.body))).toEqual({ ok: true });
    expect(seen).toEqual([expect.objectContaining({ method: "POST", path: "/fn/chaseInvoices" })]);
  });

  it("is owner-scoped: another subject sees not-found", async () => {
    const store = memoryStore();
    const runtime = createApps({
      store,
      guard: guardFixture(),
      tools: emptyTools,
      catalog: [],
      model,
      machine: { sandbox: handlerSandbox(() => ({ status: 200 })) },
    });
    await seedAppRow(store, doc, "user_ada");
    await runtime.machine.provision(doc.id, ctx());
    await expect(runtime.box.request(doc.id, { method: "POST", path: "/fn/x" }, ctx("user_bob")))
      .rejects.toMatchObject({ code: "not-found" });
  });

  it("fails loudly for an app that has no machine to wake", async () => {
    const store = memoryStore();
    const runtime = createApps({
      store,
      guard: guardFixture(),
      tools: emptyTools,
      catalog: [],
      model,
      machine: { sandbox: handlerSandbox(() => ({ status: 200 })) },
    });
    await seedAppRow(store, doc, "user_ada");
    await expect(runtime.box.request(doc.id, { method: "POST", path: "/fn/x" }, ctx()))
      .rejects.toMatchObject({ code: "validation" });
  });

  it("fails honestly without a sandbox adapter", async () => {
    const store = memoryStore();
    const runtime = createApps({ store, guard: guardFixture(), tools: emptyTools, catalog: [], model });
    await seedAppRow(store, doc, "user_ada");
    await expect(runtime.machine.provision(doc.id, ctx()))
      .rejects.toMatchObject({ code: "sandbox-unavailable" });
  });
});
