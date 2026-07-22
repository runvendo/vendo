import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { LanguageModel } from "ai";
import type { Principal } from "@vendoai/core";
import { createStore, type VendoStore } from "@vendoai/store";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createVendo } from "./server.js";

const principal: Principal = { kind: "user", subject: "user_lazy" };

const cleanups: Array<() => Promise<void>> = [];

async function tempStore(): Promise<{ store: VendoStore; ensureSchema: ReturnType<typeof vi.fn> }> {
  const dataDir = await mkdtemp(join(tmpdir(), "vendo-lazy-"));
  const store = createStore({ dataDir });
  const realEnsureSchema = store.ensureSchema.bind(store);
  const ensureSchema = vi.fn(realEnsureSchema);
  store.ensureSchema = ensureSchema;
  cleanups.push(async () => {
    await realEnsureSchema().catch(() => undefined);
    await store.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  return { store, ensureSchema };
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

describe("createVendo construction purity (Workers global scope)", () => {
  it("performs no store I/O and starts no timers at construction", async () => {
    const timerSpy = vi.spyOn(globalThis, "setInterval");
    const { store, ensureSchema } = await tempStore();
    createVendo({ model: {} as LanguageModel, principal: async () => principal, store });
    expect(ensureSchema).not.toHaveBeenCalled();
    expect(timerSpy).not.toHaveBeenCalled();
  });

  it("runs schema readiness once, on first request, and starts the sweep then", async () => {
    const timerSpy = vi.spyOn(globalThis, "setInterval");
    const { store, ensureSchema } = await tempStore();
    const vendo = createVendo({ model: {} as LanguageModel, principal: async () => principal, store });
    expect(timerSpy).not.toHaveBeenCalled();
    const status = () => vendo.handler(new Request("https://host.test/api/vendo/status"));
    const first = await status();
    expect(first.status).toBe(200);
    await status();
    expect(ensureSchema).toHaveBeenCalledTimes(1);
    expect(timerSpy.mock.calls.length).toBeGreaterThanOrEqual(1);
  });
});
