import { afterEach, describe, expect, it, vi } from "vitest";
import { armBackgroundSweep, composeSweep } from "../src/compose-sweep.js";
import type { VendoComposition } from "../src/compose-context.js";

describe("armBackgroundSweep - the newest composition ADOPTS the sweep", () => {
  it("a replacement composition stops the stale sweep and runs its own (#1250)", () => {
    // Adopt, never duplicate: Next dev re-arms the background sweep on every
    // route recompile, and arming must stop the predecessor's interval - a
    // dev server otherwise accumulates one live interval per recompile, all
    // hitting the store with no browser open (#1250).
    const host: Record<symbol, unknown> = {};
    let stopsA = 0;
    let startsB = 0;
    armBackgroundSweep(() => () => { stopsA += 1; }, host);
    expect(stopsA).toBe(0);
    armBackgroundSweep(() => { startsB += 1; return () => undefined; }, host);
    expect(stopsA).toBe(1);
    expect(startsB).toBe(1);
  });
});

describe("composeSweep - adoption is a DEVELOPMENT posture", () => {
  afterEach(() => {
    vi.useRealTimers();
    // The legs below arm against the REAL process slot (composeSweep owns the
    // host binding, unlike the isolated hosts above); drop it so no stale stop
    // leaks past this describe block.
    delete (globalThis as unknown as Record<symbol, unknown>)[Symbol.for("vendo.background-ttl-sweep")];
  });

  const compositionOf = (development: boolean): {
    composition: VendoComposition;
    sweeps: () => number;
  } => {
    let count = 0;
    const composition = {
      store: { close: async () => undefined },
      guard: {},
      byoApprovals: { sweepExpired: async () => { count += 1; } },
      parkedCallTtlMs: 60_000,
      sweepConfig: { intervalMs: 1_000 },
      sweepNow: () => 0,
      config: { development },
    } as unknown as VendoComposition;
    return { composition, sweeps: () => count };
  };

  it("two concurrently-live production handles keep their own sweeps", async () => {
    vi.useFakeTimers();
    const first = compositionOf(false);
    const second = compositionOf(false);
    composeSweep(first.composition).startBackgroundSweep();
    composeSweep(second.composition).startBackgroundSweep();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(first.sweeps()).toBe(1);
    expect(second.sweeps()).toBe(1);
    await Promise.all([first.composition.store.close(), second.composition.store.close()]);
  });

  it("a development re-arm adopts: the predecessor's sweep stops (#1250)", async () => {
    vi.useFakeTimers();
    const first = compositionOf(true);
    const second = compositionOf(true);
    composeSweep(first.composition).startBackgroundSweep();
    composeSweep(second.composition).startBackgroundSweep();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(first.sweeps()).toBe(0);
    expect(second.sweeps()).toBe(1);
    await Promise.all([first.composition.store.close(), second.composition.store.close()]);
  });
});
