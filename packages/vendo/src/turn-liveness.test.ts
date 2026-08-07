import { afterEach, describe, expect, it, vi } from "vitest";
import { registerActiveTurn, touchActiveTurn } from "./turn-liveness.js";

// ENG-353's watchdog must work on edge/Worker targets: wire/shared.ts,
// deployment-identity.ts, and capability-misses.ts all guard their process
// reads so this wire module graph loads and runs without a `process` global.
// The heartbeat route calls touchActiveTurn, which evaluates the idle-window
// env knob — a bare process.env there crashes every beat that matches an
// in-flight turn (the wire's generic catch turns it into a 500), so the
// idle-abort fallback never functions on exactly the runtimes it targets.
describe("turn liveness on process-less (edge/Worker) runtimes", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("beats an in-flight turn without touching the process global", () => {
    const unregister = registerActiveTurn({ threadId: "thr_edge", subject: "user_ada", abort: () => {} });
    let active: boolean;
    try {
      vi.stubGlobal("process", undefined);
      active = touchActiveTurn("thr_edge", "user_ada");
    } finally {
      vi.unstubAllGlobals();
      unregister();
    }
    expect(active).toBe(true);
  });
});
