import { describe, expect, it } from "vitest";
import {
  classifySmoke,
  noProgress,
  observedSmokeLatenciesMs,
  smokeBudgetMs,
  type SmokeProgress,
} from "./smoke.js";

/** A turn that got as far as streaming — the shape of every healthy run. */
const alive: SmokeProgress = { doorAnswered: true, turnStarted: true, toolCall: true };

describe("smokeBudgetMs", () => {
  // The gate this replaces sat at 180_000ms, INSIDE the measured distribution:
  // two of six real runs died on it with demos that were otherwise fine. A
  // budget is only a hard-failure gate if healthy runs cannot reach it, so the
  // measured numbers are pinned here — re-tightening the budget into them has
  // to break this test first.
  it("clears every latency ever measured on a healthy turn, with room to spare", () => {
    const worst = Math.max(...observedSmokeLatenciesMs);
    expect(worst).toBe(182_835);
    expect(smokeBudgetMs).toBeGreaterThanOrEqual(2 * worst);
  });

  it("stays small enough that one attempt cannot eat the pipeline's own cap", () => {
    // defaultCapMs is 40 minutes; a smoke attempt may not be a quarter of it.
    expect(smokeBudgetMs).toBeLessThanOrEqual(10 * 60 * 1000);
  });
});

describe("classifySmoke — a genuinely BROKEN demo fails, and fails fast", () => {
  // The dead-agent shape the gate exists to catch: the page renders, the agent
  // route throws (no model provider, a tools file the runtime cannot parse), and
  // the browser gets a 500 within seconds of the first send.
  it("calls a hard error from the demo's own agent route broken", () => {
    const outcome = classifySmoke({
      settled: false,
      timedOut: false,
      progress: { doorAnswered: true, doorError: "POST /api/vendo/acme → 500", turnStarted: false, toolCall: false },
    });
    expect(outcome.verdict).toBe("broken");
    expect(outcome.reason).toContain("500");
  });

  it("calls a turn that surfaced an error broken", () => {
    const outcome = classifySmoke({
      settled: false,
      timedOut: false,
      surfacedError: "Something went wrong and the response didn’t finish.",
      progress: { doorAnswered: true, turnStarted: true, toolCall: false },
    });
    expect(outcome.verdict).toBe("broken");
    expect(outcome.reason).toContain("didn’t finish");
  });

  // The other dead-agent shape: nothing errors, nothing arrives either. This is
  // the ONE case where the clock is the evidence — and it is still called
  // broken, not slow, because a demo that produced literally nothing in the
  // whole budget has not been shown to work at all.
  it("calls a deadline with no turn and no tool call broken, never merely slow", () => {
    const outcome = classifySmoke({
      settled: false,
      timedOut: true,
      progress: noProgress(),
    });
    expect(outcome.verdict).toBe("broken");
    expect(outcome.reason).toMatch(/never/i);
  });
});

describe("classifySmoke — a SLOW but healthy demo is not called broken", () => {
  it("passes a turn that settled, however long it took", () => {
    expect(classifySmoke({ settled: true, timedOut: false, progress: alive }).verdict).toBe("settled");
  });

  // The distinction that IS the fix. Same wall clock, same deadline; the demo
  // that demonstrably streamed and called a tool is reported as a TIMEOUT, and
  // the one that did nothing is reported as BROKEN. The old gate called both
  // "Timed out after 180000ms waiting for the generated Vendo turn".
  it("separates a slow living agent from a dead one at the very same deadline", () => {
    const slow = classifySmoke({ settled: false, timedOut: true, progress: alive });
    const dead = classifySmoke({ settled: false, timedOut: true, progress: noProgress() });
    expect(slow.verdict).toBe("timeout");
    expect(dead.verdict).toBe("broken");
    expect(slow.verdict).not.toBe(dead.verdict);
  });

  it("counts a streamed turn as life even when no tool call was ever seen", () => {
    // The transcript renders no trace of a SETTLED tool call, so the observer
    // can miss one that really happened; a streamed turn alone is enough.
    const outcome = classifySmoke({
      settled: false,
      timedOut: true,
      progress: { doorAnswered: true, turnStarted: true, toolCall: false },
    });
    expect(outcome.verdict).toBe("timeout");
  });

  it("counts a tool call as life even when no assistant article ever attached", () => {
    const outcome = classifySmoke({
      settled: false,
      timedOut: true,
      progress: { doorAnswered: true, turnStarted: false, toolCall: true },
    });
    expect(outcome.verdict).toBe("timeout");
  });
});

describe("classifySmoke — what a second attempt can and cannot fix", () => {
  // Run E died here: "Something went wrong and the response didn't finish" at
  // 129s, on a demo that was fine. An external inference failure is not the
  // demo's bug, and it is the one outcome a retry can genuinely clear.
  it("marks an errored turn retryable — that failure came from outside the demo", () => {
    expect(classifySmoke({
      settled: false,
      timedOut: false,
      surfacedError: "Something went wrong and the response didn’t finish.",
      progress: alive,
    }).retryable).toBe(true);
  });

  it("marks a hard door error retryable, because it costs seconds to re-prove", () => {
    expect(classifySmoke({
      settled: false,
      timedOut: false,
      progress: { doorAnswered: true, doorError: "POST /api/vendo/acme → 500", turnStarted: false, toolCall: false },
    }).retryable).toBe(true);
  });

  // A retry after a deadline costs another whole budget of wall clock and
  // cannot change what the clock already proved.
  it("never marks a deadline retryable, whichever way it was classified", () => {
    expect(classifySmoke({ settled: false, timedOut: true, progress: alive }).retryable).toBe(false);
    expect(classifySmoke({ settled: false, timedOut: true, progress: noProgress() }).retryable).toBe(false);
  });

  it("never marks a settled turn retryable", () => {
    expect(classifySmoke({ settled: true, timedOut: false, progress: alive }).retryable).toBe(false);
  });
});

describe("classifySmoke — precedence", () => {
  // A door that 500s while the page also shows an alert is ONE fault, and the
  // door is the more specific evidence.
  it("reports the door's own error ahead of the alert the page rendered", () => {
    const outcome = classifySmoke({
      settled: false,
      timedOut: false,
      surfacedError: "the response didn’t finish",
      progress: { doorAnswered: true, doorError: "POST /api/vendo/acme → 500", turnStarted: false, toolCall: false },
    });
    expect(outcome.reason).toContain("500");
  });

  // Content is stage 5's business (frozen contract): the classifier is handed
  // liveness signals only, so no verdict can depend on what was generated.
  it("carries no content — only liveness signals", () => {
    const outcome = classifySmoke({ settled: true, timedOut: false, progress: alive });
    expect(Object.keys(outcome.progress).sort()).toEqual(["doorAnswered", "toolCall", "turnStarted"]);
  });
});
