import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore } from "@vendoai/store";
import type { LanguageModel } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createVendo } from "./server.js";

// A transient store failure inside the amortized on-request sweep must never
// fail the request that happened to trigger it — a failed sweep just means the
// idle session lives until the next interval (same posture as the background
// timer leg, which catches and warns).
vi.mock("@vendoai/store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@vendoai/store")>();
  return {
    ...actual,
    sweepEphemeralSubjects: vi.fn(async () => {
      throw new Error("sweep boom (transient store failure)");
    }),
  };
});

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

describe("on-request sweep failure isolation (kill-list B3 review)", () => {
  it("serves the request that triggered a failing sweep instead of 500ing it", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "vendo-sweep-failure-"));
    const store = createStore({ dataDir });
    cleanups.push(async () => { await store.close(); await rm(dataDir, { recursive: true, force: true }); });
    await store.ensureSchema();
    let now = 0;
    const vendo = createVendo({
      model,
      principal: async () => null, // anonymous
      store,
      sessions: { ttlMs: 1000, sweepIntervalMs: 100, now: () => now },
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    // Past the sweep interval, so this request triggers the (throwing) sweep.
    now = 500;
    const response = await vendo.handler(
      new Request("https://host.test/api/vendo/threads"),
    );
    expect(response.status).toBe(200);
    expect((await response.json()) as unknown[]).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("session sweep failed"));
  });
});
