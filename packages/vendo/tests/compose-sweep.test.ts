import { describe, expect, it } from "vitest";
import { armBackgroundSweep } from "../src/compose-sweep.js";

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
