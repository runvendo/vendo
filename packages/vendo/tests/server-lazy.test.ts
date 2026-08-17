import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { LanguageModel } from "ai";
import type { Principal } from "@vendoai/core";
import { createStore, type VendoStore } from "@vendoai/store";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createVendo } from "../src/server.js";

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
    createVendo({ models: { default: {} as LanguageModel }, principal: async () => principal, store });
    expect(ensureSchema).not.toHaveBeenCalled();
    expect(timerSpy).not.toHaveBeenCalled();
  });

  it("triggers schema readiness from a guardedTools execute (BYO agent loops never call the handler)", async () => {
    const { store, ensureSchema } = await tempStore();
    const vendo = createVendo({ models: { default: {} as LanguageModel }, principal: async () => principal, store });
    expect(ensureSchema).not.toHaveBeenCalled();
    await vendo.guardedTools.execute(
      { id: "call_lazy", tool: "vendo_apps_list", args: {} },
      { principal, venue: "chat", presence: "present", sessionId: "session_lazy" },
    ).catch(() => undefined);
    expect(ensureSchema).toHaveBeenCalledTimes(1);
  });

  /** The wire's catch-all answers a VendoError with the error's OWN status and
   *  everything else with 501. A host bundle carrying a second `@vendoai/core`
   *  copy mints VendoErrors of a different class, so `instanceof` said no and a
   *  store refusal reached the client as "Internal Vendo error" (0.27.0). */
  it("answers a cross-realm VendoError with its own status, not 501", async () => {
    const { store } = await tempStore();
    store.ensureSchema = async () => {
      throw Object.assign(new Error("vendo_automations is not enabled for this deployment"), {
        name: "VendoError",
        code: "blocked",
      });
    };
    const vendo = createVendo({ models: { default: {} as LanguageModel }, principal: async () => principal, store });

    const response = await vendo.handler(new Request("https://host.test/api/vendo/status"));

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      error: { code: "blocked", message: "vendo_automations is not enabled for this deployment" },
    });
  });

  it("runs schema readiness once, on first request, and starts the sweep then", async () => {
    const timerSpy = vi.spyOn(globalThis, "setInterval");
    const { store, ensureSchema } = await tempStore();
    const vendo = createVendo({ models: { default: {} as LanguageModel }, principal: async () => principal, store });
    expect(timerSpy).not.toHaveBeenCalled();
    const status = () => vendo.handler(new Request("https://host.test/api/vendo/status"));
    const first = await status();
    expect(first.status).toBe(200);
    await status();
    expect(ensureSchema).toHaveBeenCalledTimes(1);
    expect(timerSpy.mock.calls.length).toBeGreaterThanOrEqual(1);
  });
});
