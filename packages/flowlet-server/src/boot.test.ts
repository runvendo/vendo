/**
 * `startFlowletScheduler()` boot tests — the instrumentation.ts hook that
 * starts the in-process scheduler timer on a long-lived Node server. The
 * started-flag and the shared assembly slot live on a globalThis registry
 * (module-scope Symbol), so tests reset it in beforeEach.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { InProcessScheduler } from "@flowlet/runtime";
import { startFlowletScheduler } from "./boot";
import { ensureFlowletState, resetFlowletBootRegistry } from "./fetch-handler";

// Point at an empty scratch dir so tests never read the repo's .flowlet/.
function emptyDir(): string {
  return path.join(mkdtempSync(path.join(tmpdir(), "flowlet-boot-")), ".flowlet");
}

// NODE_ENV=test + no storage option → in-memory store (no disk writes).
function options() {
  return { flowletDir: emptyDir() };
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

beforeEach(() => {
  resetFlowletBootRegistry();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("startFlowletScheduler", () => {
  it("starts the world's scheduler exactly once, no matter how often it is called", async () => {
    const start = vi.spyOn(InProcessScheduler.prototype, "start");
    const opts = options();

    startFlowletScheduler(opts);
    await vi.waitFor(() => expect(start).toHaveBeenCalledTimes(1));

    startFlowletScheduler(opts);
    await flushMicrotasks();
    expect(start).toHaveBeenCalledTimes(1);
  });

  it("no-ops entirely when FLOWLET_SCHEDULER=external", async () => {
    vi.stubEnv("FLOWLET_SCHEDULER", "external");
    const start = vi.spyOn(InProcessScheduler.prototype, "start");

    startFlowletScheduler(options());
    await flushMicrotasks();
    expect(start).not.toHaveBeenCalled();
  });
});

describe("ensureFlowletState — first-wins world sharing", () => {
  it("returns the same state promise for the same options object", async () => {
    const opts = options();
    const first = ensureFlowletState(opts);
    const second = ensureFlowletState(opts);
    expect(second).toBe(first);
    await first;
  });

  it("reuses the first-assembled state for an empty-options caller (instrumentation.ts shape)", async () => {
    const first = ensureFlowletState(options());
    const second = ensureFlowletState();
    expect(second).toBe(first);
    await first;
  });

  it("warns and reuses the first-assembled state when called again with DIFFERENT non-empty options", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const first = ensureFlowletState(options());
    const second = ensureFlowletState(options());
    expect(second).toBe(first);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toMatch(/first/i);
    await first;
  });
});
