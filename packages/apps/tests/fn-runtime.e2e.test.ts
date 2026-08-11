import { engineOverAdapter } from "@vendoai/core";
import {
  VENDO_APP_FORMAT,
  VENDO_TREE_FORMAT,
  type Json,
  type RunContext,
  type ToolRegistry,
} from "@vendoai/core";
import {
  type AppDocument,
} from "../src/contract/index.js";
import { describe, expect, it } from "vitest";
import { inMemoryBoxFiles } from "../src/server/testing/box-files.js";
import { guardFixture } from "../src/server/testing/guard-fixture.js";
import { memoryStore } from "../src/server/testing/memory-store.js";
import { basicLanguageModel } from "../src/server/testing/scripted-model.js";
import { seedAppRow } from "../src/server/testing/seed-app-row.js";
import { createApps } from "../src/server/index.js";
import type { SandboxAdapter, SandboxMachine } from "../src/server/escalation/sandbox.js";

/**
 * execution-v2 Lane D gate (fake adapter): a tree whose query names
 * `fn:<name>` binds its data through the box door at open(); an fn: action
 * round-trips on call() and a re-open re-binds the changed data; a failed fn
 * is a contained outcome, never a thrown white box.
 */

const model = basicLanguageModel();
const encoder = new TextEncoder();
const decoder = new TextDecoder();

const ctx = (subject = "user_ada"): RunContext => ({
  principal: { kind: "user", subject },
  venue: "app",
  presence: "present",
  sessionId: `session_${subject}`,
});

const registryTools: ToolRegistry = {
  async descriptors() { return []; },
  async execute() { return { status: "ok", output: { via: "registry" } }; },
};

/** A stateful fake box: /fn/report answers the running total, /fn/add adds. */
const statefulBox = () => {
  const state = { total: 40 };
  const seen: Array<{ method: string; path: string; body?: string }> = [];
  const machine: SandboxMachine = {
    id: "fake_fn_runtime",
    async request(request) {
      const body = request.body === undefined
        ? undefined
        : typeof request.body === "string" ? request.body : decoder.decode(request.body);
      seen.push({ method: request.method, path: request.path, ...(body === undefined ? {} : { body }) });
      const respond = (status: number, payload: unknown) => ({
        status,
        headers: { "content-type": "application/json" },
        body: encoder.encode(JSON.stringify(payload)),
      });
      if (request.method === "POST" && request.path === "/fn/report") {
        return respond(200, { result: { total: state.total } });
      }
      if (request.method === "POST" && request.path === "/fn/add") {
        const args = (JSON.parse(body ?? "{}") as { args?: { amount?: number } }).args;
        state.total += args?.amount ?? 0;
        return respond(200, { result: { total: state.total } });
      }
      if (request.method === "POST" && request.path === "/fn/broken") {
        return respond(500, { error: { code: "box-broke", message: "the box failed honestly" } });
      }
      return { status: 404, headers: {}, body: new Uint8Array() };
    },
    async url() { return "https://8080-fake_fn_runtime.test"; },
    files: inMemoryBoxFiles(new Map()),
    async snapshot() { return "fake:fn-runtime"; },
    async stop() { /* sleep */ },
    async destroy() { /* gone */ },
  };
  const adapter: SandboxAdapter = {
    async create() { return machine; },
    async resume() { return machine; },
    async destroy() { /* released */ },
  };
  return { adapter, seen, state };
};

const fnTreeApp = (id: string): AppDocument => ({
  format: VENDO_APP_FORMAT,
  id,
  name: "Fn tree app",
  ui: "tree",
  machine: { snapshotRef: "fake:fn-runtime", provisionedAt: "2026-07-19T00:00:00.000Z" },
  tree: {
    formatVersion: VENDO_TREE_FORMAT,
    root: "n1",
    nodes: [
      {
        id: "n1",
        component: "Stat",
        source: "prewired",
        props: {
          label: "Total",
          value: { $path: "/report/total" },
          onClick: { action: "fn:add", payload: { amount: 2 } },
        },
      },
    ],
    queries: [
      { name: "report", tool: "fn:report" },
      { name: "host", tool: "host_reader" },
    ],
  } as unknown as NonNullable<AppDocument["tree"]>,
});

