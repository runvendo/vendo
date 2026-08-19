import type { LanguageModel } from "ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createVendo } from "../src/server.js";
import { fakeConsole } from "@vendoai/store/test-util";

/**
 * Self-serve audit F7: the hosted-store automations notice is a boot fact, but
 * a Next dev server recomposes on nearly every request — the paragraph landed
 * in the host's log 29 times in one short session. It is latched per PROCESS.
 *
 * "Per process" is the whole claim, and a MODULE-scoped `let` does not make it:
 * Next's dev server re-instantiates the module graph too, so the latch was reborn
 * every couple of seconds and the notice — and the `vendo ready` block beside it —
 * came back with it. The first test below could never see that: it composes three
 * times through ONE module instance, which is exactly the case a module-scoped
 * latch already handles. The second test is the one that reproduces a dev-server
 * reload, and both latches now live on `globalThis`, which is the only thing in
 * the process that survives one.
 */

/** The two process-wide latches, by the registered symbols their modules use. */
const LATCHES = [
  Symbol.for("vendo.compose-store.hosted-notice"),
  Symbol.for("vendo.boot-summary.announced"),
];

const HOSTED_NOTICE = "Vendo Cloud is the hosted store for this deployment";
const READY_BLOCK = "[vendo] ready";

const cleanups: Array<() => Promise<void>> = [];

/** A latch that outlives the module also outlives the TEST, so each case clears
 *  it — which is itself the proof it is not module-scoped any more. */
beforeEach(() => {
  for (const latch of LATCHES) delete (globalThis as unknown as Record<symbol, unknown>)[latch];
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

type Compose = typeof createVendo;

function composeWith(create: Compose): void {
  const vendo = create({ models: { default: {} as LanguageModel }, principal: async () => null });
  cleanups.push(async () => { await vendo.store.close(); });
}

function hostedEnv(): void {
  vi.stubEnv("VENDO_API_KEY", "vnd_hosted_key");
  vi.stubEnv("VENDO_CLOUD_URL", "https://cloud-notice.test");
  vi.stubGlobal("fetch", fakeConsole().handler as unknown as typeof fetch);
}

/** Every console line either latch can produce, whatever level it rode. */
function said(spies: Array<{ mock: { calls: unknown[][] } }>, needle: string): unknown[] {
  return spies.flatMap((spy) => spy.mock.calls.flat()).filter((message) => String(message).includes(needle));
}

describe("the hosted-store automations notice", () => {
  it("prints once per process, however many compositions there are", async () => {
    hostedEnv();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    for (let index = 0; index < 3; index += 1) composeWith(createVendo);

    expect(said([warn], HOSTED_NOTICE)).toHaveLength(1);
  });

  it("stays latched across a module re-instantiation — the dev-server reload", async () => {
    hostedEnv();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    // Its OWN module graph to start from, so the count below is this test's
    // alone — the case above already used the one this file imported.
    vi.resetModules();
    const booted = await import("../src/server.js");
    composeWith(booted.createVendo);
    expect(said([warn], HOSTED_NOTICE)).toHaveLength(1);
    expect(said([warn, log], READY_BLOCK)).toHaveLength(1);

    // A FRESH module graph, which is what Next hands a reloaded dev server: the
    // modules holding the latches are constructed again from scratch.
    vi.resetModules();
    const reloaded = await import("../src/server.js");
    expect(reloaded.createVendo).not.toBe(booted.createVendo);
    composeWith(reloaded.createVendo);

    // Still once. A module-scoped latch says twice here, every ~2 seconds, for as
    // long as the dev server is polling.
    expect(said([warn], HOSTED_NOTICE)).toHaveLength(1);
    expect(said([warn, log], READY_BLOCK)).toHaveLength(1);
  });
});
