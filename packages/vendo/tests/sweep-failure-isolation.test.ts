import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore, createStoreOps } from "@vendoai/store";
import type { LanguageModel } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createVendo } from "../src/server.js";

// The amortized on-request sweep is a piece of housekeeping the request merely
// happened to trigger. A transient store failure inside it must never 500 that
// innocent request — the pass just warns and the reclaim waits for the next
// interval (server.ts, the catch around startSweep(false)). The surviving leg
// that can reject out of runSweep is the parked-BYO-call scan, so the fault is
// injected at the store boundary for that one collection.

const model = {
  specificationVersion: "v2",
  provider: "vendo-sweep-failure",
  modelId: "vendo-sweep-failure-v1",
  supportedUrls: {},
  async doStream() {
    return { stream: new ReadableStream({ start(controller) { controller.close(); } }) };
  },
} as unknown as LanguageModel;

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
});

describe("on-request sweep failure isolation", () => {
  it("serves the request that triggered a failing sweep instead of 500ing it", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "vendo-sweep-failure-"));
    const store = createStore({ dataDir });
    cleanups.push(async () => { await store.close(); await rm(dataDir, { recursive: true, force: true }); });
    await store.ensureSchema();

    // Fault injection at the real named-operation boundary: the parked-call
    // scan rides ops.engine now, so only that one collection's list fails and
    // everything the request itself reads stays real.
    const realOps = createStoreOps(store);
    store.ops = {
      ...realOps,
      engine: {
        ...realOps.engine,
        list: async (collection, opts) => {
          if (collection === "vendo_parked_call") throw new Error("sweep boom (transient store failure)");
          return realOps.engine.list(collection, opts);
        },
      },
    };

    let now = 0;
    const vendo = createVendo({
      models: { default: model },
      principal: async () => ({ kind: "user", subject: "user_a" }),
      store,
      sweep: { intervalMs: 100, now: () => now },
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    // Past the sweep interval, so this request triggers the (throwing) sweep.
    now = 500;
    const response = await vendo.handler(
      new Request("https://host.test/api/vendo/threads"),
    );

    expect(response.status).toBe(200);
    expect((await response.json()) as unknown[]).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("TTL sweep failed"));
  });
});