const setup = (id = "app_fn_runtime") => {
  const { adapter, seen, state } = statefulBox();
  const store = memoryStore();
  const runtime = createApps({
    store,
    guard: guardFixture(),
    tools: registryTools,
    catalog: [],
    model,
    machine: { sandbox: adapter },
  });
  return { runtime, store, seen, state, id };
};

describe("fn: runtime resolution (execution-v2 Lane D gate)", () => {
  it("open() resolves an fn: query through the box door and binds it beside host-tool queries", async () => {
    const { runtime, store, seen, id } = setup();
    await seedAppRow(engineOverAdapter(store), fnTreeApp(id), "user_ada");

    const surface = await runtime.open(id, ctx());
    if (surface.kind !== "tree") throw new Error(`expected tree surface, got ${surface.kind}`);
    const data = (surface.payload as { data?: Record<string, Json> }).data;
    // The fn: query bound through the box; the host query bound through the
    // registry — shape-aware binding is one path for both.
    expect(data).toMatchObject({ report: { total: 40 }, host: { via: "registry" } });
    expect(seen).toEqual([{
      method: "POST",
      path: "/fn/report",
      body: JSON.stringify({ args: {} }),
    }]);
  });

  it("an fn: action round-trips on call() and a re-open re-binds the new data", async () => {
    const { runtime, store, seen, id } = setup();
    await seedAppRow(engineOverAdapter(store), fnTreeApp(id), "user_ada");

    const outcome = await runtime.call(id, "fn:add", { amount: 2 }, ctx());
    expect(outcome).toEqual({ status: "ok", output: { total: 42 } });
    expect(seen).toEqual([{
      method: "POST",
      path: "/fn/add",
      body: JSON.stringify({ args: { amount: 2 } }),
    }]);

    const surface = await runtime.open(id, ctx());
    if (surface.kind !== "tree") throw new Error(`expected tree surface, got ${surface.kind}`);
    expect((surface.payload as { data?: Record<string, Json> }).data).toMatchObject({
      report: { total: 42 },
    });
  });

  it("a failed fn is a contained outcome — open() still serves the tree", async () => {
    const { runtime, store, id } = setup();
    const app = fnTreeApp(id);
    (app.tree as unknown as { queries: Array<{ name: string; tool: string }> }).queries = [
      { name: "report", tool: "fn:broken" },
      { name: "host", tool: "host_reader" },
    ];
    await seedAppRow(engineOverAdapter(store), app, "user_ada");

    const surface = await runtime.open(id, ctx());
    if (surface.kind !== "tree") throw new Error(`expected tree surface, got ${surface.kind}`);
    const data = (surface.payload as { data?: Record<string, Json> }).data;
    // The broken fn's slot stays unbound; the rest of the app still rendered.
    expect(data).toMatchObject({ host: { via: "registry" } });
    expect(data).not.toHaveProperty("report");

    const outcome = await runtime.call(id, "fn:broken", {}, ctx());
    expect(outcome).toEqual({
      status: "error",
      error: { code: "box-broke", message: "the box failed honestly" },
    });
  });

  it("a machine-bearing app with no adapter contains sandbox-unavailable per query", async () => {
    const store = memoryStore();
    const runtime = createApps({ store, guard: guardFixture(), tools: registryTools, catalog: [], model });
    await seedAppRow(engineOverAdapter(store), fnTreeApp("app_no_adapter"), "user_ada");

    const surface = await runtime.open("app_no_adapter", ctx());
    if (surface.kind !== "tree") throw new Error(`expected tree surface, got ${surface.kind}`);
    const data = (surface.payload as { data?: Record<string, Json> }).data;
    expect(data).toMatchObject({ host: { via: "registry" } });
    expect(data).not.toHaveProperty("report");
  });
});
