// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useResource } from "../src/hooks/use-resource.js";

/** Milliseconds between successive fetch attempts, off the fake clock. */
const gaps = (at: number[]) => at.slice(1).map((time, index) => time - at[index]!);

const advance = (ms: number) => act(async () => {
  await vi.advanceTimersByTimeAsync(ms);
});

describe("useResource — polling backs off while the wire is failing", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Mid-range jitter, so each delay lands on its nominal cadence.
    vi.spyOn(Math, "random").mockReturnValue(0.5);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("doubles the cadence per consecutive failure and snaps back on recovery", async () => {
    const at: number[] = [];
    let failing = false;
    const fetcher = async () => {
      at.push(Date.now());
      if (failing) throw new Error("rate limited");
      return "ok";
    };

    renderHook(() => useResource(fetcher, "", { pollMs: 1_000 }));
    await advance(1);
    failing = true;
    await advance(14_000);
    failing = false;
    await advance(2_000);

    expect(gaps(at)).toEqual([1_000, 2_000, 4_000, 8_000, 1_000]);
  });

  it("caps the widened cadence at a minute", async () => {
    const at: number[] = [];
    const fetcher = async () => {
      at.push(Date.now());
      throw new Error("offline");
    };

    renderHook(() => useResource(fetcher, "", { pollMs: 1_000 }));
    await advance(400_000);

    expect(gaps(at).slice(-2)).toEqual([60_000, 60_000]);
  });

  it("jitters the widened cadence so co-mounted pollers stop re-colliding", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const at: number[] = [];
    let failing = false;
    const fetcher = async () => {
      at.push(Date.now());
      if (failing) throw new Error("rate limited");
      return "ok";
    };

    renderHook(() => useResource(fetcher, "", { pollMs: 1_000 }));
    await advance(1);
    failing = true;
    await advance(2_600);

    // 2s doubled, then pulled down by the low end of the jitter window.
    expect(gaps(at)).toEqual([1_000, 1_500]);
  });
});
