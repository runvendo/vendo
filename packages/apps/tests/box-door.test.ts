import { VENDO_APP_FORMAT, type AppDocument, type RunContext, type ToolRegistry } from "@vendoai/core";
import { describe, expect, it } from "vitest";
import { inMemoryBoxFiles } from "../src/testing/box-files.js";
import { createMachineLane } from "../src/box-lane.js";
import { createApps, type AppsConfig } from "../src/index.js";
import type { SandboxAdapter, SandboxMachine } from "../src/sandbox.js";
import { basicLanguageModel, guardFixture, memoryStore, seedAppRow } from "../src/testing/index.js";

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
function handlerSandbox(handler: BoxHandler): SandboxAdapter {
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
    async url() { return "https://8080-fake_box_v2.test"; },
    files: inMemoryBoxFiles(new Map()),
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

/** Graduation's own provision (box-lane.ts) over the SAME deployment config
 *  `createApps` composes its lifecycle from: the snapshot ref lands on the app
 *  row, so the runtime's own lifecycle wakes from it below. */
const provisionMachine = (config: AppsConfig): Promise<AppDocument> =>
  createMachineLane(config).lifecycle.provision(doc);

describe("AppsRuntime.box.request (execution-v2 fn door over the machine lifecycle)", () => {
  it("wakes the provisioned machine and proxies one request to its $PORT", async () => {
    const store = memoryStore();
    const seen: Array<{ method: string; path: string; body?: Uint8Array | string }> = [];
    const config: AppsConfig = {
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
    };
    const runtime = createApps(config);
    await seedAppRow(store, doc, "user_ada");
    await provisionMachine(config);

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
    const config: AppsConfig = {
      store,
      guard: guardFixture(),
      tools: emptyTools,
      catalog: [],
      model,
      machine: { sandbox: handlerSandbox(() => ({ status: 200 })) },
    };
    const runtime = createApps(config);
    await seedAppRow(store, doc, "user_ada");
    await provisionMachine(config);
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
    // A graduated app opened on a deployment that configures no sandbox: the
    // ref is on the row and there is nothing to resume it with.
    await seedAppRow(store, {
      ...doc,
      machine: { snapshotRef: "fake:box-door", provisionedAt: "2026-07-19T00:00:00.000Z" },
    }, "user_ada");
    await expect(runtime.box.request(doc.id, { method: "POST", path: "/fn/x" }, ctx()))
      .rejects.toMatchObject({ code: "sandbox-unavailable" });
  });
});
